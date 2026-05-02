// Voice-note recorder modal.
//
// iOS quirk: Safari only allows ONE active microphone capture at a time.
// The inline camera stream already holds the mic (so video recording
// works), so the caller MUST detach the camera before opening this
// overlay — otherwise getUserMedia either rejects or returns a stream
// whose recorder never fires onstop. App.js handles detach/reattach.
//
// Verbose console.log output is intentional (prefix "[voice]") so we
// can trace exactly where a recording is failing.
window.AudioNote = (function () {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recMime = '';
  let startTs = 0;
  let timerHandle = null;
  let onCaptureCb = null;
  let onCloseCb = null;
  let pendingStopGuard = null;
  let isRecording = false;
  let captureFiredFor = false; // poison-pill so onstop won't double-fire

  function root() { return document.getElementById('overlay-root'); }

  function pickAudioMime() {
    const candidates = [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm'
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
        console.log('[voice] picked mime:', m);
        return m;
      }
    }
    console.log('[voice] no preferred mime supported, using default');
    return '';
  }

  function open({ onCapture, onClose }) {
    console.log('[voice] open()');
    onCaptureCb = onCapture;
    onCloseCb = onClose;
    captureFiredFor = false;
    isRecording = false;

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
    document.getElementById('audio-cancel').addEventListener('click', cancel);
  }

  async function toggle() {
    console.log('[voice] toggle clicked. recording?', isRecording);
    if (!isRecording) await start();
    else await stopAndSave();
  }

  async function start() {
    console.log('[voice] start() — requesting mic via getUserMedia');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getAudioTracks();
      console.log('[voice] mic stream OK; audio tracks:', tracks.length, 'state:', tracks[0]?.readyState);
    } catch (err) {
      console.error('[voice] getUserMedia rejected:', err);
      window.UI.toast(`Mic error: ${err.message || err.name}`, 'error');
      return;
    }
    recMime = pickAudioMime();
    try {
      recorder = recMime
        ? new MediaRecorder(stream, { mimeType: recMime, audioBitsPerSecond: 96_000 })
        : new MediaRecorder(stream);
      console.log('[voice] MediaRecorder created. effective mimeType:', recorder.mimeType);
    } catch (err) {
      console.error('[voice] MediaRecorder construction failed:', err);
      window.UI.toast(`Audio not supported: ${err.message}`, 'error');
      return;
    }
    chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) {
        chunks.push(ev.data);
        console.log('[voice] dataavailable chunk:', ev.data.size, 'bytes; total chunks:', chunks.length);
      }
    };
    recorder.onerror = (ev) => console.error('[voice] recorder.onerror:', ev.error || ev);
    recorder.onstart = () => console.log('[voice] recorder.onstart');
    recorder.onstop = handleRecorderStop;

    recorder.start(1000);
    isRecording = true;
    startTs = Date.now();
    document.getElementById('audio-rec')?.classList.add('recording');
    const status = document.getElementById('audio-status');
    if (status) status.textContent = 'Recording — tap to stop';
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

  function handleRecorderStop() {
    console.log('[voice] recorder.onstop — building blob from', chunks.length, 'chunks');
    if (pendingStopGuard) { clearTimeout(pendingStopGuard); pendingStopGuard = null; }
    const mime = recorder?.mimeType || recMime || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });
    const durationMs = startTs ? Date.now() - startTs : 0;
    chunks = [];
    console.log('[voice] blob ready —', blob.size, 'bytes,', mime, 'duration', durationMs, 'ms');
    stopStream();
    if (!captureFiredFor && onCaptureCb && blob.size > 0) {
      captureFiredFor = true;
      console.log('[voice] firing onCaptureCb');
      try { onCaptureCb(blob, mime, 'audio', { durationMs }); }
      catch (err) { console.error('[voice] onCaptureCb threw:', err); }
    } else if (blob.size === 0) {
      console.warn('[voice] empty blob — not saving');
    }
    finalizeClose();
  }

  async function stopAndSave() {
    console.log('[voice] stopAndSave() — calling recorder.stop()');
    isRecording = false;
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    document.getElementById('audio-rec')?.classList.remove('recording');
    const status = document.getElementById('audio-status');
    if (status) status.textContent = 'Saving…';

    if (!recorder || recorder.state === 'inactive') {
      console.warn('[voice] stop called but recorder not active — building from chunks anyway');
      handleRecorderStop();
      return;
    }
    // Safety net: some Safari builds occasionally don't fire onstop after a
    // slow track teardown. After 3s, force-build the blob from chunks.
    pendingStopGuard = setTimeout(() => {
      console.warn('[voice] onstop did not fire in time — forcing blob build');
      pendingStopGuard = null;
      handleRecorderStop();
    }, 3000);

    try { recorder.stop(); }
    catch (err) {
      console.error('[voice] recorder.stop() threw:', err);
      handleRecorderStop();
    }
  }

  function cancel() {
    console.log('[voice] cancel() — discarding any recording');
    captureFiredFor = true; // poison the onstop save path
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    stopStream();
    finalizeClose();
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) { /* ignore */ }
      });
      stream = null;
    }
  }

  function finalizeClose() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (pendingStopGuard) { clearTimeout(pendingStopGuard); pendingStopGuard = null; }
    isRecording = false;
    root().innerHTML = '';
    document.body.classList.remove('camera-open');
    const cb = onCloseCb;
    onCaptureCb = null;
    onCloseCb = null;
    recorder = null;
    if (cb) {
      console.log('[voice] running onClose callback');
      try { cb(); } catch (err) { console.error('[voice] onClose threw:', err); }
    }
  }

  return { open };
})();
