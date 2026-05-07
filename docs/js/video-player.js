// In-app media player overlay (video + audio).
//   - X close button
//   - Tap outside the media to dismiss
//   - Swipe down (>80px) to dismiss
//   - Browser Back closes via popstate
// On close, the media is paused and source detached.
//
// For Drive-backed clips (no local objectUrl) we fetch the file as a Blob
// with progress reporting and then play from a blob URL. That's the only
// reliable cross-browser path — `<video src=https://...?access_token=...>`
// is flaky on Safari for cross-origin auth'd content. If anything fails or
// the browser can't decode the format, we show a "Video could not load"
// retry overlay instead of leaving the user staring at a black frame.
window.VideoPlayer = (function () {
  let isOpen = false;
  let closing = false;
  let onCloseCb = null;
  let onDeleteCb = null;
  let popstateListener = null;
  let touchStartY = 0;
  let touchStartT = 0;
  let activeFetch = null;
  let blobUrl = null;

  function root() { return document.getElementById('overlay-root'); }

  // open({ src?, fileId?, name, kind = 'video', onClose, onDelete? })
  // If `src` is provided we play it directly (e.g. current-session blob URL).
  // If `fileId` is provided we fetch the bytes from Drive ourselves.
  // If `onDelete` is provided we render a trash button that confirms,
  // closes the player, and invokes the callback (caller does the actual delete).
  function open(opts) {
    if (isOpen) close();
    isOpen = true;
    closing = false;
    onCloseCb = opts.onClose || null;
    onDeleteCb = opts.onDelete || null;

    const isAudio = opts.kind === 'audio';
    document.body.classList.add('camera-fs-open');
    root().innerHTML = `
      <div class="vplayer-overlay ${isAudio ? 'audio' : ''}" id="vplayer">
        <button class="cam-fs-icon vplayer-close" id="vp-close" aria-label="Close">✕</button>
        <button class="vw-download-btn" id="vp-dl" aria-label="Save to device" title="Save to device">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v12"/>
            <path d="M6 12l6 6 6-6"/>
            <path d="M4 21h16"/>
          </svg>
        </button>
        ${opts.onDelete ? `
        <button class="vw-trash-btn" id="vp-del" aria-label="Delete" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>` : ''}
        <div class="vplayer-stage" id="vp-stage">
          <div class="vplayer-loading" id="vp-loading">Loading…</div>
          <div class="vplayer-error" id="vp-error" hidden>
            <h3 id="vp-error-title">Video could not load</h3>
            <p class="muted small" id="vp-error-detail">Try again in a few minutes.</p>
            <button class="btn-primary" id="vp-retry">Retry</button>
          </div>
          <div class="vplayer-media-wrap" id="vp-media-wrap" hidden></div>
        </div>
        <div class="vplayer-name">${escapeHtml(opts.name || '')}</div>
      </div>
    `;

    history.pushState({ overlay: 'video' }, '');
    popstateListener = () => close({ fromPop: true });
    window.addEventListener('popstate', popstateListener);

    document.getElementById('vp-close').addEventListener('click', () => close());
    document.getElementById('vp-retry').addEventListener('click', () => loadAndPlay(opts));
    document.getElementById('vp-dl').addEventListener('click', () => downloadCurrent(opts));
    document.getElementById('vp-del')?.addEventListener('click', () => {
      if (!onDeleteCb) return;
      if (!confirm('Delete this file?')) return;
      const cb = onDeleteCb;
      close();
      try { cb(); } catch (e) { console.error('[vplayer] onDelete threw:', e); }
    });
    const overlay = document.getElementById('vplayer');
    overlay.addEventListener('click', (ev) => {
      if (ev.target.id === 'vplayer' || ev.target.id === 'vp-stage') close();
    });
    const stage = document.getElementById('vp-stage');
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });

    loadAndPlay(opts);
  }

  async function loadAndPlay(opts) {
    const isAudio = opts.kind === 'audio';
    const loading = document.getElementById('vp-loading');
    const errorBox = document.getElementById('vp-error');
    const wrap = document.getElementById('vp-media-wrap');

    if (!loading || !errorBox || !wrap) return;
    errorBox.hidden = true;
    wrap.hidden = true;
    wrap.innerHTML = '';
    loading.style.display = '';
    loading.textContent = isAudio ? 'Loading…' : 'Loading video…';

    let src = opts.src;

    // For Drive content (no current-session blob) we fetch ourselves so
    // we get progress reporting and avoid Safari's CORS-with-auth flakiness.
    if (!src && opts.fileId) {
      try {
        revokeBlob();
        const token = await window.Auth.getAccessToken();
        const ctrl = new AbortController();
        activeFetch = ctrl;
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${opts.fileId}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal }
        );
        activeFetch = null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const total = Number(res.headers.get('content-length') || 0);
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader && total > 0) {
          const chunks = [];
          let received = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              received += value.byteLength;
              const pct = Math.floor((received / total) * 100);
              if (loading) loading.textContent = `Loading video… ${pct}%`;
            }
          }
          const blob = new Blob(chunks, { type: res.headers.get('content-type') || (isAudio ? 'audio/webm' : 'video/mp4') });
          blobUrl = URL.createObjectURL(blob);
        } else {
          // No streaming reader — fall back to .blob()
          const blob = await res.blob();
          blobUrl = URL.createObjectURL(blob);
        }
        src = blobUrl;
      } catch (err) {
        activeFetch = null;
        if (err.name === 'AbortError') return;
        console.error('[vplayer] fetch failed:', err);
        return showError(
          isAudio ? 'Audio could not load' : 'Video could not load',
          err.message ? `Network error: ${err.message}` : 'Try again in a few minutes.'
        );
      }
    }

    if (!src) {
      return showError('Could not play', 'No source available for this file.');
    }

    // Mount the actual media element.
    const tag = isAudio ? 'audio' : 'video';
    const attrs = isAudio
      ? 'controls autoplay preload="metadata"'
      : 'controls playsinline autoplay preload="metadata"';
    const media = isAudio
      ? `<div class="vplayer-audio-card">
           <div class="vplayer-audio-glyph">🎙️</div>
           <div class="vplayer-audio-title">${escapeHtml(opts.name || 'Voice note')}</div>
           <audio id="vp-media" ${attrs} src="${escapeHtml(src)}"></audio>
         </div>`
      : `<video id="vp-media" ${attrs} src="${escapeHtml(src)}"></video>`;

    wrap.innerHTML = media;
    wrap.hidden = false;
    if (loading) loading.style.display = 'none';

    const el = document.getElementById('vp-media');
    el.addEventListener('error', () => {
      const code = el.error?.code;
      let detail = 'Try again in a few minutes.';
      if (code === 4) detail = "Your browser can't decode this format. The original file is safe in Drive.";
      else if (code === 2) detail = 'Network error.';
      showError(isAudio ? 'Audio could not play' : 'Video could not play', detail);
    });
  }

  async function downloadCurrent(opts) {
    try {
      let blob;
      // If we already streamed the file into a blob URL, fetch from there
      // (cheap — same blob in memory).
      if (blobUrl) {
        const res = await fetch(blobUrl);
        blob = await res.blob();
      } else if (opts.src) {
        const res = await fetch(opts.src);
        blob = await res.blob();
      } else if (opts.fileId) {
        const token = await window.Auth.getAccessToken();
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${opts.fileId}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.blob();
      } else {
        throw new Error('No source available');
      }
      window.UI.downloadBlob(blob, opts.name || (opts.kind === 'audio' ? 'audio' : 'video'));
      window.UI.toast('Saved to device', 'success', 1800);
    } catch (err) {
      console.error('[vplayer] download failed:', err);
      window.UI.toast(`Download failed: ${err.message}`, 'error', 4000);
    }
  }

  function showError(title, detail) {
    const loading = document.getElementById('vp-loading');
    const errorBox = document.getElementById('vp-error');
    const wrap = document.getElementById('vp-media-wrap');
    if (loading) loading.style.display = 'none';
    if (wrap) { wrap.hidden = true; wrap.innerHTML = ''; }
    if (!errorBox) return;
    document.getElementById('vp-error-title').textContent = title;
    document.getElementById('vp-error-detail').textContent = detail;
    errorBox.hidden = false;
  }

  function onTouchStart(ev) {
    if (!ev.touches.length) return;
    touchStartY = ev.touches[0].clientY;
    touchStartT = Date.now();
  }
  function onTouchEnd(ev) {
    if (!ev.changedTouches.length) return;
    const dy = ev.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartT;
    if (dt > 800) return;
    if (dy > 80) close();
  }

  function revokeBlob() {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} blobUrl = null; }
  }

  function close(opts = {}) {
    if (!isOpen || closing) return;
    closing = true;

    const el = document.getElementById('vp-media');
    if (el) {
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
    }
    if (activeFetch) { try { activeFetch.abort(); } catch (e) {} activeFetch = null; }
    revokeBlob();

    if (popstateListener) {
      window.removeEventListener('popstate', popstateListener);
      popstateListener = null;
    }
    if (!opts.fromPop) { try { history.back(); } catch (e) {} }

    root().innerHTML = '';
    document.body.classList.remove('camera-fs-open');
    isOpen = false;
    closing = false;

    const cb = onCloseCb;
    onCloseCb = null;
    onDeleteCb = null;
    if (cb) { try { cb(); } catch (e) { console.error('[vplayer] onClose threw:', e); } }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { open, close, isOpen: () => isOpen };
})();
