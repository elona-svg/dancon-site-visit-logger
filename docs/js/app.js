// Top-level app: state, screens, upload queue runner, glue between modules.
//
// Defensive boot: a top-level try-catch around module wiring + a hard
// timeout in boot() so we never get stuck on the white "Loading…" screen
// even if Google Identity Services fails to load or IndexedDB hangs.
(function () {
  let UI;
  try {
    UI = window.UI;
    if (!UI || !window.DB || !window.Auth || !window.Drive || !window.Camera || !window.AudioNote || !window.Notes || !window.Annotate) {
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

  const state = {
    user: null,
    isOnline: navigator.onLine,
    booting: true,
    initError: null,

    // Project context
    currentProjectId: null,
    currentProjectName: null,

    // Home / projects list
    projects: [],
    projectsLoading: false,
    projectFilter: '',

    // Project (capture) screen
    cam: null,                  // Camera controller while attached
    camError: null,
    camCounter: 0,
    camRecording: false,
    recStartTs: 0,
    recTimerHandle: null,

    thumbs: [],                 // unified list of photos this project (queued + uploaded)
    thumbsLoading: false,
    notesEntries: [],
    notesFileId: null,
    notesLoading: false,

    // Drive (gallery) view
    galleryFiles: [],
    galleryLoading: false,

    view: 'login'               // 'login' | 'home' | 'capture' | 'gallery'
  };

  let queueRunnerActive = false;
  let _renderHandle = null;

  function scheduleRender() {
    if (_renderHandle) return;
    _renderHandle = requestAnimationFrame(() => {
      _renderHandle = null;
      render();
    });
  }

  // ---------- Initialization ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  async function boot() {
    // Hard floor: if boot hasn't progressed in 8s, force the login screen so
    // the user is never stuck on white. Real auth happens on click anyway.
    const safety = setTimeout(() => {
      if (state.booting) {
        state.booting = false;
        if (!state.initError) state.initError = null;
        if (!state.user) state.view = 'login';
        scheduleRender();
        console.warn('Boot safety timeout fired');
      }
    }, 8000);

    try {
      await window.DB.open();
      await window.Auth.init();
      window.Auth.onChange(({ user }) => {
        state.user = user;
        scheduleRender();
      });
      state.user = window.Auth.getUser();
      if (state.user && !window.Auth.isSignedIn()) {
        try { await window.Auth.getAccessToken(); }
        catch (e) { /* user must click Sign in */ }
      }
      state.view = state.user && window.Auth.isSignedIn() ? 'home' : 'login';
      state.booting = false;
      scheduleRender();
      if (state.view === 'home') loadProjects(); // background
      runQueue();
    } catch (err) {
      console.error('Boot failed:', err);
      state.booting = false;
      state.initError = err.message || String(err);
      scheduleRender();
    } finally {
      clearTimeout(safety);
    }
  }

  window.addEventListener('online', () => {
    state.isOnline = true;
    toast('Back online — resuming uploads', 'info');
    runQueue();
    scheduleRender();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    toast('Offline — captures will queue', 'warn');
    scheduleRender();
  });

  // ---------- Auth ----------
  async function onSignInClick() {
    try {
      await window.Auth.signIn();
      state.user = window.Auth.getUser();
      state.view = 'home';
      scheduleRender();
      loadProjects();
      runQueue();
    } catch (err) {
      toast(err.message || 'Sign in failed', 'error', 6000);
    }
  }
  async function onSignOutClick() {
    detachCamera();
    await window.Auth.signOut();
    state.user = null;
    state.currentProjectId = null;
    state.currentProjectName = null;
    state.view = 'login';
    state.projects = [];
    scheduleRender();
  }

  // ---------- Projects (home) ----------
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
    state.camCounter = 0;
    scheduleRender();
    if (created) toast(`Created "${name}"`, 'info');
    // Restore notes-fileId cache.
    try {
      const cached = await window.DB.kvGet(`notesFileId:${id}`);
      if (cached) state.notesFileId = cached;
    } catch { /* ignore */ }
    // Kick off background loads.
    refreshProjectMedia();
    refreshProjectNotes();
    maybeCaptureGPS(id, name);
  }

  function leaveProject() {
    detachCamera();
    state.currentProjectId = null;
    state.currentProjectName = null;
    state.thumbs = [];
    state.notesEntries = [];
    state.view = 'home';
    scheduleRender();
    loadProjects();
  }

  // ---------- GPS (once per folder) ----------
  async function maybeCaptureGPS(folderId, folderName) {
    if (!('geolocation' in navigator)) return;
    try {
      const existing = await window.Drive.findFileInFolder(folderId, 'gps.txt');
      if (existing) return;
    } catch (err) {
      console.warn('GPS check failed:', err.message);
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
          if (recheck) return;
          await window.Drive.uploadMultipart({
            folderId,
            fileName: 'gps.txt',
            mimeType: 'text/plain',
            blob: new Blob([text], { type: 'text/plain' })
          });
          await appendVisitLog(folderId, 'captured GPS');
        } catch (err) {
          console.warn('GPS save failed:', err.message);
        }
      },
      (err) => { console.warn('GPS denied:', err.message); },
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

  // ---------- Camera (inline) ----------
  async function attachCamera() {
    const videoEl = document.getElementById('cam-video');
    if (!videoEl) return;
    if (state.cam) return;
    state.camError = null;
    try {
      state.cam = await window.Camera.attach(videoEl, { withAudio: true });
      state.camError = null;
      updateCamErrorDOM();
    } catch (err) {
      console.warn('Camera attach failed:', err);
      state.camError = err.message || String(err);
      state.cam = null;
      updateCamErrorDOM();
    }
  }

  function detachCamera() {
    if (state.cam) {
      try { state.cam.stop(); } catch (e) { /* ignore */ }
      state.cam = null;
    }
    if (state.recTimerHandle) {
      clearInterval(state.recTimerHandle);
      state.recTimerHandle = null;
    }
    state.camRecording = false;
    state.camCounter = 0;
  }

  async function onShutterClick() {
    if (!state.cam) {
      attachCamera(); // user gesture — retry
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
    if (!state.cam) {
      attachCamera();
      return;
    }
    if (state.camRecording) {
      // stop
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
    // start
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
    window.AudioNote.open({
      onCapture: (blob, mime) => enqueueCapture(blob, mime, 'audio'),
      // No re-render on close — the modal overlays the project screen, so
      // the underlying live <video> must stay mounted with its srcObject.
      onClose: () => { /* no-op */ }
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
      toast('Note saved', 'success');
      await appendVisitLog(folderId, 'added text note');
      // Refresh notes inline.
      refreshProjectNotes();
    } catch (err) {
      toast(`Note save failed: ${err.message}`, 'error', 6000);
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
    const folderId = state.currentProjectId;
    const folderName = state.currentProjectName;
    if (!folderId) {
      toast('No project — capture discarded', 'error');
      return;
    }
    const ext = extFromMime(mime);
    const fileName = await nextFileName(folderId, ext);
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

    if (kind === 'photo') {
      const previewUrl = URL.createObjectURL(blob);
      state.thumbs.unshift({
        type: 'photo',
        src: previewUrl,
        name: fileName,
        status: 'queued',
        queueId: item.id,
        objectUrl: previewUrl
      });
      updateThumbsDOM();
    }
    runQueue();
  }

  async function runQueue() {
    if (queueRunnerActive) return;
    if (!state.isOnline) return;
    if (!window.Auth.isSignedIn()) {
      try { await window.Auth.getAccessToken(); }
      catch (e) { return; }
    }

    queueRunnerActive = true;
    try {
      while (true) {
        const pending = await window.DB.queuePending();
        if (pending.length === 0) break;
        pending.sort((a, b) => (a.attempts - b.attempts) || (a.createdAt - b.createdAt));
        const item = pending[0];

        await window.DB.queueUpdate(item.id, { status: 'uploading' });

        try {
          const result = await window.Drive.uploadFile({
            folderId: item.projectId,
            fileName: item.fileName,
            mimeType: item.mimeType,
            blob: item.blob
          });
          await appendVisitLog(item.projectId,
            `uploaded ${item.kind || 'file'}: ${item.fileName} (${fmtBytes(item.blob.size)})`);
          await window.DB.queueUpdate(item.id, { status: 'success' });
          await window.DB.queueDelete(item.id);

          // Patch thumb to success state.
          if (state.currentProjectId === item.projectId) {
            const t = state.thumbs.find((x) => x.queueId === item.id);
            if (t) {
              t.status = 'success';
              t.fileId = result?.id || null;
              updateThumbsDOM();
            }
          }
        } catch (err) {
          console.error('Upload failed', err);
          const attempts = (item.attempts || 0) + 1;
          await window.DB.queueUpdate(item.id, {
            status: 'error',
            attempts,
            lastError: err.message || String(err)
          });
          if (state.currentProjectId === item.projectId) {
            const t = state.thumbs.find((x) => x.queueId === item.id);
            if (t) { t.status = 'failed'; updateThumbsDOM(); }
          }
          const delay = Math.min(60000, 2000 * Math.pow(2, attempts - 1));
          await new Promise((r) => setTimeout(r, delay));
          if (attempts >= 6) break;
        }
      }
    } finally {
      queueRunnerActive = false;
    }
  }

  // ---------- Project media (thumbs + notes) ----------
  async function refreshProjectMedia() {
    if (!state.currentProjectId) return;
    state.thumbsLoading = true;
    updateThumbsDOM();
    try {
      const files = await window.Drive.listFolderFiles(state.currentProjectId);
      const photos = files
        .filter((f) => (f.mimeType || '').startsWith('image/'))
        .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

      // Preserve in-flight queued/failed items not yet in Drive.
      const pendingThumbs = state.thumbs.filter((t) => t.status !== 'success');
      const driveThumbs = photos.map((f) => ({
        type: 'photo',
        src: f.thumbnailLink || '',
        name: f.name,
        status: 'success',
        fileId: f.id
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
      // Find the notes file. Prefer cached id, fall back to search.
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
      const text = await window.Drive.downloadFileText(notesFile.id);
      state.notesEntries = parseNotes(text);
    } catch (err) {
      // If cached id is stale (file gone), clear it and try once more by search.
      if (state.notesFileId) {
        state.notesFileId = null;
        await window.DB.kvDelete(`notesFileId:${state.currentProjectId}`);
      }
      state.notesEntries = [];
      console.warn('Notes load failed:', err.message);
    } finally {
      state.notesLoading = false;
      updateNotesHistoryDOM();
    }
  }

  function parseNotes(text) {
    if (!text) return [];
    // Split on the divider header lines: "--- 2026-05-01 14:32 — Tech ---"
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
    return out.reverse(); // newest first
  }

  // ---------- Drive (gallery) view ----------
  async function openGallery() {
    if (!ensureProject()) return;
    // Stop the camera before unmounting the project screen — a stale
    // controller would keep the camera light on after navigation.
    detachCamera();
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
      scheduleRender();
    }
  }

  function closeGallery() {
    state.view = 'capture';
    scheduleRender();
  }

  async function annotateThumb(fileId) {
    if (!fileId) return;
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
    window.Annotate.openWithBlob({
      blob,
      onSave: async (annotated) => {
        const folderId = state.currentProjectId;
        const fileName = await nextFileName(folderId, 'jpg');
        const annotatedName = fileName.replace(/_(\d+)\.jpg$/, '_annotated_$1.jpg');
        await window.DB.queueAdd({
          projectId: folderId,
          projectName: state.currentProjectName,
          fileName: annotatedName,
          mimeType: 'image/jpeg',
          blob: annotated,
          kind: 'annotation',
          status: 'pending'
        });
        toast('Annotation queued', 'success');
        runQueue();
        setTimeout(refreshProjectMedia, 1500);
      },
      // Skip re-render on close — annotate is an overlay; the project
      // screen's <video> must keep its stream attached.
      onClose: () => { /* no-op */ }
    });
  }

  // ---------- Render ----------
  function render() {
    const app = document.getElementById('app');
    if (state.booting) {
      app.innerHTML = '<div class="boot">Loading…</div>';
      return;
    }
    if (state.initError) {
      app.innerHTML = `
        <div class="error-screen">
          <h2>Setup needed</h2>
          <p class="muted">${escapeHtml(state.initError)}</p>
          <p class="muted small">Edit <code>js/config.js</code> and set <code>CLIENT_ID</code>. See README.md.</p>
          <button class="btn-secondary" id="retry-btn">Retry</button>
        </div>
      `;
      document.getElementById('retry-btn')?.addEventListener('click', () => location.reload());
      return;
    }
    if (state.view === 'login') return renderLogin(app);
    if (state.view === 'home')  return renderHome(app);
    if (state.view === 'gallery') return renderGallery(app);
    return renderCapture(app);
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
    // Render the shell once. The input element keeps focus across filter
    // updates because we never replace it — only the recent list region.
    app.innerHTML = `
      <div class="screen home-screen">
        <header class="topbar">
          <div>
            <div class="topbar-title">Site Visits</div>
            <div class="topbar-sub">${escapeHtml(state.user?.name || '')}${
              state.isOnline ? '' : ' <span class="badge offline">offline</span>'
            }</div>
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

    updateRecentList();
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
      row.addEventListener('click', () => {
        enterProject(row.dataset.projectId, row.dataset.projectName);
      });
    });
  }

  function renderCapture(app) {
    app.innerHTML = `
      <div class="screen capture-screen">
        <header class="topbar">
          <button class="btn-ghost back-btn" id="back-btn">‹ Sites</button>
          <div class="topbar-title-center">
            <div class="topbar-title">${escapeHtml(state.currentProjectName)}</div>
            ${state.isOnline ? '' : '<div class="badge offline">offline</div>'}
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
            <span class="cam-counter" id="cam-counter">${state.camCounter} captured</span>
            <button class="cam-shutter" id="shutter-btn" aria-label="Take photo"></button>
            <button class="cam-rec-btn" id="rec-btn" aria-label="Record video"></button>
          </div>

          <section class="thumb-section">
            <div class="section-row">
              <h3 class="section-h">Photos</h3>
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

    updateThumbsDOM();
    updateNotesHistoryDOM();
    attachCamera(); // async
  }

  // Section-only updates so we don't tear down the live <video> element.
  function updateThumbsDOM() {
    const strip = document.getElementById('thumb-strip');
    if (!strip) return;
    const thumbs = state.thumbs;
    if (state.thumbsLoading && thumbs.length === 0) {
      strip.innerHTML = '<div class="thumb-empty">Loading…</div>';
      return;
    }
    if (thumbs.length === 0) {
      strip.innerHTML = '<div class="thumb-empty">No photos yet — tap the shutter above.</div>';
      return;
    }
    strip.innerHTML = thumbs.map((t, idx) => {
      const cls = t.status === 'success' ? '' : (t.status === 'failed' ? 'failed' : 'queued');
      const stateLabel = t.status === 'queued' ? 'Uploading…' : (t.status === 'failed' ? 'Failed' : '');
      const img = t.src
        ? `<img loading="lazy" alt="" src="${escapeHtml(t.src)}" onerror="this.style.display='none'"/>`
        : '';
      return `
        <button class="thumb ${cls}" data-thumb-idx="${idx}" data-file-id="${escapeHtml(t.fileId || '')}">
          ${img}
          ${stateLabel ? `<span class="thumb-state">${escapeHtml(stateLabel)}</span>` : ''}
        </button>
      `;
    }).join('');
    strip.querySelectorAll('.thumb').forEach((b) => {
      b.addEventListener('click', () => {
        const fileId = b.dataset.fileId;
        if (fileId) annotateThumb(fileId);
      });
    });
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
    root.innerHTML = state.notesEntries.map((n) => `
      <div class="note-item">
        <div class="note-meta">${escapeHtml(n.ts)} · ${escapeHtml(n.tech)}</div>
        <div class="note-body">${escapeHtml(n.body)}</div>
      </div>
    `).join('');
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

  function renderGallery(app) {
    const files = state.galleryFiles || [];
    const images = files.filter((f) => (f.mimeType || '').startsWith('image/'));
    const videos = files.filter((f) => (f.mimeType || '').startsWith('video/'));
    const audios = files.filter((f) => (f.mimeType || '').startsWith('audio/'));
    const docs = files.filter((f) => /\.txt$/i.test(f.name));

    app.innerHTML = `
      <div class="screen gallery-screen">
        <header class="topbar">
          <button class="btn-ghost back-btn" id="g-back">‹ Capture</button>
          <div class="topbar-title-center">
            <div class="topbar-title">${escapeHtml(state.currentProjectName)}</div>
            <div class="topbar-sub">${files.length} files</div>
          </div>
          <button class="btn-ghost" id="g-refresh">↻</button>
        </header>
        <main class="gallery-main">
          ${state.galleryLoading ? '<div class="muted">Loading…</div>' : ''}

          ${images.length ? `
            <h3 class="section-h">Photos (${images.length})</h3>
            <div class="thumb-grid">
              ${images.map((f) => `
                <button class="thumb" data-file-id="${escapeHtml(f.id)}">
                  ${f.thumbnailLink
                    ? `<img loading="lazy" alt="" src="${escapeHtml(f.thumbnailLink)}" onerror="this.style.display='none'"/>`
                    : ''}
                  <span class="thumb-label">${escapeHtml(f.name)}</span>
                </button>
              `).join('')}
            </div>
          ` : ''}

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
            </div>
          ` : ''}

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
            </div>
          ` : ''}

          ${docs.length ? `
            <h3 class="section-h">Notes & log</h3>
            <div class="file-list">
              ${docs.map((f) => `
                <a class="file-row" href="${escapeHtml(f.webViewLink || '#')}" target="_blank" rel="noopener">
                  <span class="file-glyph">📄</span>
                  <span class="file-name">${escapeHtml(f.name)}</span>
                </a>
              `).join('')}
            </div>
          ` : ''}

          ${!state.galleryLoading && files.length === 0
            ? '<div class="muted">No files yet — start capturing.</div>'
            : ''}
        </main>
      </div>
    `;

    document.getElementById('g-back').addEventListener('click', closeGallery);
    document.getElementById('g-refresh').addEventListener('click', openGallery);
    app.querySelectorAll('.thumb').forEach((b) => {
      b.addEventListener('click', () => annotateThumb(b.dataset.fileId));
    });
  }
})();
