import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, qsa, icon, esc, emptyState, modal, toast, toastError, setCurrency } from '../ui.js';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export async function render(view) {
  setTitle('Settings');
  const readOnly = !auth.isAdmin;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Business Settings</h1><p>Company information, hours, branding, email, payments and SEO.</p></div>
    </div>
    ${readOnly ? '<div class="alert alert--info" style="margin-bottom:16px">You have read-only access. Only administrators can change business settings.</div>' : ''}
    <div class="tabs" role="tablist" id="tabs">
      <button class="tab" role="tab" data-tab="company" aria-selected="true">Company</button>
      <button class="tab" role="tab" data-tab="hours" aria-selected="false">Business hours</button>
      <button class="tab" role="tab" data-tab="social" aria-selected="false">Social links</button>
      <button class="tab" role="tab" data-tab="email" aria-selected="false">Email</button>
      <button class="tab" role="tab" data-tab="payment" aria-selected="false">Payments</button>
      <button class="tab" role="tab" data-tab="seo" aria-selected="false">SEO</button>
    </div>
    <section class="card" style="margin-top:14px" id="panel">
      <div class="card__body" style="display:grid;place-items:center;min-height:220px"><div class="spinner"></div></div>
    </section>`;

  let settings;
  try { settings = (await api.get('/settings')).data; }
  catch (e) { qs('#panel', view).innerHTML = `<div class="card__body">${emptyState('Could not load settings', e.message)}</div>`; return; }
  setCurrency({ code: settings.payment.currency, symbol: settings.payment.currencySymbol });

  const panel = qs('#panel', view);
  const disabled = readOnly ? 'disabled' : '';
  const text = (id, name, label, value, type = 'text', hint = '') =>
    `<div class="field"><label for="${id}">${esc(label)}</label>
      <input id="${id}" name="${name}" type="${type}" value="${esc(value ?? '')}" ${disabled}>
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
  const check = (id, name, label, checked) =>
    `<label class="checkline"><input id="${id}" type="checkbox" name="${name}" ${checked ? 'checked' : ''} ${disabled}> ${esc(label)}</label>`;

  const PANELS = {
    company: () => `
      <div class="card__head"><h2>Company information</h2></div>
      <div class="card__body"><form id="form" data-section="company">
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
          <img src="${esc(settings.company.logoUrl || '../assets/logo.png')}" alt="Company logo" style="height:56px;border-radius:9px;border:1px solid var(--border);background:var(--surface-2);padding:5px"
               onerror="this.src='../assets/logo.png'">
          <button type="button" class="btn btn--ghost" id="logoBtn" ${disabled}>${icon('upload')} Upload logo</button>
        </div>
        <div class="grid grid--form">
          ${text('cf-name', 'name', 'Company name', settings.company.name)}
          ${text('cf-tagline', 'tagline', 'Tagline', settings.company.tagline)}
          ${text('cf-email', 'email', 'Contact email', settings.company.email, 'email')}
          ${text('cf-phone', 'phone', 'Phone', settings.company.phone, 'tel')}
          ${text('cf-whatsapp', 'whatsapp', 'WhatsApp number', settings.company.whatsapp, 'tel')}
          ${text('cf-city', 'city', 'City', settings.company.city)}
          ${text('cf-country', 'country', 'Country', settings.company.country)}
          ${text('cf-reg', 'registrationNo', 'Registration number', settings.company.registrationNo)}
          ${text('cf-tax', 'taxNo', 'Tax / VAT number', settings.company.taxNo)}
        </div>
        ${text('cf-address', 'address', 'Street address', settings.company.address)}
      </form></div>`,
    hours: () => `
      <div class="card__head"><h2>Business hours</h2></div>
      <div class="card__body"><form id="form" data-section="hours">
        <div class="grid grid--form">${DAYS.map((d) =>
          text(`hf-${d}`, d, d.charAt(0).toUpperCase() + d.slice(1), settings.hours[d], 'text', 'e.g. 08:00-17:00 or Closed')).join('')}</div>
        ${check('hf-emergency', 'emergency247', 'Advertise 24/7 emergency callout service', settings.hours.emergency247)}
      </form></div>`,
    social: () => `
      <div class="card__head"><h2>Social links</h2></div>
      <div class="card__body"><form id="form" data-section="social">
        <div class="grid grid--form">${['facebook', 'instagram', 'twitter', 'linkedin', 'youtube', 'tiktok'].map((k) =>
          text(`sf-${k}`, k, k.charAt(0).toUpperCase() + k.slice(1), settings.social[k], 'url')).join('')}</div>
      </form></div>`,
    email: () => `
      <div class="card__head"><h2>Email configuration</h2></div>
      <div class="card__body"><form id="form" data-section="email">
        <div class="alert alert--info">SMTP credentials live in the backend <code>.env</code> file (<code>SMTP_HOST</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code>). When SMTP is not configured, outgoing mail is written to <code>backend/data/outbox.log</code>.</div>
        <div class="grid grid--form">
          ${text('ef-fromName', 'fromName', 'From name', settings.email.fromName)}
          ${text('ef-fromEmail', 'fromEmail', 'From address', settings.email.fromEmail, 'email')}
          ${text('ef-replyTo', 'replyTo', 'Reply-to address', settings.email.replyTo, 'email')}
        </div>
        ${check('ef-nb', 'notifyBookings', 'Email the team when a booking is submitted online', settings.email.notifyBookings)}
        ${check('ef-nm', 'notifyMessages', 'Email the team when a contact message arrives', settings.email.notifyMessages)}
        <div style="margin-top:16px;display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin:0;flex:1;min-width:220px"><label for="testTo">Send a test email to</label>
            <input id="testTo" type="email" placeholder="you@example.com" ${disabled}></div>
          <button type="button" class="btn btn--ghost" id="testBtn" ${disabled}>${icon('mail')} Send test</button>
        </div>
      </form></div>`,
    payment: () => `
      <div class="card__head"><h2>Payment configuration</h2></div>
      <div class="card__body"><form id="form" data-section="payment">
        <div class="grid grid--form">
          ${text('pf-currency', 'currency', 'Currency code', settings.payment.currency, 'text', 'Three-letter ISO code, e.g. USD')}
          ${text('pf-symbol', 'currencySymbol', 'Currency symbol', settings.payment.currencySymbol)}
          ${text('pf-tax', 'taxRate', 'Default tax rate (%)', settings.payment.taxRate, 'number')}
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">
          ${check('pf-bank', 'bankTransfer', 'Accept bank transfer', settings.payment.bankTransfer)}
          ${check('pf-cod', 'cashOnDelivery', 'Accept cash on delivery', settings.payment.cashOnDelivery)}
        </div>
        ${check('pf-stripe', 'stripeEnabled', 'Enable Stripe card payments', settings.payment.stripeEnabled)}
        ${text('pf-stripeKey', 'stripePublicKey', 'Stripe publishable key', settings.payment.stripePublicKey, 'text', 'Only the publishable key belongs here — keep the secret key in the backend environment.')}
        ${check('pf-paypal', 'paypalEnabled', 'Enable PayPal', settings.payment.paypalEnabled)}
        ${text('pf-paypalId', 'paypalClientId', 'PayPal client ID', settings.payment.paypalClientId)}
        <div style="border-top:1px solid var(--border);margin:16px 0 4px"></div>
        ${check('pf-wipay', 'wipayEnabled', 'Enable WiPay (Caribbean cards &amp; vouchers)', settings.payment.wipayEnabled)}
        ${check('pf-tilopay', 'tilopayEnabled', 'Enable Tilopay', settings.payment.tilopayEnabled)}
        <div class="field" style="margin-top:12px"><label for="pf-bankDetails">Bank transfer instructions</label>
          <textarea id="pf-bankDetails" name="bankTransferDetails" rows="3" ${disabled}>${esc(settings.payment.bankTransferDetails || '')}</textarea>
          <span class="hint">Shown to customers who select bank transfer at checkout (account number, bank, etc.).</span></div>
        <p class="hint" style="margin-top:14px">Gateway API keys (Stripe secret, PayPal, WiPay, Tilopay) live in the server environment — see <code>DEPLOYMENT.md</code>. A method enabled here but missing its keys runs in test mode (development only).</p>
      </form></div>`,
    seo: () => `
      <div class="card__head"><h2>SEO settings</h2></div>
      <div class="card__body"><form id="form" data-section="seo">
        ${text('qf-title', 'title', 'Meta title', settings.seo.title, 'text', 'Aim for 50–60 characters.')}
        <div class="field"><label for="qf-desc">Meta description</label>
          <textarea id="qf-desc" name="description" rows="3" ${disabled}>${esc(settings.seo.description)}</textarea>
          <span class="hint">Aim for 140–160 characters.</span></div>
        ${text('qf-keywords', 'keywords', 'Keywords', settings.seo.keywords, 'text', 'Comma-separated.')}
        ${text('qf-og', 'ogImage', 'Open Graph image URL', settings.seo.ogImage)}
        ${text('qf-ga', 'googleAnalyticsId', 'Google Analytics ID', settings.seo.googleAnalyticsId, 'text', 'e.g. G-XXXXXXXXXX')}
        ${check('qf-index', 'indexable', 'Allow search engines to index the website', settings.seo.indexable)}
      </form></div>`,
  };

  function showTab(name) {
    panel.innerHTML = PANELS[name]() + (readOnly ? '' :
      `<div class="card__foot" style="justify-content:flex-end"><button class="btn btn--primary" id="saveBtn">Save ${esc(name)} settings</button></div>`);

    if (!readOnly) {
      qs('#saveBtn', panel).onclick = async () => {
        const form = qs('#form', panel);
        const payload = {};
        for (const field of form.elements) {
          if (!field.name) continue;
          if (field.type === 'checkbox') payload[field.name] = field.checked;
          else if (field.type === 'number') payload[field.name] = Number(field.value || 0);
          else payload[field.name] = field.value;
        }
        const btn = qs('#saveBtn', panel);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Saving…';
        try {
          const { data } = await api.put(`/settings/${form.dataset.section}`, payload);
          Object.assign(settings, data);
          if (form.dataset.section === 'payment') setCurrency({ code: settings.payment.currency, symbol: settings.payment.currencySymbol });
          if (form.dataset.section === 'company') { const n = document.querySelector('#companyName'); if (n) n.textContent = settings.company.name; }
          toast('Settings saved');
        } catch (e) { toastError(e); }
        btn.disabled = false;
        btn.textContent = `Save ${name} settings`;
      };
    }

    const logoBtn = qs('#logoBtn', panel);
    if (logoBtn) logoBtn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return toast('Logo must be 5MB or smaller', 'error');
        try {
          const fd = new FormData();
          fd.append('logo', file);
          const { data } = await api.upload('/settings/logo', fd);
          settings.company.logoUrl = data.logoUrl;
          toast('Logo uploaded');
          showTab('company');
        } catch (e) { toastError(e); }
      };
      input.click();
    };

    const testBtn = qs('#testBtn', panel);
    if (testBtn) testBtn.onclick = async () => {
      const to = qs('#testTo', panel).value.trim();
      if (!to) return toast('Enter an email address first', 'warning');
      testBtn.disabled = true;
      try { const res = await api.post('/settings/test-email', { to }); toast(res.message, 'info'); }
      catch (e) { toastError(e); }
      testBtn.disabled = false;
    };
  }

  qs('#tabs', view).addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    qsa('#tabs .tab', view).forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    showTab(tab.dataset.tab);
  });

  showTab('company');
}
