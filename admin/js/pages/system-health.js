import { auth } from '../api.js';
import { setTitle } from '../layout.js';
export async function render(view) {
  setTitle('System Health');
  if (!(auth.user?.role === 'SUPER_ADMIN' || (auth.user?.role === 'ADMIN' && !auth.user?.businessId))) { view.innerHTML='<div class="card"><div class="card__body"><h3>Platform administrators only</h3></div></div>'; return; }
  view.innerHTML='<div class="page-head"><div><h1>System Health</h1><p>Live availability checks for the application API.</p></div></div><div class="grid grid--2"><section class="card"><div class="card__head"><h2>API</h2></div><div class="card__body" id="apiStatus">Checking…</div></section><section class="card"><div class="card__head"><h2>Frontend</h2></div><div class="card__body"><div class="alert alert--success">Dashboard shell loaded successfully.</div></div></section></div>';
  try { const r=await fetch('/health',{cache:'no-store'}); document.querySelector('#apiStatus').innerHTML=r.ok?'<div class="alert alert--success">Healthy — API responded successfully.</div>':`<div class="alert alert--danger">Unhealthy — HTTP ${r.status}.</div>`; } catch(e){ document.querySelector('#apiStatus').innerHTML='<div class="alert alert--danger">Unreachable — API health check failed.</div>'; }
}
