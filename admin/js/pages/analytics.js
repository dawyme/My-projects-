import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, money, num, emptyState, lineChart, barChart, donutChart, toastError } from '../ui.js';

export async function render(view) {
  setTitle('Analytics');
  let months = 12;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Analytics</h1><p>Bookings, sales, product performance, customer growth and revenue trends.</p></div>
      <div class="page-head__actions">
        <label class="sr-only" for="rangeSelect">Reporting period</label>
        <select id="rangeSelect" style="width:auto">
          <option value="6">Last 6 months</option><option value="12" selected>Last 12 months</option><option value="24">Last 24 months</option>
        </select>
      </div>
    </div>
    <div class="grid grid--stats" id="totals"></div>
    <div class="grid grid--2" style="margin-top:16px">
      <section class="card span-2"><div class="card__head"><h2>Revenue trends</h2></div>
        <div class="card__body"><div class="chart-box" id="revenueChart"></div><div id="revenueLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Monthly bookings</h2></div>
        <div class="card__body"><div class="chart-box" id="bookingsChart"></div><div id="bookingsLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Sales volume</h2></div>
        <div class="card__body"><div class="chart-box" id="salesChart"></div><div id="salesLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Customer growth</h2></div>
        <div class="card__body"><div class="chart-box" id="customerChart"></div><div id="customerLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Revenue by category</h2></div>
        <div class="card__body"><div class="chart-box" id="categoryChart"></div><div id="categoryLegend" style="margin-top:10px"></div></div></section>
      <section class="card"><div class="card__head"><h2>Top products</h2></div>
        <div class="card__body card__body--flush"><div id="topProducts"></div></div></section>
      <section class="card"><div class="card__head"><h2>Technician performance</h2></div>
        <div class="card__body card__body--flush"><div id="technicians"></div></div></section>
    </div>`;

  const shortMoney = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

  async function load() {
    for (const id of ['revenueChart', 'bookingsChart', 'salesChart', 'customerChart', 'categoryChart']) {
      qs(`#${id}`, view).innerHTML = '<div style="display:grid;place-items:center;height:100%"><div class="spinner"></div></div>';
    }
    try {
      const [{ data }, techRes] = await Promise.all([
        api.get('/analytics/overview', { months }),
        api.get('/analytics/technicians'),
      ]);

      qs('#totals', view).innerHTML = `
        <article class="stat"><div class="stat__top"><div class="stat__icon i-success">${icon('money')}</div>
          <div><div class="stat__label">Total revenue</div><div class="stat__value">${money(data.totals.revenue)}</div></div></div>
          <div class="stat__meta">Across the selected period</div></article>
        <article class="stat"><div class="stat__top"><div class="stat__icon i-info">${icon('calendar')}</div>
          <div><div class="stat__label">Bookings</div><div class="stat__value">${num(data.totals.bookings)}</div></div></div>
          <div class="stat__meta">Service jobs created</div></article>
        <article class="stat"><div class="stat__top"><div class="stat__icon i-purple">${icon('users')}</div>
          <div><div class="stat__label">New customers</div><div class="stat__value">${num(data.totals.newCustomers)}</div></div></div>
          <div class="stat__meta">First-time contacts</div></article>
        <article class="stat"><div class="stat__top"><div class="stat__icon i-brand">${icon('chart')}</div>
          <div><div class="stat__label">Average order value</div><div class="stat__value">${money(data.totals.avgOrderValue)}</div></div></div>
          <div class="stat__meta">Parts &amp; equipment orders</div></article>`;

      qs('#revenueLegend', view).innerHTML = lineChart(qs('#revenueChart', view), {
        labels: data.labels,
        series: [
          { name: 'Total revenue', values: data.revenueTrend.total, color: '#0891b2' },
          { name: 'Product sales', values: data.revenueTrend.product, color: '#7c3aed' },
          { name: 'Service revenue', values: data.revenueTrend.service, color: '#059669' },
        ],
        formatter: shortMoney,
      });
      qs('#bookingsLegend', view).innerHTML = barChart(qs('#bookingsChart', view), {
        labels: data.labels,
        series: [
          { name: 'Total', values: data.monthlyBookings.total, color: '#0891b2' },
          { name: 'Completed', values: data.monthlyBookings.completed, color: '#059669' },
          { name: 'Cancelled', values: data.monthlyBookings.cancelled, color: '#dc2626' },
        ],
      });
      qs('#salesLegend', view).innerHTML = barChart(qs('#salesChart', view), {
        labels: data.labels,
        series: [
          { name: 'Orders', values: data.sales.orders, color: '#7c3aed' },
          { name: 'Revenue', values: data.sales.revenue, color: '#0891b2' },
        ],
        formatter: shortMoney,
      });
      qs('#customerLegend', view).innerHTML = lineChart(qs('#customerChart', view), {
        labels: data.labels,
        series: [
          { name: 'Cumulative customers', values: data.customerGrowth.cumulative, color: '#0891b2' },
          { name: 'New customers', values: data.customerGrowth.new, color: '#d97706' },
        ],
      });
      qs('#categoryLegend', view).innerHTML = donutChart(qs('#categoryChart', view),
        data.categoryPerformance.slice(0, 6).map((c) => ({ label: c.name, value: c.revenue })), money);

      const top = qs('#topProducts', view);
      top.innerHTML = data.productPerformance.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th scope="col">Product</th><th scope="col" class="num">Units sold</th><th scope="col" class="num">Revenue</th></tr></thead>
        <tbody>${data.productPerformance.map((p) => `<tr>
          <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.sku)}</div></td>
          <td class="num">${num(p.units)}</td><td class="num">${money(p.revenue)}</td></tr>`).join('')}</tbody></table></div>`
        : emptyState('No sales yet', 'Product performance appears once orders are recorded.');

      const techs = qs('#technicians', view);
      techs.innerHTML = techRes.data.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th scope="col">Technician</th><th scope="col" class="num">Assigned</th><th scope="col" class="num">Completed</th>
          <th scope="col" class="num">Revenue</th><th scope="col">Completion rate</th></tr></thead>
        <tbody>${techRes.data.map((t) => {
          const rate = t.assigned ? Math.round((t.completed / t.assigned) * 100) : 0;
          return `<tr><td><div class="cell-main">${esc(t.name)}</div><div class="cell-sub">${esc(t.role)}</div></td>
            <td class="num">${num(t.assigned)}</td><td class="num">${num(t.completed)}</td><td class="num">${money(t.revenue)}</td>
            <td><div class="progress" title="${rate}%"><div class="progress__bar" style="width:${rate}%"></div></div>
              <span class="cell-sub">${rate}%</span></td></tr>`;
        }).join('')}</tbody></table></div>`
        : emptyState('No technician data', 'Assign bookings to technicians to see performance.');
    } catch (e) { toastError(e); }
  }

  qs('#rangeSelect', view).onchange = (e) => { months = Number(e.target.value); load(); };
  document.addEventListener('themechange', load, { once: true });
  await load();
}
