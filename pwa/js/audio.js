// Voice-note recorder. Modal with big record/stop button and live duration.
window.AudioNote = (function () {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recMime = '';
  let startTs = 0;
  let timerHandle = null;
  let onCaptureCb = null;
  let onCloseCb = null;

  function root() { return document.getElementById('overlay-root'); }

  function pickAudioMime() {
    const candidates = [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm'
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async function open({ onCapture, onClose }) {
    onCaptureCb = onCapture;
    onCloseCb = onClose;
    document.body.classList.add('camera-open');
    root().innerHTML = `
      <div class="audio-overlay">
        <div class="audio-card">
          <div class="audio-title">Voice Note</div>
          <div class="audio-time" id="audio-time">0:00</div>
          <button class="audio-rec-btn" id="audio-rec" aria-label="Record"></button>
          <div class="audio-status" id="audio-status">Tap to record</div>
          <div class="audio-actions">
            <button class="btn-secondary" id="audio-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('audio-rec').addEventListener('click', toggle);
    document.getElementById('audio-cancel').addEventListener('click', close);
  }

  async function toggle() {
    if (!recorder || recorder.state === 'inactive') {
      await start();
    } else {
      stop();
    }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      window.UI.toast(`Mic error: ${err.message || err.name}`, 'error');
      return;
    }
    recMime = pickAudioMime();
    try {
      recorder = recMime
        ? new MediaRecorder(stream, { mimeType: recMime })
        : new MediaRecorder(stream);
    } catch (err) {
      window.UI.toast(`Audio not supported: ${err.message}`, 'error');
      return;
    }
    chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    recorder.onstop = () => {
      const mime = recorder.mimeType || recMime || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      stopStream();
      if (onCaptureCb) onCaptureCb(blob, mime, 'audio');
      // Auto-close after capture so a second tap on Voice Note starts fresh.
      close();
    };
    recorder.start(500);
    startTs = Date.now();
    document.getElementById('audio-rec').classList.add('recording');
    document.getElementById('audio-status').textContent = 'Recording — tap to stop';
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(updateTime, 200);
  }

  function updateTime() {
    const s = Math.floor((Date.now() - startTs) / 1000);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    const el = document.getElementById('audio-time');
    if (el) el.textContent = `${mm}:${ss}`;
  }

  function stop() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    document.getElementById('audio-rec')?.classList.remove('recording');
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  function close() {
    stop();
    stopStream();
    root().innerHTML = '';
    document.body.classList.remove('camera-open');
    const cb = onCloseCb;
    onCaptureCb = null;
    onCloseCb = null;
    if (cb) cb();
  }

  return { open };
})();
