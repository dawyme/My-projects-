/**
 * Website Content Manager — public site loader.
 *
 * Pulls published content from the admin backend and applies it to the page.
 * Every `[data-content]` element is filled from a content path (e.g.
 * "homepage.hero.title"). Containers with a `data-content-list` render
 * collections (services, testimonials, gallery, faqs, promotions, team).
 * The page keeps its hard-coded markup as a fallback when the API is
 * unreachable or a field has not been published.
 */
(function () {
  'use strict';

  var API_BASE = (function () {
    var meta = document.querySelector('meta[name="api-base"]');
    if (meta && meta.content) return meta.content.replace(/\/$/, '');
    if (location.protocol === 'file:') return 'http://localhost:3001';
    return location.origin;
  })();

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(v) { return esc(v); }
  function starRating(n) {
    n = Math.max(1, Math.min(5, Number(n) || 5));
    var out = '';
    for (var i = 1; i <= 5; i++) out += '<i class="fas fa-star' + (i <= n ? '' : ' far') + '"></i>';
    return out;
  }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, obj);
  }
  function linkOr(s, fallback) { return (s && s.trim()) ? s : fallback; }

  function loadJson(path, fallback) {
    return fetch(API_BASE + path).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { return j.data; })
      .catch(function () { return fallback; });
  }

  // Published content pages + collections + settings, loaded in parallel.
  function fetchAll() {
    return Promise.all([
      loadJson('/api/public/content', {}),
      loadJson('/api/public/site-content/services', []),
      loadJson('/api/public/site-content/testimonials', []),
      loadJson('/api/public/site-content/gallery', []),
      loadJson('/api/public/site-content/faqs', []),
      loadJson('/api/public/site-content/promotions', []),
      loadJson('/api/public/site-content/team', []),
      loadJson('/api/public/settings', {}),
    ]).then(function (parts) {
      return { pages: parts[0], services: parts[1], testimonials: parts[2], gallery: parts[3], faqs: parts[4], promotions: parts[5], team: parts[6], settings: parts[7] };
    });
  }

  function applyContent(data) {
    // ---- [data-content] text fields
    document.querySelectorAll('[data-content]').forEach(function (el) {
      var val = getPath(data.pages, el.getAttribute('data-content'));
      if (val === undefined || val === null) return;
      el.textContent = val;
    });

    // ---- [data-content-html] rich text fields
    document.querySelectorAll('[data-content-html]').forEach(function (el) {
      var val = getPath(data.pages, el.getAttribute('data-content-html'));
      if (val === undefined || val === null) return;
      el.innerHTML = val;
    });

    // ---- [data-content-img] images
    document.querySelectorAll('[data-content-img]').forEach(function (el) {
      var val = getPath(data.pages, el.getAttribute('data-content-img'));
      if (val) { el.src = val; el.removeAttribute('srcset'); }
    });

    // ---- [data-href] links
    document.querySelectorAll('[data-href]').forEach(function (el) {
      var val = getPath(data.pages, el.getAttribute('data-href'));
      if (val) el.setAttribute('href', val);
    });

    // ---- emergency banner
    var emergency = data.pages.emergency && data.pages.emergency.content;
    if (emergency) {
      document.querySelectorAll('[data-emergency-banner]').forEach(function (el) {
        var on = emergency.enabled !== false && (emergency.text || emergency.title);
        el.hidden = !on;
        if (on) {
          var textEl = el.querySelector('[data-emergency-text]');
          if (textEl) textEl.textContent = emergency.text || emergency.title;
          var linkEl = el.querySelector('[data-emergency-link]');
          if (linkEl && emergency.link) linkEl.setAttribute('href', emergency.link);
          var linkLabel = el.querySelector('[data-emergency-label]');
          if (linkLabel && emergency.linkLabel) linkLabel.textContent = emergency.linkLabel;
        }
      });
    }

    // ---- footer
    var footer = data.pages.footer && data.pages.footer.content;
    if (footer) {
      var aboutEl = document.querySelector('[data-footer-about]');
      if (aboutEl) aboutEl.textContent = footer.about;
      var copyEl = document.querySelector('[data-footer-copyright]');
      if (copyEl) copyEl.textContent = footer.copyright;
      var quickLinks = document.querySelector('[data-footer-quicklinks]');
      if (quickLinks && Array.isArray(footer.quickLinks)) {
        quickLinks.innerHTML = footer.quickLinks.map(function (l) {
          return '<li><a href="' + escAttr(l.url || '#') + '">' + esc(l.label) + '</a></li>';
        }).join('');
      }
      var contactFoot = document.querySelector('[data-footer-contact]');
      if (contactFoot && footer.contact) {
        var phone = footer.contact.phone || data.settings.company.phone;
        var email = footer.contact.email || data.settings.company.email;
        var addr = footer.contact.address || data.settings.company.address;
        contactFoot.innerHTML = (phone ? '<p><i class="fas fa-phone"></i> <a href="tel:' + escAttr(phone) + '">' + esc(phone) + '</a></p>' : '') +
          (email ? '<p><i class="fas fa-envelope"></i> <a href="mailto:' + escAttr(email) + '">' + esc(email) + '</a></p>' : '') +
          (addr ? '<p><i class="fas fa-map-marker-alt"></i> ' + esc(addr).replace(/\n/g, '<br>') + '</p>' : '') +
          (footer.contact.emergencyNote ? '<p class="emergency-note"><strong>' + esc(footer.contact.emergencyNote) + '</strong></p>' : '');
      }
    }

    // ---- business hours
    var hours = data.pages.hours && data.pages.hours.content;
    if (hours) {
      document.querySelectorAll('[data-hours]').forEach(function (el) {
        var day = el.getAttribute('data-hours').toLowerCase();
        if (hours[day] !== undefined) el.textContent = hours[day];
      });
      var h247 = document.querySelector('[data-hours-247]');
      if (h247) h247.hidden = !hours.emergency247;
    }

    // ---- collections
    renderList('[data-content-list="services"]', data.services, serviceCard);
    renderList('[data-content-list="testimonials"]', data.testimonials, testimonialCard);
    renderList('[data-content-list="gallery"]', data.gallery, galleryCard);
    renderList('[data-content-list="faqs"]', data.faqs, faqItem);
    renderList('[data-content-list="promotions"]', data.promotions, promotionCard);
    renderList('[data-content-list="team"]', data.team, teamCard);

    // ---- CTA section
    var cta = data.pages.homepage && data.pages.homepage.content && data.pages.homepage.content.cta;
    if (cta) {
      var ctaTitle = document.querySelector('[data-cta-title]');
      if (ctaTitle && cta.title) ctaTitle.textContent = cta.title;
      var ctaSub = document.querySelector('[data-cta-subtitle]');
      if (ctaSub && cta.subtitle) ctaSub.textContent = cta.subtitle;
    }

    // ---- dynamic SEO (title / description / OG)
    applySeo(data.pages);
  }

  function renderList(selector, items, renderer) {
    var host = document.querySelector(selector);
    if (!host || !Array.isArray(items)) return;
    if (!items.length) return; // keep the hard-coded markup as a fallback
    host.innerHTML = items.map(renderer).join('');
  }

  function serviceCard(s) {
    return '<div class="service-card">' +
      '<div class="service-icon"><i class="fas ' + escAttr(s.icon || 'fa-wrench') + '"></i></div>' +
      '<h3>' + esc(s.name) + '</h3>' +
      (s.description ? '<p>' + esc(s.description) + '</p>' : '') +
      '<a href="/services.html#' + escAttr(s.slug || '') + '" class="learn-more">Learn more</a>' +
      '</div>';
  }
  function testimonialCard(t) {
    return '<div class="testimonial-card">' +
      '<div class="testimonial-content"><p>' + esc(t.review) + '</p></div>' +
      '<div class="testimonial-author"><strong>' + esc(t.name) + '</strong>' +
      (t.company ? '<span>' + esc(t.company) + '</span>' : '') +
      (t.photoUrl ? '<span class="testimonial-photo"><img src="' + escAttr(t.photoUrl) + '" alt="' + escAttr(t.name) + '"></span>' : '') +
      '</div>' +
      '<div class="testimonial-rating">' + starRating(t.rating) + '</div>' +
      '</div>';
  }
  function galleryCard(g) {
    return '<a href="' + escAttr(g.imageUrl) + '" class="gallery-item" data-fancybox="gallery">' +
      '<img src="' + escAttr(g.thumbUrl || g.imageUrl) + '" alt="' + escAttr(g.title || g.alt || 'Gallery image') + '" loading="lazy">' +
      (g.title ? '<div class="gallery-caption">' + esc(g.title) + '</div>' : '') +
      '</a>';
  }
  function faqItem(f) {
    return '<div class="faq-item"><h3>' + esc(f.question) + '</h3><p>' + f.answer + '</p></div>';
  }
  function promotionCard(p) {
    return '<div class="promo-card">' +
      (p.badge ? '<span class="promo-badge">' + esc(p.badge) + '</span>' : '') +
      '<h3>' + esc(p.title) + '</h3>' +
      (p.body ? '<p>' + p.body + '</p>' : '') +
      (p.link ? '<a href="' + escAttr(p.link) + '" class="btn-primary">Learn more</a>' : '') +
      '</div>';
  }
  function teamCard(m) {
    return '<div class="team-card">' +
      (m.photoUrl ? '<div class="team-photo"><img src="' + escAttr(m.photoUrl) + '" alt="' + escAttr(m.name) + '"></div>' : '') +
      '<h3>' + esc(m.name) + '</h3>' +
      (m.role ? '<div class="team-role">' + esc(m.role) + '</div>' : '') +
      (m.bio ? '<p>' + esc(m.bio) + '</p>' : '') +
      '</div>';
  }

  function applySeo(pages) {
    var seo = pages.seo && pages.seo.content;
    if (!seo) return;
    if (seo.globalTitle && !document.querySelector('[data-seo-title-static]')) {
      if (document.title.indexOf(seo.globalTitle) === -1) document.title = seo.globalTitle;
    }
    if (seo.globalDescription) {
      var metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute('content', seo.globalDescription);
      var ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc) ogDesc.setAttribute('content', seo.globalDescription);
    }
    if (seo.ogImage) {
      var ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg) ogImg.setAttribute('content', seo.ogImage);
    }
    if (seo.keywords) {
      var kw = document.querySelector('meta[name="keywords"]');
      if (kw) kw.setAttribute('content', seo.keywords);
    }
  }

  function init() {
    fetchAll().then(applyContent).catch(function (e) { /* keep static fallback */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.NDSContent = { load: init };
})();
