/* Financial Management — money in, money out, refunds, balances and net cash movement (TTD). */
import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, qsa, el, esc, icon, num, date, titleCase, emptyState, skeletonRows, pagination, modal, confirmDialog, toast, toastError, barChart, donutChart } from '../ui.js';

const ttd = (v) => { const n = Number(v || 0); return `${n < 0 ? '-' : ''}TT$${new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n))}`; };
const shortTtd = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
// "Today" in Trinidad (UTC-4, no DST) so date inputs default to the right calendar day.
const todayLocal = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
const METHOD_LABEL = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', CARD: 'Card', PAYPAL: 'PayPal', STRIPE: 'Stripe', WIPAY: 'WiPay', TILOPAY: 'Tilopay', OTHER: 'Other' };
const methodLabel = (m) => METHOD_LABEL[m] || titleCase(m);
const badge = (tone, label) => `<span class="badge badge--${tone}">${esc(label)}</span>`;

export async function render(view) {
  setTitle('Financial Management');
  const state = { period: 'month', from: '', to: '', tab: 'transactions', txPage: 1, exPage: 1, txType: '', txMethod: '', txSearch: '', exCategory: '', exSearch: '', meta: null };
  const range = () => (state.period === 'custom' ? { period: 'custom', from: state.from, to: state.to } : { period: state.period });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Financial Management</h1><p>Money received, expenses, refunds and what customers still owe — all in TTD, by actual payment date.</p></div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="addExpense">${icon('plus')} Add expense</button>
        <button class="btn btn--primary" id="addPayment">${icon('plus')} Record payment</button>
      </div>
    </div>
    <section class="card" style="margin-bottom:16px"><div class="toolbar">
      <label class="sr-only" for="period">Reporting period</label>
      <select id="period"><option value="today">Today</option><option value="week">This week</option><option value="month" selected>This month</option><option value="last_month">Last month</option><option value="year">This year</option><option value="custom">Custom range</option></select>
      <span id="customRange" hidden style="display:none;gap:9px;align-items:center"><label class="sr-only" for="from">From</label><input type="date" id="from"><span>to</span><label class="sr-only" for="to">To</label><input type="date" id="to"></span>
      <span class="hint" id="periodHint" style="color:var(--text-muted);font-size:12px"></span>
    </div></section>
    <div id="warnings"></div>
    <div class="grid grid--stats" id="stats">${'<div class="skeleton" style="height:92px"></div>'.repeat(6)}</div>
    <div class="grid grid--2" style="margin-top:16px">
      <section class="card span-2"><div class="card__head"><h2>Monthly income vs expenses</h2></div><div class="card__body"><div class="chart-box" id="monthlyChart"></div><div id="monthlyLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Received by payment method</h2></div><div class="card__body"><div class="chart-box chart-box--sm" id="methodChart"></div><div id="methodLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Expenses by category</h2></div><div class="card__body"><div class="chart-box chart-box--sm" id="categoryChart"></div><div id="categoryLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Revenue by type</h2></div><div class="card__body card__body--flush" id="splitTable"></div></section>
      <section class="card"><div class="card__head"><h2>Revenue by service (jobs)</h2></div><div class="card__body card__body--flush" id="serviceTable"></div></section>
    </div>
    <section class="card" style="margin-top:16px">
      <div class="toolbar" role="tablist" aria-label="Finance records">
        <button class="btn btn--sm" role="tab" data-tab="transactions">Transactions</button>
        <button class="btn btn--sm btn--ghost" role="tab" data-tab="expenses">Expenses</button>
        <button class="btn btn--sm btn--ghost" role="tab" data-tab="outstanding">Outstanding</button>
        <span style="flex:1"></span><button class="btn btn--sm btn--ghost" id="exportCsv">${icon('download')} Export CSV</button>
      </div>
      <div id="panel"></div>
    </section>`;

  const periodSel = qs('#period', view);
  const customWrap = qs('#customRange', view);
  const syncTabs = () => qsa('[data-tab]', view).forEach((b) => b.classList.toggle('btn--ghost', b.dataset.tab !== state.tab));

  /* ------------------------------------------------------------ summary */
  async function loadSummary() {
    if (state.period === 'custom' && (!state.from || !state.to)) return;
    try {
      const { data: s } = await api.get('/finance/summary', range());
      qs('#periodHint', view).textContent = `${s.period.label} · ${s.period.timezone}`;
      qs('#warnings', view).innerHTML = s.warnings.map((w) => `<div class="card" role="alert" style="margin-bottom:10px;border-left:4px solid var(--warning)"><div class="card__body" style="padding:10px 14px">${icon('alert')} ${esc(w.message)}</div></div>`).join('');
      const t = s.totals;
      const card = (label, value, tone, meta) => `<article class="stat"><div class="stat__top"><div class="stat__icon ${tone}">${icon('money')}</div><div><div class="stat__label">${esc(label)}</div><div class="stat__value">${esc(ttd(value))}</div></div></div><div class="stat__meta">${esc(meta)}</div></article>`;
      qs('#stats', view).innerHTML = [
        card('Money received', t.received, 'i-success', `${num(t.transactionCount)} recorded transaction(s)`),
        card('Refunds', t.refunds, 'i-danger', 'Returned to customers'),
        card('Net receipts', t.netReceipts, 'i-brand', 'Received − refunds'),
        card('Expenses', t.expenses, 'i-warning', `${num(t.expenseCount)} expense(s)`),
        card('Net cash movement', t.netCashMovement, Number(t.netCashMovement) >= 0 ? 'i-success' : 'i-danger', 'Net receipts − expenses'),
        card('Outstanding', s.outstanding.total, 'i-info', `${s.outstanding.invoices.count} invoice(s) · ${s.outstanding.jobs.count} job(s) · ${s.outstanding.orders.count} order(s)`),
      ].join('');
      const months = s.monthly;
      qs('#monthlyLegend', view).innerHTML = barChart(qs('#monthlyChart', view), { labels: months.map((m) => m.label), series: [{ name: 'Net receipts', values: months.map((m) => Math.max(0, Number(m.received) - Number(m.refunds))) }, { name: 'Expenses', values: months.map((m) => Number(m.expenses)) }], formatter: shortTtd }) || '';
      const donut = (host, legend, rows, label, value) => {
        if (!rows.length) { qs(host, view).innerHTML = emptyState('No data', 'Nothing recorded in this period.'); qs(legend, view).innerHTML = ''; return; }
        qs(legend, view).innerHTML = donutChart(qs(host, view), rows.map((r) => ({ label: label(r), value: Number(value(r)) })), ttd) || '';
      };
      donut('#methodChart', '#methodLegend', s.byMethod.filter((m) => Number(m.net) > 0), (m) => methodLabel(m.method), (m) => m.net);
      donut('#categoryChart', '#categoryLegend', s.expenseByCategory, (c) => c.label, (c) => c.total);
      const simple = (rows, name, val) => (rows.length ? `<table class="data"><tbody>${rows.map((r) => `<tr><td>${esc(name(r))}</td><td style="text-align:right">${esc(ttd(val(r)))}</td></tr>`).join('')}</tbody></table>` : emptyState('No data', 'Nothing recorded in this period.'));
      qs('#splitTable', view).innerHTML = simple([{ n: 'Products (POS + online orders)', v: s.revenueSplit.product }, { n: 'Services (invoices + jobs)', v: s.revenueSplit.service }, { n: 'Other / manual', v: s.revenueSplit.other }], (r) => r.n, (r) => r.v);
      qs('#serviceTable', view).innerHTML = simple(s.byService, (r) => r.name, (r) => r.received);
    } catch (e) { toastError(e); }
  }

  /* ------------------------------------------------------------ panels */
  const panel = qs('#panel', view);
  async function loadPanel() {
    syncTabs();
    if (state.tab === 'transactions') return loadTransactions();
    if (state.tab === 'expenses') return loadExpenses();
    return loadOutstanding();
  }

  async function loadTransactions() {
    panel.innerHTML = `<div class="toolbar"><select id="txType"><option value="">All types</option><option value="PAYMENT">Payments</option><option value="REFUND">Refunds</option></select>
      <select id="txMethod"><option value="">All methods</option>${Object.entries(METHOD_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input class="toolbar__search" id="txSearch" type="search" placeholder="Search reference or notes…" value="${esc(state.txSearch)}"></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Method</th><th>Source</th><th style="text-align:right">Amount</th><th>Status</th><th></th></tr></thead><tbody id="rows">${skeletonRows(8)}</tbody></table></div><div id="pager"></div>`;
    qs('#txType', panel).value = state.txType; qs('#txMethod', panel).value = state.txMethod;
    const rows = qs('#rows', panel);
    try {
      const r = await api.get('/finance/transactions', { ...range(), page: state.txPage, limit: 15, type: state.txType, method: state.txMethod, search: state.txSearch });
      rows.innerHTML = r.data.length ? r.data.map((t) => `<tr${t.status === 'VOIDED' ? ' style="opacity:.55"' : ''}>
        <td>${esc(date(t.paidAt))}${t.estimatedDate ? ' <span title="Estimated date (backfilled)">≈</span>' : ''}</td><td><code>${esc(t.reference)}</code>${t.notes ? `<div class="hint" style="font-size:11.5px;color:var(--text-muted)">${esc(t.notes)}</div>` : ''}</td>
        <td>${badge(t.type === 'REFUND' ? 'danger' : 'success', t.type === 'REFUND' ? 'Refund' : titleCase(t.kind))}</td><td>${esc(methodLabel(t.method))}</td><td>${esc(titleCase(t.sourceLabel))}</td>
        <td style="text-align:right;white-space:nowrap">${t.type === 'REFUND' ? '−' : ''}${esc(ttd(t.amount))}</td><td>${badge(t.status === 'VOIDED' ? 'muted' : 'success', titleCase(t.status))}</td>
        <td style="white-space:nowrap">${t.status === 'RECORDED' && t.type === 'PAYMENT' ? `<button class="btn btn--ghost btn--sm" data-refund="${esc(t.id)}" data-amount="${esc(t.amount)}">Refund</button> ` : ''}${t.status === 'RECORDED' ? `<button class="btn btn--ghost btn--sm" data-void="${esc(t.id)}">Void</button>` : ''}</td></tr>`).join('')
        : `<tr><td colspan="8">${emptyState('No transactions', 'Record a payment, or complete a POS sale or online order.')}</td></tr>`;
      qs('#pager', panel).replaceChildren(pagination(r.meta, (p) => { state.txPage = p; loadTransactions(); }));
    } catch (e) { rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load transactions', e.message)}</td></tr>`; }
  }

  async function loadExpenses() {
    panel.innerHTML = `<div class="toolbar"><select id="exCategory"><option value="">All categories</option>${state.meta.expenseCategories.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select>
      <input class="toolbar__search" id="exSearch" type="search" placeholder="Search description, payee, reference…" value="${esc(state.exSearch)}"><span id="exTotal" style="margin-left:auto;font-weight:650"></span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Payee</th><th>Method</th><th style="text-align:right">Amount</th><th>Receipt</th><th></th></tr></thead><tbody id="rows">${skeletonRows(8)}</tbody></table></div><div id="pager"></div>`;
    qs('#exCategory', panel).value = state.exCategory;
    const rows = qs('#rows', panel);
    try {
      const r = await api.get('/finance/expenses', { ...range(), page: state.exPage, limit: 15, category: state.exCategory, search: state.exSearch });
      qs('#exTotal', panel).textContent = `Total: ${ttd(r.meta.totalAmount)}`;
      const label = Object.fromEntries(state.meta.expenseCategories.map((c) => [c.key, c.label]));
      rows.innerHTML = r.data.length ? r.data.map((e) => `<tr><td>${esc(date(e.expenseDate))}</td><td>${esc(label[e.category] || e.category)}</td><td>${esc(e.description)}${e.referenceNumber ? `<div class="hint" style="font-size:11.5px;color:var(--text-muted)">Ref ${esc(e.referenceNumber)}</div>` : ''}</td>
        <td>${esc(e.payee || '—')}</td><td>${esc(methodLabel(e.method))}</td><td style="text-align:right;white-space:nowrap">${esc(ttd(e.amount))}</td>
        <td>${e.hasReceipt ? `<button class="btn btn--ghost btn--sm" data-receipt="${esc(e.id)}">View</button>` : '—'}</td>
        <td style="white-space:nowrap"><button class="btn btn--ghost btn--sm" data-edit="${esc(e.id)}">Edit</button> <button class="btn btn--ghost btn--sm" data-del="${esc(e.id)}">Delete</button></td></tr>`).join('')
        : `<tr><td colspan="8">${emptyState('No expenses', 'Add an expense to start tracking money out.')}</td></tr>`;
      panel._expenses = new Map(r.data.map((e) => [e.id, e]));
      qs('#pager', panel).replaceChildren(pagination(r.meta, (p) => { state.exPage = p; loadExpenses(); }));
    } catch (e) { rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load expenses', e.message)}</td></tr>`; }
  }

  async function loadOutstanding() {
    panel.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Type</th><th>Reference</th><th>Customer</th><th style="text-align:right">Total</th><th style="text-align:right">Paid</th><th style="text-align:right">Balance</th><th>Status</th></tr></thead><tbody id="rows">${skeletonRows(7)}</tbody></table></div>
      <p class="hint" style="padding:10px 16px;color:var(--text-muted);font-size:12px">Job value is not money received. A job appears here only after a deposit or part-payment is recorded against it; invoices and unpaid online orders appear in full.</p>`;
    try {
      const { data } = await api.get('/finance/outstanding');
      qs('#rows', panel).innerHTML = data.items.length ? data.items.map((i) => `<tr><td>${esc(titleCase(i.kind))}</td><td><code>${esc(i.reference)}</code></td><td>${esc(i.customer || '—')}</td><td style="text-align:right">${esc(ttd(i.total))}</td><td style="text-align:right">${esc(ttd(i.paid))}</td><td style="text-align:right;font-weight:650">${esc(ttd(i.balance))}</td><td>${esc(titleCase(i.status))}</td></tr>`).join('')
        : `<tr><td colspan="7">${emptyState('Nothing outstanding', 'Every invoice and recorded job is settled.')}</td></tr>`;
    } catch (e) { qs('#rows', panel).innerHTML = `<tr><td colspan="7">${emptyState('Could not load balances', e.message)}</td></tr>`; }
  }

  /* ------------------------------------------------------------ forms */
  const field = (label, control, hint) => `<div class="field"><label>${esc(label)}</label>${control}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
  const methodSelect = (v) => `<select name="method" required>${Object.entries(METHOD_LABEL).map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const formBody = (form) => { const d = {}; for (const [k, v] of new FormData(form)) if (v !== '') d[k] = v; return d; };
  const submitting = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toastError(e); } finally { btn.disabled = false; } };

  async function paymentModal() {
    let balances = [], jobs = [];
    try { balances = (await api.get('/finance/outstanding')).data.items.filter((i) => i.kind === 'INVOICE'); } catch { /* optional */ }
    try { jobs = (await api.get('/bookings', { limit: 100 })).data.filter((b) => b.status !== 'CANCELLED'); } catch { /* optional */ }
    modal({
      title: 'Record payment', size: 'md',
      body: `<form id="payForm" class="grid grid--form">
        ${field('Amount (TTD)', '<input name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal">')}
        ${field('Payment method', methodSelect('CASH'))}
        ${field('Payment date', `<input name="paidAt" type="date" required value="${todayLocal()}" max="${todayLocal()}">`)}
        ${field('Type', '<select name="kind"><option value="">Auto (full / deposit / partial)</option><option value="FULL">Full payment</option><option value="DEPOSIT">Deposit</option><option value="PARTIAL">Partial payment</option></select>')}
        ${field('Invoice', `<select name="invoiceId"><option value="">— none —</option>${balances.map((i) => `<option value="${esc(i.id)}">${esc(i.reference)} · ${esc(i.customer || '')} · owes ${esc(ttd(i.balance))}</option>`).join('')}</select>`, 'Payments cannot exceed the balance.')}
        ${field('Job / booking', `<select name="bookingId"><option value="">— none —</option>${jobs.map((b) => `<option value="${esc(b.id)}">${esc(b.reference)} · ${esc(b.customer?.name || '')} · job value ${esc(ttd(b.price))}</option>`).join('')}</select>`, 'Link a deposit to a job to track what is still owed.')}
        ${field('Reference', '<input name="reference" maxlength="120" placeholder="Bank ref / receipt no.">', 'Each reference can only be used once.')}
        ${field('Notes', '<input name="notes" maxlength="1000">')}</form>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" data-save>Save payment</button>',
      onMount: ({ root, close }) => qs('[data-save]', root).addEventListener('click', (ev) => {
        const form = qs('#payForm', root); if (!form.reportValidity()) return;
        submitting(ev.currentTarget, async () => { await api.post('/finance/transactions', formBody(form)); toast('Payment recorded'); close(); refresh(); });
      }),
    });
  }

  function refundModal(id, amount) {
    modal({
      title: 'Refund payment', size: 'sm',
      body: `<form id="refForm">${field('Refund amount (TTD)', `<input name="amount" type="number" min="0.01" step="0.01" max="${esc(amount)}" value="${esc(amount)}" required>`, 'Up to the amount still refundable.')}${field('Refund date', `<input name="paidAt" type="date" required value="${todayLocal()}" max="${todayLocal()}">`)}${field('Notes', '<input name="notes" maxlength="1000">')}</form>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--danger" data-save>Record refund</button>',
      onMount: ({ root, close }) => qs('[data-save]', root).addEventListener('click', (ev) => {
        const form = qs('#refForm', root); if (!form.reportValidity()) return;
        submitting(ev.currentTarget, async () => { await api.post('/finance/transactions', { ...formBody(form), type: 'REFUND', relatedTransactionId: id }); toast('Refund recorded'); close(); refresh(); });
      }),
    });
  }

  function expenseModal(existing) {
    const e = existing || {};
    modal({
      title: existing ? 'Edit expense' : 'Add expense', size: 'md',
      body: `<form id="exForm" class="grid grid--form">
        ${field('Category', `<select name="category" required>${state.meta.expenseCategories.map((c) => `<option value="${esc(c.key)}"${c.key === e.category ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`)}
        ${field('Amount (TTD)', `<input name="amount" type="number" min="0.01" step="0.01" required value="${esc(e.amount || '')}">`)}
        ${field('Date', `<input name="expenseDate" type="date" required max="${todayLocal()}" value="${esc(e.expenseDate ? String(e.expenseDate).slice(0, 10) : todayLocal())}">`)}
        ${field('Payment method', methodSelect(e.method || 'CASH'))}
        ${field('Description', `<input name="description" required maxlength="300" value="${esc(e.description || '')}">`)}
        ${field('Supplier / payee', `<input name="payee" maxlength="160" value="${esc(e.payee || '')}">`)}
        ${field('Reference number', `<input name="referenceNumber" maxlength="120" value="${esc(e.referenceNumber || '')}">`)}
        ${field('Receipt', '<input name="receipt" type="file" accept="application/pdf,image/jpeg,image/png,image/webp">', 'PDF, JPG, PNG or WebP up to 5MB. Stored privately.')}</form>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" data-save>Save expense</button>',
      onMount: ({ root, close }) => qs('[data-save]', root).addEventListener('click', (ev) => {
        const form = qs('#exForm', root); if (!form.reportValidity()) return;
        submitting(ev.currentTarget, async () => {
          const body = formBody(form); delete body.receipt;
          const saved = existing ? await api.put(`/finance/expenses/${existing.id}`, body) : await api.post('/finance/expenses', body);
          const file = form.elements.receipt.files[0];
          if (file) {
            try { const fd = new FormData(); fd.append('file', file); await api.upload(`/finance/expenses/${saved.data.id}/receipt`, fd); }
            catch (err) { toast(`Expense saved, but the receipt was not uploaded: ${err.message}`, 'error'); close(); return refresh(); }
          }
          toast('Expense saved'); close(); refresh();
        });
      }),
    });
  }

  /* ------------------------------------------------------------ events */
  const refresh = () => { loadSummary(); loadPanel(); };
  periodSel.addEventListener('change', () => {
    state.period = periodSel.value; state.txPage = state.exPage = 1;
    const custom = state.period === 'custom'; customWrap.hidden = !custom; customWrap.style.display = custom ? 'inline-flex' : 'none';
    if (!custom) refresh();
  });
  for (const k of ['from', 'to']) qs(`#${k}`, view).addEventListener('change', (ev) => { state[k] = ev.target.value; if (state.from && state.to) refresh(); });
  qs('#addPayment', view).addEventListener('click', paymentModal);
  qs('#addExpense', view).addEventListener('click', () => expenseModal(null));
  view.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab; return loadPanel(); }
    if (t.id === 'exportCsv') {
      if (state.tab === 'outstanding') return toast('Outstanding balances have no CSV export');
      return api.download(`/finance/${state.tab}`, { ...range(), format: 'csv', type: state.txType, method: state.txMethod, category: state.exCategory }, `${state.tab}.csv`).catch(toastError);
    }
    if (t.dataset.refund) return refundModal(t.dataset.refund, t.dataset.amount);
    if (t.dataset.void) {
      const reason = prompt('Why is this transaction being voided? (kept in the audit history)');
      if (!reason || reason.trim().length < 3) return;
      return api.post(`/finance/transactions/${t.dataset.void}/void`, { reason: reason.trim() }).then(() => { toast('Transaction voided'); refresh(); }).catch(toastError);
    }
    if (t.dataset.edit) return expenseModal(panel._expenses?.get(t.dataset.edit));
    if (t.dataset.del && await confirmDialog({ title: 'Delete expense?', message: 'It stops counting in reports but stays in the audit history.', confirmLabel: 'Delete' })) {
      return api.del(`/finance/expenses/${t.dataset.del}`).then(() => { toast('Expense deleted'); refresh(); }).catch(toastError);
    }
    if (t.dataset.receipt) return api.get(`/finance/expenses/${t.dataset.receipt}/receipt`).then((r) => window.open(r.data.url, '_blank', 'noopener')).catch(toastError);
  });
  panel.addEventListener('change', (ev) => {
    const map = { txType: 'txType', txMethod: 'txMethod', exCategory: 'exCategory' };
    if (map[ev.target.id]) { state[map[ev.target.id]] = ev.target.value; state.txPage = state.exPage = 1; loadPanel(); }
  });
  let timer; panel.addEventListener('input', (ev) => {
    if (ev.target.id !== 'txSearch' && ev.target.id !== 'exSearch') return;
    clearTimeout(timer); timer = setTimeout(() => { state[ev.target.id] = ev.target.value; state.txPage = state.exPage = 1; loadPanel(); }, 320);
  });

  try { state.meta = (await api.get('/finance/meta')).data; } catch (e) { toastError(e); view.querySelector('#stats').innerHTML = emptyState('Financial Management is unavailable', e.message); return; }
  refresh();
}
