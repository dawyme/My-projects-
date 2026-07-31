import { api } from '../api.js';
import { setTitle } from '../layout.js';
import {
  el, icon, esc, money, num, trend, dateTime, relative, statusBadge,
  emptyState, lineChart, donutChart, initials, toastError,
} from '../ui.js';

const ACTIVITY_ICONS = {
  booking: ['calendar', 'i-info'], product: ['box', 'i-brand'], inventory: ['layers', 'i-warning'],
  customer: ['users', 'i-purple'], message: ['mail', 'i-info'], order: ['file', 'i-success'], auth: ['shield', 'i-brand'],
};

const statCard = ({ label, value, iconName, tone, meta }) => `
  <article class="stat">
    <div class="stat__top">
      <div class="stat__icon ${tone}">${icon(iconName)}</div>
      <div style="min-width:0">
        <div class="stat__label">${esc(label)}</div>
        <div class="stat__value">${value}</div>
      </div>
    </div>
    <div class="stat__meta">${meta}</div>
  </article>`;

export async function render(view, query) {
  setTitle('Dashboard');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Dashboard</h1>
        <p id="greeting">Business overview at a glance</p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="refreshBtn">${icon('refresh')} Refresh</button>
        <a class="btn btn--primary" href="#/bookings?new=1">${icon('plus')} New booking</a>
      </div>
    </div>
    <div class="grid grid--stats" id="stats"></div>
    <div class="grid grid--2" style="margin-top:16px">
      <section class="card span-2">
        <div class="card__head"><h2>Revenue &amp; bookings trend</h2>
          <div class="card__actions">
            <label for="trendRange" class="sr-only">Trend period</label>
            <select id="trendRange" class="btn--sm" style="width:auto">
              <option value="6">Last 6 months</option><option value="12" selected>Last 12 months</option>
            </select>
          </div></div>
        <div class="card__body"><div class="chart-box" id="trendChart"></div><div id="trendLegend" style="margin-top:10px"></div></div>
      </section>
      <section class="card">
        <div class="card__head"><h2>Bookings by status</h2></div>
        <div class="card__body"><div class="chart-box chart-box--sm" id="statusChart"></div><div id="statusLegend" style="margin-top:10px"></div></div>
      </section>
      <section class="card">
        <div class="card__head"><h2>Low stock alerts</h2>
          <div class="card__actions"><a class="btn btn--ghost btn--sm" href="#/inventory?status=low">View all</a></div></div>
        <div class="card__body card__body--flush"><div id="lowStock"></div></div>
      </section>
      <section class="card">
        <div class="card__head"><h2>Upcoming appointments</h2>
          <div class="card__actions"><a class="btn btn--ghost btn--sm" href="#/bookings">All bookings</a></div></div>
        <div class="card__body card__body--flush"><div id="upcoming"></div></div>
      </section>
      <section class="card">
        <div class="card__head"><h2>Recent activity</h2></div>
        <div class="card__body"><div id="activity"></div></div>
      </section>
    </div>`;

  const load = async () => {
    try {
      const [statsRes, activityRes, upcomingRes, lowStockRes] = await Promise.all([
        api.get('/dashboard/stats'),
        api.get('/dashboard/activity', { limit: 10 }),
        api.get('/dashboard/upcoming'),
        api.get('/dashboard/low-stock'),
      ]);
      renderStats(statsRes.data);
      renderStatusChart(statsRes.data);
      renderActivity(activityRes.data);
      renderUpcoming(upcomingRes.data);
      renderLowStock(lowStockRes.data);
    } catch (e) { toastError(e); }
  };

  function renderStats(s) {
    view.querySelector('#stats').innerHTML = [
      statCard({ label: 'Total Products', value: num(s.products.total), iconName: 'box', tone: 'i-brand',
        meta: `<span>${num(s.products.active)} active · ${num(s.products.inactive)} archived</span>` }),
      statCard({ label: 'Service Bookings', value: num(s.bookings.total), iconName: 'calendar', tone: 'i-info',
        meta: `${trend(s.bookings.change)}<span>${num(s.bookings.thisMonth)} this month</span>` }),
      statCard({ label: 'Customers', value: num(s.customers.total), iconName: 'users', tone: 'i-purple',
        meta: `${trend(s.customers.change)}<span>${num(s.customers.thisMonth)} new this month</span>` }),
      statCard({ label: 'Contact Messages', value: num(s.messages.total), iconName: 'mail', tone: 'i-success',
        meta: s.messages.unread
          ? `<span class="badge badge--warning">${num(s.messages.unread)} unread</span>`
          : '<span>Inbox is clear</span>' }),
      statCard({ label: 'Low Stock Alerts', value: num(s.inventory.lowStockCount), iconName: 'alert',
        tone: s.inventory.lowStockCount ? 'i-danger' : 'i-success',
        meta: `<span>${num(s.inventory.outOfStock)} out of stock · ${money(s.inventory.stockValue)} on hand</span>` }),
      statCard({ label: 'Revenue', value: money(s.revenue.total), iconName: 'money', tone: 'i-success',
        meta: `${trend(s.revenue.change)}<span>${money(s.revenue.thisMonth)} this month</span>` }),
      statCard({ label: 'Pending Bookings', value: num(s.bookings.pending), iconName: 'clock',
        tone: s.bookings.pending ? 'i-warning' : 'i-success',
        meta: `<span>${num(s.bookings.today)} scheduled today</span>` }),
      statCard({ label: 'Stock Retail Value', value: money(s.inventory.retailValue), iconName: 'layers', tone: 'i-brand',
        meta: `<span>Cost basis ${money(s.inventory.stockValue)}</span>` }),
    ].join('');

    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    view.querySelector('#greeting').textContent =
      `${part} — ${num(s.bookings.today)} appointment(s) today and ${num(s.messages.unread)} unread message(s).`;
  }

  function renderStatusChart(s) {
    const data = Object.entries(s.bookings.byStatus)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ label: k.replace('_', ' '), value: v }));
    view.querySelector('#statusLegend').innerHTML = donutChart(view.querySelector('#statusChart'), data, num);
  }

  async function loadTrend(months) {
    const box = view.querySelector('#trendChart');
    box.innerHTML = '<div style="display:grid;place-items:center;height:100%"><div class="spinner"></div></div>';
    try {
      const { data } = await api.get('/analytics/overview', { months });
      view.querySelector('#trendLegend').innerHTML = lineChart(box, {
        labels: data.labels,
        series: [
          { name: 'Total revenue', values: data.revenueTrend.total, color: '#0891b2' },
          { name: 'Bookings', values: data.monthlyBookings.total, color: '#7c3aed' },
        ],
        formatter: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : num(v)),
      });
    } catch (e) { box.innerHTML = emptyState('Chart unavailable', e.message); }
  }

  function renderActivity(items) {
    const host = view.querySelector('#activity');
    if (!items.length) return void (host.innerHTML = emptyState('No activity yet', 'Actions taken in the dashboard will appear here.'));
    host.innerHTML = `<ul class="timeline">${items.map((a) => {
      const [ic, tone] = ACTIVITY_ICONS[a.type] || ['box', 'i-brand'];
      return `<li><div class="timeline__icon ${tone}">${icon(ic)}</div>
        <div class="timeline__body"><div class="timeline__msg">${esc(a.message)}</div>
        <div class="timeline__time">${esc(relative(a.createdAt))}${a.user ? ` · ${esc(a.user.name)}` : ''}</div></div></li>`;
    }).join('')}</ul>`;
  }

  function renderUpcoming(items) {
    const host = view.querySelector('#upcoming');
    if (!items.length) return void (host.innerHTML = emptyState('Nothing scheduled', 'Upcoming appointments will show up here.'));
    host.innerHTML = `<div class="table-wrap"><table class="data"><caption class="sr-only">Upcoming appointments</caption>
      <thead><tr><th scope="col">Customer</th><th scope="col">Service</th><th scope="col">When</th><th scope="col">Status</th></tr></thead>
      <tbody>${items.map((b) => `<tr>
        <td><div class="cell-flex"><span class="avatar">${esc(initials(b.customer?.name))}</span>
          <div><div class="cell-main">${esc(b.customer?.name || '—')}</div>
          <div class="cell-sub">${esc(b.technician?.name || 'Unassigned')}</div></div></div></td>
        <td>${esc(b.service?.name || 'General service')}</td>
        <td><div>${esc(dateTime(b.scheduledAt))}</div><div class="cell-sub">${esc(relative(b.scheduledAt))}</div></td>
        <td>${statusBadge(b.status)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderLowStock(items) {
    const host = view.querySelector('#lowStock');
    if (!items.length) return void (host.innerHTML = emptyState('Stock levels healthy', 'No products are below their reorder threshold.'));
    host.innerHTML = `<div class="table-wrap"><table class="data"><caption class="sr-only">Low stock products</caption>
      <thead><tr><th scope="col">Product</th><th scope="col">Category</th><th scope="col" class="num">In stock</th><th scope="col">Status</th></tr></thead>
      <tbody>${items.map((p) => `<tr>
        <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.sku)}</div></td>
        <td>${esc(p.category?.name || '—')}</td>
        <td class="num">${num(p.quantity)} / ${num(p.lowStockLevel)}</td>
        <td>${statusBadge(p.quantity === 0 ? 'out' : 'low', p.quantity === 0 ? 'Out of stock' : 'Low')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  view.querySelector('#refreshBtn').onclick = () => { load(); loadTrend(view.querySelector('#trendRange').value); };
  view.querySelector('#trendRange').onchange = (e) => loadTrend(e.target.value);

  await Promise.all([load(), loadTrend(12)]);
}
