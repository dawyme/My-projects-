/**
 * Shared chrome for the Supplier Marketplace section.
 *
 * Every marketplace page renders the same in-section tab bar, so the section
 * reads as one cohesive area of the dashboard with its own navigation rather
 * than ten unrelated screens.
 */
import { esc } from '../ui.js';

export const SECTION_LINKS = [
  { path: '/supplier-marketplace', label: 'Dashboard' },
  { path: '/suppliers', label: 'Suppliers' },
  { path: '/supplier-integrations', label: 'Integrations' },
  { path: '/supplier-imports', label: 'Import Products' },
  { path: '/supplier-products', label: 'Supplier Products' },
  { path: '/supplier-fulfillment', label: 'Fulfillment' },
  { path: '/supplier-shipping', label: 'Shipping' },
  { path: '/supplier-sync', label: 'Sync & Automation' },
  { path: '/supplier-logs', label: 'Sync Logs' },
  { path: '/supplier-settings', label: 'Settings' },
];

export function sectionNav(active) {
  return `<nav class="tabs tabs--scroll" aria-label="Supplier Marketplace sections">${SECTION_LINKS.map((l) => `
    <a class="tab ${l.path === active ? 'is-active' : ''}" href="#${l.path}"
       ${l.path === active ? 'aria-current="page"' : ''}>${esc(l.label)}</a>`).join('')}</nav>`;
}

export function sectionHead({ title, subtitle = '', actions = '', active }) {
  return `
    ${sectionNav(active)}
    <div class="page-head">
      <div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
      ${actions ? `<div class="page-head__actions">${actions}</div>` : ''}
    </div>`;
}

/** Compact key/value strip used across the marketplace pages. */
export function kvList(pairs) {
  return `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `
    <dt>${esc(k)}</dt><dd>${v === undefined || v === null || v === '' ? '—' : v}</dd>`).join('')}</dl>`;
}

/** A masked-secret row: shows that something is stored, never what it is. */
export function credentialRow(field) {
  return `<div class="cell-flex">
    <div><div class="cell-main">${esc(field.name)}</div>
    <div class="cell-sub"><code>${esc(field.fingerprint || '••••')}</code>${field.updatedAt ? ` · set ${new Date(field.updatedAt).toLocaleDateString()}` : ''}</div></div>
    <span class="badge badge--success">Stored</span></div>`;
}
