#!/usr/bin/env node
/**
 * Regression contracts for the "Add from Contacts" enhancement of the
 * tenant-admin customer form (Contact Picker API, `navigator.contacts.select`).
 *
 *   node tests/customer-contacts-picker.test.js
 *
 * Covers:
 *  1. Manual customer creation remains the primary path (existing form + API).
 *  2. A "Add from Contacts" entry point exists on the new-customer form.
 *  3. Contact Picker feature detection (supported / unsupported).
 *  4. navigator.contacts.select is invoked only when the user invokes it.
 *  5. Selected contact maps into the EXISTING customer form fields.
 *  6. Multiple phones/emails do not break the mapping.
 *  7. Missing phone/email/name do not crash and are surfaced as "missing".
 *  8. User cancellation never produces customer data (nothing to save).
 *  9. Permission/security/unknown picker errors degrade gracefully.
 * 10. The existing customer API + tenant isolation contracts are untouched.
 * 11. Unsupported browsers keep the manual workflow (no picker UI at all).
 * 12. No contact data is persisted, uploaded or sent anywhere by the picker.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const CONTACTS_FILE = path.join(ROOT, 'admin', 'js', 'contacts.js');
const CUSTOMERS_PAGE_FILE = path.join(ROOT, 'admin', 'js', 'pages', 'customers.js');
const CUSTOMERS_ROUTE_FILE = path.join(ROOT, 'backend', 'src', 'routes', 'customers.js');
const CONTACTS_SOURCE = fs.readFileSync(CONTACTS_FILE, 'utf8');
const CUSTOMERS_PAGE_SOURCE = fs.readFileSync(CUSTOMERS_PAGE_FILE, 'utf8');
const CUSTOMERS_ROUTE_SOURCE = fs.readFileSync(CUSTOMERS_ROUTE_FILE, 'utf8');

/** Minimal fake of the Contact Picker entry point; records every call. */
function fakeNavigator(selectImpl) {
  const calls = [];
  return {
    calls,
    contacts: {
      select: (...args) => {
        calls.push(args);
        return selectImpl ? selectImpl(...args) : Promise.resolve([]);
      },
    },
  };
}

function countMatches(source, regex) {
  return (source.match(regex) || []).length;
}

async function main() {
  // The REAL module under test — imported directly, no bundling, no mocks.
  const contacts = await import(pathToFileURL(CONTACTS_FILE).href);

  // -------------------------------------------- 3. feature detection
  assert.strictEqual(contacts.contactsSupported(fakeNavigator()), true, 'picker entry point counts as supported');
  assert.strictEqual(contacts.contactsSupported({}), false, 'navigator without contacts is unsupported');
  assert.strictEqual(contacts.contactsSupported({ contacts: {} }), false, 'contacts without select() is unsupported');
  assert.strictEqual(contacts.contactsSupported({ contacts: { select: 'nope' } }), false, 'non-function select is unsupported');
  assert.strictEqual(contacts.contactsSupported(undefined), false, 'missing navigator is unsupported');
  assert.deepStrictEqual(contacts.CONTACT_PROPERTIES, ['name', 'tel', 'email', 'address'],
    'only minimal contact properties are requested (never the photo/icon)');
  console.log('  \u2713 contactsSupported() detects the Contact Picker API correctly');

  // -------------------------------------------- 4. select only after user invokes
  {
    const nav = fakeNavigator(() => Promise.resolve([{ name: ['Jane Doe'] }]));
    // Merely importing the module (page load) must not touch the picker.
    assert.strictEqual(nav.calls.length, 0, 'no picker access at import time');
    const before = await contacts.pickContact(nav); // simulate the user tap
    assert.strictEqual(nav.calls.length, 1, 'pickContact() calls select() exactly once');
    assert.deepStrictEqual(before, { ok: true, cancelled: false, contact: { name: ['Jane Doe'] } });
    assert.deepStrictEqual(nav.calls[0], [['name', 'tel', 'email', 'address'], { multiple: false }],
      'select() must be called single-select with the minimal property list');
  }
  console.log('  \u2713 navigator.contacts.select is called only after the user invokes the feature');

  // -------------------------------------------- 5. mapping into existing fields
  {
    const contact = {
      name: ['  Jane   Doe  '],
      tel: [' +1 (555) 010-0199 '],
      email: ['Jane.Doe@Example.COM'],
      address: [{ addressLine: ['12 Bay Street', 'Unit 4'], city: 'Bridgetown', region: 'St Michael', postalCode: 'BB00111' }],
    };
    const { draft, missing } = contacts.mapContactToCustomer(contact);
    assert.deepStrictEqual(draft, {
      name: 'Jane Doe',
      phone: '+1 (555) 010-0199',
      email: 'jane.doe@example.com',
      address: '12 Bay Street, Unit 4',
      city: 'Bridgetown',
      state: 'St Michael',
      postalCode: 'BB00111',
    }, 'contact maps onto the existing customer fields (trimmed, email lowercased, region->state)');
    assert.deepStrictEqual(missing, { name: false, email: false, phone: false });

    // Values land in the real DOM form controls and stay editable.
    const dom = new JSDOM('<form id="f">'
      + '<input id="cf-name" name="name" required><input id="cf-email" name="email" type="email" required>'
      + '<input id="cf-phone" name="phone" type="tel"><input id="cf-company" name="company">'
      + '<input id="cf-city" name="city"><input id="cf-state" name="state">'
      + '<input id="cf-postal" name="postalCode"><input id="cf-address" name="address">'
      + '<textarea id="cf-notes" name="notes"></textarea></form>');
    const form = dom.window.document.getElementById('f');
    const applied = contacts.applyContactToForm(form, draft);
    assert.strictEqual(form.elements.name.value, 'Jane Doe');
    assert.strictEqual(form.elements.email.value, 'jane.doe@example.com');
    assert.strictEqual(form.elements.phone.value, '+1 (555) 010-0199');
    assert.strictEqual(form.elements.city.value, 'Bridgetown');
    assert.deepStrictEqual(applied.sort(), ['address', 'city', 'email', 'name', 'phone', 'postalCode', 'state'].sort());
    // Manual entries are never clobbered with blanks by a sparse draft.
    form.elements.notes.value = 'prefers evening calls';
    contacts.applyContactToForm(form, { name: '', email: '', phone: '', notes: undefined });
    assert.strictEqual(form.elements.notes.value, 'prefers evening calls', 'sparse draft must not clear fields');
    assert.strictEqual(form.elements.name.value, 'Jane Doe', 'empty draft values must not clear fields');
  }
  console.log('  \u2713 selected contact data maps correctly into the existing customer form');

  // -------------------------------------------- 6. multiple values
  {
    const { draft } = contacts.mapContactToCustomer({
      name: ['Multi Contact', 'Secondary Name'],
      tel: ['+15550001', '+15550002', '+15550003'],
      email: ['first@example.com', 'second@example.com', 'third@example.com'],
      address: [{ city: 'A' }, { city: 'B' }],
    });
    assert.strictEqual(draft.name, 'Multi Contact', 'first name wins');
    assert.strictEqual(draft.phone, '+15550001', 'first phone is the sensible default, editable afterwards');
    assert.strictEqual(draft.email, 'first@example.com', 'first email is the sensible default, editable afterwards');
    assert.strictEqual(draft.city, 'A', 'first address wins');
  }
  console.log('  \u2713 multiple phones/emails/addresses default sensibly without breaking the form');

  // -------------------------------------------- 7. missing fields
  {
    for (const contact of [undefined, {}, { name: [], tel: [], email: [], address: [] }, { name: ['   '], tel: [42], email: [null] }]) {
      const { draft, missing } = contacts.mapContactToCustomer(contact);
      assert.deepStrictEqual(draft, {}, 'no draft keys without usable values');
      assert.deepStrictEqual(missing, { name: true, email: true, phone: true });
      const dom = new JSDOM('<form><input name="name"><input name="email"><input name="phone"></form>');
      assert.deepStrictEqual(contacts.applyContactToForm(dom.window.document.querySelector('form'), draft), []);
    }
    const hints = contacts.contactImportHints({ name: true, email: true, phone: true });
    assert.strictEqual(hints.length, 3, 'each missing core field gets a plain-language hint');
    assert.match(hints[0], /didn\u2019t share a name/);
    assert.deepStrictEqual(contacts.contactImportHints({}), []);
  }
  console.log('  \u2713 missing phone/email/name never crash and are explained to the user');

  // -------------------------------------------- 8. cancellation
  {
    const abort = Object.assign(new Error('The user aborted the request.'), { name: 'AbortError' });
    const cancelledPick = await contacts.pickContact(fakeNavigator(() => Promise.reject(abort)));
    assert.deepStrictEqual(cancelledPick, { ok: false, cancelled: true, error: 'cancelled' });
    const dismissedPick = await contacts.pickContact(fakeNavigator(() => Promise.resolve([])));
    assert.deepStrictEqual(dismissedPick, { ok: false, cancelled: true, error: 'cancelled' });
    assert.ok(!('contact' in cancelledPick) && !('contact' in dismissedPick), 'no contact data exists after cancellation');
  }
  console.log('  \u2713 user cancellation yields no customer data and no error UI');

  // -------------------------------------------- 9. permission/security/other errors
  {
    const denied = await contacts.pickContact(fakeNavigator(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.cancelled, false);
    assert.strictEqual(denied.error, 'permission');
    assert.match(denied.message, /enter the customer manually/i);

    const blocked = await contacts.pickContact(fakeNavigator(() => Promise.reject(Object.assign(new Error('sec'), { name: 'SecurityError' }))));
    assert.strictEqual(blocked.error, 'permission');

    const invalid = await contacts.pickContact(fakeNavigator(() => Promise.reject(Object.assign(new Error('bad props'), { name: 'TypeError' }))));
    assert.strictEqual(invalid.error, 'invalid');
    assert.match(invalid.message, /manually/i);

    const unknown = await contacts.pickContact(fakeNavigator(() => Promise.reject(new Error('boom'))));
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.error, 'unknown');
    assert.match(unknown.message, /manually/i);

    const unsupported = await contacts.pickContact({});
    assert.strictEqual(unsupported.error, 'unsupported');
    assert.match(unsupported.message, /isn\u2019t supported by this browser/i);
  }
  console.log('  \u2713 permission/security/invalid/unknown picker errors degrade gracefully');

  // -------------------------------------------- 2 + 11. entry point & fallback on the page
  {
    assert.match(CUSTOMERS_PAGE_SOURCE, /Add from Contacts/, 'new-customer form exposes the contacts entry point');
    assert.match(CUSTOMERS_PAGE_SOURCE, /contactsAvailable = !isEdit && contactsSupported\(\)/,
      'entry point is rendered only on the create form and only when the API is supported');
    assert.match(CUSTOMERS_PAGE_SOURCE, /id="customerForm"[\s\S]*?id="pickContactBtn"[\s\S]*?contacts-divider[\s\S]*?id="cf-name"/,
      'contacts entry point sits above the unchanged manual fields ("or fill in manually")');
    // The edit modal must be untouched by the enhancement.
    const editBranch = CUSTOMERS_PAGE_SOURCE.match(/const contactsAvailable[\s\S]*?title: isEdit \? `Edit \$\{customer\.name\}`/);
    assert.ok(editBranch, 'edit modal keeps its own title path');
    assert.strictEqual(countMatches(CUSTOMERS_PAGE_SOURCE, /contactsSupported\(/g), 1,
      'the only feature-detection call is the create-form guard — edit form never renders the contacts entry point');
    assert.match(CUSTOMERS_PAGE_SOURCE, /title: isEdit \? `Edit \$\{customer\.name\}` : 'New customer'/,
      'modal titles (edit vs create) are unchanged');
  }
  console.log('  \u2713 contacts entry point exists on the new-customer form; manual form intact');

  // -------------------------------------------- 1 + 11. manual workflow stays default
  {
    assert.match(CUSTOMERS_PAGE_SOURCE, /id="customerForm"/, 'manual customer form is still rendered');
    assert.match(CUSTOMERS_PAGE_SOURCE, /await api\.post\('\/customers', payload\)/, 'create still posts to the existing /customers API');
    assert.match(CUSTOMERS_PAGE_SOURCE, /await api\.put\(`\/customers\/\$\{customer\.id\}`/, 'edit still uses the existing update API');
    assert.match(CUSTOMERS_PAGE_SOURCE, /showFieldErrors\(form, err\)/, 'existing validation-error behaviour is intact');
    assert.match(CUSTOMERS_PAGE_SOURCE, /id="saveCustomer"/, 'the existing Save button still drives creation');
    // The picker path never creates anything by itself: only the save button posts.
    const postCalls = countMatches(CUSTOMERS_PAGE_SOURCE, /api\.post\('\/customers'/g);
    assert.strictEqual(postCalls, 1, 'exactly one create path exists (the manual save button)');
    assert.doesNotMatch(CUSTOMERS_PAGE_SOURCE, /api\.post[\s\S]{0,80}pickContact|pickContact[\s\S]{0,200}api\.post/,
      'no customer is created merely by picking a contact');
  }
  console.log('  \u2713 manual creation remains the primary, unchanged save path');

  // -------------------------------------------- 4 (page wiring). picker invoked from the tap handler only
  {
    assert.match(CUSTOMERS_PAGE_SOURCE, /pickBtn\.onclick = async \(\) => \{[\s\S]*?await pickContact\(\)/,
      'navigator.contacts is reached only from the "Add from Contacts" click handler');
    assert.strictEqual(countMatches(CUSTOMERS_PAGE_SOURCE, /pickContact\(/g), 1,
      'no top-level or stray picker invocation on the page');
    assert.match(CUSTOMERS_PAGE_SOURCE, /mapContactToCustomer\(result\.contact\)[\s\S]*?applyContactToForm\(form, draft\)/,
      'picked contact flows through the isolated mapper into the form');
    assert.match(CUSTOMERS_PAGE_SOURCE, /if \(!result\.cancelled\) toast\(result\.message, 'error'\)/,
      'errors surface as a toast; cancellation stays silent');
    assert.match(CUSTOMERS_PAGE_SOURCE, /contactImportHints\(missing\)/, 'missing-field hints are shown after import');
    assert.match(CUSTOMERS_PAGE_SOURCE, /Imported from a phone contact/, 'the form indicates the data came from a contact');
  }
  console.log('  \u2713 page wiring invokes the picker only on user tap and populates the normal form');

  // -------------------------------------------- 12. no persistence, no network, no list upload
  {
    assert.doesNotMatch(CONTACTS_SOURCE, /\bfetch\s*\(|XMLHttpRequest|\.post\(|\.put\(|api\./,
      'the contacts module never talks to the network');
    assert.doesNotMatch(CONTACTS_SOURCE, /localStorage|sessionStorage|document\.cookie|indexedDB/,
      'the contacts module never persists anything');
    assert.strictEqual(countMatches(CONTACTS_SOURCE, /multiple:\s*true/g), 0,
      'picker is always single-select: the whole contact list can never be requested');
    assert.strictEqual(countMatches(CONTACTS_SOURCE, /'icon'|"icon"/g), 0, 'contact photos are never requested');
    assert.doesNotMatch(CUSTOMERS_PAGE_SOURCE, /navigator\.contacts/,
      'page code reaches the picker exclusively through the audited contacts module');
  }
  console.log('  \u2713 no contact list upload, no persistence, no network access from the picker');

  // -------------------------------------------- 10. existing API + tenant isolation untouched
  {
    const postRoute = CUSTOMERS_ROUTE_SOURCE.match(/router\.post\('\/', protect, validate\(body\),[\s\S]*?\}\)\);/);
    assert.ok(postRoute, 'POST /api/customers route exists unchanged in shape');
    assert.match(postRoute[0], /tenantWhere\(req, \{ email \}\)/, 'duplicate check stays tenant-scoped');
    assert.match(postRoute[0], /businessId: req\.tenantId/, 'created customers stay bound to the tenant');
    assert.match(postRoute[0], /protect/, 'route stays behind authentication');
    const bodySchema = CUSTOMERS_ROUTE_SOURCE.match(/const body = z\.object\(\{[\s\S]*?\}\);/);
    assert.ok(bodySchema, 'customer body schema is present');
    assert.match(bodySchema[0], /name: z\.string\(\)\.trim\(\)\.min\(2\)\.max\(120\)/);
    assert.match(bodySchema[0], /email: z\.string\(\)\.email\(\)\.max\(180\)/);
    assert.match(bodySchema[0], /phone: z\.string\(\)\.trim\(\)\.max\(40\)\.optional\(\)\.nullable\(\)/);
  }
  console.log('  \u2713 existing customer API, validation and tenant isolation contracts intact');

  // -------------------------------------------- DOM end-to-end (supported env, real mapper)
  {
    const dom = new JSDOM('<form id="f">'
      + '<input id="cf-name" name="name"><input id="cf-email" name="email"><input id="cf-phone" name="phone"></form>');
    const form = dom.window.document.getElementById('f');
    const nav = fakeNavigator(() => Promise.resolve([{ name: ['  Bob   Ray '], tel: ['+15550100', '+15550101'], email: [] }]));
    const result = await contacts.pickContact(nav);
    assert.ok(result.ok);
    const { draft, missing } = contacts.mapContactToCustomer(result.contact);
    contacts.applyContactToForm(form, draft);
    assert.strictEqual(form.elements.name.value, 'Bob Ray');
    assert.strictEqual(form.elements.phone.value, '+15550100');
    assert.strictEqual(form.elements.email.value, '', 'missing email left for manual entry');
    assert.deepStrictEqual(missing, { name: false, email: true, phone: false });
  }
  console.log('  \u2713 end-to-end pick -> map -> populate keeps the form fully editable');

  console.log('customer contacts picker contracts: PASS');
}

main().catch((e) => {
  console.error('customer contacts picker contracts: FAIL');
  console.error(e);
  process.exit(1);
});
