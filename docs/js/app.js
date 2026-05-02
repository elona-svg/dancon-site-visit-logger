// Top-level app: state, screens, queue runner, glue between modules.
//
// Render strategy: render() only replaces the screen shell on view change.
// Same-view state updates run targeted DOM mutations instead of clobbering
// the whole tree — this is what keeps the home input from losing focus on
// every keystroke (and what keeps the inline <video> mounted across notes
// saves, online/offline events, and token refreshes).
(function () {
  let UI;
  try {
    UI = window.UI;
    if (!UI || !window.DB || !window.Auth || !window.Drive || !window.Camera || !window.AudioNote || !window.Annotate || !window.Viewer) {
      throw new Error('A required module failed to load. Reload the page.');
    }
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="error-screen"><h2>Could not start</h2><p class="muted">${
        (err && err.message) || 'Module load failed'
      }</p><p class="muted small">Pull to refresh, or hard-reload the page.</p></div>`;
    return;
  }

  const { escapeHtml, fmtTimestampForFilename, fmtDateTime, fmtBytes, fmtRelative, toast } = UI;

  const MAX_CONCURRENT_UPLOADS = 3;

  const state = {
    user: null,
    isOnline: navigator.onLine,
    booting: true,
    initError: null,

    currentProjectId: null,
    currentProjectName: null,

    projects: [],
    projectsLoading: false,
    projectFilter: '',

    cam: null,
    camError: null,
    camAttaching: false,
    camCounter: 0,
    camRecording: false,
    recStartTs: 0,
    recTimerHandle: null,

    thumbs: [],
    thumbsLoading: false,

    notesEntries: [],
    notesFileId: null,
    notesLoading: false,

    gps: null,            // { lat, lng, link } once known for current folder
    gpsLoading: false,

    galleryFiles: [],
    galleryLoading: false,

    view: 'login'
  };

  const inflight = new Map();
  let queuePumpScheduled = false;
  let _renderHandle = null;
  let renderedFlag = '';

  function scheduleRender() {
    if (_renderHandle) return;
    _renderHandle = requestAnimationFrame(() => {
      _renderHandle = null;
      render();
    });
  }

  // ---------- Boot ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  async function boot() {
    const safety = setTimeout(() => {
      if (state.booting) {
        state.booting = false;
        if (!state.user) state.view = 'login';
        scheduleRender();
        console.warn('Boot safety timeout fired');
      }
    }, 8000);

    try {
      await window.DB.open();
      await window.Auth.init();
      window.Auth.onChange(({ user }) => {
        const wasUser = !!state.user;
        state.user = user;
        if (!user && state.view !== 'login') {
          state.view = 'login';
          scheduleRender();
        } else if (state.view === 'home') {
          updateHomeTopbar();
        } else if (state.view === 'capture') {
          updateCaptureTopbar();
        }
      });
      state.user = window.Auth.getUser();
      if (state.user && !window.Auth.isSignedIn()) {
        try { await window.Auth.getAccessToken(); }
        catch (e) { /* user must click Sign in */ }
      }
      state.view = state.user && window.Auth.isSignedIn() ? 'home' : 'login';
      state.booting = false;
      scheduleRender();
      if (state.view === 'home') loadProjects();
      // Reset items left in 'uploading' from a previous run (e.g. a tab
      // close mid-upload). Without this they'd be invisible to pumpQueue
      // which only picks up 'pending'/'error' rows.
      try {
        const all = await window.DB.queueAll();
        for (const item of all) {
          if (item.status === 'uploading') {
            await window.DB.queueUpdate(item.id, { status: 'pending' });
          }
        }
      } catch (e) { /* ignore */ }
      pumpQueue();
    } catch (err) {
      console.error('Boot failed:', err);
      state.booting = false;
      state.initError = err.message || String(err);
      scheduleRender();
    } finally {
      clearTimeout(safety);
    }
  }

  // Network / lifecycle
  window.addEventListener('online', () => {
    state.isOnline = true;
    toast('Back online — resuming uploads', 'info');
    pumpQueue();
    updateOnlineBadges();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    toast('Offline — captures will queue', 'warn');
    updateOnlineBadges();
  });
  // Stop the camera the moment the page goes background — iOS keeps the
  // green/orange privacy indicator on otherwise.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.view === 'capture') {
      detachCamera({ silent: true });
    } else if (document.visibilityState === 'visible' && state.view === 'capture' && !state.cam) {
      attachCamera();
    }
  });
  window.addEventListener('pagehide', () => {
    detachCamera({ silent: true });
  });

  // ---------- Auth handlers ----------
  async function onSignInClick() {
    try {
      await window.Auth.signIn();
      state.user = window.Auth.getUser();
      state.view = 'home';
      scheduleRender();
      loadProjects();
      pumpQueue();
    } catch (err) {
      toast(err.message || 'Sign in failed', 'error', 6000);
    }
  }
  async function onSignOutClick() {
    detachCamera({ silent: true });
    await window.Auth.signOut();
    state.user = null;
    state.currentProjectId = null;
    state.currentProjectName = null;
    state.view = 'login';
    state.projects = [];
    scheduleRender();
  }

  // ---------- Projects ----------
  async function loadProjects() {
    state.projectsLoading = true;
    updateRecentList();
    try {
      const folders = await window.Drive.listProjectFolders({ pageSize: 200 });
      state.projects = folders;
    } catch (err) {
      console.error(err);
      toast(`Could not list projects: ${err.message}`, 'error');
    } finally {
      state.projectsLoading = false;
      updateRecentList();
    }
  }

  async function openOrCreateProject(rawName) {
    const name = window.Drive.sanitizeFolderName(rawName);
    if (!name) { toast('Type a project name', 'warn'); return; }
    try {
      const { id, name: actualName, created } = await window.Drive.ensureProjectFolder(name);
      enterProject(id, actualName, { created });
    } catch (err) {
      console.error(err);
      toast(`Could not open project: ${err.message}`, 'error', 6000);
    }
  }

  async function enterProject(id, name, { created = false } = {}) {
    state.currentProjectId = id;
    state.currentProjectName = name;
    state.view = 'capture';
    state.thumbs = [];
    state.thumbsLoading = true;
    state.notesEntries = [];
    state.notesFileId = null;
    state.notesLoading = true;
    state.gps = null;
    state.gpsLoading = true;
    state.camCounter = 0;
    state.projectFilter = '';
    scheduleRender();
    if (created) toast(`Created "${name}"`, 'info');

    try {
      const cached = await window.DB.kvGet(`notesFileId:${id}`);
      if (cached) state.notesFileId = cached;
    } catch { /* ignore */ }

    refreshProjectMedia();
    refreshProjectNotes();
    loadOrCaptureGPS(id, name);
  }

  function leaveProject() {
    detachCamera({ silent: true });
    state.currentProjectId = null;
    state.currentProjectName = null;
    state.thumbs.forEach(revokeThumbBlob);
    state.thumbs = [];
    state.notesEntries = [];
    state.gps = null;
    state.view = 'home';
    scheduleRender();
    loadProjects();
  }

  // ---------- GPS ----------
  async function loadOrCaptureGPS(folderId) {
    state.gps = null;
    state.gpsLoading = true;
    updateGpsChipDOM();

    let existing = null;
    try { existing = await window.Drive.findFileInFolder(folderId, 'gps.txt'); }
    catch (err) { console.warn('GPS check failed:', err.message); }

    if (existing) {
      try {
        const text = await window.Drive.downloadFileText(existing.id);
        const lat = (text.match(/Latitude:\s*([-\d.]+)/) || [])[1];
        const lng = (text.match(/Longitude:\s*([-\d.]+)/) || [])[1];
        if (lat && lng) {
          state.gps = {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            link: `https://maps.google.com/?q=${lat},${lng}`
          };
        }
      } catch (e) { /* ignore */ }
      state.gpsLoading = false;
      updateGpsChipDOM();
      return;
    }

    if (!('geolocation' in navigator)) {
      state.gpsLoading = false;
      updateGpsChipDOM();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const link = `https://maps.google.com/?q=${latitude},${longitude}`;
        const text =
          `Captured: ${new Date().toISOString()}\n` +
          `Tech: ${state.user?.name || 'unknown'}\n` +
          `Latitude: ${latitude}\n` +
          `Longitude: ${longitude}\n` +
          `Accuracy (m): ${Math.round(accuracy)}\n` +
          `Maps link: ${link}\n`;
        try {
          const recheck = await window.Drive.findFileInFolder(folderId, 'gps.txt');
          if (!recheck) {
            await window.Drive.uploadMultipart({
              folderId,
              fileName: 'gps.txt',
              mimeType: 'text/plain',
              blob: new Blob([text], { type: 'text/plain' })
            });
            await appendVisitLog(folderId, 'captured GPS');
          }
        } catch (err) {
          console.warn('GPS save failed:', err.message);
        }
        state.gps = { lat: latitude, lng: longitude, link };
        state.gpsLoading = false;
        updateGpsChipDOM();
      },
      (err) => {
        console.warn('GPS denied:', err.message);
        state.gpsLoading = false;
        updateGpsChipDOM();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  // ---------- Visit log + filenames ----------
  async function appendVisitLog(folderId, summary) {
    const line = `${fmtDateTime()} — ${state.user?.name || 'unknown'} — ${summary}\n`;
    try {
      const cachedKey = `visitLogId:${folderId}`;
      const cached = await window.DB.kvGet(cachedKey);
      const result = await window.Drive.appendToTextFile({
        folderId,
        fileName: 'visit_log.txt',
        lineOrText: line,
        cachedFileId: cached || null
      });
      if (result?.id && result.id !== cached) {
        await window.DB.kvSet(cachedKey, result.id);
      }
    } catch (err) {
      console.warn('visit_log append failed:', err.message);
    }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  async function nextFileName(folderId, ext) {
    const today = new Date();
    const dayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    const counterKey = `seq:${folderId}:${dayKey}`;
    const current = (await window.DB.kvGet(counterKey)) || 0;
    const next = current + 1;
    await window.DB.kvSet(counterKey, next);
    const stamp = fmtTimestampForFilename(today);
    const first = (state.user?.firstName || 'Tech').replace(/[^A-Za-z0-9]/g, '');
    const seq = String(next).padStart(3, '0');
    return `${stamp}_${first}_${seq}.${ext}`;
  }

  function extFromMime(mime) {
    if (!mime) return 'bin';
    if (mime.startsWith('image/jpeg')) return 'jpg';
    if (mime.startsWith('image/png')) return 'png';
    if (mime.startsWith('image/')) return mime.split('/')[1].split(';')[0] || 'img';
    if (mime.startsWith('video/mp4')) return 'mp4';
    if (mime.startsWith('video/webm')) return 'webm';
    if (mime.startsWith('audio/mp4')) return 'm4a';
    if (mime.startsWith('audio/webm')) return 'webm';
    if (mime.startsWith('audio/')) return mime.split('/')[1].split(';')[0] || 'aud';
    return mime.split('/')[1]?.split(';')[0] || 'bin';
  }

  // ---------- Camera ----------
  async function attachCamera() {
    const videoEl = document.getElementById('cam-video');
    if (!videoEl) return;
    if (state.cam || state.camAttaching) return;
    state.camAttaching = true;
    state.camError = null;
    updateCamErrorDOM();
    try {
      state.cam = await window.Camera.attach(videoEl, { withAudio: true });
    } catch (err) {
      console.warn('Camera attach failed:', err);
      state.camError = err.message || String(err);
      state.cam = null;
    } finally {
      state.camAttaching = false;
      updateCamErrorDOM();
    }
  }

  function detachCamera({ silent = false } = {}) {
    if (state.cam) {
      try { state.cam.stop(); } catch (e) { /* ignore */ }
      state.cam = null;
    }
    if (state.recTimerHandle) { clearInterval(state.recTimerHandle); state.recTimerHandle = null; }
    state.camRecording = false;
    if (!silent) state.camCounter = 0;
    const recBar = document.getElementById('rec-bar');
    if (recBar) recBar.hidden = true;
    document.getElementById('rec-btn')?.classList.remove('recording');
  }

  async function onShutterClick() {
    if (!state.cam) {
      attachCamera();
      return;
    }
    if (state.camRecording) return;
    let blob;
    try { blob = await state.cam.takePhoto(); }
    catch (err) {
      toast(`Photo failed: ${err.message}`, 'error');
      return;
    }
    flashStage();
    state.camCounter += 1;
    updateCamCounterDOM();
    enqueueCapture(blob, blob.type || 'image/jpeg', 'photo');
  }

  async function onRecordClick() {
    if (!state.cam) { attachCamera(); return; }
    if (state.camRecording) {
      const btn = document.getElementById('rec-btn');
      btn?.classList.remove('recording');
      const recBar = document.getElementById('rec-bar');
      if (recBar) recBar.hidden = true;
      if (state.recTimerHandle) { clearInterval(state.recTimerHandle); state.recTimerHandle = null; }
      state.camRecording = false;
      try {
        const { blob, mime } = await state.cam.stopVideo();
        state.camCounter += 1;
        updateCamCounterDOM();
        enqueueCapture(blob, mime, 'video');
      } catch (err) {
        toast(`Video failed: ${err.message}`, 'error');
      }
      return;
    }
    try {
      state.cam.startVideo();
      state.camRecording = true;
      state.recStartTs = Date.now();
      const btn = document.getElementById('rec-btn');
      btn?.classList.add('recording');
      const recBar = document.getElementById('rec-bar');
      if (recBar) {
        recBar.hidden = false;
        recBar.querySelector('.rec-time').textContent = '0:00';
      }
      if (state.recTimerHandle) clearInterval(state.recTimerHandle);
      state.recTimerHandle = setInterval(() => {
        const s = Math.floor((Date.now() - state.recStartTs) / 1000);
        const mm = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, '0');
        const el = document.querySelector('#rec-bar .rec-time');
        if (el) el.textContent = `${mm}:${ss}`;
      }, 250);
    } catch (err) {
      toast(`Could not start recording: ${err.message}`, 'error');
    }
  }

  function flashStage() {
    const stage = document.getElementById('cam-stage');
    if (!stage) return;
    stage.classList.add('flash');
    setTimeout(() => stage.classList.remove('flash'), 220);
  }

  // ---------- Voice & notes ----------
  function startVoiceNote() {
    if (!ensureProject()) return;
    console.log('[voice] startVoiceNote');
    // iOS Safari only allows one mic capture at a time. The camera stream
    // already holds it (audio:true so video records audio), so we MUST
    // release the camera before opening the voice modal — otherwise
    // getUserMedia either rejects or returns a stream whose recorder
    // never fires onstop. We re-attach the camera on close.
    const wasCamAttached = !!state.cam;
    if (wasCamAttached) {
      console.log('[voice] detaching camera so iOS releases the mic');
      detachCamera({ silent: true });
    }
    window.AudioNote.open({
      onCapture: (blob, mime) => {
        console.log('[voice] app.onCapture — blob:', blob?.size, 'mime:', mime);
        enqueueCapture(blob, mime, 'audio');
      },
      onClose: () => {
        console.log('[voice] AudioNote closed; reattach camera?', wasCamAttached, 'view:', state.view);
        if (wasCamAttached && state.view === 'capture') {
          // Small delay lets iOS fully release the audio track before we
          // re-acquire it through the camera stream.
          setTimeout(() => attachCamera(), 250);
        }
      }
    });
  }

  async function saveNote() {
    if (!ensureProject()) return;
    const ta = document.getElementById('notes-textarea');
    const text = ta?.value.trim();
    if (!text) return;
    const folderId = state.currentProjectId;
    const stamp = fmtDateTime();
    const tech = state.user?.name || 'unknown';
    const block = `\n--- ${stamp} — ${tech} ---\n${text}\n`;
    const saveBtn = document.getElementById('save-note-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const result = await window.Drive.appendToTextFile({
        folderId,
        fileName: 'notes.txt',
        lineOrText: block,
        cachedFileId: state.notesFileId
      });
      state.notesFileId = result.id;
      await window.DB.kvSet(`notesFileId:${folderId}`, result.id);
      ta.value = '';
      // Optimistic: prepend the new note to history before refresh fires.
      state.notesEntries.unshift({ ts: stamp, tech, body: text });
      updateNotesHistoryDOM();
      toast('Note saved', 'success');
      appendVisitLog(folderId, 'added text note').catch(() => {});
    } catch (err) {
      toast(`Note save failed: ${err.message}`, 'error', 6000);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function ensureProject() {
    if (!state.currentProjectId) {
      toast('Open a project first', 'warn');
      return false;
    }
    return true;
  }

  // ---------- Capture queue ----------
  async function enqueueCapture(blob, mime, kind) {
    console.log('[capture] enqueueCapture kind=', kind, 'mime=', mime, 'size=', blob?.size, 'project=', state.currentProjectId);
    const folderId = state.currentProjectId;
    const folderName = state.currentProjectName;
    if (!folderId) {
      console.warn('[capture] no project — capture discarded');
      toast('No project — capture discarded', 'error');
      return;
    }
    if (!blob || blob.size === 0) {
      console.warn('[capture] empty blob — capture discarded');
      toast('Empty capture — try again', 'error');
      return;
    }
    const ext = extFromMime(mime);
    const fileName = await nextFileName(folderId, ext);
    console.log('[capture] generated fileName=', fileName, 'ext=', ext);
    const item = await window.DB.queueAdd({
      projectId: folderId,
      projectName: folderName,
      fileName,
      mimeType: mime,
      blob,
      kind,
      status: 'pending',
      attempts: 0
    });
    console.log('[capture] queued id=', item.id);

    const previewUrl = (kind === 'photo' || kind === 'video' || kind === 'audio')
      ? URL.createObjectURL(blob)
      : null;
    const thumb = {
      type: kind,
      src: previewUrl,
      objectUrl: previewUrl,
      name: fileName,
      mime,
      size: blob.size,
      status: 'queued',
      progress: 0,
      queueId: item.id
    };
    state.thumbs.unshift(thumb);
    updateThumbsDOM();
    pumpQueue();
  }

  function patchThumbByQueueId(queueId, patch) {
    const t = state.thumbs.find((x) => x.queueId === queueId);
    if (!t) return;
    Object.assign(t, patch);
    updateThumbsDOM();
  }

  async function pumpQueue() {
    if (queuePumpScheduled) return;
    queuePumpScheduled = true;
    queueMicrotask(async () => {
      queuePumpScheduled = false;
      if (!state.isOnline) return;
      if (!window.Auth.isSignedIn()) {
        try { await window.Auth.getAccessToken(); }
        catch (e) { return; }
      }
      const pending = await window.DB.queuePending();
      const candidates = pending
        .filter((p) => !inflight.has(p.id))
        .sort((a, b) => (a.attempts - b.attempts) || (a.createdAt - b.createdAt));
      while (inflight.size < MAX_CONCURRENT_UPLOADS && candidates.length) {
        const item = candidates.shift();
        startUpload(item);
      }
    });
  }

  function startUpload(item) {
    console.log('[upload] starting id=', item.id, 'name=', item.fileName, 'kind=', item.kind, 'size=', item.blob?.size);
    const promise = (async () => {
      await window.DB.queueUpdate(item.id, { status: 'uploading' });
      patchThumbByQueueId(item.id, { status: 'uploading', progress: 0 });

      try {
        const result = await window.Drive.uploadFile({
          folderId: item.projectId,
          fileName: item.fileName,
          mimeType: item.mimeType,
          blob: item.blob,
          onProgress: (p) => patchThumbByQueueId(item.id, { progress: p })
        });
        console.log('[upload] success id=', item.id, 'driveFileId=', result?.id);
        await window.DB.queueDelete(item.id);
        patchThumbByQueueId(item.id, {
          status: 'success',
          fileId: result?.id || null,
          progress: 1
        });
        appendVisitLog(item.projectId,
          `uploaded ${item.kind || 'file'}: ${item.fileName} (${fmtBytes(item.blob.size)})`
        ).catch(() => {});
      } catch (err) {
        console.error('[upload] failed id=', item.id, err);
        const attempts = (item.attempts || 0) + 1;
        await window.DB.queueUpdate(item.id, {
          status: 'error',
          attempts,
          lastError: err.message || String(err)
        });
        patchThumbByQueueId(item.id, { status: 'failed', error: err.message || String(err) });
      }
    })().finally(() => {
      inflight.delete(item.id);
      pumpQueue();
    });
    inflight.set(item.id, promise);
  }

  async function retryThumb(queueId) {
    if (inflight.has(queueId)) return;
    await window.DB.queueUpdate(queueId, { status: 'pending', attempts: 0, lastError: null });
    patchThumbByQueueId(queueId, { status: 'queued', progress: 0, error: null });
    pumpQueue();
  }

  // ---------- Project media (thumbs + notes) ----------
  async function refreshProjectMedia() {
    if (!state.currentProjectId) return;
    state.thumbsLoading = true;
    updateThumbsDOM();
    try {
      const files = await window.Drive.listFolderFiles(state.currentProjectId);
      const media = files
        .filter((f) =>
          (f.mimeType || '').startsWith('image/') ||
          (f.mimeType || '').startsWith('video/') ||
          (f.mimeType || '').startsWith('audio/')
        )
        .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

      // Preserve in-flight items not yet on Drive.
      const pendingThumbs = state.thumbs.filter((t) => t.status !== 'success' || !t.fileId);
      const driveThumbs = media.map((f) => ({
        type: f.mimeType.startsWith('image/') ? 'photo'
            : f.mimeType.startsWith('video/') ? 'video' : 'audio',
        src: f.thumbnailLink || '',
        name: f.name,
        mime: f.mimeType,
        size: Number(f.size || 0),
        status: 'success',
        fileId: f.id,
        webViewLink: f.webViewLink || ''
      }));
      state.thumbs = [...pendingThumbs, ...driveThumbs];
    } catch (err) {
      console.warn('Could not refresh media:', err.message);
    } finally {
      state.thumbsLoading = false;
      updateThumbsDOM();
    }
  }

  async function refreshProjectNotes() {
    if (!state.currentProjectId) return;
    state.notesLoading = true;
    updateNotesHistoryDOM();
    try {
      let notesFile = null;
      if (state.notesFileId) {
        notesFile = { id: state.notesFileId };
      } else {
        notesFile = await window.Drive.findFileInFolder(state.currentProjectId, 'notes.txt');
        if (notesFile) {
          state.notesFileId = notesFile.id;
          await window.DB.kvSet(`notesFileId:${state.currentProjectId}`, notesFile.id);
        }
      }
      if (!notesFile) {
        state.notesEntries = [];
        return;
      }
      try {
        const text = await window.Drive.downloadFileText(notesFile.id);
        state.notesEntries = parseNotes(text);
      } catch (err) {
        // 404 = stale cache. Other errors = transient — keep cached id.
        if (window.Drive.isNotFound(err)) {
          state.notesFileId = null;
          await window.DB.kvDelete(`notesFileId:${state.currentProjectId}`);
        } else {
          console.warn('Notes load failed (transient):', err.message);
        }
      }
    } finally {
      state.notesLoading = false;
      updateNotesHistoryDOM();
    }
  }

  function parseNotes(text) {
    if (!text) return [];
    const re = /^---\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+—\s+(.+?)\s+---$/gm;
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ index: m.index, end: re.lastIndex, ts: m[1], tech: m[2] });
    }
    if (matches.length === 0) return [];
    const out = [];
    for (let i = 0; i < matches.length; i += 1) {
      const start = matches[i].end;
      const stop = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const body = text.slice(start, stop).replace(/^\s+|\s+$/g, '');
      out.push({ ts: matches[i].ts, tech: matches[i].tech, body });
    }
    return out.reverse();
  }

  // Inverse of parseNotes — entries are newest-first; file is chronological.
  function serializeNotes(entries) {
    const ascending = [...entries].reverse();
    return ascending.map((e) => `\n--- ${e.ts} — ${e.tech} ---\n${e.body}\n`).join('');
  }

  async function deleteNoteAt(idx) {
    const note = state.notesEntries[idx];
    if (!note) return;
    if (!confirm('Delete this note?')) return;

    if (!state.notesFileId) {
      toast('Notes file not loaded yet', 'warn');
      return;
    }

    // Optimistic UI update — restore from server if the write fails.
    const removed = state.notesEntries.splice(idx, 1)[0];
    updateNotesHistoryDOM();

    try {
      const text = await window.Drive.downloadFileText(state.notesFileId);
      const fresh = parseNotes(text); // newest-first
      const matchIdx = fresh.findIndex(
        (e) => e.ts === removed.ts && e.tech === removed.tech && e.body === removed.body
      );
      if (matchIdx >= 0) fresh.splice(matchIdx, 1);
      const newText = serializeNotes(fresh);
      const blob = new Blob([newText], { type: 'text/plain' });
      await window.Drive.updateFileContent(state.notesFileId, blob, 'text/plain');
      toast('Note deleted', 'success');
      appendVisitLog(state.currentProjectId, 'deleted text note').catch(() => {});
    } catch (err) {
      console.error('[notes] delete failed:', err);
      toast(`Could not delete note: ${err.message}`, 'error', 6000);
      refreshProjectNotes(); // pull authoritative state
    }
  }

  // ---------- Viewer + delete + annotate ----------
  function openViewerForThumb(thumbIdx) {
    const photoThumbs = state.thumbs.filter((t) => t.type === 'photo');
    const target = state.thumbs[thumbIdx];
    if (!target) return;

    if (target.type === 'video' || target.type === 'audio') {
      if (target.webViewLink) {
        window.open(target.webViewLink, '_blank', 'noopener');
      } else if (target.objectUrl) {
        window.open(target.objectUrl, '_blank', 'noopener');
      } else {
        toast('Wait for upload to finish before opening', 'warn');
      }
      return;
    }

    const startIndex = photoThumbs.findIndex((t) => t === target);
    const items = photoThumbs.map((t) => ({
      src: t.src || t.objectUrl || '',
      name: t.name,
      fileId: t.fileId || null,
      status: t.status,
      thumbRef: t
    }));

    window.Viewer.open({
      items,
      startIndex: startIndex < 0 ? 0 : startIndex,
      onAnnotate: (item) => {
        if (item.fileId) {
          annotateFromDrive(item.fileId);
        } else if (item.thumbRef?.objectUrl) {
          annotateFromBlobUrl(item.thumbRef.objectUrl);
        } else {
          toast('Wait for upload to finish before annotating', 'warn');
        }
      },
      onDelete: async (item, _idx) => {
        await deleteThumb(item.thumbRef);
      }
    });
  }

  async function annotateFromDrive(fileId) {
    let blob;
    try {
      const token = await window.Auth.getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      blob = await res.blob();
    } catch (err) {
      toast(`Could not load image: ${err.message}`, 'error');
      return;
    }
    openAnnotateForBlob(blob);
  }

  async function annotateFromBlobUrl(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      openAnnotateForBlob(blob);
    } catch (err) {
      toast(`Could not load image: ${err.message}`, 'error');
    }
  }

  function openAnnotateForBlob(blob) {
    window.Annotate.openWithBlob({
      blob,
      onSave: async (annotated) => {
        const folderId = state.currentProjectId;
        const fileName = await nextFileName(folderId, 'jpg');
        const annotatedName = fileName.replace(/_(\d+)\.jpg$/, '_annotated_$1.jpg');
        const item = await window.DB.queueAdd({
          projectId: folderId,
          projectName: state.currentProjectName,
          fileName: annotatedName,
          mimeType: 'image/jpeg',
          blob: annotated,
          kind: 'annotation',
          status: 'pending'
        });
        const previewUrl = URL.createObjectURL(annotated);
        state.thumbs.unshift({
          type: 'photo',
          src: previewUrl,
          objectUrl: previewUrl,
          name: annotatedName,
          mime: 'image/jpeg',
          size: annotated.size,
          status: 'queued',
          progress: 0,
          queueId: item.id
        });
        updateThumbsDOM();
        toast('Annotation queued', 'success');
        pumpQueue();
      },
      onClose: () => { /* overlay only */ }
    });
  }

  async function deleteThumb(thumb) {
    if (!thumb) return;
    if (thumb.fileId) {
      try {
        await window.Drive.deleteFile(thumb.fileId);
      } catch (err) {
        toast(`Delete failed: ${err.message}`, 'error');
        return;
      }
    } else if (thumb.queueId) {
      // Local-only — drop from queue.
      try { await window.DB.queueDelete(thumb.queueId); } catch (e) { /* ignore */ }
    }
    const idx = state.thumbs.indexOf(thumb);
    if (idx >= 0) state.thumbs.splice(idx, 1);
    revokeThumbBlob(thumb);
    updateThumbsDOM();
    toast('Deleted', 'success');
  }

  function revokeThumbBlob(t) {
    if (t && t.objectUrl) {
      try { URL.revokeObjectURL(t.objectUrl); } catch (e) { /* ignore */ }
    }
  }

  // ---------- Drive (gallery) view ----------
  async function openGallery() {
    if (!ensureProject()) return;
    detachCamera({ silent: true });
    state.view = 'gallery';
    state.galleryLoading = true;
    state.galleryFiles = [];
    scheduleRender();
    try {
      const files = await window.Drive.listFolderFiles(state.currentProjectId);
      state.galleryFiles = files;
    } catch (err) {
      toast(`Could not load Drive: ${err.message}`, 'error');
    } finally {
      state.galleryLoading = false;
      updateGalleryListDOM();
    }
  }

  function closeGallery() {
    state.view = 'capture';
    scheduleRender();
  }

  // ---------- Render ----------
  function render() {
    const app = document.getElementById('app');

    let target;
    if (state.booting) target = '_boot';
    else if (state.initError) target = '_error';
    else target = state.view;

    if (target !== renderedFlag) {
      // Preserve focus across full re-renders as a safety net.
      const focusedId = document.activeElement?.id;
      const focusedSel = document.activeElement instanceof HTMLInputElement
        ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
        : null;

      if (target === '_boot') app.innerHTML = '<div class="boot">Loading…</div>';
      else if (target === '_error') {
        app.innerHTML = `
          <div class="error-screen">
            <h2>Setup needed</h2>
            <p class="muted">${escapeHtml(state.initError || '')}</p>
            <p class="muted small">Edit <code>js/config.js</code> and set <code>CLIENT_ID</code>. See README.md.</p>
            <button class="btn-secondary" id="retry-btn">Retry</button>
          </div>`;
        document.getElementById('retry-btn')?.addEventListener('click', () => location.reload());
      }
      else if (target === 'login') renderLogin(app);
      else if (target === 'home') renderHome(app);
      else if (target === 'capture') renderCapture(app);
      else if (target === 'gallery') renderGallery(app);

      renderedFlag = target;

      if (focusedId) {
        const el = document.getElementById(focusedId);
        if (el) {
          el.focus();
          if (focusedSel && el.setSelectionRange) {
            try { el.setSelectionRange(focusedSel[0], focusedSel[1]); } catch (e) { /* ignore */ }
          }
        }
      }
    }

    // Targeted updates
    if (target === 'home') updateHomeDOM();
    else if (target === 'capture') updateCaptureDOM();
    else if (target === 'gallery') updateGalleryDOM();
  }

  function renderLogin(app) {
    app.innerHTML = `
      <div class="screen login-screen">
        <div class="brand">
          <svg width="72" height="72" viewBox="0 0 192 192" aria-hidden="true">
            <rect fill="#0f172a" width="192" height="192" rx="36"/>
            <g fill="none" stroke="#fbbf24" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="40" y="62" width="112" height="84" rx="10"/>
              <path d="M70 62 L82 46 H110 L122 62"/>
              <circle cx="96" cy="106" r="22"/>
            </g>
          </svg>
          <h1>Site Visit Logger</h1>
          <p>Dancon Services — field documentation</p>
        </div>
        <button id="signin-btn" class="btn-primary big">Sign in with Google</button>
        <p class="muted small">Only @${escapeHtml(window.CONFIG.HOSTED_DOMAIN)} accounts are allowed.</p>
      </div>
    `;
    document.getElementById('signin-btn').addEventListener('click', onSignInClick);
  }

  function renderHome(app) {
    app.innerHTML = `
      <div class="screen home-screen">
        <header class="topbar">
          <div>
            <div class="topbar-title">Site Visits</div>
            <div class="topbar-sub" id="home-topbar-sub"></div>
          </div>
          <button class="btn-ghost" id="signout-btn">Sign out</button>
        </header>

        <main class="home-main">
          <label class="field">
            <span class="field-label">Project name</span>
            <div class="field-row">
              <input
                type="text"
                id="project-input"
                placeholder="e.g. 55 East 87th — Water Damage"
                autocomplete="off"
                autocapitalize="words"
                inputmode="text"
              />
              <button class="btn-primary" id="start-visit-btn">Start Visit</button>
            </div>
            <p class="muted small">Type to filter recent sites, or tap Start Visit to create a new one.</p>
          </label>

          <section class="recent">
            <h2 class="section-h">Recent sites</h2>
            <div id="recent-list"></div>
          </section>
        </main>
      </div>
    `;

    const input = document.getElementById('project-input');
    input.value = state.projectFilter;
    input.addEventListener('input', (e) => {
      state.projectFilter = e.target.value;
      updateRecentList();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        openOrCreateProject(state.projectFilter);
      }
    });
    document.getElementById('start-visit-btn').addEventListener('click',
      () => openOrCreateProject(state.projectFilter));
    document.getElementById('signout-btn').addEventListener('click', onSignOutClick);
  }

  // ---------- Targeted updates: HOME ----------
  function updateHomeDOM() {
    updateHomeTopbar();
    updateRecentList();
  }
  function updateHomeTopbar() {
    const sub = document.getElementById('home-topbar-sub');
    if (!sub) return;
    sub.innerHTML = `${escapeHtml(state.user?.name || '')}${
      state.isOnline ? '' : ' <span class="badge offline">offline</span>'
    }`;
  }
  function updateRecentList() {
    const list = document.getElementById('recent-list');
    if (!list) return;
    const filter = state.projectFilter.trim().toLowerCase();
    const filtered = filter
      ? state.projects.filter((p) => p.name.toLowerCase().includes(filter))
      : state.projects;
    if (state.projectsLoading && state.projects.length === 0) {
      list.innerHTML = '<div class="muted">Loading…</div>';
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = filter
        ? '<div class="muted">No matching projects. Tap Start Visit to create.</div>'
        : '<div class="muted">No projects yet. Type a name and tap Start Visit.</div>';
      return;
    }
    list.innerHTML = filtered.slice(0, 100).map((p) => `
      <button class="list-row" data-project-id="${escapeHtml(p.id)}" data-project-name="${escapeHtml(p.name)}">
        <div class="list-row-main">
          <div class="list-row-title">${escapeHtml(p.name)}</div>
          <div class="list-row-sub">${escapeHtml(fmtRelative(p.modifiedTime))}</div>
        </div>
        <span class="list-row-chev">›</span>
      </button>
    `).join('');
    list.querySelectorAll('.list-row').forEach((row) => {
      row.addEventListener('click', () =>
        enterProject(row.dataset.projectId, row.dataset.projectName));
    });
  }

  // ---------- CAPTURE shell ----------
  function renderCapture(app) {
    app.innerHTML = `
      <div class="screen capture-screen">
        <header class="topbar">
          <button class="btn-ghost back-btn" id="back-btn">‹ Sites</button>
          <div class="topbar-title-center">
            <div class="topbar-title">${escapeHtml(state.currentProjectName)}</div>
            <div id="cap-offline" class="cap-offline"></div>
          </div>
          <button class="btn-ghost" id="drive-btn">📁 Drive</button>
        </header>

        <main class="capture-main">
          <div class="cam-stage" id="cam-stage">
            <video id="cam-video" playsinline autoplay muted></video>
            <div id="cam-error-box" class="cam-error" hidden></div>
            <div id="rec-bar" class="cam-rec-bar" hidden>
              <span class="rec-dot"></span>
              <span class="rec-time">0:00</span>
            </div>
          </div>

          <div class="cam-controls">
            <span class="cam-counter" id="cam-counter">0 captured</span>
            <div class="cam-buttons">
              <button class="cam-shutter" id="shutter-btn" aria-label="Take photo"></button>
              <button class="cam-rec-btn" id="rec-btn" aria-label="Record video"></button>
            </div>
          </div>

          <div class="gps-row" id="gps-row"></div>

          <section class="thumb-section">
            <div class="section-row">
              <h3 class="section-h">Captured</h3>
            </div>
            <div id="thumb-strip" class="thumb-strip"></div>
          </section>

          <section class="notes-section">
            <div class="section-row">
              <h3 class="section-h">Notes</h3>
            </div>
            <textarea id="notes-textarea" placeholder="Type a note…"></textarea>
            <div class="notes-actions">
              <button class="btn-primary" id="save-note-btn">Save note</button>
            </div>
            <div id="notes-history" class="notes-history"></div>
          </section>

          <section class="voice-section">
            <button class="voice-btn" id="voice-btn">🎙️ Record voice note</button>
          </section>
        </main>
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', leaveProject);
    document.getElementById('drive-btn').addEventListener('click', openGallery);
    document.getElementById('shutter-btn').addEventListener('click', onShutterClick);
    document.getElementById('rec-btn').addEventListener('click', onRecordClick);
    document.getElementById('voice-btn').addEventListener('click', startVoiceNote);
    document.getElementById('save-note-btn').addEventListener('click', saveNote);

    attachCamera();
  }

  function updateCaptureDOM() {
    updateCaptureTopbar();
    updateCamCounterDOM();
    updateCamErrorDOM();
    updateThumbsDOM();
    updateNotesHistoryDOM();
    updateGpsChipDOM();
  }
  function updateCaptureTopbar() {
    const off = document.getElementById('cap-offline');
    if (!off) return;
    off.innerHTML = state.isOnline ? '' : '<span class="badge offline">offline</span>';
  }
  function updateOnlineBadges() {
    if (renderedFlag === 'home') updateHomeTopbar();
    else if (renderedFlag === 'capture') updateCaptureTopbar();
  }
  function updateCamCounterDOM() {
    const el = document.getElementById('cam-counter');
    if (el) el.textContent = `${state.camCounter} captured`;
  }
  function updateCamErrorDOM() {
    const box = document.getElementById('cam-error-box');
    if (!box) return;
    if (state.camError) {
      box.hidden = false;
      box.innerHTML = `${escapeHtml(state.camError)}<br><br><button class="btn-secondary small" id="cam-retry">Retry camera</button>`;
      box.querySelector('#cam-retry')?.addEventListener('click', () => {
        state.camError = null;
        attachCamera();
      });
    } else {
      box.hidden = true;
    }
  }

  function updateGpsChipDOM() {
    const row = document.getElementById('gps-row');
    if (!row) return;
    if (state.gpsLoading && !state.gps) {
      row.innerHTML = '<span class="gps-chip muted">📍 Capturing GPS…</span>';
      return;
    }
    if (!state.gps) {
      row.innerHTML = '<span class="gps-chip muted">📍 GPS unavailable</span>';
      return;
    }
    const lat = state.gps.lat.toFixed(5);
    const lng = state.gps.lng.toFixed(5);
    row.innerHTML = `
      <a class="gps-chip" href="${escapeHtml(state.gps.link)}" target="_blank" rel="noopener">
        📍 ${escapeHtml(lat)}, ${escapeHtml(lng)} — Open Maps
      </a>`;
  }

  function updateThumbsDOM() {
    const strip = document.getElementById('thumb-strip');
    if (!strip) return;
    const thumbs = state.thumbs;
    if (state.thumbsLoading && thumbs.length === 0) {
      strip.innerHTML = '<div class="thumb-empty">Loading…</div>';
      return;
    }
    if (thumbs.length === 0) {
      strip.innerHTML = '<div class="thumb-empty">No captures yet — tap the shutter above.</div>';
      return;
    }
    strip.innerHTML = thumbs.map((t, idx) => thumbHtml(t, idx)).join('');
    strip.querySelectorAll('[data-thumb-action]').forEach((el) => {
      const idx = parseInt(el.dataset.thumbIdx, 10);
      const action = el.dataset.thumbAction;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (action === 'open') openViewerForThumb(idx);
        else if (action === 'delete') {
          if (confirm('Delete this file?')) deleteThumb(state.thumbs[idx]);
        }
        else if (action === 'retry') retryThumb(state.thumbs[idx].queueId);
      });
    });
  }

  function thumbHtml(t, idx) {
    const cls = t.status === 'success' ? '' : (t.status === 'failed' ? 'failed' : 'queued');
    const showProgress = t.status === 'uploading' || t.status === 'queued';
    const pct = Math.round((t.progress || 0) * 100);

    let bgHtml = '';
    if (t.type === 'photo') {
      bgHtml = t.src
        ? `<img loading="lazy" alt="" src="${escapeHtml(t.src)}" onerror="this.style.display='none'"/>`
        : '';
    } else if (t.type === 'video') {
      bgHtml = `<div class="thumb-icon">▶</div>`;
    } else if (t.type === 'audio') {
      bgHtml = `<div class="thumb-icon">🎙</div>`;
    }

    let stateHtml = '';
    if (t.status === 'failed') stateHtml = '<span class="thumb-state">Failed</span>';
    else if (t.status === 'queued') stateHtml = '<span class="thumb-state">Queued</span>';
    else if (t.status === 'uploading') stateHtml = `<span class="thumb-state">${pct}%</span>`;

    return `
      <div class="thumb ${cls} ${t.type}" data-thumb-action="open" data-thumb-idx="${idx}">
        ${bgHtml}
        ${stateHtml}
        ${showProgress ? `<div class="thumb-progress"><div class="thumb-progress-bar" style="width:${pct}%"></div></div>` : ''}
        <button class="thumb-trash" data-thumb-action="delete" data-thumb-idx="${idx}" aria-label="Delete">🗑</button>
        ${t.status === 'failed'
          ? `<button class="thumb-retry" data-thumb-action="retry" data-thumb-idx="${idx}" aria-label="Retry">↻ Retry</button>`
          : ''}
      </div>
    `;
  }

  function updateNotesHistoryDOM() {
    const root = document.getElementById('notes-history');
    if (!root) return;
    if (state.notesLoading && state.notesEntries.length === 0) {
      root.innerHTML = '<div class="muted small" style="padding:8px 0;">Loading notes…</div>';
      return;
    }
    if (state.notesEntries.length === 0) {
      root.innerHTML = '';
      return;
    }
    root.innerHTML = state.notesEntries.map((n, idx) => `
      <div class="note-item">
        <div class="note-meta">
          <span>${escapeHtml(n.ts)} · ${escapeHtml(n.tech)}</span>
          <button class="note-trash" data-note-idx="${idx}" aria-label="Delete note" title="Delete note">🗑</button>
        </div>
        <div class="note-body">${escapeHtml(n.body)}</div>
      </div>
    `).join('');
    root.querySelectorAll('[data-note-idx]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteNoteAt(parseInt(b.dataset.noteIdx, 10));
      });
    });
  }

  // ---------- GALLERY ----------
  function renderGallery(app) {
    app.innerHTML = `
      <div class="screen gallery-screen">
        <header class="topbar">
          <button class="btn-ghost back-btn" id="g-back">‹ Capture</button>
          <div class="topbar-title-center">
            <div class="topbar-title">${escapeHtml(state.currentProjectName)}</div>
            <div class="topbar-sub" id="gallery-count"></div>
          </div>
          <button class="btn-ghost" id="g-refresh">↻</button>
        </header>
        <main class="gallery-main" id="gallery-main"></main>
      </div>
    `;
    document.getElementById('g-back').addEventListener('click', closeGallery);
    document.getElementById('g-refresh').addEventListener('click', openGallery);
  }

  function updateGalleryDOM() {
    updateGalleryListDOM();
  }
  function updateGalleryListDOM() {
    const root = document.getElementById('gallery-main');
    if (!root) return;
    const files = state.galleryFiles || [];
    document.getElementById('gallery-count').textContent = `${files.length} files`;
    if (state.galleryLoading) { root.innerHTML = '<div class="muted">Loading…</div>'; return; }
    if (files.length === 0) {
      root.innerHTML = '<div class="muted">No files yet — start capturing.</div>';
      return;
    }
    const images = files.filter((f) => (f.mimeType || '').startsWith('image/'));
    const videos = files.filter((f) => (f.mimeType || '').startsWith('video/'));
    const audios = files.filter((f) => (f.mimeType || '').startsWith('audio/'));
    const docs = files.filter((f) => /\.txt$/i.test(f.name));

    root.innerHTML = `
      ${images.length ? `
        <h3 class="section-h">Photos (${images.length})</h3>
        <div class="thumb-grid">
          ${images.map((f) => `
            <button class="thumb" data-file-id="${escapeHtml(f.id)}" data-file-name="${escapeHtml(f.name)}">
              ${f.thumbnailLink ? `<img loading="lazy" alt="" src="${escapeHtml(f.thumbnailLink)}" onerror="this.style.display='none'"/>` : ''}
              <span class="thumb-label">${escapeHtml(f.name)}</span>
            </button>
          `).join('')}
        </div>` : ''}
      ${videos.length ? `
        <h3 class="section-h">Videos (${videos.length})</h3>
        <div class="file-list">
          ${videos.map((f) => `
            <a class="file-row" href="${escapeHtml(f.webViewLink || '#')}" target="_blank" rel="noopener">
              <span class="file-glyph">🎥</span>
              <span class="file-name">${escapeHtml(f.name)}</span>
              <span class="file-meta">${escapeHtml(fmtBytes(Number(f.size || 0)))}</span>
            </a>
          `).join('')}
        </div>` : ''}
      ${audios.length ? `
        <h3 class="section-h">Voice notes (${audios.length})</h3>
        <div class="file-list">
          ${audios.map((f) => `
            <a class="file-row" href="${escapeHtml(f.webViewLink || '#')}" target="_blank" rel="noopener">
              <span class="file-glyph">🎙️</span>
              <span class="file-name">${escapeHtml(f.name)}</span>
              <span class="file-meta">${escapeHtml(fmtBytes(Number(f.size || 0)))}</span>
            </a>
          `).join('')}
        </div>` : ''}
      ${docs.length ? `
        <h3 class="section-h">Notes &amp; log</h3>
        <div class="file-list">
          ${docs.map((f) => `
            <a class="file-row" href="${escapeHtml(f.webViewLink || '#')}" target="_blank" rel="noopener">
              <span class="file-glyph">📄</span>
              <span class="file-name">${escapeHtml(f.name)}</span>
            </a>
          `).join('')}
        </div>` : ''}
    `;

    root.querySelectorAll('.thumb-grid .thumb').forEach((el) => {
      el.addEventListener('click', () => {
        const fileId = el.dataset.fileId;
        const fileName = el.dataset.fileName;
        // Open in viewer using Drive content URL via authed fetch.
        const item = images.find((f) => f.id === fileId);
        annotateFromDrive(fileId);
      });
    });
  }
})();
