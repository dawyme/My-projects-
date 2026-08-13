/**
 * Connects the public website forms to the CoolAir admin backend.
 * Submissions land directly in the dashboard inbox / bookings queue.
 * If the API is unreachable the original form action is used as a fallback.
 */
(function () {
  'use strict';

  // Same-origin by default (the backend serves this site). Override with
  // <meta name="api-base" content="https://api.example.com"> when the website
  // is hosted separately from the API.
  var API_BASE = (function () {
    var meta = document.querySelector('meta[name="api-base"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
    if (location.protocol === 'file:') return 'http://localhost:3001';
    return '';
  })();

  function csrfCookie() {
    var m = document.cookie.match(/(?:^|;\s*)hvac_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function ensureCsrf() {
    var existing = csrfCookie();
    if (existing) return Promise.resolve(existing);
    return fetch(API_BASE + '/api/csrf-token', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.data && j.data.csrfToken) || null; })
      .catch(function () { return null; });
  }

  function post(path, payload) {
    return ensureCsrf().then(function (token) {
      return fetch(API_BASE + '/api' + path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token || '' },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error((json && json.error) || 'Submission failed');
          return json;
        });
      });
    });
  }

  function feedback(form, message, isError) {
    var box = form.querySelector('.form-feedback');
    if (!box) {
      box = document.createElement('div');
      box.className = 'form-feedback';
      box.setAttribute('role', 'status');
      box.style.cssText = 'margin-top:16px;padding:12px 16px;border-radius:8px;font-size:0.95rem;';
      form.appendChild(box);
    }
    box.style.background = isError ? '#fee2e2' : '#d1fae5';
    box.style.color = isError ? '#b91c1c' : '#065f46';
    box.textContent = message;
  }

  function busy(form, on, label) {
    var btn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = label || 'Sending…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  function showThankYou(form) {
    var panel = document.getElementById('thank-you-message');
    if (panel) {
      form.style.display = 'none';
      panel.style.display = 'block';
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ------------------------------------------------------------ contact */
  var contactForm = document.getElementById('contactForm');
  if (contactForm) {
    contactForm.dataset.apiHandled = 'true';
    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(contactForm);
      var name = (data.get('name') || '').toString().trim();
      var email = (data.get('email') || '').toString().trim();
      var message = (data.get('message') || '').toString().trim();
      var phone = (data.get('phone') || '').toString().trim();

      var serviceType = (data.get('service_type') || '').toString().trim();
      if (!name || !phone || !message) {
        return feedback(contactForm, 'Please fill in your name, phone, and message.', true);
      }

      busy(contactForm);
      post('/public/contact', {
        name: name, email: email || null, phone: phone,
        subject: (data.get('subject') || 'Website enquiry').toString(),
        serviceType: serviceType, message: message,
      }).then(function (res) {
        contactForm.reset();
        feedback(contactForm, res.message || 'Thank you — your message has been received.');
        showThankYou(contactForm);
      }).catch(function (err) {
        feedback(contactForm, err.message || 'We could not send your message. Please call us instead.', true);
      }).finally(function () { busy(contactForm, false); });
    });
  }

  /* ------------------------------------------------------------ booking */
  var bookingForm = document.getElementById('bookingForm');
  if (bookingForm) {
    bookingForm.dataset.apiHandled = 'true';
    var SERVICE_HINTS = {
      'ac-repair': 'AC Repair & Diagnostics',
      'ac-install': 'AC Installation',
      refrigeration: 'Refrigeration Servicing',
      'automotive-ac': 'Automotive AC Re-gas',
      maintenance: 'Preventive Maintenance',
      emergency: 'Emergency Callout',
    };
    var TIME_HINTS = { morning: '09:00', afternoon: '13:00', evening: '17:00', '': '10:00' };
    var serviceIndex = {};

    fetch(API_BASE + '/api/public/services')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        (j.data || []).forEach(function (s) { serviceIndex[s.name] = s.id; });
      })
      .catch(function () { /* the booking still submits without a service link */ });

    bookingForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(bookingForm);
      var name = (data.get('name') || '').toString().trim();
      var email = (data.get('email') || '').toString().trim();
      var phone = (data.get('phone') || '').toString().trim();

      if (!name || !phone) return feedback(bookingForm, 'Please provide your name and phone number.', true);
      if (!email) return feedback(bookingForm, 'Please provide an email address so we can confirm your booking.', true);

      var day = (data.get('date') || '').toString();
      var time = TIME_HINTS[(data.get('time') || '').toString()] || '10:00';
      var when = day ? new Date(day + 'T' + time) : new Date(Date.now() + 86400000);
      if (isNaN(when.getTime())) when = new Date(Date.now() + 86400000);

      var serviceName = SERVICE_HINTS[(data.get('service_type') || '').toString()];
      var details = (data.get('message') || '').toString().trim();
      if (data.get('emergency')) details = '[EMERGENCY] ' + details;

      busy(bookingForm, true, 'Submitting…');
      post('/public/bookings', {
        name: name, email: email, phone: phone,
        address: (data.get('address') || '').toString().trim() || null,
        serviceId: serviceIndex[serviceName] || null,
        scheduledAt: when.toISOString(),
        description: (serviceName ? serviceName + ' — ' : '') + (details || 'Requested via the website booking form.'),
      }).then(function (res) {
        bookingForm.reset();
        feedback(bookingForm, 'Booking received. Reference: ' + (res.data && res.data.reference));
        showThankYou(bookingForm);
      }).catch(function (err) {
        feedback(bookingForm, err.message || 'We could not submit your booking. Please call us instead.', true);
      }).finally(function () { busy(bookingForm, false); });
    });
  }

  /**
   * Generic delivery hook used by main.js for any enhanced form that this
   * module does not handle directly (e.g. #appointmentForm).
   */
  window.CoolAirSubmitForm = function (form) {
    var data = new FormData(form);
    var name = (data.get('name') || '').toString().trim();
    var email = (data.get('email') || '').toString().trim();
    var phone = (data.get('phone') || '').toString().trim();
    if (!name || !email) return Promise.reject(new Error('Name and email are required'));

    var lines = [];
    data.forEach(function (value, key) {
      if (['name', 'email', 'phone'].indexOf(key) === -1 && String(value).trim()) {
        lines.push(key.replace(/_/g, ' ') + ': ' + value);
      }
    });
    return post('/public/contact', {
      name: name, email: email, phone: phone || null,
      subject: 'Website enquiry',
      serviceType: (data.get('service_type') || 'General Inquiry').toString(),
      message: lines.join('\n') || 'Enquiry submitted via the website.',
    });
  };

  /* ------------------------------------------------------------ quote */
  // quote-form.js owns the quote UI; it delegates delivery to this helper.
  window.CoolAirSubmitQuote = function (payload) {
    return post('/public/contact', {
      name: payload.name,
      email: payload.email,
      phone: payload.phone || null,
      subject: 'Quote request',
      message: payload.message,
    });
  };

  var quoteForm = document.getElementById('quoteForm');
  if (quoteForm) {
    quoteForm.dataset.apiHandled = 'true';
    // quote-form.js drives the quote UI when present; otherwise handle it here.
    if (!document.querySelector('script[src*="quote-form.js"]')) {
      quoteForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var data = new FormData(quoteForm);
        var name = (data.get('name') || '').toString().trim();
        var email = (data.get('email') || '').toString().trim();
        if (!name || !email) return feedback(quoteForm, 'Please provide your name and email address.', true);
        var summary = [];
        data.forEach(function (value, key) {
          if (['name', 'email', 'phone'].indexOf(key) === -1 && String(value).trim()) {
            summary.push(key.replace(/_/g, ' ') + ': ' + value);
          }
        });
        busy(quoteForm);
        window.CoolAirSubmitQuote({
          name: name, email: email,
          phone: (data.get('phone') || '').toString().trim(),
          message: summary.join('\n') || 'Quote requested via the website.',
        }).then(function () {
          quoteForm.reset();
          feedback(quoteForm, 'Thank you — your quote request has been received.');
          showThankYou(quoteForm);
        }).catch(function (err) {
          feedback(quoteForm, err.message || 'We could not submit your request. Please call us instead.', true);
        }).finally(function () { busy(quoteForm, false); });
      });
    }
  }
})();
