// Fullscreen camera overlay.
//   - PHOTO | VIDEO pill toggle above a single capture button
//   - Photo mode: white outer ring + white inner circle. Tap = still frame.
//   - Video mode: white outer ring + red inner circle. Tap = start; the
//     inner shape animates to a rounded square and the outer ring pulses.
//     Tap again = stop.
//   - Permission preflight via navigator.permissions.query — no prompts
//     for a granted state, clear "how to enable" panel for denied.
//   - history.pushState / popstate so the browser Back gesture closes us.
window.Camera = (function () {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recMime = '';
  let recStartTs = 0;
  let recTimerHandle = null;
  let counter = 0;
  let mode = 'photo'; // 'photo' | 'video'
  let isOpen = false;
  let closing = false;
  let onCaptureCb = null;
  let onCloseCb = null;
  let popstateListener = null;
  let singleShot = false;

  function root() { return document.getElementById('overlay-root'); }

  // Prefer MP4 (H264 + AAC). Drive treats MP4 with H264 as native and serves
  // it back for streaming within seconds; WebM forces a slow transcode that
  // can take many minutes. Plain 'video/mp4' is checked first because some
  // Safari builds reject codec-specific strings while accepting the generic
  // form. WebM is only the absolute fallback (Chrome desktop / Android).
  function pickVideoMime() {
    const candidates = [
      'video/mp4',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
        console.log('[camera] selected video mime:', m);
        return m;
      }
    }
    console.warn('[camera] no preferred video mime supported — falling back to MediaRecorder default');
    return '';
  }

  async function checkPermission(name) {
    if (!navigator.permissions?.query) return 'unknown';
    try {
      const status = await navigator.permissions.query({ name });
      return status.state; // 'granted' | 'denied' | 'prompt'
    } catch (e) { return 'unknown'; }
  }

  // Always acquire a fresh stream. No cache, no TTL — when the camera
  // overlay closes, the tracks stop immediately and the OS privacy
  // indicator turns off. Permissions are persisted by the BROWSER once
  // the app is installed as a PWA (handled by the install hint flow);
  // we no longer try to keep a stream alive across overlay opens.
  async function acquireStream({ wantAudio }) {
    console.log('[camera] acquiring fresh stream');
    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 4096 },
        height: { ideal: 2160 }
      },
      audio: wantAudio
    });
  }

  // releaseStream is exposed for backwards-compat; with no cache this is
  // a no-op. The local stream is stopped inside close().
  function releaseStream() { /* no-op — no cached stream to release */ }

  async function open(opts = {}) {
    if (isOpen) return;
    isOpen = true;
    closing = false;
    onCaptureCb = opts.onCapture || null;
    onCloseCb = opts.onClose || null;
    singleShot = opts.mode === 'single';
    counter = 0;
    mode = 'photo'; // always start in photo mode

    document.body.classList.add('camera-fs-open');

    root().innerHTML = `
      <div class="camera-fs" id="cam-fs">
        <video id="cam-fs-video" playsinline autoplay muted></video>
        <div id="cam-fs-error" class="cam-fs-error" hidden></div>

        <div class="cam-fs-top">
          <button id="cam-fs-close" class="cam-fs-icon" aria-label="Close">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M6 6 L18 18"/><path d="M18 6 L6 18"/>
            </svg>
          </button>
          <div id="cam-fs-rec-bar" class="cam-fs-rec" hidden>
            <span class="rec-dot"></span>
            <span class="rec-time">0:00</span>
          </div>
          <div class="cam-fs-counter" id="cam-fs-counter">${counter}</div>
        </div>

        <div class="cam-fs-bottom">
          ${singleShot ? '' : `
            <div class="cam-mode-toggle" id="cam-mode-toggle" role="tablist">
              <button class="cam-mode-btn active" data-mode="photo">PHOTO</button>
              <button class="cam-mode-btn" data-mode="video">VIDEO</button>
            </div>
          `}
          <button class="cam-btn ${mode}" id="cam-btn" aria-label="Capture">
            <span class="cam-btn-inner"></span>
          </button>
        </div>
      </div>
    `;

    document.getElementById('cam-fs-close').addEventListener('click', () => close());
    document.getElementById('cam-btn').addEventListener('click', onCaptureTap);
    if (!singleShot) {
      root().querySelectorAll('[data-mode]').forEach((b) => {
        b.addEventListener('click', () => setMode(b.dataset.mode));
      });
    }

    history.pushState({ overlay: 'camera' }, '');
    popstateListener = () => close({ fromPop: true });
    window.addEventListener('popstate', popstateListener);

    // Permission preflight — short-circuit denied with a clear panel.
    const camPerm = await checkPermission('camera');
    console.log('[camera] permission state:', camPerm);
    if (camPerm === 'denied') {
      showDenied();
      return;
    }

    try {
      stream = await acquireStream({ wantAudio: !singleShot });
    } catch (err) {
      console.error('[camera] getUserMedia failed:', err);
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') showDenied();
      else showError(err.message || err.name || 'Camera unavailable');
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

  function setMode(m) {
    if (m === mode) return;
    if (recorder && recorder.state === 'recording') return; // can't change mid-record
    mode = m;
    const btn = document.getElementById('cam-btn');
    if (btn) {
      btn.classList.remove('photo', 'video');
      btn.classList.add(mode);
    }
    root().querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function onCaptureTap() {
    if (mode === 'photo') return takePhoto();
    // video mode
    if (!recorder || recorder.state === 'inactive') startVideo();
    else stopVideo();
  }

  async function takePhoto() {
    if (!stream) return;
    if (recorder && recorder.state === 'recording') return;
    const video = document.getElementById('cam-fs-video');
    if (!video || !video.videoWidth) {
      await new Promise((r) => setTimeout(r, 120));
      if (!video.videoWidth) { console.warn('[camera] not ready'); return; }
    }
    // Native sensor resolution — no downscaling.
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95)
    );
    if (!blob) { console.error('[camera] toBlob returned null'); return; }
    flashStage();
    counter += 1;
    const counterEl = document.getElementById('cam-fs-counter');
    if (counterEl) counterEl.textContent = String(counter);
    if (onCaptureCb) {
      try { onCaptureCb(blob, 'image/jpeg', 'photo'); }
      catch (err) { console.error('[camera] onCapture threw:', err); }
    }
    if (singleShot) close();
  }

  function startVideo() {
    if (!stream) return;
    recMime = pickVideoMime();
    try {
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
      if (counterEl) counterEl.textContent = String(counter);
      hideRecBar();
      document.getElementById('cam-btn')?.classList.remove('recording');
      if (onCaptureCb && blob.size > 0) {
        try { onCaptureCb(blob, mime, 'video'); }
        catch (err) { console.error('[camera] onCapture (video) threw:', err); }
      }
    };
    recorder.start(1000);
    recStartTs = Date.now();
    document.getElementById('cam-btn')?.classList.add('recording');
    showRecBar();
  }

  function stopVideo() {
    if (!recorder || recorder.state === 'inactive') return;
    try { recorder.stop(); } catch (e) { /* ignore */ }
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

  function close(opts = {}) {
    if (!isOpen || closing) return;
    closing = true;

    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    recorder = null;
    chunks = [];
    if (recTimerHandle) { clearInterval(recTimerHandle); recTimerHandle = null; }

    // Stop every track immediately so the OS privacy indicator turns off
    // the moment the overlay closes (the source of the "indicator stays
    // on after exit" bug).
    if (stream) {
      stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
      stream = null;
    }
    // Detach from the <video> element too; some browsers keep the tracks
    // alive while the element holds the MediaStream reference.
    const videoEl = document.getElementById('cam-fs-video');
    if (videoEl) {
      try { videoEl.srcObject = null; } catch (e) { /* ignore */ }
    }

    if (popstateListener) {
      window.removeEventListener('popstate', popstateListener);
      popstateListener = null;
    }
    if (!opts.fromPop) { try { history.back(); } catch (e) { /* ignore */ } }

    root().innerHTML = '';
    document.body.classList.remove('camera-fs-open');
    isOpen = false;
    closing = false;
    counter = 0;
    mode = 'photo';
    singleShot = false;

    const cb = onCloseCb;
    onCaptureCb = null;
    onCloseCb = null;
    if (cb) { try { cb(); } catch (err) { console.error('[camera] onClose threw:', err); } }
  }

  return {
    open,
    close,
    checkPermission,
    releaseStream, // call on signOut / leave-project / pagehide
    isOpen: () => isOpen
  };
})();
