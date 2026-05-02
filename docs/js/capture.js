// Inline camera controller. The caller owns the <video> element and the UI
// chrome (shutter, record button, indicators); this module just manages the
// MediaStream + MediaRecorder lifecycle and produces Blobs.
//
// Usage:
//   const cam = await Camera.attach(videoEl, { withAudio: true });
//   const photo = await cam.takePhoto();
//   await cam.startVideo();
//   const video = await cam.stopVideo();
//   cam.stop();
window.Camera = (function () {

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

  async function attach(videoEl, opts = {}) {
    const withAudio = opts.withAudio !== false;
    const facing = opts.facing || 'environment';

    const constraints = {
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: withAudio
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (withAudio) {
        // Fall back to video-only if mic permission is the blocker.
        stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false });
      } else {
        throw err;
      }
    }

    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    try { await videoEl.play(); } catch (e) { /* iOS may need a user-gesture retry */ }

    let recorder = null;
    let chunks = [];
    let recMime = '';
    let stopResolver = null;

    function isRecording() {
      return !!recorder && recorder.state === 'recording';
    }

    async function takePhoto() {
      if (!videoEl.videoWidth) {
        await new Promise((r) => setTimeout(r, 100));
        if (!videoEl.videoWidth) throw new Error('Camera not ready');
      }
      const max = window.CONFIG.PHOTO_MAX_DIMENSION;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      const scale = Math.min(1, max / Math.max(vw, vh));
      const cw = Math.round(vw * scale);
      const ch = Math.round(vh * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(videoEl, 0, 0, cw, ch);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', window.CONFIG.PHOTO_JPEG_QUALITY)
      );
      if (!blob) throw new Error('Could not encode photo');
      return blob;
    }

    function startVideo() {
      if (isRecording()) return;
      recMime = pickVideoMime();
      recorder = recMime
        ? new MediaRecorder(stream, { mimeType: recMime })
        : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        const mime = recorder.mimeType || recMime || 'video/webm';
        const blob = new Blob(chunks, { type: mime });
        chunks = [];
        if (stopResolver) {
          stopResolver({ blob, mime });
          stopResolver = null;
        }
      };
      recorder.start(1000);
    }

    function stopVideo() {
      return new Promise((resolve, reject) => {
        if (!recorder || recorder.state === 'inactive') {
          return reject(new Error('Not recording'));
        }
        stopResolver = resolve;
        try { recorder.stop(); }
        catch (err) { reject(err); }
      });
    }

    function stop() {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
      catch (e) { /* ignore */ }
      recorder = null;
      stream.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    }

    return {
      takePhoto,
      startVideo,
      stopVideo,
      stop,
      get isRecording() { return isRecording(); },
      get stream() { return stream; }
    };
  }

  return { attach };
})();
