// Full-screen photo viewer with prev/next arrows, swipe gesture, pinch +
// double-tap zoom, and a position indicator. Items can be opened from any
// thumb strip — works for both queued (blob URL) and uploaded (Drive)
// photos. For Drive items the full-resolution file is fetched and held in
// a blob URL so the image fills the viewer instead of stretching a tiny
// 220px thumbnail.
//
// Viewer.open({ items, startIndex, onAnnotate(item), onDelete(item, idx) })
//   items: [{ src, name, fileId?, objectUrl?, status?, ... }]
//   src is used directly when present; otherwise we fetch the Drive file.
window.Viewer = (function () {
  let items = [];
  let idx = 0;
  let onAnnotateCb = null;
  let onDeleteCb = null;
  let onCloseCb = null;
  let popstateListener = null;
  let closing = false;

  // Per-index blob-URL cache — avoids refetching when nav back-and-forth.
  const resolvedSrc = new Map(); // idx -> URL
  let activeFetch = null;

  // Zoom + pan state for the current image.
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  // Pinch tracking
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchCenter = { x: 0, y: 0 };
  // Pan tracking (single-finger drag while zoomed)
  let panStartX = 0;
  let panStartY = 0;
  let panStartTranslate = { x: 0, y: 0 };
  // Double-tap detection
  let lastTapTime = 0;
  // Swipe nav (single-finger horizontal while NOT zoomed)
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeStartT = 0;
  let activeTouchMode = null; // 'pan' | 'pinch' | 'swipe' | null

  function root() { return document.getElementById('overlay-root'); }

  function open(opts) {
    items = (opts.items || []).slice();
    idx = Math.max(0, Math.min(items.length - 1, opts.startIndex || 0));
    onAnnotateCb = opts.onAnnotate || null;
    onDeleteCb = opts.onDelete || null;
    onCloseCb = opts.onClose || null;
    closing = false;
    if (items.length === 0) return;
    resolvedSrc.clear();

    document.body.classList.add('camera-open');
    render();
    window.addEventListener('keydown', onKey);

    history.pushState({ overlay: 'viewer' }, '');
    popstateListener = () => close({ fromPop: true });
    window.addEventListener('popstate', popstateListener);
  }

  function close(opts = {}) {
    if (closing) return;
    closing = true;
    window.removeEventListener('keydown', onKey);
    if (popstateListener) {
      window.removeEventListener('popstate', popstateListener);
      popstateListener = null;
    }
    if (!opts.fromPop) {
      try { history.back(); } catch (e) { /* ignore */ }
    }
    // Revoke blob URLs we created so we don't leak memory.
    resolvedSrc.forEach((url, key) => {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    });
    resolvedSrc.clear();
    if (activeFetch) { try { activeFetch.abort(); } catch (e) {} activeFetch = null; }
    root().innerHTML = '';
    document.body.classList.remove('camera-open');
    items = [];
    const cb = onCloseCb;
    onAnnotateCb = onDeleteCb = onCloseCb = null;
    closing = false;
    if (cb) cb();
  }

  function resetZoom() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    activeTouchMode = null;
  }

  function applyTransform() {
    const img = document.getElementById('vw-img');
    if (!img) return;
    img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  function render() {
    const item = items[idx];
    if (!item) { close(); return; }
    const canAnnotate = !!item.fileId && !!onAnnotateCb;
    const canDelete = !!onDeleteCb;
    resetZoom();

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
          <div class="viewer-loading" id="vw-loading">Loading…</div>
          <img id="vw-img" alt="${(item.name || '').replace(/"/g, '&quot;')}" hidden draggable="false"/>
        </div>

        <button class="viewer-arrow left"  id="vw-prev" aria-label="Previous" ${idx === 0 ? 'disabled' : ''}>‹</button>
        <button class="viewer-arrow right" id="vw-next" aria-label="Next"     ${idx === items.length - 1 ? 'disabled' : ''}>›</button>

        <footer class="viewer-bottom">
          <div class="viewer-name">${escapeHtml(item.name || '')}</div>
          ${item.status === 'queued'   ? '<div class="viewer-tag">Uploading…</div>' : ''}
          ${item.status === 'failed'   ? '<div class="viewer-tag failed">Upload failed</div>' : ''}
        </footer>
      </div>
    `;

    document.getElementById('vw-close').addEventListener('click', () => close());
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
      const cached = resolvedSrc.get(idx);
      if (cached) { try { URL.revokeObjectURL(cached); } catch {} resolvedSrc.delete(idx); }
      items.splice(idx, 1);
      if (items.length === 0) { close(); return; }
      if (idx >= items.length) idx = items.length - 1;
      render();
    });

    const stage = document.getElementById('vw-stage');
    stage.addEventListener('touchstart', onTouchStart, { passive: false });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });

    loadCurrentImage();
  }

  async function loadCurrentImage() {
    const item = items[idx];
    if (!item) return;
    const img = document.getElementById('vw-img');
    const loading = document.getElementById('vw-loading');
    if (!img) return;

    // 1. Cached blob URL from a previous nav?
    const cached = resolvedSrc.get(idx);
    if (cached) {
      showImg(img, loading, cached);
      return;
    }

    // 2. Current-session blob URL? (newly captured photo, not yet uploaded)
    if (item.objectUrl) {
      showImg(img, loading, item.objectUrl);
      return;
    }

    // 3. Drive file — fetch original bytes for full quality.
    if (item.fileId) {
      if (loading) loading.textContent = 'Loading photo…';
      try {
        const token = await window.Auth.getAccessToken();
        const ctrl = new AbortController();
        activeFetch = ctrl;
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${item.fileId}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal }
        );
        activeFetch = null;
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        resolvedSrc.set(idx, url);
        // The user might have navigated away while this loaded — bail.
        if (items[idx] !== item) { try { URL.revokeObjectURL(url); } catch {} return; }
        showImg(img, loading, url);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('[viewer] image load failed:', err);
        if (loading) {
          loading.textContent = `Could not load image — ${err.message}`;
        }
      }
      return;
    }

    // 4. Last resort: a thumbnail link or whatever was passed in.
    if (item.src) {
      showImg(img, loading, item.src);
      return;
    }
    if (loading) loading.textContent = 'Image not available';
  }

  function showImg(img, loading, url) {
    img.onload = () => {
      img.hidden = false;
      if (loading) loading.style.display = 'none';
    };
    img.onerror = () => {
      if (loading) loading.textContent = 'Could not load image';
    };
    img.src = url;
    // If the browser cached it, onload may not fire late — show now.
    if (img.complete && img.naturalWidth > 0) {
      img.hidden = false;
      if (loading) loading.style.display = 'none';
    }
  }

  function prev() {
    if (idx > 0) {
      idx -= 1;
      render();
    }
  }
  function next() {
    if (idx < items.length - 1) {
      idx += 1;
      render();
    }
  }

  function onKey(ev) {
    if (ev.key === 'ArrowLeft') prev();
    else if (ev.key === 'ArrowRight') next();
    else if (ev.key === 'Escape') close();
  }

  // ---------- Touch handlers ----------
  function distance(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
  }
  function midpoint(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function clampTranslate() {
    const stage = document.getElementById('vw-stage');
    const img = document.getElementById('vw-img');
    if (!stage || !img) return;
    const stageRect = stage.getBoundingClientRect();
    // Image rendered size at scale=1 is the natural fit-contain size; we
    // approximate by reading bounding rect at scale=1 once. To keep this
    // simple, allow free-ish pan and don't clamp tightly.
    const max = Math.max(stageRect.width, stageRect.height) * (scale - 1) * 0.6;
    translateX = Math.max(-max, Math.min(max, translateX));
    translateY = Math.max(-max, Math.min(max, translateY));
  }

  function onTouchStart(ev) {
    if (ev.touches.length === 2) {
      ev.preventDefault();
      activeTouchMode = 'pinch';
      pinchStartDist = distance(ev.touches[0], ev.touches[1]);
      pinchStartScale = scale;
      pinchCenter = midpoint(ev.touches[0], ev.touches[1]);
    } else if (ev.touches.length === 1) {
      const t = ev.touches[0];
      if (scale > 1.01) {
        // Pan when zoomed in
        activeTouchMode = 'pan';
        panStartX = t.clientX;
        panStartY = t.clientY;
        panStartTranslate = { x: translateX, y: translateY };
      } else {
        // Otherwise track for swipe nav / double-tap
        activeTouchMode = 'swipe';
        swipeStartX = t.clientX;
        swipeStartY = t.clientY;
        swipeStartT = Date.now();
      }
    }
  }

  function onTouchMove(ev) {
    if (activeTouchMode === 'pinch' && ev.touches.length === 2) {
      ev.preventDefault();
      const d = distance(ev.touches[0], ev.touches[1]);
      const next = pinchStartScale * (d / pinchStartDist);
      scale = Math.max(1, Math.min(4, next));
      if (scale === 1) { translateX = 0; translateY = 0; }
      applyTransform();
    } else if (activeTouchMode === 'pan' && ev.touches.length === 1) {
      ev.preventDefault();
      const t = ev.touches[0];
      translateX = panStartTranslate.x + (t.clientX - panStartX);
      translateY = panStartTranslate.y + (t.clientY - panStartY);
      clampTranslate();
      applyTransform();
    }
  }

  function onTouchEnd(ev) {
    // Double-tap detection for single-finger taps that didn't drag.
    if (activeTouchMode === 'swipe' && ev.changedTouches.length === 1) {
      const t = ev.changedTouches[0];
      const dx = t.clientX - swipeStartX;
      const dy = t.clientY - swipeStartY;
      const dt = Date.now() - swipeStartT;
      const moved = Math.abs(dx) > 10 || Math.abs(dy) > 10;

      if (!moved) {
        const now = Date.now();
        if (now - lastTapTime < 320) {
          // double tap — toggle zoom
          if (scale > 1.01) {
            scale = 1; translateX = 0; translateY = 0;
          } else {
            scale = 2;
            // Zoom toward the tap point
            const stage = document.getElementById('vw-stage');
            const r = stage.getBoundingClientRect();
            translateX = (r.width / 2 - (t.clientX - r.left)) * 0.5;
            translateY = (r.height / 2 - (t.clientY - r.top)) * 0.5;
          }
          applyTransform();
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
      } else if (scale <= 1.01 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && dt < 600) {
        // horizontal swipe → nav
        if (dx < 0) next(); else prev();
      }
    }
    if (ev.touches.length === 0) {
      activeTouchMode = null;
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

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
