// Continuous in-app camera (photo + video). Opens a fullscreen viewfinder over
// the app, fires onCapture(blob, mimeType) for each shot, keeps stream alive
// so the tech can hammer the shutter without re-opening the camera.
window.Camera = (function () {
  let stream = null;
  let mode = 'photo'; // 'photo' | 'video'
  let recorder = null;
  let recorderChunks = [];
  let recorderMime = '';
  let facing = 'environment';
  let onCaptureCb = null;
  let onCloseCb = null;
  let lastThumbDataUrl = null;
  let captureCount = 0;
  let videoStartTs = 0;
  let timerHandle = null;

  function root() { return document.getElementById('overlay-root'); }

  async function startStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    const constraints = {
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: mode === 'video'
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('cam-preview');
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => {});
    }
  }

  function stopStream() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    recorder = null;
    recorderChunks = [];
  }

  function close() {
    stopStream();
    root().innerHTML = '';
    document.body.classList.remove('camera-open');
    const cb = onCloseCb;
    onCaptureCb = null;
    onCloseCb = null;
    if (cb) cb({ count: captureCount });
    captureCount = 0;
    lastThumbDataUrl = null;
  }

  async function open({ kind, onCapture, onClose }) {
    mode = kind === 'video' ? 'video' : 'photo';
    onCaptureCb = onCapture;
    onCloseCb = onClose;
    captureCount = 0;
    lastThumbDataUrl = null;

    document.body.classList.add('camera-open');
    root().innerHTML = `
      <div class="cam-overlay" id="cam-overlay">
        <video id="cam-preview" playsinline autoplay muted></video>
        <canvas id="cam-canvas" hidden></canvas>

        <div class="cam-top">
          <button class="cam-icon-btn" id="cam-close" aria-label="Close">✕</button>
          <div class="cam-mode-label" id="cam-mode-label">${mode === 'video' ? 'VIDEO' : 'PHOTO'}</div>
          <button class="cam-icon-btn" id="cam-flip" aria-label="Switch camera">⟳</button>
        </div>

        <div class="cam-rec-bar" id="cam-rec-bar" hidden>
          <span class="rec-dot"></span>
          <span id="cam-rec-time">0:00</span>
        </div>

        <div class="cam-bottom">
          <div class="cam-thumb" id="cam-thumb"></div>
          <button class="cam-shutter ${mode === 'video' ? 'video' : ''}" id="cam-shutter" aria-label="Capture"></button>
          <div class="cam-counter" id="cam-counter">0</div>
        </div>
      </div>
    `;

    document.getElementById('cam-close').addEventListener('click', close);
    document.getElementById('cam-flip').addEventListener('click', flipCamera);
    document.getElementById('cam-shutter').addEventListener('click', onShutter);

    try {
      await startStream();
    } catch (err) {
      window.UI.toast(`Camera error: ${err.message || err.name}`, 'error');
      close();
    }
  }

  async function flipCamera() {
    if (recorder && recorder.state === 'recording') return;
    facing = facing === 'environment' ? 'user' : 'environment';
    try { await startStream(); }
    catch (err) {
      window.UI.toast(`Camera flip failed: ${err.message}`, 'error');
    }
  }

  function onShutter() {
    if (mode === 'photo') return capturePhoto();
    // video
    if (!recorder || recorder.state === 'inactive') return startVideoRecording();
    return stopVideoRecording();
  }

  // -------- Photo --------
  async function capturePhoto() {
    const video = document.getElementById('cam-preview');
    if (!video || !video.videoWidth) return;

    const canvas = document.getElementById('cam-canvas');
    const max = window.CONFIG.PHOTO_MAX_DIMENSION;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, max / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', window.CONFIG.PHOTO_JPEG_QUALITY)
    );
    if (!blob) return;

    flashScreen();
    bumpCounter();
    updateThumb(canvas.toDataURL('image/jpeg', 0.4));

    if (onCaptureCb) onCaptureCb(blob, 'image/jpeg', 'photo');
  }

  function flashScreen() {
    const overlay = document.getElementById('cam-overlay');
    if (!overlay) return;
    overlay.classList.add('flash');
    setTimeout(() => overlay.classList.remove('flash'), 120);
  }

  function bumpCounter() {
    captureCount += 1;
    const el = document.getElementById('cam-counter');
    if (el) el.textContent = String(captureCount);
  }

  function updateThumb(dataUrl) {
    lastThumbDataUrl = dataUrl;
    const thumb = document.getElementById('cam-thumb');
    if (thumb) thumb.style.backgroundImage = `url('${dataUrl}')`;
  }

  // -------- Video --------
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

  function startVideoRecording() {
    if (!stream) return;
    recorderMime = pickVideoMime();
    try {
      recorder = recorderMime
        ? new MediaRecorder(stream, { mimeType: recorderMime })
        : new MediaRecorder(stream);
    } catch (err) {
      window.UI.toast(`Video not supported: ${err.message}`, 'error');
      return;
    }
    recorderChunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) recorderChunks.push(ev.data);
    };
    recorder.onstop = () => {
      const mime = recorder.mimeType || recorderMime || 'video/webm';
      const blob = new Blob(recorderChunks, { type: mime });
      recorderChunks = [];
      bumpCounter();
      hideRecBar();
      if (onCaptureCb) onCaptureCb(blob, mime, 'video');
    };
    recorder.start(1000); // gather chunks every second so a crash loses ≤1s
    showRecBar();
    document.getElementById('cam-shutter').classList.add('recording');
  }

  function stopVideoRecording() {
    if (!recorder) return;
    try { recorder.stop(); } catch (e) { /* ignore */ }
    document.getElementById('cam-shutter')?.classList.remove('recording');
  }

  function showRecBar() {
    const bar = document.getElementById('cam-rec-bar');
    if (!bar) return;
    bar.hidden = false;
    videoStartTs = Date.now();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - videoStartTs) / 1000);
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      const el = document.getElementById('cam-rec-time');
      if (el) el.textContent = `${mm}:${ss}`;
    }, 250);
  }

  function hideRecBar() {
    const bar = document.getElementById('cam-rec-bar');
    if (bar) bar.hidden = true;
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  return { open, close };
})();
