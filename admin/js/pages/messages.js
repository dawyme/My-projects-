import { api, auth } from '../api.js';
import { setTitle, refreshBadges } from '../layout.js';
import {
  qs, qsa, icon, esc, dateTime, relative, statusBadge, initials, debounce,
  emptyState, modal, confirmDialog, toast, toastError, pagination,
} from '../ui.js';

const state = { page: 1, limit: 25, search: '', status: '' };
let activeId = null;

export async function render(view, query) {
  setTitle('Messages');
  Object.assign(state, { page: 1, search: query.search || '', status: query.status || '' });
  // Each mount starts fresh so the detail pane always opens a message.
  activeId = null;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Contact Messages</h1><p>Website enquiries — read, reply, archive and search.</p></div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="refreshBtn">${icon('refresh')} Refresh</button>
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search messages</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search sender, subject or content…" value="${esc(state.search)}">
        <div class="tabs" role="tablist" style="border:0;padding:0" id="statusTabs">
          <button class="tab" role="tab" data-status="" aria-selected="${!state.status}">All</button>
          <button class="tab" role="tab" data-status="UNREAD" aria-selected="${state.status === 'UNREAD'}">Unread <span id="cUnread"></span></button>
          <button class="tab" role="tab" data-status="READ" aria-selected="${state.status === 'READ'}">Read</button>
          <button class="tab" role="tab" data-status="ARCHIVED" aria-selected="${state.status === 'ARCHIVED'}">Archived</button>
        </div>
      </div>
      <div class="bulkbar" id="bulkbar">
        <span class="bulkbar__count" id="bulkCount">0 selected</span>
        <button class="btn btn--ghost btn--sm" data-bulk="read">${icon('check')} Mark read</button>
        <button class="btn btn--ghost btn--sm" data-bulk="unread">Mark unread</button>
        <button class="btn btn--ghost btn--sm" data-bulk="archive">${icon('archive')} Archive</button>
        <button class="btn btn--danger btn--sm" data-bulk="delete" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')} Delete</button>
      </div>
      <div class="inbox">
        <div class="inbox__list" id="list"></div>
        <div class="inbox__detail" id="detail"></div>
      </div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const list = qs('#list', view);
  const detail = qs('#detail', view);
  const selected = new Set();

  function syncBulk() {
    qs('#bulkbar', view).classList.toggle('show', selected.size > 0);
    qs('#bulkCount', view).textContent = `${selected.size} selected`;
  }

  async function load() {
    list.innerHTML = Array.from({ length: 6 }, () =>
      '<div style="padding:13px 15px;border-bottom:1px solid var(--border)"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:85%;margin-top:7px"></div></div>').join('');
    try {
      const { data, meta } = await api.get('/messages', { ...state });
      qs('#cUnread', view).textContent = meta.summary.UNREAD ? `(${meta.summary.UNREAD})` : '';
      if (!data.length) {
        list.innerHTML = emptyState('No messages', 'Enquiries submitted on the website will appear here.');
        detail.innerHTML = '';
        qs('#pager', view).innerHTML = '';
        return;
      }
      list.innerHTML = data.map((m) => `<button class="inbox__item ${m.status === 'UNREAD' ? 'unread' : ''} ${m.id === activeId ? 'active' : ''}" data-id="${esc(m.id)}">
        <input type="checkbox" class="msgsel" value="${esc(m.id)}" aria-label="Select message from ${esc(m.name)}" ${selected.has(m.id) ? 'checked' : ''}>
        <span class="avatar">${esc(initials(m.name))}</span>
        <span style="flex:1;min-width:0">
          <span class="inbox__from">${esc(m.name)} ${m.status === 'UNREAD' ? '<span class="badge badge--warning badge--plain">New</span>' : ''}
            ${m.status === 'ARCHIVED' ? '<span class="badge badge--muted badge--plain">Archived</span>' : ''}</span>
          <span class="inbox__subject">${esc(m.subject || '(no subject)')}</span>
          <span class="inbox__preview">${esc(m.body.slice(0, 80))}</span>
          <span class="inbox__preview" style="color:var(--text-soft)">${esc(relative(m.createdAt))}${m._count.replies ? ` · ${m._count.replies} repl${m._count.replies === 1 ? 'y' : 'ies'}` : ''}</span>
        </span></button>`).join('');
      const pager = qs('#pager', view);
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
      const stillListed = activeId && data.some((m) => m.id === activeId);
      openMessage(stillListed ? activeId : data[0].id);
      syncBulk();
    } catch (e) { list.innerHTML = emptyState('Could not load messages', e.message); }
  }

  async function openMessage(id) {
    activeId = id;
    qsa('.inbox__item', view).forEach((n) => n.classList.toggle('active', n.dataset.id === id));
    detail.innerHTML = '<div style="display:grid;place-items:center;min-height:220px"><div class="spinner"></div></div>';
    try {
      const { data: m } = await api.get(`/messages/${id}`);
      detail.innerHTML = `
        <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:16px">
          <span class="avatar avatar--lg">${esc(initials(m.name))}</span>
          <div style="flex:1;min-width:180px">
            <h2 style="font-size:16.5px">${esc(m.subject || '(no subject)')}</h2>
            <p style="margin:3px 0 0;color:var(--text-muted);font-size:13px">
              ${esc(m.name)} &lt;<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>&gt;${m.phone ? ` · ${esc(m.phone)}` : ''}</p>
            <p style="margin:2px 0 0;color:var(--text-soft);font-size:12px">${esc(dateTime(m.createdAt))}</p>
          </div>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            ${statusBadge(m.status)}
            <button class="btn btn--ghost btn--sm" id="archiveBtn">${icon('archive')} ${m.status === 'ARCHIVED' ? 'Unarchive' : 'Archive'}</button>
            <button class="btn btn--danger btn--sm" id="deleteBtn" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')} Delete</button>
          </div>
        </div>
        <div style="white-space:pre-wrap;font-size:14px;line-height:1.65;padding:15px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px">${esc(m.body)}</div>
        ${m.customer ? `<p style="margin-top:12px;font-size:12.5px;color:var(--text-muted)">Linked customer: <a href="#/customers?search=${encodeURIComponent(m.customer.email)}">${esc(m.customer.name)}</a></p>` : ''}
        ${m.replies.length ? `<h3 style="margin:20px 0 8px;font-size:14px">Replies</h3>${m.replies.map((r) => `<div class="reply">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:5px">${esc(r.user?.name || 'Team')} · ${esc(dateTime(r.sentAt))}</div>
            <div style="white-space:pre-wrap;font-size:13.5px">${esc(r.body)}</div></div>`).join('')}` : ''}
        <div class="card" style="margin-top:20px"><div class="card__head"><h3>Reply to ${esc(m.name)}</h3></div><div class="card__body">
          <div class="field"><label class="sr-only" for="replyBody">Reply message</label>
            <textarea id="replyBody" rows="4" placeholder="Type your reply — it will be emailed to the customer…"></textarea></div>
          <button class="btn btn--primary" id="sendReply">${icon('reply')} Send reply</button>
        </div></div>`;

      qs('#archiveBtn', detail).onclick = async () => {
        try {
          await api.patch(`/messages/${id}/status`, { status: m.status === 'ARCHIVED' ? 'READ' : 'ARCHIVED' });
          toast(m.status === 'ARCHIVED' ? 'Message restored' : 'Message archived');
          load();
          openMessage(id);
        } catch (e) { toastError(e); }
      };
      qs('#deleteBtn', detail).onclick = async () => {
        if (!await confirmDialog({ title: 'Delete message', message: 'This permanently removes the message and its replies.', confirmLabel: 'Delete' })) return;
        try { await api.del(`/messages/${id}`); toast('Message deleted'); activeId = null; detail.innerHTML = ''; load(); }
        catch (e) { toastError(e); }
      };
      qs('#sendReply', detail).onclick = async () => {
        const box = qs('#replyBody', detail);
        if (!box.value.trim()) return toast('Please write a reply first', 'warning');
        const btn = qs('#sendReply', detail);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Sending…';
        try {
          const res = await api.post(`/messages/${id}/reply`, { body: box.value.trim() });
          toast(res.meta?.emailDelivered ? 'Reply sent by email' : 'Reply saved (SMTP not configured — queued to the outbox)');
          openMessage(id);
          load();
        } catch (e) { toastError(e); btn.disabled = false; btn.innerHTML = `${icon('reply')} Send reply`; }
      };
      refreshBadges();
    } catch (e) { detail.innerHTML = emptyState('Could not load message', e.message); }
  }

  list.addEventListener('click', (e) => {
    if (e.target.classList.contains('msgsel')) {
      e.stopPropagation();
      if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
      return syncBulk();
    }
    const item = e.target.closest('.inbox__item');
    if (item) openMessage(item.dataset.id);
  });

  qs('#bulkbar', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn || !selected.size) return;
    const action = btn.dataset.bulk;
    if (action === 'delete' && !await confirmDialog({ title: 'Delete messages', message: `Permanently delete ${selected.size} message(s)?`, confirmLabel: 'Delete' })) return;
    try {
      const { data } = await api.post('/messages/bulk', { ids: [...selected], action });
      toast(`${data.affected} message(s) updated`);
      selected.clear();
      activeId = null;
      load();
    } catch (err) { toastError(err); }
  });

  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#statusTabs', view).addEventListener('click', (e) => {
    const tab = e.target.closest('[data-status]');
    if (!tab) return;
    qsa('#statusTabs .tab', view).forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    state.status = tab.dataset.status;
    state.page = 1;
    activeId = null;
    load();
  });
  qs('#refreshBtn', view).onclick = () => load();

  await load();
}
