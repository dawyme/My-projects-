/**
 * Media Manager — the site-wide media library. Upload, search, folder
 * organisation, replace, delete and file validation.
 */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { el, qs, qsa, icon, esc, dateTime, modal, toast, toastError, confirmDialog, debounce, emptyState, pagination, num } from '../ui.js';

export async function render(view, query) {
  setTitle('Media Library');
  const readOnly = !auth.isAdmin;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Media Library</h1><p>Upload, organise and manage every image used across the website.</p></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn--ghost" id="foldersBtn">${icon('layers')} Folders</button>
        <button class="btn btn--primary" id="uploadBtn" ${readOnly ? 'disabled' : ''}>${icon('upload')} Upload</button>
      </div>
    </div>
    <div class="card">
      <div class="card__head" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div class="topbar__search" style="max-width:280px">${icon('search')}<input data-search type="search" placeholder="Search files…" aria-label="Search files"></div>
        <select data-type aria-label="Filter by file type"><option value="">All types</option><option value="image/">Images</option></select>
        <span class="hint" data-count style="margin-left:auto"></span>
      </div>
      <div class="card__body">
        <div class="media-grid" data-grid style="min-height:180px"></div>
        <div data-pager style="margin-top:14px"></div>
      </div>
    </div>`;

  const grid = qs('[data-grid]', view);
  const pager = qs('[data-pager]', view);
  let state = { search: '', type: '', folder: '', page: 1, limit: 24, meta: null };

  const load = debounce(async () => {
    grid.innerHTML = `<div style="display:grid;place-items:center;padding:40px"><div class="spinner"></div></div>`;
    try {
      const r = await api.get('/media', { search: state.search, type: state.type, folder: state.folder, page: state.page, limit: state.limit });
      state.meta = r.meta;
      renderGrid(r.data);
      qs('[data-count]', view).textContent = `${num(r.meta.total)} files`;
      pager.replaceChildren(pagination(r.meta, (p) => { state.page = p; load(); }));
    } catch (e) { grid.innerHTML = emptyState('Could not load media', e.message); }
  }, 250);

  function renderGrid(items) {
    if (!items.length) {
      grid.innerHTML = emptyState('No files found', 'Upload images or try a different search.', readOnly ? '' : `<button class="btn btn--primary" data-emptyupload>${icon('upload')} Upload images</button>`);
      qs('[data-emptyupload]', view)?.addEventListener('click', openUploader);
      return;
    }
    grid.innerHTML = items.map((a) => `
      <button class="media-tile" data-id="${esc(a.id)}" aria-label="View ${esc(a.filename)}">
        <div class="media-tile__thumb"><img src="${esc(a.thumbUrl || a.url)}" alt="${esc(a.alt || a.filename)}" loading="lazy"></div>
        <div class="media-tile__meta"><div class="media-tile__name">${esc(a.filename)}</div>
          <div class="media-tile__sub">${esc(a.folder)} · ${a.width ? `${a.width}×${a.height}` : ''} ${esc(a.mimeType)}</div></div>
      </button>`).join('');
    grid.querySelectorAll('.media-tile').forEach((tile) => tile.addEventListener('click', () => openDetail(items.find((a) => a.id === tile.dataset.id))));
  }

  qs('[data-search]', view).addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; load(); });
  qs('[data-type]', view).addEventListener('change', (e) => { state.type = e.target.value; state.page = 1; load(); });
  qs('#uploadBtn', view).addEventListener('click', openUploader);
  qs('#foldersBtn', view).addEventListener('click', () => { modal({ title: 'Folders', body: '<p class="hint">Use the "Move to folder" option on a file to organise it. Folders are auto-created.</p><button class="btn btn--primary" data-close>Close</button>' }); });

  function openUploader() {
    const input = el('<input type="file" accept="image/*" multiple>');
    input.onchange = async () => {
      const files = [...input.files];
      if (!files.length) return;
      const m = modal({ title: 'Uploading…', body: `<div class="upload-progress"><div class="upload-progress__bar" data-bar style="width:0%"></div></div><p data-status class="hint">Preparing ${files.length} file(s)…</p>` });
      let done = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.append('images', file);
        fd.append('folder', '/');
        try {
          await api.upload('/media/upload', fd);
          done++;
          const pct = Math.round((done / files.length) * 100);
          m.body.querySelector('[data-bar]').style.width = `${pct}%`;
          m.body.querySelector('[data-status]').textContent = `Uploaded ${done}/${files.length}`;
        } catch (e) { toastError(e); }
      }
      m.close();
      if (done) { toast(`Uploaded ${done} file(s)`, 'success'); state.page = 1; load(); }
    };
    input.click();
  }

  function openDetail(asset) {
    const m = modal({
      title: asset.filename,
      size: 'md',
      body: `<div style="text-align:center;margin-bottom:16px"><img src="${esc(asset.url)}" alt="${esc(asset.alt || '')}" style="max-height:280px;max-width:100%;border-radius:10px"></div>
        <div class="grid grid--form">
          <div class="field"><label>Alt text</label><input data-field="alt" value="${esc(asset.alt || '')}"></div>
          <div class="field"><label>Folder</label><input data-field="folder" value="${esc(asset.folder || '/')}"></div>
          <div class="field"><label>File name</label><input data-field="filename" value="${esc(asset.filename)}"></div>
          <div class="field"><label>Type</label><input value="${esc(asset.mimeType)}" disabled></div>
          <div class="field"><label>Dimensions</label><input value="${asset.width ? `${asset.width} × ${asset.height}px` : '—'}" disabled></div>
          <div class="field"><label>Size</label><input value="${fmtBytes(asset.size)}" disabled></div>
          <div class="field" style="grid-column:1/-1"><label>URL</label><input value="${esc(asset.url)}" readonly onclick="this.select()"></div>
        </div>`,
      footer: readOnly
        ? '<button class="btn btn--primary" data-close>Close</button>'
        : `<button class="btn btn--ghost" data-replace>${icon('refresh')} Replace</button>
           <button class="btn btn--danger" data-delete>${icon('trash')} Delete</button>
           <button class="btn btn--primary" data-save>Save</button>`,
      onMount: ({ root, close }) => {
        root.querySelector('[data-save]')?.addEventListener('click', async () => {
          const payload = {};
          for (const f of ['alt', 'folder', 'filename']) payload[f] = root.querySelector(`[data-field="${f}"]`).value;
          try { await api.patch(`/media/${asset.id}`, payload); toast('Metadata saved', 'success'); load(); close(); }
          catch (e) { toastError(e); }
        });
        root.querySelector('[data-delete]')?.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Delete this file?', message: 'This permanently removes the image from the library.', confirmLabel: 'Delete' });
          if (!ok) return;
          try { await api.del(`/media/${asset.id}`); toast('File deleted', 'success'); load(); close(); }
          catch (e) { toastError(e); }
        });
        root.querySelector('[data-replace]')?.addEventListener('click', async () => {
          const input = el('<input type="file" accept="image/*">');
          input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('image', file);
            try { await api.post(`/media/${asset.id}/replace`, fd); toast('File replaced', 'success'); load(); close(); }
            catch (e) { toastError(e); }
          };
          input.click();
        });
      },
    });
  }

  load();
}

function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
