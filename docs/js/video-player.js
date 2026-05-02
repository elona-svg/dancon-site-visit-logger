// In-app video player overlay.
//   - X close button (top-right)
//   - Tap outside the video to dismiss
//   - Swipe down (>80px) to dismiss
//   - Browser Back closes via history.popstate
// On close, the video is paused and the underlying MediaSource (if any)
// is released. Returns control to whatever the caller had open before
// (typically the project screen with its asset strip).
window.VideoPlayer = (function () {
  let isOpen = false;
  let closing = false;
  let onCloseCb = null;
  let popstateListener = null;
  let touchStartY = 0;
  let touchStartT = 0;

  function root() { return document.getElementById('overlay-root'); }

  function open({ src, name, kind = 'video', onClose }) {
    if (isOpen) close();
    isOpen = true;
    closing = false;
    onCloseCb = onClose || null;

    document.body.classList.add('camera-fs-open');
    const isAudio = kind === 'audio';
    const mediaTag = isAudio
      ? `<audio id="vp-video" controls autoplay preload="metadata" src="${escapeHtml(src)}"></audio>`
      : `<video id="vp-video" controls playsinline autoplay preload="metadata" src="${escapeHtml(src)}"></video>`;
    const stageInner = isAudio
      ? `<div class="vplayer-audio-card">
           <div class="vplayer-audio-glyph">🎙️</div>
           <div class="vplayer-audio-title">${escapeHtml(name || 'Voice note')}</div>
           ${mediaTag}
         </div>`
      : mediaTag;

    root().innerHTML = `
      <div class="vplayer-overlay ${isAudio ? 'audio' : ''}" id="vplayer">
        <button class="cam-fs-icon vplayer-close" id="vp-close" aria-label="Close">✕</button>
        <div class="vplayer-stage" id="vp-stage">
          ${stageInner}
        </div>
        <div class="vplayer-name">${escapeHtml(name || '')}</div>
      </div>
    `;

    history.pushState({ overlay: 'video' }, '');
    popstateListener = () => close({ fromPop: true });
    window.addEventListener('popstate', popstateListener);

    document.getElementById('vp-close').addEventListener('click', () => close());
    const overlay = document.getElementById('vplayer');
    overlay.addEventListener('click', onBackdropClick);
    const stage = document.getElementById('vp-stage');
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });
  }

  function onBackdropClick(ev) {
    // Tap outside the <video> dismisses; tap on the video itself does not.
    if (ev.target.id === 'vplayer' || ev.target.id === 'vp-stage') {
      close();
    }
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

  function close(opts = {}) {
    if (!isOpen || closing) return;
    closing = true;

    const video = document.getElementById('vp-video');
    if (video) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ }
    }
    if (popstateListener) {
      window.removeEventListener('popstate', popstateListener);
      popstateListener = null;
    }
    if (!opts.fromPop) {
      try { history.back(); } catch (e) { /* ignore */ }
    }
    root().innerHTML = '';
    document.body.classList.remove('camera-fs-open');
    isOpen = false;
    closing = false;

    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) { try { cb(); } catch (err) { console.error('[vplayer] onClose threw:', err); } }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { open, close, isOpen: () => isOpen };
})();
