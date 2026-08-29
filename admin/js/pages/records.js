import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, emptyState, skeletonRows } from '../ui.js';

function value(row, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let v = row;
    for (const p of parts) v = v?.[p];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '—';
}

export async function renderRecords(view, config) {
  setTitle(config.title);
  view.innerHTML = `<div class="page-head"><div><h1>${esc(config.title)}</h1><p>${esc(config.description)}</p></div></div><section class="card"><div class="table-wrap"><table class="data"><thead><tr>${config.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody id="recordRows">${skeletonRows(6)}</tbody></table></div></section>`;
  const rows = qs('#recordRows', view);
  try {
    const response = await api.get(config.endpoint);
    const data = Array.isArray(response?.data) ? response.data : (Array.isArray(response) ? response : []);
    rows.innerHTML = data.length ? data.map(item => `<tr>${config.columns.map(c => `<td>${esc(String(value(item, c.keys)))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${config.columns.length}">${emptyState(config.empty)}</td></tr>`;
  } catch (error) {
    rows.innerHTML = `<tr><td colspan="${config.columns.length}">${emptyState(`Could not load ${config.title.toLowerCase()}: ${error.message}`)}</td></tr>`;
  }
}
