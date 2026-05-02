// Full-screen photo viewer with prev/next arrows, swipe gesture, and a
// position indicator. Built to be opened from the project screen's thumb
// strip — works for both queued (blob URL) and uploaded (Drive) photos.
//
// Viewer.open({ items, startIndex, onAnnotate(item), onDelete(item, idx) })
//   items: [{ src, name, fileId? }]
window.Viewer = (function () {
  let items = [];
  let idx = 0;
  let onAnnotateCb = null;
  let onDeleteCb = null;
  let onCloseCb = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartT = 0;

  function root() { return document.getElementById('overlay-root'); }

  function open(opts) {
    items = (opts.items || []).slice();
    idx = Math.max(0, Math.min(items.length - 1, opts.startIndex || 0));
    onAnnotateCb = opts.onAnnotate || null;
    onDeleteCb = opts.onDelete || null;
    onCloseCb = opts.onClose || null;
    if (items.length === 0) return;

    document.body.classList.add('camera-open');
    render();
    window.addEventListener('keydown', onKey);
  }

  function close() {
    window.removeEventListener('keydown', onKey);
    root().innerHTML = '';
    document.body.classList.remove('camera-open');
    items = [];
    const cb = onCloseCb;
    onAnnotateCb = onDeleteCb = onCloseCb = null;
    if (cb) cb();
  }

  function render() {
    const item = items[idx];
    if (!item) { close(); return; }
    const canAnnotate = !!item.fileId && !!onAnnotateCb;
    const canDelete = !!onDeleteCb;
    root().innerHTML = `
      <div class="viewer-overlay">
        <header class="viewer-top">
          <button class="cam-icon-btn" id="vw-close" aria-label="Close">✕</button>
          <div class="viewer-pos">${idx + 1} of ${items.length}</div>
          <div class="viewer-actions">
            ${canAnnotate ? `<button class="cam-icon-btn" id="vw-ann" aria-label="Annotate" title="Annotate">✎</button>` : ''}
            ${canDelete ? `<button class="cam-icon-btn vw-trash" id="vw-del" aria-label="Delete" title="Delete">🗑</button>` : ''}
          </div>
        </header>

        <div class="viewer-stage" id="vw-stage">
          ${item.src
            ? `<img id="vw-img" alt="${(item.name || '').replace(/"/g, '&quot;')}" src="${item.src}"/>`
            : '<div class="muted" style="color:#aaa">Image not available</div>'}
        </div>

        <button class="viewer-arrow left"  id="vw-prev" aria-label="Previous" ${idx === 0 ? 'disabled' : ''}>‹</button>
        <button class="viewer-arrow right" id="vw-next" aria-label="Next"     ${idx === items.length - 1 ? 'disabled' : ''}>›</button>

        <footer class="viewer-bottom">
          <div class="viewer-name">${escapeHtml(item.name || '')}</div>
          ${item.status === 'queued'  ? '<div class="viewer-tag">Uploading…</div>' : ''}
          ${item.status === 'failed'  ? '<div class="viewer-tag failed">Upload failed</div>' : ''}
        </footer>
      </div>
    `;

    document.getElementById('vw-close').addEventListener('click', close);
    document.getElementById('vw-prev')?.addEventListener('click', prev);
    document.getElementById('vw-next')?.addEventListener('click', next);
    document.getElementById('vw-ann')?.addEventListener('click', () => {
      if (onAnnotateCb) onAnnotateCb(items[idx]);
    });
    document.getElementById('vw-del')?.addEventListener('click', () => {
      if (!onDeleteCb) return;
      if (!confirm('Delete this file?')) return;
      const removed = items[idx];
      onDeleteCb(removed, idx);
      items.splice(idx, 1);
      if (items.length === 0) { close(); return; }
      if (idx >= items.length) idx = items.length - 1;
      render();
    });

    const stage = document.getElementById('vw-stage');
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function prev() { if (idx > 0) { idx -= 1; render(); } }
  function next() { if (idx < items.length - 1) { idx += 1; render(); } }

  function onKey(ev) {
    if (ev.key === 'ArrowLeft') prev();
    else if (ev.key === 'ArrowRight') next();
    else if (ev.key === 'Escape') close();
  }

  function onTouchStart(ev) {
    if (!ev.touches.length) return;
    touchStartX = ev.touches[0].clientX;
    touchStartY = ev.touches[0].clientY;
    touchStartT = Date.now();
  }
  function onTouchEnd(ev) {
    if (!ev.changedTouches.length) return;
    const dx = ev.changedTouches[0].clientX - touchStartX;
    const dy = ev.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartT;
    if (dt > 800) return;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) next(); else prev();
  }

  // Public API to update a viewer item (e.g. when an upload completes and
  // we want to swap the local blob URL for the Drive thumbnail).
  function updateItem(predicate, patch) {
    let dirty = false;
    items = items.map((it) => {
      if (predicate(it)) { dirty = true; return { ...it, ...patch }; }
      return it;
    });
    if (dirty) render();
  }

  function isOpen() { return items.length > 0; }

  return { open, close, updateItem, isOpen };
})();
