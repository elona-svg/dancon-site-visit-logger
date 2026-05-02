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
    if (!UI || !window.DB || !window.Auth || !window.Drive || !window.Camera || !window.AudioNote || !window.Annotate || !window.Viewer || !window.VideoPlayer) {
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

    thumbs: [],
    thumbsLoading: false,

    notesEntries: [],
    notesFileId: null,
    notesLoading: false,
    editingNoteIdx: null,    // index in notesEntries currently being edited

    isRenaming: false,
    renameSaving: false,

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
      // Trust the cached profile as proof of past sign-in. Token refresh
      // is lazy — the first Drive call that hits a 401 will trigger it.
      // Only when that refresh fails do we route back to the login screen
      // (auth.js clears the user via notifyChange in that case).
      state.view = state.user ? 'home' : 'login';
      state.booting = false;
      scheduleRender();
      if (state.view === 'home') {
        loadProjects();
        ensureMediaPermissions();
      }
      maybeShowIosInstallHint();
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
  // If the camera overlay is open and the page is backgrounded, close it
  // and force-release the cached stream so iOS turns off the camera/mic
  // indicator immediately rather than waiting for the cache TTL.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (window.Camera.isOpen()) window.Camera.close();
      window.Camera.releaseStream();
    }
  });
  window.addEventListener('pagehide', () => {
    if (window.Camera.isOpen()) window.Camera.close();
    window.Camera.releaseStream();
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
      ensureMediaPermissions(); // first-launch preflight
    } catch (err) {
      toast(err.message || 'Sign in failed', 'error', 6000);
    }
  }
  async function onSignOutClick() {
    if (window.Camera.isOpen()) window.Camera.close();
    window.Camera.releaseStream();
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
    state.editingNoteIdx = null;
    state.isRenaming = false;
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
    if (window.Camera.isOpen()) window.Camera.close();
    window.Camera.releaseStream();
    state.currentProjectId = null;
    state.currentProjectName = null;
    state.thumbs.forEach(revokeThumbBlob);
    state.thumbs = [];
    state.notesEntries = [];
    state.gps = null;
    state.editingNoteIdx = null;
    state.isRenaming = false;
    state.view = 'home';
    scheduleRender();
    loadProjects();
  }

  // ---------- GPS ----------
  // Build a polished standalone HTML page that the office team can open
  // straight from Drive. No external resources, inline CSS only.
  function buildGpsHtml({ lat, lng, accuracy, tech, stamp, link }) {
    const safeTech = escapeHtml(tech);
    const safeStamp = escapeHtml(stamp);
    const safeLink = escapeHtml(link);
    const latStr = Number(lat).toFixed(6);
    const lngStr = Number(lng).toFixed(6);
    const acc = Math.round(accuracy);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site location</title>
<style>
  *,*:before,*:after{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f5f5f5;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:520px;margin:40px auto;padding:0 16px}
  .card{background:#fff;border-radius:18px;padding:28px;box-shadow:0 12px 30px rgba(15,23,42,.08);border:1px solid #e5e7eb}
  h1{margin:0 0 4px;font-size:20px;font-weight:700;letter-spacing:.01em}
  .sub{color:#64748b;font-size:13px;margin:0 0 24px}
  .row{display:flex;justify-content:space-between;padding:12px 0;border-top:1px solid #e5e7eb;font-size:14px}
  .row:first-of-type{border-top:0}
  .row .k{color:#64748b}
  .row .v{font-weight:600;font-variant-numeric:tabular-nums}
  .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:24px;padding:16px;background:linear-gradient(180deg,#2563eb,#1d4ed8);color:#fff;border-radius:14px;font-weight:700;font-size:16px;text-decoration:none;letter-spacing:.02em;box-shadow:0 8px 20px rgba(37,99,235,.25)}
  .btn:hover{filter:brightness(1.05)}
  .footer{margin-top:18px;color:#94a3b8;font-size:12px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Site location</h1>
    <p class="sub">Captured by ${safeTech} · ${safeStamp}</p>

    <div class="row"><span class="k">Latitude</span><span class="v">${latStr}</span></div>
    <div class="row"><span class="k">Longitude</span><span class="v">${lngStr}</span></div>
    <div class="row"><span class="k">Accuracy</span><span class="v">${acc} m</span></div>

    <a class="btn" href="${safeLink}" target="_blank" rel="noopener">📍 Open in Google Maps</a>
  </div>
  <p class="footer">Recorded in the Dancon Site Visit Logger.</p>
</div>
</body>
</html>`;
  }

  async function loadOrCaptureGPS(folderId) {
    state.gps = null;
    state.gpsLoading = true;
    updateGpsChipDOM();

    // Look for either the new gps.html or the legacy gps.txt — first one
    // we find wins for the local chip; we never overwrite either.
    let existing = null;
    let existingKind = null;
    try {
      existing = await window.Drive.findFileInFolder(folderId, 'gps.html');
      if (existing) existingKind = 'html';
    } catch (err) { console.warn('GPS check failed:', err.message); }
    if (!existing) {
      try {
        existing = await window.Drive.findFileInFolder(folderId, 'gps.txt');
        if (existing) existingKind = 'txt';
      } catch (err) { /* ignore */ }
    }

    if (existing) {
      try {
        const text = await window.Drive.downloadFileText(existing.id);
        const lat = (text.match(/lat(?:itude)?["\s:>=]+(-?\d+\.\d+)/i) || [])[1]
                 || (text.match(/Latitude:\s*([-\d.]+)/) || [])[1];
        const lng = (text.match(/(?:lon|lng)(?:gitude)?["\s:>=]+(-?\d+\.\d+)/i) || [])[1]
                 || (text.match(/Longitude:\s*([-\d.]+)/) || [])[1];
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
        const tech = state.user?.name || 'unknown';
        const stamp = fmtDateTime();
        const html = buildGpsHtml({ lat: latitude, lng: longitude, accuracy, tech, stamp, link });

        state.gps = { lat: latitude, lng: longitude, link };
        state.gpsLoading = false;
        updateGpsChipDOM();

        // Push gps.html through the regular upload queue so transient
        // failures (offline, 5xx) get the same retry/backoff machinery
        // as photos. Existing GPS file? Skip — first writer wins.
        try {
          const checkHtml = await window.Drive.findFileInFolder(folderId, 'gps.html');
          if (checkHtml) return;
          const checkTxt = await window.Drive.findFileInFolder(folderId, 'gps.txt');
          if (checkTxt) return;
        } catch (err) {
          console.warn('[gps] findFile failed, queuing upload anyway:', err.message);
        }
        try {
          await window.DB.queueAdd({
            projectId: folderId,
            projectName: state.currentProjectName,
            fileName: 'gps.html',
            mimeType: 'text/html',
            blob: new Blob([html], { type: 'text/html' }),
            kind: 'gps',
            status: 'pending',
            attempts: 0
          });
          pumpQueue();
        } catch (err) {
          console.warn('[gps] queue add failed:', err.message);
        }
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

  // ---------- iOS Add-to-Home-Screen hint ----------
  // Shown once on iPhone Safari when the app isn't already installed. We
  // can't prompt programmatically on iOS — the tech has to do Share → Add
  // to Home Screen — so we just teach them how. Dismissed flag persists
  // so they never see it twice on the same device.
  async function maybeShowIosInstallHint() {
    try {
      const dismissed = await window.DB.kvGet('iosInstallHintDismissed');
      if (dismissed) return;
      const ua = navigator.userAgent || '';
      const isIos = /iPad|iPhone|iPod/.test(ua) && !/Macintosh/.test(ua);
      const isCriOS = /CriOS|FxiOS|EdgiOS/.test(ua); // not Safari
      const isStandalone =
        window.navigator.standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;
      if (!isIos || isCriOS || isStandalone) return;
      // Wait a beat so it doesn't compete with permission card / boot.
      setTimeout(showIosInstallHint, 1200);
    } catch (e) { /* ignore */ }
  }

  function showIosInstallHint() {
    const root = document.getElementById('toast-root');
    if (!root) return;
    if (document.getElementById('ios-install-hint')) return;
    const el = document.createElement('div');
    el.id = 'ios-install-hint';
    el.className = 'install-banner';
    el.innerHTML = `
      <span class="install-banner-text">
        Tap <strong>Share</strong> <span aria-hidden="true">⬆️</span> then
        <strong>Add to Home Screen</strong> to install this app.
      </span>
      <button class="install-banner-x" id="install-banner-x" aria-label="Dismiss">✕</button>
    `;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    document.getElementById('install-banner-x').addEventListener('click', async () => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
      try { await window.DB.kvSet('iosInstallHintDismissed', true); } catch (e) { /* ignore */ }
    });
  }

  // ---------- Permissions preflight ----------
  // Asked exactly once across app installs. After that we rely on the
  // browser's own permission cache — getUserMedia returns instantly on
  // 'granted', the in-camera "blocked" panel handles 'denied'.
  let mediaPermissionsRequested = false;
  async function ensureMediaPermissions() {
    if (mediaPermissionsRequested) return;
    mediaPermissionsRequested = true;
    try {
      const cam = await window.Camera.checkPermission('camera');
      const mic = await window.Camera.checkPermission('microphone');
      console.log('[perm] cam=', cam, 'mic=', mic);
      const asked = await window.DB.kvGet('permissions.asked');
      if ((cam === 'granted' && mic === 'granted') || asked) {
        // Already settled — do nothing.
        return;
      }
      // Show a one-time pre-prompt explaining why, then trigger the OS
      // permission dialog from the user's tap on Continue.
      await showPermissionPrePrompt();
    } catch (err) {
      console.warn('[perm] preflight error', err);
    }
  }

  function showPermissionPrePrompt() {
    return new Promise((resolve) => {
      const root = document.getElementById('overlay-root');
      root.innerHTML = `
        <div class="modal-backdrop perm-backdrop">
          <div class="perm-card">
            <div class="perm-icons">📷&nbsp;&nbsp;🎙️</div>
            <h2>One quick setup</h2>
            <p class="muted">Site Visit needs camera and microphone access to capture photos, videos, and voice notes for your jobs. We only ask once.</p>
            <button class="btn-primary big" id="perm-grant">Continue</button>
            <button class="btn-ghost" id="perm-skip">Skip for now</button>
          </div>
        </div>
      `;
      const finish = async (granted) => {
        await window.DB.kvSet('permissions.asked', true);
        root.innerHTML = '';
        if (granted) toast('Permissions granted', 'success', 1800);
        resolve();
      };
      document.getElementById('perm-grant').addEventListener('click', async () => {
        try {
          const result = await window.Camera.preflightPermissions();
          if (result === 'denied') {
            toast('Permission denied — enable it later in browser settings', 'warn', 5000);
            finish(false);
          } else {
            finish(true);
          }
        } catch (err) {
          console.error('[perm] grant failed:', err);
          finish(false);
        }
      });
      document.getElementById('perm-skip').addEventListener('click', () => finish(false));
    });
  }

  // ---------- Camera (fullscreen) ----------
  function openCamera({ mode = 'multi' } = {}) {
    if (!ensureProject()) return;
    window.Camera.open({
      mode,
      onCapture: (blob, mime, kind) => {
        console.log('[camera] onCapture', kind, blob?.size);
        enqueueCapture(blob, mime, kind);
      },
      onClose: () => { /* overlay closes itself; nothing to do */ }
    });
  }

  // ---------- Voice & notes ----------
  function startVoiceNote() {
    if (!ensureProject()) return;
    console.log('[voice] startVoiceNote');
    if (window.Camera.isOpen()) window.Camera.close();
    window.Camera.releaseStream();
    window.AudioNote.open({
      onCapture: (blob, mime, _kind, opts = {}) => {
        console.log('[voice] app.onCapture — blob:', blob?.size, 'mime:', mime, 'duration:', opts?.durationMs);
        enqueueCapture(blob, mime, 'audio', { durationMs: opts?.durationMs });
      },
      onClose: () => {}
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

    const saveBtn = document.getElementById('save-note-btn');
    if (saveBtn) saveBtn.disabled = true;

    try {
      if (state.editingNoteIdx != null) {
        // EDIT path: replace existing entry in notes.txt
        const original = state.notesEntries[state.editingNoteIdx];
        if (!original) throw new Error('Original note not found');
        if (!state.notesFileId) throw new Error('Notes file not loaded yet');

        const editedBody = `${text}\n_(edited ${stamp})_`;
        const updatedEntry = { ts: original.ts, tech: original.tech, body: editedBody };

        // parseNotesAll preserves soft-deleted entries so editing one note
        // doesn't inadvertently drop the audit trail.
        const fileText = await window.Drive.downloadFileText(state.notesFileId);
        const all = parseNotesAll(fileText);
        const matchIdx = all.findIndex(
          (e) => e.ts === original.ts && e.tech === original.tech && e.body === original.body
        );
        if (matchIdx >= 0) all[matchIdx] = updatedEntry;
        else all.unshift(updatedEntry); // safety: prepend if not found

        const newText = serializeNotes(all);
        const blob = new Blob([newText], { type: 'text/plain' });
        await window.Drive.updateFileContent(state.notesFileId, blob, 'text/plain');

        state.notesEntries[state.editingNoteIdx] = updatedEntry;
        state.editingNoteIdx = null;
        ta.value = '';
        updateNotesHistoryDOM();
        updateNotesEditUIDOM();
        toast('Note updated', 'success');
        appendVisitLog(folderId, 'edited text note').catch(() => {});
      } else {
        // APPEND path: new note
        const block = `\n--- ${stamp} — ${tech} ---\n${text}\n`;
        const result = await window.Drive.appendToTextFile({
          folderId,
          fileName: 'notes.txt',
          lineOrText: block,
          cachedFileId: state.notesFileId
        });
        state.notesFileId = result.id;
        await window.DB.kvSet(`notesFileId:${folderId}`, result.id);
        ta.value = '';
        state.notesEntries.unshift({ ts: stamp, tech, body: text });
        updateNotesHistoryDOM();
        toast('Note saved', 'success');
        appendVisitLog(folderId, 'added text note').catch(() => {});
      }
    } catch (err) {
      toast(`Note save failed: ${err.message}`, 'error', 6000);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function startEditNote(idx) {
    const note = state.notesEntries[idx];
    if (!note) return;
    state.editingNoteIdx = idx;
    // Strip a prior "(edited TS)" footer when loading into the editor —
    // a fresh save will append a new one.
    const cleanBody = note.body.replace(/\n?_\(edited [^)]+\)_\s*$/, '');
    const ta = document.getElementById('notes-textarea');
    if (ta) {
      ta.value = cleanBody;
      ta.focus();
      ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateNotesEditUIDOM();
  }

  function cancelEditNote() {
    state.editingNoteIdx = null;
    const ta = document.getElementById('notes-textarea');
    if (ta) ta.value = '';
    updateNotesEditUIDOM();
  }

  // state.thumbs is rebuilt every time the tech enters a project, so any
  // objectUrl in a thumb came from this session and is guaranteed alive.
  // Drive-loaded thumbs from a past session never have an objectUrl —
  // they're always played by passing fileId to VideoPlayer.
  function itemAlive(thumb) {
    return !!(thumb && thumb.objectUrl);
  }

  function ensureProject() {
    if (!state.currentProjectId) {
      toast('Open a project first', 'warn');
      return false;
    }
    return true;
  }

  // ---------- Capture queue ----------
  async function enqueueCapture(blob, mime, kind, opts = {}) {
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
      queueId: item.id,
      addedAt: Date.now(),
      durationMs: opts.durationMs || null
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
        const logSummary = item.kind === 'gps'
          ? 'captured GPS'
          : `uploaded ${item.kind || 'file'}: ${item.fileName} (${fmtBytes(item.blob.size)})`;
        appendVisitLog(item.projectId, logSummary).catch(() => {});
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
  // Drive's `thumbnailLink` is a small (~220 px) image — when we render it
  // inside a thumb cell that's typically 110-160 px wide on phones, it
  // looks blurry/small compared to the original blob preview. Bumping the
  // size suffix to s1024 gives a much sharper rendering at the same
  // physical cell size, with no layout change.
  function upscaleDriveThumb(url) {
    if (!url) return url;
    return url.replace(/=s\d+(-[a-z])?$/, '=s1024$1');
  }

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

      // Index existing thumbs so we can preserve blob URLs / queueIds /
      // duration metadata across the refresh. This is what keeps a
      // freshly-captured photo at full quality even after its upload
      // completes — we don't downgrade to Drive's 220 px thumbnailLink
      // when we already have the sharp local blob.
      const byFileId = new Map();
      const byName = new Map();
      state.thumbs.forEach((t) => {
        if (t.fileId) byFileId.set(t.fileId, t);
        if (t.name) byName.set(t.name, t);
      });

      const driveThumbs = media.map((f) => {
        const existing = byFileId.get(f.id) || byName.get(f.name);
        const driveSrc = upscaleDriveThumb(f.thumbnailLink || '');
        return {
          type: f.mimeType.startsWith('image/') ? 'photo'
              : f.mimeType.startsWith('video/') ? 'video' : 'audio',
          // Prefer the live blob URL so the image stays sharp + identical
          // size before/after upload. Fall back to a high-res Drive thumb
          // for files from previous sessions.
          src: existing?.objectUrl || driveSrc,
          objectUrl: existing?.objectUrl || null,
          name: f.name,
          mime: f.mimeType,
          size: Number(f.size || 0),
          status: 'success',
          fileId: f.id,
          webViewLink: f.webViewLink || '',
          addedAt: existing?.addedAt || new Date(f.createdTime || Date.now()).getTime(),
          durationMs: existing?.durationMs || null
        };
      });

      // Anything still pending (queued / uploading / failed) — i.e. not
      // yet on Drive — gets carried over verbatim.
      const pendingThumbs = state.thumbs.filter((t) => !t.fileId);
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

  // Returns ALL parsed entries (visible + soft-deleted), newest-first.
  function parseNotesAll(text) {
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

  // A note marked as deleted starts its body with "[DELETED ts — tech]".
  // We keep these in the Drive file forever (audit trail) but hide them
  // from the in-app list.
  function isDeletedNote(entry) {
    return /^\[DELETED\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+—\s+.+?\]/.test(entry?.body || '');
  }

  // Public visible-only parser — used for the in-app list.
  function parseNotes(text) {
    return parseNotesAll(text).filter((e) => !isDeletedNote(e));
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
      const stamp = fmtDateTime();
      const tech = state.user?.name || 'unknown';
      // Soft delete: prepend a "[DELETED ts — tech]" marker to the original
      // body. The block stays in notes.txt forever — never shrinks.
      const text = await window.Drive.downloadFileText(state.notesFileId);
      const all = parseNotesAll(text);
      const matchIdx = all.findIndex(
        (e) => e.ts === removed.ts && e.tech === removed.tech && e.body === removed.body
      );
      if (matchIdx >= 0) {
        all[matchIdx] = {
          ...all[matchIdx],
          body: `[DELETED ${stamp} — ${tech}] ${all[matchIdx].body}`
        };
      }
      const newText = serializeNotes(all);
      const blob = new Blob([newText], { type: 'text/plain' });
      await window.Drive.updateFileContent(state.notesFileId, blob, 'text/plain');
      toast('Note deleted', 'success');
      appendVisitLog(state.currentProjectId, 'deleted text note (soft)').catch(() => {});
    } catch (err) {
      console.error('[notes] delete failed:', err);
      toast(`Could not delete note: ${err.message}`, 'error', 6000);
      refreshProjectNotes(); // pull authoritative state on failure
    }
  }

  // ---------- Viewer + delete + annotate ----------
  async function openViewerForThumb(thumbIdx) {
    const photoThumbs = state.thumbs.filter((t) => t.type === 'photo');
    const target = state.thumbs[thumbIdx];
    if (!target) return;

    if (target.type === 'video' || target.type === 'audio') {
      const kind = target.type;
      // For files captured in this session we hand over the live blob URL
      // directly. For everything else we let VideoPlayer fetch from Drive
      // by fileId — that's the only reliable cross-browser path for
      // auth'd Drive content.
      const opts = {
        kind,
        name: target.name,
        onClose: () => {}
      };
      if (target.objectUrl && itemAlive(target)) {
        opts.src = target.objectUrl;
      } else if (target.fileId) {
        opts.fileId = target.fileId;
      } else {
        toast(target.status === 'failed'
          ? 'Upload failed — tap retry on the thumbnail'
          : 'Wait for upload to finish', 'warn');
        return;
      }
      window.VideoPlayer.open(opts);
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
    if (window.Camera.isOpen()) window.Camera.close();
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
          <img class="brand-logo" src="icons/icon-512.png" alt="Dancon Construction Services" />
          <p class="brand-tag">Site Visit Logger</p>
        </div>
        <button id="signin-btn" class="btn-signin">Sign in with Google</button>
        <p class="login-fineprint">Only @${escapeHtml(window.CONFIG.HOSTED_DOMAIN)} accounts can sign in.</p>
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
          <div class="topbar-title-center" id="proj-title-region"></div>
          <button class="btn-ghost drive-btn" id="drive-btn">All Files</button>
        </header>

        <main class="capture-main">
          <div class="gps-row" id="gps-row"></div>

          <button class="open-camera-btn" id="open-cam-btn">
            <svg class="open-camera-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 8.5C3 7.67 3.67 7 4.5 7H7l1.4-1.87A1.5 1.5 0 0 1 9.6 4.5h4.8c.47 0 .91.22 1.2.6L17 7h2.5c.83 0 1.5.67 1.5 1.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            <span>Open Camera</span>
          </button>

          <section class="thumb-section">
            <div class="section-row">
              <h3 class="section-h">Captured</h3>
              <div class="sort-wrap">
                <button class="sort-btn" id="sort-btn" type="button" aria-haspopup="true">↕ ${escapeHtml(sortLabel())}</button>
                <div class="sort-popover" id="sort-popover" hidden>
                  <button data-sort="date" type="button">Date (newest first)</button>
                  <button data-sort="type" type="button">Type</button>
                </div>
              </div>
            </div>
            <div id="thumb-strip" class="thumb-strip"></div>
          </section>

          <section class="notes-section">
            <div class="section-row">
              <h3 class="section-h">Notes</h3>
            </div>
            <textarea id="notes-textarea" placeholder="Type a note…"></textarea>
            <div class="notes-actions">
              <button class="btn-secondary small" id="cancel-edit-btn" hidden>Cancel</button>
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
    document.getElementById('open-cam-btn').addEventListener('click', () => openCamera({ mode: 'multi' }));
    document.getElementById('voice-btn').addEventListener('click', startVoiceNote);
    document.getElementById('save-note-btn').addEventListener('click', saveNote);
    document.getElementById('cancel-edit-btn').addEventListener('click', cancelEditNote);
    document.getElementById('sort-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleSortPopover();
    });
    document.querySelectorAll('#sort-popover [data-sort]').forEach((b) => {
      b.addEventListener('click', () => chooseSort(b.dataset.sort));
    });
  }

  function updateProjectTitleDOM() {
    const region = document.getElementById('proj-title-region');
    if (!region) return;
    if (state.isRenaming) {
      region.innerHTML = `
        <form class="rename-form" id="rename-form">
          <input type="text" id="rename-input" value="${escapeHtml(state.currentProjectName || '')}" autocomplete="off" autocapitalize="words" />
          <button type="submit" class="rename-ok" aria-label="Save">${state.renameSaving ? '…' : '✓'}</button>
          <button type="button" class="rename-cancel" id="rename-cancel" aria-label="Cancel">✕</button>
        </form>
      `;
      const form = document.getElementById('rename-form');
      const input = document.getElementById('rename-input');
      form.addEventListener('submit', (ev) => { ev.preventDefault(); commitRename(); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
      });
      document.getElementById('rename-cancel').addEventListener('click', cancelRename);
    } else {
      region.innerHTML = `
        <button class="proj-title-btn" id="proj-title-btn" aria-label="Rename project">
          <span class="topbar-title">${escapeHtml(state.currentProjectName || '')}</span>
          <span class="proj-title-pencil">✎</span>
        </button>
        <div id="cap-offline" class="cap-offline"></div>
      `;
      document.getElementById('proj-title-btn').addEventListener('click', startRename);
      updateCaptureTopbar();
    }
  }

  function updateCaptureDOM() {
    updateProjectTitleDOM();
    updateThumbsDOM();
    updateNotesHistoryDOM();
    updateNotesEditUIDOM();
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
        📍 Location: ${escapeHtml(lat)}, ${escapeHtml(lng)} — Open Maps
      </a>`;
  }

  // -------- Sort --------
  const SORT_KEY = 'thumbsSort';
  function getSortMode() {
    return sessionStorage.getItem(SORT_KEY) || 'date';
  }
  function setSortMode(mode) {
    sessionStorage.setItem(SORT_KEY, mode);
  }
  function sortedThumbs() {
    const mode = getSortMode();
    const list = [...state.thumbs];
    if (mode === 'type') {
      const order = { photo: 0, video: 1, audio: 2 };
      list.sort((a, b) => {
        const ta = order[a.type] ?? 9;
        const tb = order[b.type] ?? 9;
        if (ta !== tb) return ta - tb;
        return (b.addedAt || 0) - (a.addedAt || 0);
      });
    } else {
      // 'date' — newest first
      list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }
    return list;
  }
  function sortLabel() {
    return getSortMode() === 'type' ? 'Type' : 'Date';
  }
  function toggleSortPopover() {
    const pop = document.getElementById('sort-popover');
    if (!pop) return;
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      // close on outside tap
      setTimeout(() => {
        document.addEventListener('click', closeSortOnOutside, { once: true });
      }, 0);
    }
  }
  function closeSortOnOutside(ev) {
    const pop = document.getElementById('sort-popover');
    const btn = document.getElementById('sort-btn');
    if (!pop) return;
    if (ev.target === btn || btn?.contains(ev.target) || pop.contains(ev.target)) {
      // re-arm if still inside the sort UI
      document.addEventListener('click', closeSortOnOutside, { once: true });
      return;
    }
    pop.hidden = true;
  }
  function chooseSort(mode) {
    setSortMode(mode);
    const pop = document.getElementById('sort-popover');
    if (pop) pop.hidden = true;
    const btn = document.getElementById('sort-btn');
    if (btn) btn.textContent = `↕ ${sortLabel()}`;
    updateThumbsDOM();
  }

  // -------- Long-press to reveal trash --------
  let longPressedId = null;     // queueId or fileId of the currently "selected" thumb
  let lpTimer = null;
  let lpSuppressClick = false;

  function clearLongPress() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  }
  function setLongPressed(id) {
    if (longPressedId === id) return;
    longPressedId = id;
    document.querySelectorAll('.thumb.show-trash').forEach((el) => el.classList.remove('show-trash'));
    if (id != null) {
      const el = document.querySelector(`[data-thumb-key="${CSS.escape(String(id))}"]`);
      if (el) el.classList.add('show-trash');
      if (navigator.vibrate) try { navigator.vibrate(20); } catch (e) { /* ignore */ }
    }
  }

  function attachThumbInteractions(strip) {
    strip.querySelectorAll('.thumb').forEach((thumbEl) => {
      const key = thumbEl.dataset.thumbKey;
      thumbEl.addEventListener('pointerdown', () => {
        clearLongPress();
        lpTimer = setTimeout(() => {
          lpSuppressClick = true;
          setLongPressed(key);
        }, 500);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
        thumbEl.addEventListener(evt, clearLongPress);
      });
    });
    // Tap outside any thumb dismisses the long-press selection.
    document.addEventListener('pointerdown', (ev) => {
      if (longPressedId == null) return;
      if (ev.target.closest('.thumb')) return;
      setLongPressed(null);
    }, { capture: true });
  }

  function parseTimeFromFilename(name) {
    const m = name && name.match(/^\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
  }
  function formatDuration(ms) {
    if (!ms || ms < 0) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // -------- Thumbs render --------
  function updateThumbsDOM() {
    const strip = document.getElementById('thumb-strip');
    if (!strip) return;
    const sorted = sortedThumbs();
    if (state.thumbsLoading && sorted.length === 0) {
      strip.innerHTML = '<div class="thumb-empty">Loading…</div>';
      return;
    }
    if (sorted.length === 0) {
      strip.innerHTML = '<div class="thumb-empty">No captures yet — tap the shutter above.</div>';
      return;
    }
    strip.innerHTML = sorted.map((t, sortedIdx) => {
      const realIdx = state.thumbs.indexOf(t);
      return thumbHtml(t, realIdx);
    }).join('');

    strip.querySelectorAll('[data-thumb-action]').forEach((el) => {
      const idx = parseInt(el.dataset.thumbIdx, 10);
      const action = el.dataset.thumbAction;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (lpSuppressClick && action === 'open') {
          lpSuppressClick = false;
          return;
        }
        lpSuppressClick = false;
        if (action === 'open') openViewerForThumb(idx);
        else if (action === 'delete') {
          if (confirm('Delete this file?')) deleteThumb(state.thumbs[idx]);
          setLongPressed(null);
        }
        else if (action === 'retry') retryThumb(state.thumbs[idx].queueId);
      });
    });

    attachThumbInteractions(strip);
    // Restore long-press highlight after re-render.
    if (longPressedId != null) {
      const el = strip.querySelector(`[data-thumb-key="${CSS.escape(String(longPressedId))}"]`);
      if (el) el.classList.add('show-trash');
    }
  }

  function thumbHtml(t, idx) {
    const cls = t.status === 'success' ? '' : (t.status === 'failed' ? 'failed' : 'queued');
    const showProgress = t.status === 'uploading' || t.status === 'queued';
    const pct = Math.round((t.progress || 0) * 100);
    const key = escapeHtml(String(t.queueId ?? t.fileId ?? `thumb-${idx}`));

    let bgHtml = '';
    let metaHtml = '';
    if (t.type === 'photo') {
      bgHtml = t.src
        ? `<img loading="lazy" alt="" src="${escapeHtml(t.src)}" onerror="this.style.display='none'"/>`
        : '';
    } else if (t.type === 'video') {
      bgHtml = `<div class="thumb-icon">▶</div>`;
    } else if (t.type === 'audio') {
      const time = parseTimeFromFilename(t.name);
      const dur = formatDuration(t.durationMs);
      bgHtml = `<div class="thumb-icon">🎙</div>`;
      const parts = [];
      if (time) parts.push(time);
      if (dur) parts.push(dur);
      if (parts.length) {
        metaHtml = `<div class="thumb-audio-meta">${parts.map(escapeHtml).join(' · ')}</div>`;
      }
    }

    let stateHtml = '';
    if (t.status === 'failed') stateHtml = '<span class="thumb-state">Failed</span>';
    else if (t.status === 'queued') stateHtml = '<span class="thumb-state">Queued</span>';
    else if (t.status === 'uploading') stateHtml = `<span class="thumb-state">${pct}%</span>`;

    return `
      <div class="thumb ${cls} ${t.type}" data-thumb-action="open" data-thumb-idx="${idx}" data-thumb-key="${key}">
        ${bgHtml}
        ${stateHtml}
        ${showProgress ? `<div class="thumb-progress"><div class="thumb-progress-bar" style="width:${pct}%"></div></div>` : ''}
        <button class="thumb-trash" data-thumb-action="delete" data-thumb-idx="${idx}" aria-label="Delete">🗑</button>
        ${t.status === 'failed'
          ? `<button class="thumb-retry" data-thumb-action="retry" data-thumb-idx="${idx}" aria-label="Retry">↻ Retry</button>`
          : ''}
        ${metaHtml}
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
    root.innerHTML = state.notesEntries.map((n, idx) => {
      const editingCls = state.editingNoteIdx === idx ? ' editing' : '';
      return `
        <div class="note-item${editingCls}" data-note-idx="${idx}">
          <div class="note-meta">
            <span>${escapeHtml(n.ts)} · ${escapeHtml(n.tech)}</span>
            <span class="note-actions">
              <button class="note-edit" data-note-edit="${idx}" aria-label="Edit note" title="Edit note">✎</button>
              <button class="note-trash" data-note-trash="${idx}" aria-label="Delete note" title="Delete note">🗑</button>
            </span>
          </div>
          <div class="note-body">${escapeHtml(n.body)}</div>
        </div>
      `;
    }).join('');

    // Whole-card tap opens the note for editing — pencil is purely a visual cue.
    root.querySelectorAll('.note-item').forEach((card) => {
      card.addEventListener('click', () => {
        startEditNote(parseInt(card.dataset.noteIdx, 10));
      });
    });
    // Pencil and trash live inside the card; both stop propagation so the
    // card-tap edit handler doesn't ALSO fire.
    root.querySelectorAll('[data-note-edit]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        startEditNote(parseInt(b.dataset.noteEdit, 10));
      });
    });
    root.querySelectorAll('[data-note-trash]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteNoteAt(parseInt(b.dataset.noteTrash, 10));
      });
    });
  }

  function updateNotesEditUIDOM() {
    const saveBtn = document.getElementById('save-note-btn');
    const cancelBtn = document.getElementById('cancel-edit-btn');
    const editing = state.editingNoteIdx != null;
    if (saveBtn) saveBtn.textContent = editing ? 'Update note' : 'Save note';
    if (cancelBtn) cancelBtn.hidden = !editing;
  }


  // ---------- Project rename ----------
  function startRename() {
    state.isRenaming = true;
    updateProjectTitleDOM();
    setTimeout(() => {
      const input = document.getElementById('rename-input');
      input?.focus();
      input?.select();
    }, 50);
  }
  function cancelRename() {
    state.isRenaming = false;
    updateProjectTitleDOM();
  }
  async function commitRename() {
    if (state.renameSaving) return;
    const input = document.getElementById('rename-input');
    if (!input) return;
    const raw = input.value;
    const sanitized = window.Drive.sanitizeFolderName(raw);
    if (!sanitized || sanitized === state.currentProjectName) {
      cancelRename();
      return;
    }

    // Conflict check — warn if another folder under Site Visits already has
    // this name (case-insensitive match).
    try {
      const existing = await window.Drive.listProjectFolders({ pageSize: 200 });
      const conflict = existing.find(
        (p) => p.id !== state.currentProjectId &&
               p.name.toLowerCase() === sanitized.toLowerCase()
      );
      if (conflict) {
        const ok = confirm(
          `A project named "${conflict.name}" already exists. Continue and create a duplicate name?`
        );
        if (!ok) return;
      }
    } catch (err) {
      console.warn('[rename] could not list folders for conflict check:', err);
    }

    state.renameSaving = true;
    updateProjectTitleDOM();
    try {
      const updated = await window.Drive.renameFile(state.currentProjectId, sanitized);
      state.currentProjectName = updated.name || sanitized;
      // Update local projects cache so the home list reflects immediately.
      const cached = state.projects.find((p) => p.id === state.currentProjectId);
      if (cached) cached.name = state.currentProjectName;
      state.isRenaming = false;
      toast('Project renamed', 'success');
      appendVisitLog(state.currentProjectId, `renamed project to "${state.currentProjectName}"`).catch(() => {});
    } catch (err) {
      toast(`Rename failed: ${err.message}`, 'error', 6000);
    } finally {
      state.renameSaving = false;
      updateProjectTitleDOM();
    }
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
              ${f.thumbnailLink ? `<img loading="lazy" alt="" src="${escapeHtml(upscaleDriveThumb(f.thumbnailLink))}" onerror="this.style.display='none'"/>` : ''}
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
