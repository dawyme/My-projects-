/**
 * Public website integration checks — verifies the storefront pages are served
 * and that the contact / booking / quote forms reach the admin backend.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
let failures = 0;
const record = (ok, name, extra = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` — ${extra}` : '')]);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (_) {} await wait(60); }
  return false;
}

function installFetch(window, base) {
  const jar = new Map();
  // jsdom loads sub-resources with its own client, so cookies can land in
  // document.cookie without passing through this shim. Browsers attach them
  // automatically; mirror that here before every request.
  const syncFromDoc = () => {
    for (const part of (window.document.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  };
  window.fetch = async (input, init = {}) => {
    syncFromDoc();
    const url = new URL(String(input), base).toString();
    const headers = new Headers(init.headers || {});
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
      window.document.cookie = `${pair.slice(0, i)}=${pair.slice(i + 1)}; path=/`;
    }
    return res;
  };
  window.Headers = Headers;
}

async function loadPage(file, base, virtualConsole, extraBeforeParse) {
  let html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  html = html.replace(/<link[^>]+(fonts\.googleapis|cdnjs|jsdelivr)[^>]*>/g, '');
  html = html.replace(/<script[^>]+(cdnjs|jsdelivr|googletagmanager)[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, {
    url: `${base}/${file}`, runScripts: 'dangerously', resources: 'usable',
    pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      installFetch(window, base);
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (m) => { window.__alert = m; };
      if (extraBeforeParse) extraBeforeParse(window);
    },
  });
  // Give inline page scripts time to attach their handlers.
  await wait(800);
  return dom;
}

async function main() {
  // The public form limiter is per-IP per hour; this run submits several forms
  // from the same address, so raise the ceiling for the test process only.
  process.env.PUBLIC_FORM_LIMIT = '1000';
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => { if (!/Could not (load|parse)/.test(e.message)) errors.push(e.message); });

  // ---------- static pages are served by the backend
  const PAGES = ['index.html', 'about.html', 'services.html', 'contact.html', 'booking.html',
    'quote-request.html', 'cart.html', 'checkout.html', 'testimonials.html', 'privacy.html', 'terms.html'];
  for (const page of PAGES) {
    const res = await fetch(`${base}/${page}`);
    const body = await res.text();
    record(res.ok && body.includes('<!DOCTYPE html'), `Public page /${page} is served`, res.ok ? '' : `HTTP ${res.status}`);
  }
  record((await fetch(`${base}/assets/css/style.css`)).ok, 'Site stylesheet is served');
  record((await fetch(`${base}/assets/js/site-api.js`)).ok, 'Site API bridge script is served');
  record((await fetch(`${base}/assets/js/site-content.js`)).ok, 'Site content loader script is served');

  // ---------- contact form
  const beforeMessages = await prisma.contactMessage.count();
  const contactDom = await loadPage('contact.html', base, vc);
  const cw = contactDom.window;
  const cForm = cw.document.getElementById('contactForm');
  record(!!cForm, 'Contact page exposes the contact form');
  const contactHtml = fs.readFileSync(path.join(ROOT, 'contact.html'), 'utf8');
  record(!/formbold/i.test(contactHtml), 'Contact form does not reference FormBold');
  record(!/<form[^>]*id=\"contactForm\"[^>]*action=/i.test(contactHtml), 'Contact form has no external action fallback');
  if (cForm) {
    cForm.elements.name.value = 'Integration Tester';
    cForm.elements.email.value = `site.contact.${Date.now()}@example.com`;
    cForm.elements.phone.value = '+1 555 4444';
    cForm.elements.message.value = 'Automated verification of the website contact form.';
    cForm.dispatchEvent(new cw.Event('submit', { bubbles: true, cancelable: true }));
    const stored = await until(async () => (await prisma.contactMessage.count()) > beforeMessages);
    record(stored, 'Contact form submission reaches the admin inbox',
      stored ? '' : `feedback: ${cw.document.querySelector('.form-feedback')?.textContent || 'none'} | alert: ${cw.__alert || 'none'}`);
    if (stored) {
      const latest = await prisma.contactMessage.findFirst({ orderBy: { createdAt: 'desc' } });
      record(latest?.body?.includes('Service Type: Air Conditioning Repair / Installation'), 'Contact Service Type is preserved in the admin message');
    }
    record(!!cw.document.querySelector('.form-feedback'), 'Contact form shows confirmation feedback');
  }
  contactDom.window.close();

  // ---------- booking form
  const beforeBookings = await prisma.booking.count();
  const bookingDom = await loadPage('booking.html', base, vc);
  const bw = bookingDom.window;
  const bForm = bw.document.getElementById('bookingForm');
  record(!!bForm, 'Booking page exposes the booking form');
  if (bForm) {
    bForm.elements.name.value = 'Integration Booker';
    bForm.elements.email.value = `site.booking.${Date.now()}@example.com`;
    bForm.elements.phone.value = '+1 555 5555';
    bForm.elements.address.value = '12 Test Street';
    bForm.elements.service_type.value = 'ac-repair';
    bForm.elements.date.value = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    bForm.elements.time.value = 'morning';
    bForm.elements.message.value = 'Automated verification of the website booking form.';
    bForm.dispatchEvent(new bw.Event('submit', { bubbles: true, cancelable: true }));
    const stored = await until(async () => (await prisma.booking.count()) > beforeBookings);
    record(stored, 'Booking form submission creates a pending booking');
    if (stored) {
      const latest = await prisma.booking.findFirst({ orderBy: { createdAt: 'desc' }, include: { customer: true } });
      record(latest.status === 'PENDING', 'Website bookings arrive with PENDING status');
      record(!!latest.customer?.email, 'Website bookings create or link a customer record');
    }
  }
  bookingDom.window.close();

  // ---------- quote form
  const beforeQuotes = await prisma.contactMessage.count();
  const quoteDom = await loadPage('quote-request.html', base, vc);
  const qw = quoteDom.window;
  const qForm = qw.document.getElementById('quoteForm');
  record(!!qForm, 'Quote page exposes the quote form');
  record(typeof qw.CoolAirSubmitQuote === 'function', 'Quote form is wired to the backend helper');
  if (qForm && qw.CoolAirSubmitQuote) {
    const set = (id, v) => { const n = qw.document.getElementById(id); if (n) n.value = v; };
    set('quoteName', 'Integration Quoter');
    set('quotePhone', '+1 555 6666');
    set('quoteEmail', `site.quote.${Date.now()}@example.com`);
    set('quoteService', qw.document.getElementById('quoteService')?.options[1]?.value || 'installation');
    set('quoteMessage', 'Automated verification of the website quote form.');
    qForm.dispatchEvent(new qw.Event('submit', { bubbles: true, cancelable: true }));
    const stored = await until(async () => (await prisma.contactMessage.count()) > beforeQuotes);
    record(stored, 'Quote request submission reaches the admin inbox',
      stored ? '' : `alert: ${qw.__alert || 'none'}`);
  }
  quoteDom.window.close();

  // ---------- storefront checkout (real order through the payment API)
  {
    const feed = await (await fetch(`${base}/api/public/products?limit=1`)).json();
    const product = feed.data && feed.data[0];
    if (product) {
      const email = `site.checkout.${Date.now()}@example.com`;
      const coDom = await loadPage('checkout.html', base, vc, (win) => {
        win.localStorage.setItem('cart', JSON.stringify([{ id: product.id, name: product.name, price: product.price, quantity: 2 }]));
      });
      const cow = coDom.window;
      const coForm = cow.document.getElementById('checkoutForm');
      record(!!coForm, 'Checkout page exposes the checkout form');
      const methodsRendered = await until(() => cow.document.querySelectorAll('#paymentMethods input[name="payment"]').length >= 2);
      record(methodsRendered, 'Checkout page renders payment methods from settings',
        methodsRendered ? '' : 'no payment radios appeared');
      const beforeOrders = await prisma.order.count();
      if (coForm && methodsRendered) {
        cow.document.getElementById('fullName').value = 'Site Checkout Tester';
        cow.document.getElementById('email').value = email;
        cow.document.getElementById('phone').value = '+1 555 7777';
        cow.document.getElementById('address').value = '5 Checkout Lane';
        cow.document.getElementById('city').value = 'Springfield';
        const bankRadio = [...cow.document.querySelectorAll('#paymentMethods input[name="payment"]')]
          .find((r) => r.value === 'BANK_TRANSFER');
        if (bankRadio) bankRadio.checked = true;
        coForm.dispatchEvent(new cow.Event('submit', { bubbles: true, cancelable: true }));
        const placed = await until(async () => Boolean(
          await prisma.order.findFirst({ where: { customer: { email } } })
        ));
        record(placed, 'Checkout form submission creates a real order');
        if (placed) {
          const order = await prisma.order.findFirst({ where: { customer: { email } }, include: { items: true } });
          record(order.paymentMethod === 'BANK_TRANSFER', 'Checkout order records the selected payment method');
          record(order.paymentStatus === 'PENDING', 'Bank-transfer order stays pending until captured');
          record(order.items.length === 1 && order.items[0].quantity === 2, 'Checkout order line items match the cart');
          const resultVisible = await until(() => cow.document.getElementById('checkoutResult').style.display === 'block');
          record(resultVisible, 'Checkout shows the post-order confirmation panel');
        }
        record((await prisma.order.count()) > beforeOrders, 'Checkout order lands in the admin order list');
      }
      coDom.window.close();
    }
  }

  // ---------- Website Content Manager dynamic integration
  const scDom = await loadPage('index.html', base, vc);
  const scWin = scDom.window;
  record(typeof scWin.CoolAirContent === 'object', 'Homepage loads the site content loader');
  const heroTitle = scWin.document.querySelector('[data-content="homepage.hero.title"]');
  record(!!heroTitle && heroTitle.textContent.trim().length > 10, 'Homepage hero title is wired to dynamic content',
    heroTitle ? heroTitle.textContent.trim() : 'missing element');
  const svcList = scWin.document.querySelector('[data-content-list="services"]');
  record(!!svcList && svcList.querySelectorAll('.service-card').length >= 4, 'Homepage services render from published content',
    svcList ? `${svcList.querySelectorAll('.service-card').length} cards` : 'missing');
  const emergency = scWin.document.querySelector('[data-emergency-banner]');
  record(!!emergency && emergency.hidden === false, 'Emergency banner is shown when published/enabled');
  const footAbout = scWin.document.querySelector('[data-footer-about]');
  record(!!footAbout && footAbout.textContent.trim().length > 20, 'Footer about text is dynamic');
  scDom.window.close();

  // ---------- public catalogue API used by the storefront
  const cat = await (await fetch(`${base}/api/public/categories`)).json();
  record(cat.data.length >= 10, 'Public catalogue exposes all product categories', `${cat.data.length}`);
  const prods = await (await fetch(`${base}/api/public/products?limit=6&featured=true`)).json();
  record(Array.isArray(prods.data), 'Public products endpoint returns the storefront feed');
  const settings = await (await fetch(`${base}/api/public/settings`)).json();
  record(!!settings.data.company.name && !settings.data.payment, 'Public settings expose business info without secrets');

  record(errors.length === 0, 'No page script errors on the public website', errors.slice(0, 2).join(' | '));

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nPublic website verification\n===========================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
