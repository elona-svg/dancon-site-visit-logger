// Fullscreen camera overlay with continuous photo capture + video recording.
// Permission handling:
//   - Uses navigator.permissions.query({name:'camera'}) where supported to
//     check state up front. If 'granted', getUserMedia returns instantly
//     with no prompt. If 'denied', shows a one-time "how to enable" panel.
//     If 'prompt', the OS prompts on first getUserMedia call (once); the
//     browser caches the answer afterwards.
//
// Photo quality: snapshots at the camera's native resolution (no
// downscaling) at JPEG quality 0.95.
//
// History: pushes a state on open so the browser Back gesture closes the
// overlay instead of leaving the project screen.
window.Camera = (function () {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recMime = '';
  let recStartTs = 0;
  let recTimerHandle = null;
  let counter = 0;
  let isOpen = false;
  let closing = false;
  let onCaptureCb = null;
  let onCloseCb = null;
  let popstateListener = null;
  let mode = 'multi'; // 'multi' (default) or 'single' (one photo then auto-close)

  function root() { return document.getElementById('overlay-root'); }

  function pickVideoMime() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async function checkPermission() {
    if (!navigator.permissions?.query) return 'unknown';
    try {
      const status = await navigator.permissions.query({ name: 'camera' });
      return status.state; // 'granted' | 'denied' | 'prompt'
    } catch (e) {
      return 'unknown';
    }
  }

  async function open(opts = {}) {
    if (isOpen) return;
    isOpen = true;
    closing = false;
    onCaptureCb = opts.onCapture || null;
    onCloseCb = opts.onClose || null;
    mode = opts.mode || 'multi';
    counter = 0;

    document.body.classList.add('camera-fs-open');

    root().innerHTML = `
      <div class="camera-fs" id="cam-fs">
        <video id="cam-fs-video" playsinline autoplay muted></video>
        <div id="cam-fs-error" class="cam-fs-error" hidden></div>

        <div class="cam-fs-top">
          <button id="cam-fs-close" class="cam-fs-icon" aria-label="Close">✕</button>
          <div id="cam-fs-rec-bar" class="cam-fs-rec" hidden>
            <span class="rec-dot"></span>
            <span class="rec-time">0:00</span>
          </div>
          <div class="cam-fs-counter" id="cam-fs-counter">${counter} captured</div>
        </div>

        <div class="cam-fs-controls">
          <button id="cam-fs-shutter" class="cam-shutter" aria-label="Take photo"></button>
          ${mode === 'multi' ? '<button id="cam-fs-rec" class="cam-rec-btn" aria-label="Record video"></button>' : ''}
        </div>
      </div>
    `;

    document.getElementById('cam-fs-close').addEventListener('click', () => close());
    document.getElementById('cam-fs-shutter').addEventListener('click', onShutter);
    document.getElementById('cam-fs-rec')?.addEventListener('click', onRec);

    // History entry so Back closes us instead of leaving the project screen.
    history.pushState({ overlay: 'camera' }, '');
    popstateListener = () => close({ fromPop: true });
    window.addEventListener('popstate', popstateListener);

    // Permission preflight — short-circuit denied state with a clear message
    // so we don't fire a getUserMedia that would just reject again.
    const perm = await checkPermission();
    console.log('[camera] permission state:', perm);
    if (perm === 'denied') {
      showDenied();
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 4096 },
          height: { ideal: 2160 }
        },
        audio: mode === 'multi' // only acquire mic when video recording is allowed
      });
    } catch (err) {
      console.error('[camera] getUserMedia failed:', err);
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        showDenied();
      } else {
        showError(err.message || err.name || 'Camera unavailable');
      }
      return;
    }

    const video = document.getElementById('cam-fs-video');
    if (!video) return;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    try { await video.play(); } catch (e) { /* iOS sometimes needs a tap */ }
  }

  function showDenied() {
    const errBox = document.getElementById('cam-fs-error');
    if (!errBox) return;
    errBox.hidden = false;
    errBox.innerHTML = `
      <div class="cam-fs-error-card">
        <h3>Camera access blocked</h3>
        <p class="muted">Enable camera access for this site in your browser settings:</p>
        <p class="muted small">
          <strong>iPhone Safari:</strong> Settings → Safari → Camera → Allow<br>
          <strong>Chrome:</strong> tap the lock icon in the address bar → Camera → Allow<br>
          Then reload this page.
        </p>
        <button class="btn-primary" id="cam-fs-deny-close">Got it</button>
      </div>
    `;
    document.getElementById('cam-fs-deny-close')?.addEventListener('click', () => close());
  }

  function showError(msg) {
    const errBox = document.getElementById('cam-fs-error');
    if (!errBox) return;
    errBox.hidden = false;
    errBox.innerHTML = `
      <div class="cam-fs-error-card">
        <h3>Camera error</h3>
        <p class="muted small">${escapeHtml(msg)}</p>
        <button class="btn-primary" id="cam-fs-err-close">Close</button>
      </div>
    `;
    document.getElementById('cam-fs-err-close')?.addEventListener('click', () => close());
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async function onShutter() {
    if (!stream) return;
    if (recorder && recorder.state === 'recording') return; // ignore while recording
    const video = document.getElementById('cam-fs-video');
    if (!video || !video.videoWidth) {
      // Camera not ready — let the stream produce a frame, then try once more.
      await new Promise((r) => setTimeout(r, 120));
      if (!video.videoWidth) {
        console.warn('[camera] not ready');
        return;
      }
    }
    // Snapshot at native resolution. No downscaling — full quality.
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95)
    );
    if (!blob) {
      console.error('[camera] toBlob returned null');
      return;
    }
    flashStage();
    counter += 1;
    const counterEl = document.getElementById('cam-fs-counter');
    if (counterEl) counterEl.textContent = `${counter} captured`;
    if (onCaptureCb) {
      try { onCaptureCb(blob, 'image/jpeg', 'photo'); }
      catch (err) { console.error('[camera] onCapture threw:', err); }
    }
    if (mode === 'single') {
      close();
    }
  }

  function onRec() {
    if (!stream) return;
    if (recorder && recorder.state === 'recording') {
      stopVideo();
    } else {
      startVideo();
    }
  }

  function startVideo() {
    if (!stream) return;
    recMime = pickVideoMime();
    try {
      // No artificial bitrate cap — full quality recording per spec.
      recorder = recMime
        ? new MediaRecorder(stream, { mimeType: recMime })
        : new MediaRecorder(stream);
    } catch (err) {
      console.error('[camera] MediaRecorder failed:', err);
      return;
    }
    chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    recorder.onstop = () => {
      const mime = recorder?.mimeType || recMime || 'video/webm';
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      counter += 1;
      const counterEl = document.getElementById('cam-fs-counter');
      if (counterEl) counterEl.textContent = `${counter} captured`;
      hideRecBar();
      if (onCaptureCb && blob.size > 0) {
        try { onCaptureCb(blob, mime, 'video'); }
        catch (err) { console.error('[camera] onCapture (video) threw:', err); }
      }
    };
    recorder.start(1000);
    recStartTs = Date.now();
    document.getElementById('cam-fs-rec')?.classList.add('recording');
    showRecBar();
  }

  function stopVideo() {
    if (!recorder || recorder.state === 'inactive') return;
    try { recorder.stop(); } catch (e) { /* ignore */ }
    document.getElementById('cam-fs-rec')?.classList.remove('recording');
  }

  function showRecBar() {
    const bar = document.getElementById('cam-fs-rec-bar');
    if (!bar) return;
    bar.hidden = false;
    bar.querySelector('.rec-time').textContent = '0:00';
    if (recTimerHandle) clearInterval(recTimerHandle);
    recTimerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - recStartTs) / 1000);
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      const el = bar.querySelector('.rec-time');
      if (el) el.textContent = `${mm}:${ss}`;
    }, 250);
  }

  function hideRecBar() {
    const bar = document.getElementById('cam-fs-rec-bar');
    if (bar) bar.hidden = true;
    if (recTimerHandle) { clearInterval(recTimerHandle); recTimerHandle = null; }
  }

  function flashStage() {
    const stage = document.getElementById('cam-fs');
    if (!stage) return;
    stage.classList.add('flash');
    setTimeout(() => stage.classList.remove('flash'), 200);
  }

  function close(opts = {}) {
    if (!isOpen || closing) return;
    closing = true;

    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    recorder = null;
    chunks = [];
    if (recTimerHandle) { clearInterval(recTimerHandle); recTimerHandle = null; }

    if (stream) {
      stream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) { /* ignore */ }
      });
      stream = null;
    }

    if (popstateListener) {
      window.removeEventListener('popstate', popstateListener);
      popstateListener = null;
    }
    if (!opts.fromPop) {
      // X tapped: pop the history entry we pushed on open.
      try { history.back(); } catch (e) { /* ignore */ }
    }

    root().innerHTML = '';
    document.body.classList.remove('camera-fs-open');
    isOpen = false;
    closing = false;
    counter = 0;

    const cb = onCloseCb;
    onCaptureCb = null;
    onCloseCb = null;
    if (cb) { try { cb(); } catch (err) { console.error('[camera] onClose threw:', err); } }
  }

  function isCameraOpen() { return isOpen; }

  return {
    open,
    close,
    checkPermission,
    isOpen: isCameraOpen
  };
})();
