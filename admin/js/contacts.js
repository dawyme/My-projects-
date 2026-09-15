/**
 * "Add from Contacts" helper for the customer form (Contact Picker API).
 *
 * Thin wrapper around the W3C Contact Picker API (`navigator.contacts.select`),
 * which today is only implemented by Chrome on Android — detection is therefore
 * mandatory and the customer form must stay fully usable without it.
 *
 * Scope rules enforced by this module:
 *  - Contacts are read ONLY after the user taps "Add from Contacts" (the API
 *    itself is user-gesture gated; nothing here runs at import time).
 *  - Nothing is persisted, uploaded or sent anywhere: no fetch, no storage,
 *    no contact list retention. Only the single selected contact is returned
 *    to the caller, which merely fills the existing customer form fields.
 *  - The mapping to customer-form values is isolated in
 *    `mapContactToCustomer()` so it can be regression-tested directly.
 */

/** Properties requested from the picker. Deliberately minimal: no `icon`. */
export const CONTACT_PROPERTIES = ['name', 'tel', 'email', 'address'];

/** Maximum lengths mirror the backend zod schema for POST /api/customers. */
const LIMITS = { name: 120, email: 180, phone: 40, address: 300, city: 80, state: 80, postalCode: 20 };

/**
 * Feature detection. True only when the device/browser actually implements
 * `navigator.contacts.select` (Chrome/Android 80+). Safe to call anywhere —
 * it never touches the network or prompts the user.
 */
export function contactsSupported(nav = globalThis.navigator) {
  return Boolean(nav && nav.contacts && typeof nav.contacts.select === 'function');
}

function collapse(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/** First non-empty string of an array-valued contact property ('' if none). */
export function firstValue(values) {
  if (!Array.isArray(values)) return '';
  for (const v of values) if (typeof v === 'string' && v.trim()) return collapse(v);
  return '';
}

function clip(value, max) {
  const s = collapse(value || '');
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Opens the device contact picker and resolves a result object:
 *   { ok: true, contact }                       — user picked one contact
 *   { ok: false, cancelled: true }              — user dismissed / picked none
 *   { ok: false, error, message }               — failed; message is user-facing
 * Must be called from a user gesture (e.g. a click handler).
 */
export async function pickContact(nav = globalThis.navigator) {
  if (!contactsSupported(nav)) {
    return {
      ok: false, cancelled: false, error: 'unsupported',
      message: 'Contact import isn\u2019t supported by this browser. You can enter the customer manually.',
    };
  }
  let selected;
  try {
    selected = await nav.contacts.select(CONTACT_PROPERTIES, { multiple: false });
  } catch (err) {
    const name = err && err.name;
    if (name === 'AbortError') return { ok: false, cancelled: true, error: 'cancelled' };
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return {
        ok: false, cancelled: false, error: 'permission',
        message: 'Contact access was blocked. Allow contact permission for this site, or enter the customer manually.',
      };
    }
    if (name === 'TypeError' || name === 'InvalidStateError') {
      return {
        ok: false, cancelled: false, error: 'invalid',
        message: 'This device couldn\u2019t open the contact picker. Enter the customer manually.',
      };
    }
    return {
      ok: false, cancelled: false, error: 'unknown',
      message: 'Could not read the selected contact. Enter the customer manually.',
    };
  }
  if (!Array.isArray(selected) || !selected.length) {
    return { ok: false, cancelled: true, error: 'cancelled' };
  }
  return { ok: true, cancelled: false, contact: selected[0] };
}

/**
 * Maps one picked contact (only the fields the browser actually returned)
 * onto the EXISTING customer form fields. Pure function — no DOM, no API.
 * Returns { draft, missing }:
 *   draft   — only keys with a usable value; shaped exactly like the fields
 *             the customer form already submits (name, email, phone, address,
 *             city, state, postalCode). Company is intentionally not mapped:
 *             the picker exposes no organisation field.
 *   missing — which of name/email/phone the contact did not provide, so the
 *             UI can ask the user to complete them.
 */
export function mapContactToCustomer(contact) {
  const draft = {};
  const missing = { name: true, email: true, phone: true };

  const name = clip(firstValue(contact?.name), LIMITS.name);
  if (name) { draft.name = name; missing.name = false; }

  const email = clip(firstValue(contact?.email), LIMITS.email).toLowerCase();
  if (email) { draft.email = email; missing.email = false; }

  const phone = clip(firstValue(contact?.tel), LIMITS.phone);
  if (phone) { draft.phone = phone; missing.phone = false; }

  const addr = Array.isArray(contact?.address) ? contact.address.find(Boolean) : null;
  if (addr && typeof addr === 'object') {
    const street = clip(Array.isArray(addr.addressLine) ? addr.addressLine.filter(Boolean).join(', ') : (addr.street || ''), LIMITS.address);
    const city = clip(addr.city || '', LIMITS.city);
    const state = clip(addr.state ?? addr.region ?? '', LIMITS.state);
    const postalCode = clip(addr.postalCode || '', LIMITS.postalCode);
    if (street) draft.address = street;
    if (city) draft.city = city;
    if (state) draft.state = state;
    if (postalCode) draft.postalCode = postalCode;
  }
  return { draft, missing };
}

/**
 * Fills named form controls from a mapped draft. Only non-empty values are
 * applied (nothing is clobbered with blanks) and every field remains fully
 * editable afterwards. Returns the names of the fields actually filled.
 */
export function applyContactToForm(form, draft) {
  const applied = [];
  for (const [field, value] of Object.entries(draft || {})) {
    const input = form && form.elements ? form.elements[field] : null;
    if (input && typeof value === 'string' && value) {
      input.value = value;
      applied.push(field);
    }
  }
  return applied;
}

/** User-facing notices about what the selected contact did NOT provide. */
export function contactImportHints(missing = {}) {
  const hints = [];
  if (missing.name) hints.push('The contact didn\u2019t share a name — please enter it below before saving.');
  if (missing.email) hints.push('The contact didn\u2019t share an email — it\u2019s required to save this customer.');
  if (missing.phone) hints.push('The contact didn\u2019t share a phone number.');
  return hints;
}
