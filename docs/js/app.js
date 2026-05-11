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
    projectsSyncing: false,
    projectFilter: '',

    thumbs: [],
    thumbsLoading: false,
    thumbsSyncing: false,

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
        state.user = user;
        if (!user && state.view !== 'login') {
          state.view = 'login';
          scheduleRender();
        } else if (state.view === 'home') {
          updateHomeTopbar();
        } else if (state.view === 'capture') {
          updateCaptureTopbar();
        }
        onAuthStateUpdate();
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
        // Migrate FIRST so loadProjects only sees marker-aware data.
        // The migration is async + non-blocking; loadProjects starts
        // immediately and will pick up newly stamped projects once a
        // refresh cycle (or visibilitychange wake) re-runs it.
        runProjectMarkerMigration().then(() => loadProjects());
        loadProjects(); // also kick off an immediate cached paint
        ensureMediaPermissions();
      }
      maybeShowInstallHint();
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
    updateConnDotDOM();
    // Kick a refresh so the status dot turns green again ASAP.
    if (window.Auth.getTokenStatus() !== 'valid') {
      window.Auth.getAccessToken(true).catch(() => {});
    }
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    toast('Offline — captures will queue', 'warn');
    updateOnlineBadges();
    updateConnDotDOM();
  });

  // Connection state machine ------------------------------------------------
  // Combines navigator.onLine + Auth.tokenStatus into a single signal that
  // the topbar dot reflects. State transitions also drive the 30s reconnect
  // loop: when Auth gives up after its 5 retries we keep poking it in the
  // background — the UI never gates on this and the user is never signed
  // out as a side effect.
  function getConnectionStatus() {
    if (!state.isOnline) return 'offline';
    const ts = window.Auth.getTokenStatus();
    if (ts === 'failed' || ts === 'refreshing') return 'reconnecting';
    return 'connected';
  }
  let reconnectTimer = null;
  function startReconnectLoop() {
    if (reconnectTimer) return;
    // Don't run reconnect attempts when there's no user — the only way
    // to recover is interactive sign-in via the login screen, not a
    // silent token grant. Gating here AND inside the interval handles
    // the case where the user signs out mid-loop.
    if (!window.Auth.isSignedIn()) return;
    console.log('[conn] starting 30s reconnect loop');
    reconnectTimer = setInterval(async () => {
      if (!state.isOnline) return;
      if (!window.Auth.isSignedIn()) { stopReconnectLoop(); return; }
      if (window.Auth.getTokenStatus() === 'valid') {
        stopReconnectLoop();
        return;
      }
      console.log('[conn] reconnect attempt …');
      try { await window.Auth.getAccessToken(true); }
      catch (e) { /* keep looping */ }
    }, 30000);
  }
  function stopReconnectLoop() {
    if (!reconnectTimer) return;
    console.log('[conn] reconnect loop done');
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  function onAuthStateUpdate() {
    updateConnDotDOM();
    const ts = window.Auth.getTokenStatus();
    if (ts === 'failed') startReconnectLoop();
    else if (ts === 'valid') stopReconnectLoop();
  }

  function ensureConnDotMounted() {
    if (document.getElementById('conn-dot')) return;
    const dot = document.createElement('div');
    dot.id = 'conn-dot';
    dot.className = 'conn-dot';
    dot.title = '';
    dot.setAttribute('role', 'status');
    document.body.appendChild(dot);
  }
  function updateConnDotDOM() {
    ensureConnDotMounted();
    const dot = document.getElementById('conn-dot');
    if (!dot) return;
    // Hide on the login screen — we don't have a session to monitor.
    if (state.view === 'login' || state.booting) { dot.hidden = true; return; }
    dot.hidden = false;
    const status = getConnectionStatus();
    dot.classList.remove('connected', 'reconnecting', 'offline');
    dot.classList.add(status);
    dot.title = status === 'connected' ? 'Connected to Drive'
      : status === 'reconnecting' ? 'Reconnecting…'
      : 'Offline — working from cache';
  }

  // Wake-from-idle: when the tab is shown again after >5 min hidden, give
  // the token a fresh poke and revalidate the cache the user is looking
  // at. NEVER blocks the UI.
  let lastVisibleTs = Date.now();
  const WAKE_THRESHOLD_MS = 5 * 60 * 1000;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const idleMs = Date.now() - lastVisibleTs;
      if (idleMs > WAKE_THRESHOLD_MS) {
        console.log('[wake] back from', Math.round(idleMs / 1000), 's idle — revalidating');
        if (window.Auth.isSignedIn()) {
          window.Auth.getAccessToken(true).catch(() => {});
        }
        if (state.view === 'home') loadProjects();
        else if (state.view === 'capture' && state.currentProjectId) {
          refreshProjectMedia();
        }
      }
    } else {
      lastVisibleTs = Date.now();
    }
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
  // Final safety net: tab/app being torn down. close() stops every track
  // synchronously, which is what unblocks the OS privacy indicator.
  window.addEventListener('beforeunload', () => {
    if (window.Camera.isOpen()) window.Camera.close();
  });

  // ---------- Login debug log (production diagnostic) ----------
  // Mirrors every [auth]-prefixed console.log / .warn / .error to an on-screen
  // panel so users can copy a transcript when sign-in fails on a device where
  // Web Inspector isn't practical. Pure passive surface — no auth logic
  // changes; we only patch console to also append to a buffer + DOM.
  const DEBUG_BUFFER_MAX = 200;
  const debugLogBuffer = [];

  function fmtDebugTime() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtDebugArg(a) {
    if (a instanceof Error) {
      const stackHead = (a.stack || '').split('\n').slice(0, 3).join('\n  ');
      return `${a.name || 'Error'}: ${a.message}${stackHead ? '\n  ' + stackHead : ''}`;
    }
    if (typeof a === 'string') return a;
    if (a === null || a === undefined) return String(a);
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }
  function appendDebugLine(level, args) {
    const body = args.map(fmtDebugArg).join(' ');
    const line = `[${fmtDebugTime()}] ${level.padEnd(4)} ${body}`;
    debugLogBuffer.push(line);
    if (debugLogBuffer.length > DEBUG_BUFFER_MAX) debugLogBuffer.shift();
    // Only update DOM if the panel is currently visible (revealed via the
    // logo Easter egg). Buffering still happens regardless so a tech can
    // reveal the panel mid-session and see backfill.
    const panelEl = document.getElementById('login-debug-log');
    if (!panelEl || panelEl.hidden) return;
    const bodyEl = document.getElementById('login-debug-log-body');
    if (bodyEl) {
      bodyEl.textContent = debugLogBuffer.join('\n');
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  }
  (function patchConsoleForAuth() {
    const levels = [['log', 'LOG'], ['warn', 'WARN'], ['error', 'ERR']];
    for (const [name, label] of levels) {
      const orig = console[name].bind(console);
      console[name] = function (...args) {
        orig(...args);
        if (typeof args[0] === 'string' && args[0].startsWith('[auth]')) {
          try { appendDebugLine(label, args); } catch (_) { /* never break console */ }
        }
      };
    }
  })();
  async function onCopyDebugLog() {
    const text = debugLogBuffer.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Log copied to clipboard', 'success', 2000);
    } catch (e) {
      toast('Copy failed: ' + (e && e.message || e), 'error', 4000);
    }
  }
  function onHideDebugLog() {
    const panel = document.getElementById('login-debug-log');
    if (panel) panel.hidden = true;
  }
  // Easter egg: 5 taps on the brand logo within 2s reveals the debug panel.
  // Sliding window — keeps the last 5 timestamps and triggers when all are
  // within range. Console.log output is unaffected; this only flips the
  // on-screen panel visible.
  const LOGO_TAP_WINDOW_MS = 2000;
  const LOGO_TAP_TARGET = 5;
  let logoTapTimes = [];
  function onLogoTap() {
    const now = Date.now();
    logoTapTimes.push(now);
    if (logoTapTimes.length > LOGO_TAP_TARGET) {
      logoTapTimes = logoTapTimes.slice(-LOGO_TAP_TARGET);
    }
    if (logoTapTimes.length === LOGO_TAP_TARGET &&
        (logoTapTimes[LOGO_TAP_TARGET - 1] - logoTapTimes[0]) <= LOGO_TAP_WINDOW_MS) {
      revealDebugPanel();
      logoTapTimes = [];
    }
  }
  function revealDebugPanel() {
    const panel = document.getElementById('login-debug-log');
    if (!panel) return;
    panel.hidden = false;
    const bodyEl = document.getElementById('login-debug-log-body');
    if (bodyEl) {
      bodyEl.textContent = debugLogBuffer.join('\n');
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    if (navigator.vibrate) try { navigator.vibrate(20); } catch (e) { /* ignore */ }
  }

  // ---------- Auth handlers ----------
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    // iPadOS 13+ reports navigator.platform as 'MacIntel'; disambiguate via touch.
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
                  (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    if (isIOS) return 'ios-safari';
    if (/Android/i.test(ua)) return 'android-chrome';
    return 'desktop';
  }

  function showLoginError(reason) {
    const errEl = document.getElementById('login-error');
    if (!errEl) {
      toast(`Sign-in failed: ${reason}`, 'error', 8000);
      return;
    }
    const platform = detectPlatform();
    const open = (p) => p === platform ? ' open' : '';
    errEl.innerHTML = `
      <h3 class="login-error-title">Sign-in didn't complete</h3>
      <p class="login-error-reason">Reason: ${escapeHtml(reason)}</p>
      <p class="login-error-body">This usually means Safari is blocking part of the Google sign-in. Here's how to fix it (one-time setup):</p>
      <details class="login-error-section"${open('ios-safari')}>
        <summary>iPhone / iPad (Safari)</summary>
        <ol>
          <li>Open the <strong>Settings</strong> app on your phone</li>
          <li>Tap <strong>Apps → Safari</strong></li>
          <li>Turn <strong>OFF</strong> "Block Pop-ups"</li>
          <li>Turn <strong>OFF</strong> "Prevent Cross-Site Tracking"</li>
          <li>Come back and tap "Try sign-in again"</li>
        </ol>
      </details>
      <details class="login-error-section"${open('android-chrome')}>
        <summary>Android (Chrome)</summary>
        <ol>
          <li>Tap the three-dot menu in Chrome → <strong>Settings</strong> → <strong>Site Settings</strong></li>
          <li>Tap <strong>Pop-ups and redirects</strong> → Allow</li>
          <li>Tap <strong>Cookies</strong> → Allow</li>
          <li>Come back and tap "Try sign-in again"</li>
        </ol>
      </details>
      <details class="login-error-section"${open('desktop')}>
        <summary>Desktop browser</summary>
        <ol>
          <li>Allow popups for <strong>elona-svg.github.io</strong> in your browser settings</li>
          <li>Try sign-in again</li>
        </ol>
      </details>
      <button type="button" id="signin-retry-btn" class="btn-signin-retry">Try sign-in again</button>
      <a class="login-error-contact" href="mailto:elona@danconservices.com?subject=Site%20Visit%20Logger%20sign-in%20issue">Still not working? Contact Elona</a>
    `;
    errEl.hidden = false;
    const retryBtn = document.getElementById('signin-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', onSignInClick);
  }

  async function onSignInClick() {
    console.log('[auth] sign-in button tapped');
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('signin-btn');
    if (errEl) { errEl.hidden = true; errEl.innerHTML = ''; }
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    try {
      await window.Auth.signIn();
      console.log('[auth] sign-in resolved — routing to home');
      state.user = window.Auth.getUser();
      state.view = 'home';
      scheduleRender();
      runProjectMarkerMigration().then(() => loadProjects());
      loadProjects();
      pumpQueue();
      ensureMediaPermissions();
    } catch (err) {
      console.error('[auth] signIn failed:', err);
      const reason = (err && err.message === 'TOKEN_TIMEOUT')
        ? 'Sign-in timed out'
        : (err && err.message) || 'Sign-in failed';
      showLoginError(reason);
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in with Google'; }
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
  // One-time migration: walk every subfolder in Site Visits and stamp a
  // .dancon-project marker on any folder that already has app-generated
  // content (visit_log.txt, notes.txt, gps.*, or YYYY-MM-DD_HH-MM_…
  // captures). Folders with no app-generated content stay un-marked,
  // making them invisible to the new project list. Idempotent + tracked
  // by an IDB flag so it only runs once per device.
  const APP_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_/;
  const APP_KNOWN_NAMES = new Set(['visit_log.txt', 'notes.txt', 'gps.txt', 'gps.html']);
  async function runProjectMarkerMigration() {
    try {
      const done = await window.DB.kvGet('markers.migrated.v1');
      if (done) return;
    } catch (e) { /* ignore */ }
    console.log('[marker-migration] starting');
    try {
      const [allFolders, markers, visitLogs, metaFolders] = await Promise.all([
        window.Drive.listProjectFolders({ pageSize: 500 }),
        window.Drive.listAllProjectMarkers({ pageSize: 500 }),
        window.Drive.listAllVisitLogs({ pageSize: 500 }),
        window.Drive.listAllMetadataFolders({ pageSize: 500 })
      ]);
      // metaFolderId → projectId map so we can resolve markers/visit_logs
      // whose parent is an `_metadata/` folder up to the actual project.
      const metaToProject = new Map();
      metaFolders.forEach((f) => {
        const p = (f.parents || [])[0];
        if (p) metaToProject.set(f.id, p);
      });
      const resolveParent = (parentId) => metaToProject.get(parentId) || parentId;
      // A project is "already marked" if any of these point at it:
      //  - a `.dancon-project` file (legacy or v37/v38)
      //  - a `visit_log.txt` file (v39+ ownership marker, or any legacy
      //    log that happens to exist)
      //  - an `_metadata/` subfolder (defensive: covers an interrupted
      //    creation where the folder exists but no log yet)
      const alreadyMarked = new Set();
      markers.forEach((m) => (m.parents || []).forEach((p) => alreadyMarked.add(resolveParent(p))));
      visitLogs.forEach((v) => (v.parents || []).forEach((p) => alreadyMarked.add(resolveParent(p))));
      metaFolders.forEach((f) => (f.parents || []).forEach((p) => alreadyMarked.add(p)));
      const candidates = allFolders.filter((f) => !alreadyMarked.has(f.id));
      console.log(`[marker-migration] ${candidates.length} folder(s) without marker; checking contents`);

      let stamped = 0;
      for (const folder of candidates) {
        try {
          const files = await window.Drive.listFolderFiles(folder.id, { pageSize: 25 });
          const looksLikeProject = files.some((f) =>
            APP_KNOWN_NAMES.has(f.name) || APP_FILE_PATTERN.test(f.name || '')
          );
          if (!looksLikeProject) continue;
          await window.Drive.createProjectMarker(folder.id, {
            createdAt: new Date().toISOString(),
            createdBy: state.user?.email || 'migration',
            appVersion: 'v39',
            projectId: `migrated-${folder.id}`,
            migrated: true
          });
          stamped += 1;
          console.log('[marker-migration] stamped', folder.name);
        } catch (e) {
          console.warn('[marker-migration] failed for', folder.name, e.message);
        }
      }
      try { await window.DB.kvSet('markers.migrated.v1', Date.now()); } catch (e) {}
      console.log(`[marker-migration] done — stamped ${stamped} pre-existing project(s)`);
    } catch (err) {
      console.warn('[marker-migration] aborted:', err.message);
    }
  }

  // Cache-first rendering: paint from IDB instantly, refresh in the
  // background, diff + update only if changed. Cache schema:
  //   { projects: [{id, name, modifiedTime}], cachedAt: timestamp }
  const PROJECTS_CACHE_KEY = 'projects.cache';
  let projectsCacheLoaded = false;

  function projectsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].id !== b[i].id || a[i].name !== b[i].name ||
          a[i].modifiedTime !== b[i].modifiedTime) return false;
    }
    return true;
  }

  async function preloadProjectsFromCache() {
    if (projectsCacheLoaded) return;
    projectsCacheLoaded = true;
    try {
      const cached = await window.DB.kvGet(PROJECTS_CACHE_KEY);
      if (cached && Array.isArray(cached.projects) && cached.projects.length > 0) {
        state.projects = cached.projects;
        state.projectsLoading = false;
        console.log('[home] cache hit:', cached.projects.length, 'projects, age',
          Math.round((Date.now() - (cached.cachedAt || 0)) / 1000), 's');
      }
    } catch (e) { /* ignore */ }
    updateRecentList();
  }

  async function loadProjects() {
    // Paint cached list immediately. Only mark "loading" (and render the
    // skeleton) if there's nothing cached at all.
    await preloadProjectsFromCache();
    const hadCache = state.projects.length > 0;
    state.projectsSyncing = true;
    if (!hadCache) state.projectsLoading = true;
    updateRecentList();
    updateHomeSyncIndicatorDOM();

    try {
      // Four parallel queries:
      //  - every subfolder of Site Visits
      //  - every `.dancon-project` marker (legacy ownership marker)
      //  - every `visit_log.txt` file (v39+ ownership marker, also
      //    catches legacy projects that have a root log)
      //  - every `_metadata/` subfolder (defensive: catches a
      //    half-initialized project that has the folder but no log yet)
      // We resolve any parent that's a `_metadata/` folder up to the
      // actual project ID via the metaToProject map, then union all
      // resolved parents into ownedIds.
      const [allFolders, markers, visitLogs, metaFolders] = await Promise.all([
        window.Drive.listProjectFolders({ pageSize: 500 }),
        window.Drive.listAllProjectMarkers({ pageSize: 500 }),
        window.Drive.listAllVisitLogs({ pageSize: 500 }),
        window.Drive.listAllMetadataFolders({ pageSize: 500 })
      ]);
      const metaToProject = new Map();
      metaFolders.forEach((f) => {
        const p = (f.parents || [])[0];
        if (p) metaToProject.set(f.id, p);
      });
      const resolveParent = (parentId) => metaToProject.get(parentId) || parentId;
      const ownedIds = new Set();
      markers.forEach((m) => {
        (m.parents || []).forEach((p) => ownedIds.add(resolveParent(p)));
      });
      visitLogs.forEach((v) => {
        (v.parents || []).forEach((p) => ownedIds.add(resolveParent(p)));
      });
      metaFolders.forEach((f) => {
        (f.parents || []).forEach((p) => ownedIds.add(p));
      });
      const folders = allFolders.filter((f) => ownedIds.has(f.id));
      const skipped = allFolders.length - folders.length;
      if (skipped > 0) console.log(`[home] filtered ${skipped} unmarked folder(s)`);

      // Explicit reconcile: drop any cached project whose ID is not in
      // the live Drive response. listProjectFolders already filters
      // trashed=false so a folder deleted directly in Drive won't appear
      // here, and overwriting state.projects below carries the deletion
      // through. This filter is defensive — surfacing the intent in code.
      const freshIds = new Set(folders.map((f) => f.id));
      const removed = state.projects.filter((p) => !freshIds.has(p.id));
      if (removed.length > 0) {
        console.log('[home] reconcile: dropping', removed.length, 'stale folder(s) from cache:',
          removed.map((p) => p.name).join(', '));
      }
      const changed = !projectsEqual(folders, state.projects);
      state.projects = folders;
      try {
        await window.DB.kvSet(PROJECTS_CACHE_KEY, { projects: folders, cachedAt: Date.now() });
      } catch (e) { /* ignore */ }
      console.log('[home]', changed ? 'cache updated' : 'cache fresh', '-', folders.length, 'projects');
    } catch (err) {
      const msg = err && err.message || '';
      // Auth-side failures are silenced when we already have a cached
      // list painted — the next user action will retry naturally.
      if (/TOKEN_TIMEOUT|Token request|Auth not initialized/i.test(msg)) {
        console.warn('[home] live fetch deferred (auth):', msg);
      } else {
        console.error(err);
        if (!hadCache) toast(`Could not list projects: ${msg}`, 'error');
      }
    } finally {
      state.projectsLoading = false;
      state.projectsSyncing = false;
      updateRecentList();
      updateHomeSyncIndicatorDOM();
    }
  }

  // Map raw error messages to something the tech can act on. The bare
  // GIS rejection ("TOKEN_TIMEOUT") is meaningless to a field user;
  // give them the same plain instruction every time auth chokes.
  function friendlyErrorMessage(err) {
    const msg = (err && err.message) || String(err || 'Unknown error');
    if (/TOKEN_TIMEOUT|Token request|popup_closed|popup_blocked|Auth not initialized/i.test(msg)) {
      return 'Sign-in is reconnecting — please try again in a moment';
    }
    return msg;
  }

  async function openOrCreateProject(rawName) {
    const name = window.Drive.sanitizeFolderName(rawName);
    if (!name) { toast('Type a project name', 'warn'); return; }
    try {
      const { id, name: actualName, created } = await window.Drive.ensureProjectFolder(name);
      // Stamp every newly-created folder with the .dancon-project marker
      // so the home list (and any other device) recognizes it as ours.
      // If the folder already had one (re-open path), this is a no-op.
      try {
        const existingMarker = await window.Drive.findProjectMarker(id);
        if (!existingMarker) {
          await window.Drive.createProjectMarker(id, {
            createdAt: new Date().toISOString(),
            createdBy: state.user?.email || 'unknown',
            appVersion: 'v39',
            projectId: (window.crypto?.randomUUID && window.crypto.randomUUID()) || `proj-${Date.now()}`
          });
          console.log('[marker] stamped new project', id);
        }
      } catch (e) {
        console.warn('[marker] could not stamp project:', e.message);
      }
      enterProject(id, actualName, { created });
    } catch (err) {
      console.error(err);
      toast(`Could not open project: ${friendlyErrorMessage(err)}`, 'error', 6000);
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

    // Cache-first project page: paint thumbs from IDB before kicking off
    // the live Drive fetch. The first-paint target is <200ms.
    await preloadProjectMediaFromCache(id);
    refreshProjectMedia();
    refreshProjectNotes();
    loadPinnedLocation(id);

    // Auto-capture GPS on Start Visit so the original location is recorded
    // immediately. iOS will prompt for permission on the first
    // getCurrentPosition call. If the tech denies or it times out, the
    // captureLocationExplicit error path handles it silently — they can
    // still capture manually later via the GPS chip.
    if (created) {
      captureLocationExplicit(id, { isUpdate: false }).catch((err) => {
        console.warn('[gps] auto-capture on Start Visit failed:', err && err.message);
      });
    }
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
  // Plain-text format. Drive renders raw .html files as code, which the
  // office team complained about. .txt opens nicely in any browser.
  function fmtGpsTimestamp(d = new Date()) {
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    let tz = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
      tz = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
    } catch (e) { /* ignore */ }
    return tz ? `${date} ${time} ${tz}` : `${date} ${time}`;
  }

  // Build a block for the append-only gps.txt log. `header` is one of
  // 'ORIGINAL LOCATION' (first capture) or 'LOCATION UPDATED' (subsequent).
  // First line after the header is "<verb>: <ts>" — verb matches the
  // header type so the file reads naturally.
  function buildGpsBlock({ header, lat, lng, accuracy, tech, stamp, link }) {
    const accStr = accuracy != null ? `±${Math.round(accuracy)}m` : 'unknown';
    const verb = header === 'ORIGINAL LOCATION' ? 'Captured' : 'Updated';
    return [
      `=== ${header} ===`,
      `${verb}: ${stamp}`,
      `Tech: ${tech}`,
      `Latitude: ${Number(lat).toFixed(6)}`,
      `Longitude: ${Number(lng).toFixed(6)}`,
      `Accuracy: ${accStr}`,
      `Google Maps: ${link}`,
      ''
    ].join('\n');
  }

  // Find the byte offset of the last `=== ... ===` header line in `text`,
  // or -1 if none. Used by the stage-2 GPS upgrade to overwrite the last
  // block in place (one user gesture = one block) without disturbing the
  // append-only log of prior captures.
  function findLastSectionHeaderOffset(text) {
    if (!text) return -1;
    const re = /^=== [^=\n]+ ===$/gm;
    let last = -1;
    let m;
    while ((m = re.exec(text)) !== null) last = m.index;
    return last;
  }

  // Legacy: kept so we still write the previously-shipped HTML if any
  // project already has gps.html. New captures use buildGpsTxt above.
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

  // GPS is now treated as a PINNED LOCATION — captured once per project,
  // shown read-only on every subsequent visit. We NEVER call
  // getCurrentPosition automatically. The two-stage capture only runs
  // when the tech taps "Capture location" or "Update location".
  function pinnedLocationKey(folderId) { return `project.${folderId}.pinnedLocation`; }

  async function loadPinnedLocation(folderId) {
    state.gps = null;
    state.gpsLoading = true;
    updateGpsChipDOM();

    // 1. Cache hit — paint instantly, done.
    try {
      const cached = await window.DB.kvGet(pinnedLocationKey(folderId));
      if (cached && cached.lat != null && cached.lng != null) {
        state.gps = {
          lat: cached.lat,
          lng: cached.lng,
          accuracy: cached.accuracy,
          capturedAt: cached.capturedAt,
          capturedBy: cached.capturedBy,
          link: `https://maps.google.com/?q=${cached.lat},${cached.lng}`
        };
        state.gpsLoading = false;
        updateGpsChipDOM();
        return;
      }
    } catch (e) { /* ignore */ }

    // 2. Migration — look for an existing gps file in Drive (root for
    //    legacy projects, _metadata/ for current). If we find one,
    //    populate the cache so future opens are instant.
    let existing = null;
    try {
      const found = await window.Drive.findMetadataFile(folderId, 'gps.txt');
      if (found) existing = found.file;
    } catch (e) { /* ignore */ }
    if (!existing) {
      try { existing = await window.Drive.findFileInFolder(folderId, 'gps.html'); }
      catch (e) { /* ignore */ }
    }
    if (existing) {
      try {
        const text = await window.Drive.downloadFileText(existing.id);
        const lat = (text.match(/Latitude:\s*([-\d.]+)/) || [])[1]
                 || (text.match(/lat(?:itude)?["\s:>=]+(-?\d+\.\d+)/i) || [])[1];
        const lng = (text.match(/Longitude:\s*([-\d.]+)/) || [])[1]
                 || (text.match(/(?:lon|lng)(?:gitude)?["\s:>=]+(-?\d+\.\d+)/i) || [])[1];
        const acc = (text.match(/Accuracy:\s*±?(\d+)\s*m/i) || [])[1];
        const tech = (text.match(/Tech:\s*(.+)/) || [])[1] || '';
        if (lat && lng) {
          const pinned = {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            accuracy: acc ? parseInt(acc, 10) : null,
            capturedAt: null,
            capturedBy: tech.trim() || null
          };
          try { await window.DB.kvSet(pinnedLocationKey(folderId), pinned); } catch (e) {}
          if (state.currentProjectId === folderId) {
            state.gps = { ...pinned, link: `https://maps.google.com/?q=${pinned.lat},${pinned.lng}` };
          }
        }
      } catch (e) { /* ignore */ }
    }

    state.gpsLoading = false;
    updateGpsChipDOM();
  }

  // Explicit "Capture location" / "Update location" — the ONLY entry point
  // that calls getCurrentPosition. Triggered by user tap, never automatic.
  async function captureLocationExplicit(folderId, { isUpdate = false } = {}) {
    if (!('geolocation' in navigator)) {
      toast('GPS not supported on this device', 'warn');
      return;
    }
    if (isUpdate) {
      const ok = confirm('Replace the saved location for this project?');
      if (!ok) return;
    }
    state.gpsCapturing = true;
    updateGpsChipDOM();
    await runTwoStageGps(folderId);
    state.gpsCapturing = false;
    updateGpsChipDOM();
  }

  function getCurrentPositionPromise(opts) {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, opts);
    });
  }

  // Two-stage strategy:
  //   Stage 1 — low-accuracy (network/wifi), 5s timeout, 60s cache age.
  //             Fast and reliable. The chip lights up as soon as this
  //             returns so the tech sees their location immediately.
  //             If it fails, we retry once with up to a 5-min-old cached
  //             fix.
  //   Stage 2 — high-accuracy (GPS), 20s timeout, no cache. Runs in
  //             parallel; if it returns a tighter `accuracy` than Stage 1
  //             we silently upgrade the saved file.
  // Only when BOTH stages fail do we flip to "GPS unavailable".
  async function runTwoStageGps(folderId) {
    let stage1Pos = null;
    const stage1Promise = (async () => {
      try {
        const p = await getCurrentPositionPromise({
          enableHighAccuracy: false, timeout: 5000, maximumAge: 60000
        });
        stage1Pos = p;
        if (state.currentProjectId === folderId) {
          await applyGpsResult(folderId, p, /* isUpgrade */ false);
        }
        return p;
      } catch (err) {
        console.warn('[gps] stage1 failed:', err.message || err.code);
        if (err && err.code === 1) throw err; // PERMISSION_DENIED — terminal
        // Retry stage 1 once with a wider cache window.
        try {
          const p2 = await getCurrentPositionPromise({
            enableHighAccuracy: false, timeout: 5000, maximumAge: 300000
          });
          stage1Pos = p2;
          if (state.currentProjectId === folderId) {
            await applyGpsResult(folderId, p2, false);
          }
          return p2;
        } catch (err2) {
          console.warn('[gps] stage1 retry failed:', err2.message || err2.code);
          throw err2;
        }
      }
    })();

    const stage2Promise = (async () => {
      try {
        const p = await getCurrentPositionPromise({
          enableHighAccuracy: true, timeout: 20000, maximumAge: 0
        });
        if (state.currentProjectId !== folderId) return null;
        // Only commit if stage 2 actually came back with a better fix.
        const s1Acc = stage1Pos?.coords?.accuracy ?? Infinity;
        const s2Acc = p.coords.accuracy ?? Infinity;
        if (s2Acc < s1Acc) {
          console.log(`[gps] stage2 upgrade: ${s1Acc.toFixed(0)}m -> ${s2Acc.toFixed(0)}m`);
          await applyGpsResult(folderId, p, /* isUpgrade */ true);
        } else {
          console.log('[gps] stage2 no better than stage1; skipping upgrade');
        }
        return p;
      } catch (err) {
        console.warn('[gps] stage2 failed:', err.message || err.code);
        return null;
      }
    })();

    const [s1, s2] = await Promise.allSettled([stage1Promise, stage2Promise]);
    if (state.currentProjectId !== folderId) return;
    if (s1.status === 'rejected' && (!s2 || s2.value == null)) {
      console.warn('[gps] both stages failed; giving up');
      state.gps = null;
      state.gpsLoading = false;
      updateGpsChipDOM();
    }
  }

  async function applyGpsResult(folderId, pos, isUpgrade) {
    const { latitude, longitude, accuracy } = pos.coords;
    const link = `https://maps.google.com/?q=${latitude},${longitude}`;
    const tech = state.user?.name || 'unknown';
    const capturedAt = Date.now();
    const stamp = fmtGpsTimestamp(new Date(capturedAt));

    state.gps = {
      lat: latitude, lng: longitude, accuracy,
      capturedAt, capturedBy: tech, link
    };
    state.gpsLoading = false;
    updateGpsChipDOM();

    // Persist to project cache so the next open is instant + offline-safe.
    try {
      await window.DB.kvSet(pinnedLocationKey(folderId), {
        lat: latitude, lng: longitude, accuracy, capturedAt, capturedBy: tech
      });
    } catch (e) { /* ignore */ }

    // Append-only gps.txt: each user "Capture/Update Location" gesture
    // adds one block to the file. The two-stage GPS strategy (fast then
    // accurate) produces ONE block per gesture — stage 1 appends, stage 2
    // (if better) replaces the last block in place with the upgraded
    // coordinates. Prior captures from earlier gestures are preserved.
    const metaId = await window.Drive.findMetadataFolderId(folderId, { createIfMissing: true });
    return window.Drive.withSingletonLock(metaId, 'gps.txt', async () => {
      // Prefer a file already in `_metadata/`; legacy projects may have
      // one in the project root — leave it alone and create a new
      // append-only log in `_metadata/`.
      const found = await window.Drive.findFileInFolder(metaId, 'gps.txt');
      let existingText = '';
      if (found) {
        try { existingText = await window.Drive.downloadFileText(found.id); }
        catch (e) { /* treat as empty, will re-create */ }
      }
      const hasPriorBlock = /^=== [^=\n]+ ===$/m.test(existingText);
      const headerType = hasPriorBlock ? 'LOCATION UPDATED' : 'ORIGINAL LOCATION';
      const newBlock = buildGpsBlock({
        header: headerType,
        lat: latitude, lng: longitude, accuracy, tech, stamp, link
      });

      let newText;
      if (isUpgrade && hasPriorBlock) {
        // Stage-2 upgrade: replace the LAST block in the file with the
        // better-accuracy block. Keep the existing header type (don't
        // promote an ORIGINAL to UPDATED — we're refining the same
        // capture event, not creating a new one).
        const lastHeaderOffset = findLastSectionHeaderOffset(existingText);
        const lastHeaderLine = existingText.slice(lastHeaderOffset).split('\n', 1)[0];
        const lastHeaderType = (lastHeaderLine.match(/^=== ([^=\n]+) ===$/) || [])[1] || headerType;
        const replacementBlock = buildGpsBlock({
          header: lastHeaderType,
          lat: latitude, lng: longitude, accuracy, tech, stamp, link
        });
        newText = existingText.slice(0, lastHeaderOffset) + replacementBlock;
      } else {
        newText = existingText
          ? existingText.replace(/\n*$/, '\n') + newBlock
          : newBlock;
      }

      const blob = new Blob([newText], { type: 'text/plain' });
      try {
        if (found) {
          await window.Drive.updateFileContent(found.id, blob, 'text/plain');
        } else {
          await window.Drive.uploadMultipart({
            folderId: metaId, fileName: 'gps.txt', mimeType: 'text/plain', blob
          });
        }
        appendVisitLog(folderId, isUpgrade ? 'refined GPS' : 'captured GPS').catch(() => {});
      } catch (err) {
        console.warn('[gps] file write failed:', err.message);
        toast(`GPS save failed: ${err.message}`, 'error', 4000);
      }
    });
  }

  // ---------- Visit log + filenames ----------
  async function appendVisitLog(folderId, summary) {
    const line = `${fmtDateTime()} — ${state.user?.name || 'unknown'} — ${summary}\n`;
    // Serialize all visit_log writes per project. Two concurrent
    // callers (e.g. a photo upload finishing while the user adds a
    // note) would each do search-then-create and miss each other's
    // writes, producing duplicate files. The lock + kv id cache
    // collapses them to a single file with one append per call.
    return window.Drive.withSingletonLock(folderId, 'visit_log.txt', async () => {
      try {
        const cachedKey = `visitLogId:${folderId}`;
        const cached = await window.DB.kvGet(cachedKey);
        // Resolve the parent folder for visit_log.txt:
        //  - if a cached file id exists, appendToTextFile uses it directly
        //  - else find an existing copy in root (legacy) or _metadata/
        //  - else use _metadata/ for new writes
        let parentId = folderId;
        if (!cached) {
          const found = await window.Drive.findMetadataFile(folderId, 'visit_log.txt');
          if (found) {
            parentId = found.parentId;
          } else {
            parentId = await window.Drive.findMetadataFolderId(folderId, { createIfMissing: true });
          }
        }
        const result = await window.Drive.appendToTextFile({
          folderId: parentId,
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
    });
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

  // ---------- PWA install hint (cross-platform, one-time) ----------
  // Camera + microphone permissions don't persist reliably for non-
  // installed pages on iOS Safari. Installation as a PWA fixes that. On
  // first launch we show a blocking screen with platform-specific
  // instructions. Dismissed flag persists in localStorage so the screen
  // never returns. Once detected as standalone we mark it dismissed
  // automatically.
  let deferredInstallEvent = null;
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferredInstallEvent = ev;
    console.log('[install] beforeinstallprompt captured — Install button will trigger native prompt');
    const btn = document.getElementById('install-native-btn');
    if (btn) btn.hidden = false;
  });

  function isStandalone() {
    return window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
  }

  function detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) && !/Macintosh/.test(ua)) {
      return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other' : 'ios-safari';
    }
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  function maybeShowInstallHint() {
    try {
      // If we're already running standalone, lock the flag forever.
      if (isStandalone()) {
        try { localStorage.setItem('install_hint_shown', '1'); } catch (e) { /* ignore */ }
        return;
      }
      let shown = null;
      try { shown = localStorage.getItem('install_hint_shown'); } catch (e) { /* ignore */ }
      if (shown === '1') return;
      // Defer briefly so it doesn't fight the auth/boot path.
      setTimeout(showInstallHint, 600);
    } catch (e) { /* ignore */ }
  }

  function dismissInstallHint() {
    try { localStorage.setItem('install_hint_shown', '1'); } catch (e) { /* ignore */ }
    const root = document.getElementById('overlay-root');
    if (root) root.innerHTML = '';
  }

  function showInstallHint() {
    if (isStandalone()) return;
    const platform = detectPlatform();
    const root = document.getElementById('overlay-root');
    if (!root) return;
    if (document.getElementById('install-hint-screen')) return;

    const blocks = {
      'ios-safari': `
        <h2>Install on iPhone</h2>
        <ol class="install-steps">
          <li>Tap the <strong>Share</strong> button in Safari (the square with ↑).</li>
          <li>Scroll and choose <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong>. Launch the app from your home screen — camera, mic, and sign-in will be remembered.</li>
        </ol>`,
      'ios-other': `
        <h2>Install on iPhone</h2>
        <p>Open this site in <strong>Safari</strong>, then Share → Add to Home Screen. Other iOS browsers don't support installation.</p>`,
      'android': `
        <h2>Install on Android</h2>
        <p>Tap <strong>Install</strong> below — or open the Chrome menu (⋮) and choose <strong>Install app</strong>.</p>
        <button class="btn-install-native" id="install-native-btn" ${deferredInstallEvent ? '' : 'hidden'}>Install app</button>`,
      'desktop': `
        <h2>Install on this computer</h2>
        <p>Click the <strong>install</strong> icon at the right of the address bar — or open the browser menu and choose <strong>Install Site Visit Logger</strong>.</p>
        <button class="btn-install-native" id="install-native-btn" ${deferredInstallEvent ? '' : 'hidden'}>Install app</button>`
    };

    root.innerHTML = `
      <div class="install-screen" id="install-hint-screen">
        <div class="install-card">
          <img class="install-logo" src="icons/icon-192.png" alt=""/>
          ${blocks[platform]}
          <p class="muted small install-why">Installing keeps the camera, microphone, and sign-in granted between visits.</p>
          <button class="btn-install-skip" id="install-hint-skip">Skip — open in browser</button>
        </div>
      </div>
    `;
    document.getElementById('install-hint-skip')?.addEventListener('click', dismissInstallHint);
    document.getElementById('install-native-btn')?.addEventListener('click', async () => {
      if (!deferredInstallEvent) return;
      try {
        deferredInstallEvent.prompt();
        const choice = await deferredInstallEvent.userChoice;
        console.log('[install] user choice:', choice && choice.outcome);
        deferredInstallEvent = null;
        dismissInstallHint();
      } catch (e) {
        console.warn('[install] prompt failed:', e);
      }
    });
  }

  // ---------- Permissions ----------
  // We DO NOT call getUserMedia at boot. On iOS Safari every getUserMedia
  // call risks re-prompting the tech, even when the browser already
  // remembers the previous grant. Instead the OS prompt only fires when
  // the tech actually taps Open Camera (or Record voice note) — that's
  // the only time a stream is needed, and the prompt is in context of a
  // user-initiated action.
  // Here we just log the current Permissions API state for diagnostics.
  let mediaPermissionsChecked = false;
  async function ensureMediaPermissions() {
    if (mediaPermissionsChecked) return;
    mediaPermissionsChecked = true;
    try {
      const cam = await window.Camera.checkPermission('camera');
      const mic = await window.Camera.checkPermission('microphone');
      console.log('[perm] state cam=', cam, 'mic=', mic, '— deferring any prompt to first Open Camera tap');
    } catch (err) {
      console.warn('[perm] check error', err);
    }
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
      // Append-only: edits + new notes both append a new block. The
      // edit path uses (EDITED) so the office team can tell. Previous
      // entries are never modified or removed.
      const kind = state.editingNoteIdx != null ? 'EDITED' : 'NOTE';
      const block = buildNoteBlock(kind, stamp, tech, text);
      const result = await window.Drive.appendToTextFile({
        folderId,
        fileName: 'notes.txt',
        lineOrText: block,
        cachedFileId: state.notesFileId
      });
      state.notesFileId = result.id;
      await window.DB.kvSet(`notesFileId:${folderId}`, result.id);
      ta.value = '';
      state.notesEntries.unshift({ ts: stamp, tech, body: text, kind });
      const wasEdit = state.editingNoteIdx != null;
      state.editingNoteIdx = null;
      updateNotesHistoryDOM();
      updateNotesEditUIDOM();
      toast(wasEdit ? 'Note updated' : 'Note saved', 'success');
      appendVisitLog(folderId, wasEdit ? 'edited text note' : 'added text note').catch(() => {});
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
      // No user → nothing to upload; calling getAccessToken would only
      // trigger a doomed silent-refresh against the GIS iframe in the
      // PWA sandbox. The user will pumpQueue again after signing in.
      if (!window.Auth.isSignedIn()) return;
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
        const uploadArgs = {
          folderId: item.targetFolderId || item.projectId,
          fileName: item.fileName,
          mimeType: item.mimeType,
          blob: item.blob,
          onProgress: (p) => patchThumbByQueueId(item.id, { progress: p })
        };
        const result = item.singleton
          ? await window.Drive.upsertSingletonFile(uploadArgs)
          : await window.Drive.uploadFile(uploadArgs);
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

  // ---- Per-project cache (cache-first project pages) ---------------------
  // Key: project.{folderId}.cache → { files:[{id,name,mimeType,size,
  //   modifiedTime,createdTime,thumbnailLink,webViewLink}], cachedAt }
  // Used to paint the project gallery within ~150ms; live Drive fetch runs
  // in the background and only re-renders if anything actually changed.
  function projectCacheKey(folderId) { return `project.${folderId}.cache`; }

  function fileListEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].id !== b[i].id || a[i].name !== b[i].name ||
          a[i].modifiedTime !== b[i].modifiedTime || a[i].size !== b[i].size) return false;
    }
    return true;
  }

  function buildThumbsFromFiles(files) {
    const media = files
      .filter((f) =>
        (f.mimeType || '').startsWith('image/') ||
        (f.mimeType || '').startsWith('video/') ||
        (f.mimeType || '').startsWith('audio/')
      )
      .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

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

    const pendingThumbs = state.thumbs.filter((t) => !t.fileId);
    return [...pendingThumbs, ...driveThumbs];
  }

  // Synchronous-feeling cache load: paints from IDB before the network
  // fetch starts. Called from enterProject so the gallery has thumbs
  // visible within a single repaint.
  async function preloadProjectMediaFromCache(folderId) {
    try {
      const cached = await window.DB.kvGet(projectCacheKey(folderId));
      if (cached && Array.isArray(cached.files) && cached.files.length > 0) {
        if (state.currentProjectId !== folderId) return;
        state.thumbs = buildThumbsFromFiles(cached.files);
        state.thumbsLoading = false;
        console.log('[project] cache hit:', cached.files.length, 'files, age',
          Math.round((Date.now() - (cached.cachedAt || 0)) / 1000), 's');
        updateThumbsDOM();
      }
    } catch (e) { /* ignore */ }
  }

  async function refreshProjectMedia() {
    if (!state.currentProjectId) return;
    const folderId = state.currentProjectId;

    // Paint from cache first if we haven't yet — so the live fetch runs
    // in the background, never gating the UI.
    if (state.thumbs.length === 0) await preloadProjectMediaFromCache(folderId);
    const hadThumbs = state.thumbs.length > 0;
    state.thumbsSyncing = true;
    if (!hadThumbs) state.thumbsLoading = true;
    updateThumbsDOM();
    updateProjectSyncIndicatorDOM();

    try {
      const files = await window.Drive.listFolderFiles(folderId);
      if (state.currentProjectId !== folderId) return; // tech navigated away
      try {
        await window.DB.kvSet(projectCacheKey(folderId), {
          files: files.map((f) => ({
            id: f.id, name: f.name, mimeType: f.mimeType,
            size: f.size, modifiedTime: f.modifiedTime,
            createdTime: f.createdTime,
            thumbnailLink: f.thumbnailLink || '',
            webViewLink: f.webViewLink || ''
          })),
          cachedAt: Date.now()
        });
      } catch (e) { /* ignore */ }
      state.thumbs = buildThumbsFromFiles(files);
    } catch (err) {
      const msg = err && err.message || '';
      if (/TOKEN_TIMEOUT|Token request|Auth not initialized/i.test(msg)) {
        console.warn('[project] live fetch deferred (auth):', msg);
      } else {
        console.warn('[project] refresh failed:', msg);
      }
    } finally {
      state.thumbsLoading = false;
      state.thumbsSyncing = false;
      updateThumbsDOM();
      updateProjectSyncIndicatorDOM();
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
  // Append-only notes.txt log. New entries use one of three section
  // headers:
  //   === NOTE ===            new note
  //   === NOTE (EDITED) ===   amendment to a prior note (own entry,
  //                           does not replace the original)
  //   === NOTE (DELETED) ===  tombstone whose body contains
  //                           `Original: <ts>` to identify which entry
  //                           to hide from the UI.
  // Legacy entries (--- ts — tech ---) are still parsed for backward
  // compatibility; legacy soft-deletes use the `[DELETED ...]` body
  // prefix.
  function parseNotesAll(text) {
    if (!text) return [];
    const out = [];

    // New format: === NOTE === / (EDITED) === / (DELETED) ===
    const sectionRe = /^=== NOTE(?:\s+\((EDITED|DELETED)\))? ===$/gm;
    const sections = [];
    let m;
    while ((m = sectionRe.exec(text)) !== null) {
      sections.push({ index: m.index, end: m.index + m[0].length, kind: m[1] || 'NOTE' });
    }
    for (let i = 0; i < sections.length; i += 1) {
      const block = text.slice(sections[i].end, i + 1 < sections.length ? sections[i + 1].index : text.length);
      const lines = block.replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
      if (lines.length === 0) continue;
      const head = lines[0].match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+—\s+(.+)$/);
      if (!head) continue;
      const entry = {
        ts: head[1],
        tech: head[2],
        body: lines.slice(1).join('\n').replace(/^\s+|\s+$/g, ''),
        kind: sections[i].kind
      };
      if (entry.kind === 'DELETED') {
        const origMatch = entry.body.match(/^Original:\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\b/);
        if (origMatch) entry.targetTs = origMatch[1];
      }
      out.push(entry);
    }

    // Legacy format: --- ts — tech ---
    const legacyRe = /^---\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+—\s+(.+?)\s+---$/gm;
    const legacyMatches = [];
    while ((m = legacyRe.exec(text)) !== null) {
      legacyMatches.push({ index: m.index, end: legacyRe.lastIndex, ts: m[1], tech: m[2] });
    }
    for (let i = 0; i < legacyMatches.length; i += 1) {
      const start = legacyMatches[i].end;
      // Stop at the next legacy delimiter OR the first new-format section,
      // so a mixed-format file doesn't bleed bodies across boundaries.
      let stop = i + 1 < legacyMatches.length ? legacyMatches[i + 1].index : text.length;
      for (const s of sections) {
        if (s.index > start && s.index < stop) stop = s.index;
      }
      const body = text.slice(start, stop).replace(/^\s+|\s+$/g, '');
      out.push({ ts: legacyMatches[i].ts, tech: legacyMatches[i].tech, body, kind: 'NOTE' });
    }

    // Newest-first ordering — same as before; ties broken by file order
    // (later in file wins among same-ts entries).
    out.sort((a, b) => (a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0)));
    return out;
  }

  // Legacy soft-delete marker: body starts with "[DELETED ts — tech]".
  function isLegacyDeletedNote(entry) {
    return /^\[DELETED\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+—\s+.+?\]/.test(entry?.body || '');
  }

  // Visible entries for the UI: skip DELETED tombstones, skip any entry
  // whose ts is targeted by a tombstone, and skip legacy-soft-deleted
  // entries (the `[DELETED …]` body-prefix style).
  function parseNotes(text) {
    const all = parseNotesAll(text);
    const deletedTargets = new Set();
    for (const e of all) {
      if (e.kind === 'DELETED' && e.targetTs) deletedTargets.add(e.targetTs);
    }
    return all.filter((e) =>
      e.kind !== 'DELETED' &&
      !isLegacyDeletedNote(e) &&
      !deletedTargets.has(e.ts));
  }

  function buildNoteBlock(kind, ts, tech, body) {
    const header = kind === 'EDITED' ? '=== NOTE (EDITED) ==='
      : kind === 'DELETED' ? '=== NOTE (DELETED) ==='
      : '=== NOTE ===';
    return `\n${header}\n${ts} — ${tech}\n${body}\n`;
  }

  async function deleteNoteAt(idx) {
    const note = state.notesEntries[idx];
    if (!note) return;
    if (!confirm('Delete this note?')) return;

    // Optimistic UI update — restore from server if the write fails.
    const removed = state.notesEntries.splice(idx, 1)[0];
    updateNotesHistoryDOM();

    try {
      const stamp = fmtDateTime();
      const tech = state.user?.name || 'unknown';
      // Append-only soft delete: write a `=== NOTE (DELETED) ===` block
      // whose body references the original by timestamp. Never modifies
      // or removes the original entry from the file.
      const block = buildNoteBlock('DELETED', stamp, tech, `Original: ${removed.ts}`);
      const result = await window.Drive.appendToTextFile({
        folderId: state.currentProjectId,
        fileName: 'notes.txt',
        lineOrText: block,
        cachedFileId: state.notesFileId
      });
      state.notesFileId = result.id;
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
        onClose: () => {},
        onDelete: async () => { await deleteThumb(target); }
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
    // If a voice/video is currently playing through VideoPlayer or any
    // <audio> element holds this blob, stop it before deleting so the
    // browser doesn't keep the file referenced.
    if ((thumb.type === 'audio' || thumb.type === 'video') && window.VideoPlayer?.isOpen()) {
      try { window.VideoPlayer.close(); } catch (e) { /* ignore */ }
    }
    document.querySelectorAll('audio, video').forEach((el) => {
      if (el.src && thumb.objectUrl && el.src === thumb.objectUrl) {
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
      }
    });

    let deletedTranscriptId = null;
    if (thumb.fileId) {
      try { await window.Drive.deleteFile(thumb.fileId); }
      catch (err) {
        console.warn(`[delete] thumb FAILED in Drive: fileId=${thumb.fileId}, name=${thumb.name}, err=${err.message}`);
        toast(`Delete failed: ${err.message}`, 'error');
        return;
      }
      console.log(`[delete] thumb deleted from Drive: fileId=${thumb.fileId}, name=${thumb.name}`);
      // Voice notes: also remove the matching _transcript.txt sibling
      // (if a transcript was ever generated). This mirrors the Drive
      // file pair so the office team doesn't see stale text.
      if (thumb.type === 'audio' && thumb.name) {
        const transcriptName = thumb.name.replace(/\.[^.]+$/, '_transcript.txt');
        try {
          const t = await window.Drive.findFileInFolder(state.currentProjectId, transcriptName);
          if (t) { deletedTranscriptId = t.id; await window.Drive.deleteFile(t.id); }
        } catch (e) { /* best-effort */ }
      }
      // Audit trail in visit_log.txt — same pattern as soft-deleted notes.
      const kindLabel = thumb.type === 'audio' ? 'voice recording'
        : thumb.type === 'video' ? 'video'
        : thumb.type === 'photo' ? 'photo'
        : 'file';
      appendVisitLog(state.currentProjectId,
        `[DELETED ${kindLabel} ${thumb.name}]`).catch(() => {});
    } else if (thumb.queueId) {
      try { await window.DB.queueDelete(thumb.queueId); } catch (e) { /* ignore */ }
    }
    const idx = state.thumbs.indexOf(thumb);
    if (idx >= 0) state.thumbs.splice(idx, 1);
    revokeThumbBlob(thumb);

    // Persistent cache: remove the deleted file (and its transcript, if
    // any) from project.{folderId}.cache so the next cache-first paint
    // doesn't re-show it. The cache shape is { files:[{id,...}], cachedAt };
    // ignore the dead-code `cached.thumbs` branch the user's spec includes.
    try {
      const folderId = state.currentProjectId;
      if (folderId && thumb.fileId) {
        const cacheKey = projectCacheKey(folderId);
        const cached = await window.DB.kvGet(cacheKey);
        if (cached && Array.isArray(cached.files)) {
          const dropIds = new Set([thumb.fileId]);
          if (deletedTranscriptId) dropIds.add(deletedTranscriptId);
          cached.files = cached.files.filter((f) => !dropIds.has(f.id));
          cached.cachedAt = Date.now();
          await window.DB.kvSet(cacheKey, cached);
        }
        // Gallery state may be loaded too — keep it in sync.
        if (Array.isArray(state.galleryFiles)) {
          state.galleryFiles = state.galleryFiles.filter((f) =>
            f.id !== thumb.fileId && (!deletedTranscriptId || f.id !== deletedTranscriptId));
        }
      }
    } catch (e) { console.warn('[delete] cache update failed:', e); }

    updateThumbsDOM();
    toast('Deleted', 'success');
  }

  function revokeThumbBlob(t) {
    if (t && t.objectUrl) {
      try { URL.revokeObjectURL(t.objectUrl); } catch (e) { /* ignore */ }
    }
  }

  // ---------- Drive (gallery) view ----------
  // Cache-first paint: read project.{folderId}.cache (same cache used by the
  // capture-screen thumb strip) and render immediately, then refresh from
  // Drive in the background. First-ever open with no cache shows a brief
  // skeleton; subsequent opens paint within ~150ms.
  let galleryLoadToken = 0;
  async function openGallery() {
    if (!ensureProject()) return;
    if (window.Camera.isOpen()) window.Camera.close();
    const folderId = state.currentProjectId;
    const myToken = ++galleryLoadToken;
    state.view = 'gallery';
    state.galleryFiles = [];
    state.galleryLoading = true;
    if (gallerySelectMode) exitGallerySelectMode();
    scheduleRender();

    try {
      const cached = await window.DB.kvGet(projectCacheKey(folderId));
      if (cached && Array.isArray(cached.files) && cached.files.length > 0
          && myToken === galleryLoadToken
          && state.currentProjectId === folderId && state.view === 'gallery') {
        state.galleryFiles = cached.files;
        state.galleryLoading = false;
        console.log('[gallery] cache hit:', cached.files.length, 'files, age',
          Math.round((Date.now() - (cached.cachedAt || 0)) / 1000), 's');
        updateGalleryListDOM();
      }
    } catch (e) { /* ignore */ }

    try {
      const files = await window.Drive.listFolderFiles(folderId);
      // Invalidate result if the user navigated away or a delete bumped the
      // token — otherwise a stale list would re-include deleted files.
      if (myToken !== galleryLoadToken) return;
      if (state.currentProjectId !== folderId || state.view !== 'gallery') return;
      try {
        await window.DB.kvSet(projectCacheKey(folderId), {
          files: files.map((f) => ({
            id: f.id, name: f.name, mimeType: f.mimeType,
            size: f.size, modifiedTime: f.modifiedTime,
            createdTime: f.createdTime,
            thumbnailLink: f.thumbnailLink || '',
            webViewLink: f.webViewLink || ''
          })),
          cachedAt: Date.now()
        });
      } catch (e) { /* ignore */ }
      if (!fileListEqual(state.galleryFiles, files)) {
        state.galleryFiles = files;
        updateGalleryListDOM();
      }
    } catch (err) {
      if (myToken !== galleryLoadToken) return;
      // If we already painted from cache, don't toast over a working view.
      if (!state.galleryFiles || state.galleryFiles.length === 0) {
        toast(`Could not load Drive: ${err.message}`, 'error');
      } else {
        console.warn('[gallery] background refresh failed:', err.message);
      }
    } finally {
      if (myToken === galleryLoadToken) {
        state.galleryLoading = false;
        updateGalleryListDOM();
      }
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
    updateConnDotDOM();
  }

  function renderLogin(app) {
    app.innerHTML = `
      <div class="screen login-screen">
        <div class="brand">
          <img class="brand-logo" src="icons/icon-512.png" alt="Dancon Construction Services" />
          <p class="brand-tag">Site Visit Logger</p>
        </div>
        <button id="signin-btn" class="btn-signin">Sign in with Google</button>
        <div id="login-error" class="login-error" role="alert" hidden></div>
        <p class="login-fineprint">Only @${escapeHtml(window.CONFIG.HOSTED_DOMAIN)} accounts can sign in.</p>
        <div id="login-debug-log" class="login-debug-log" hidden>
          <div class="login-debug-log-header">
            <span class="login-debug-log-title">Debug log</span>
            <button type="button" id="login-debug-copy" class="login-debug-btn">Copy log</button>
            <button type="button" id="login-debug-hide" class="login-debug-btn">Hide</button>
          </div>
          <pre id="login-debug-log-body" class="login-debug-log-body"></pre>
        </div>
      </div>
    `;
    document.getElementById('signin-btn').addEventListener('click', onSignInClick);
    const copyBtn = document.getElementById('login-debug-copy');
    if (copyBtn) copyBtn.addEventListener('click', onCopyDebugLog);
    const hideBtn = document.getElementById('login-debug-hide');
    if (hideBtn) hideBtn.addEventListener('click', onHideDebugLog);
    // Easter egg: 5 quick taps on the brand logo reveal the debug panel.
    // Console.log calls still output to the browser dev console regardless.
    const logo = document.querySelector('.brand-logo');
    if (logo) logo.addEventListener('click', onLogoTap);
    // PWA-only: render the inline GIS One Tap prompt. iOS opens redirect
    // OAuth in an isolated SFSafariViewController sheet that breaks 2FA;
    // One Tap stays inside the PWA's own webview/cookie context.
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (isStandalone && window.Auth && typeof window.Auth.initOneTap === 'function') {
      try { window.Auth.initOneTap(); } catch (e) { console.warn('initOneTap threw:', e); }
    }
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
            <div class="recent-head">
              <h2 class="section-h">Recent sites</h2>
              <span id="recent-sync" class="sync-dot" hidden aria-label="Syncing"></span>
            </div>
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
    updateHomeSyncIndicatorDOM();
  }
  function updateHomeSyncIndicatorDOM() {
    const dot = document.getElementById('recent-sync');
    if (!dot) return;
    dot.hidden = !state.projectsSyncing;
  }
  function updateProjectSyncIndicatorDOM() {
    const dot = document.getElementById('thumbs-sync');
    if (!dot) return;
    dot.hidden = !state.thumbsSyncing;
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
      // First-ever launch (no cache): skeleton, not a "Loading…" line.
      list.innerHTML = `
        <div class="list-skeleton" aria-hidden="true">
          <div></div><div></div><div></div>
        </div>`;
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
              <span id="thumbs-sync" class="sync-dot" hidden aria-label="Syncing"></span>
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

  // Project names get a ` MM-DD-YYYY` suffix at creation. The suffix is
  // permanent identity — never editable. Returns {prefix, date|null}.
  function parseProjectName(fullName) {
    const m = (fullName || '').match(/^(.*) (\d{2}-\d{2}-\d{4})$/);
    if (m) return { prefix: m[1], date: m[2] };
    return { prefix: fullName || '', date: null };
  }

  function updateProjectTitleDOM() {
    const region = document.getElementById('proj-title-region');
    if (!region) return;
    if (state.isRenaming) {
      const parsed = parseProjectName(state.currentProjectName || '');
      const dateLabel = parsed.date
        ? `<span class="rename-date" aria-label="Project date (not editable)">${escapeHtml(parsed.date)}</span>`
        : '';
      region.innerHTML = `
        <form class="rename-form" id="rename-form">
          <input type="text" id="rename-input" value="${escapeHtml(parsed.prefix)}" autocomplete="off" autocapitalize="words" />
          ${dateLabel}
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

  // The GPS chip is the project's PINNED-LOCATION control.
  //   • Loading the cache for the first time: small "Loading location…"
  //   • Cache empty / never captured: "📍 Capture location" button
  //   • Pinned: "📍 Location: lat, lng ✓" — tap → Maps, long-press → Update
  //   • Capture in progress: "📍 Capturing location…" (explicit only)
  function updateGpsChipDOM() {
    const row = document.getElementById('gps-row');
    if (!row) return;
    if (state.gpsCapturing) {
      row.innerHTML = '<span class="gps-chip muted">📍 Capturing location…</span>';
      return;
    }
    if (state.gpsLoading && !state.gps) {
      row.innerHTML = '<span class="gps-chip muted">📍 Loading location…</span>';
      return;
    }
    if (!state.gps) {
      row.innerHTML = `
        <button class="gps-chip gps-chip-cta" id="gps-capture-btn" type="button">
          📍 Capture location
        </button>`;
      document.getElementById('gps-capture-btn')?.addEventListener('click', () => {
        if (state.currentProjectId) captureLocationExplicit(state.currentProjectId, { isUpdate: false });
      });
      return;
    }
    const lat = state.gps.lat.toFixed(5);
    const lng = state.gps.lng.toFixed(5);
    row.innerHTML = `
      <button class="gps-chip gps-chip-pinned" id="gps-pinned-btn" type="button"
              data-link="${escapeHtml(state.gps.link)}">
        📍 Location: ${escapeHtml(lat)}, ${escapeHtml(lng)} ✓
      </button>`;
    const btn = document.getElementById('gps-pinned-btn');
    let lpTimer = null;
    let lpFired = false;
    btn?.addEventListener('click', (ev) => {
      if (lpFired) { lpFired = false; ev.preventDefault(); return; }
      // Default tap → open Maps
      window.open(btn.dataset.link, '_blank', 'noopener');
    });
    btn?.addEventListener('pointerdown', () => {
      lpFired = false;
      lpTimer = setTimeout(() => {
        lpFired = true;
        if (state.currentProjectId) {
          captureLocationExplicit(state.currentProjectId, { isUpdate: true });
        }
      }, 600);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
      btn?.addEventListener(evt, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    });
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

  // -------- Long-press → multi-select --------
  // Long-pressing any thumb enters selection mode with that item auto-
  // selected. Subsequent taps toggle selection. A floating action bar
  // shows the count with Delete / Cancel buttons. Bulk delete fires the
  // existing single-item deleteThumb() in parallel for each selection.
  const thumbSelection = new Set();
  let thumbSelectMode = false;
  let lpTimer = null;
  let lpSuppressClick = false;
  let thumbsDocListenerAttached = false;

  function clearLongPress() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  }
  function thumbKeyToIndex(key) {
    return state.thumbs.findIndex((t) =>
      String(t.queueId ?? t.fileId ?? '') === String(key));
  }
  function enterThumbSelectMode(initialKey) {
    thumbSelectMode = true;
    thumbSelection.clear();
    if (initialKey) thumbSelection.add(String(initialKey));
    if (navigator.vibrate) try { navigator.vibrate(20); } catch (e) { /* ignore */ }
    updateThumbsDOM();
    renderThumbActionBar();
  }
  function exitThumbSelectMode() {
    thumbSelectMode = false;
    thumbSelection.clear();
    const bar = document.getElementById('thumb-action-bar');
    if (bar) bar.remove();
    updateThumbsDOM();
  }
  function toggleThumbSelection(key) {
    const k = String(key);
    if (thumbSelection.has(k)) thumbSelection.delete(k);
    else thumbSelection.add(k);
    if (thumbSelection.size === 0) { exitThumbSelectMode(); return; }
    updateThumbsDOM();
    renderThumbActionBar();
  }
  function renderThumbActionBar() {
    let bar = document.getElementById('thumb-action-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'thumb-action-bar';
      bar.className = 'thumb-action-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <span class="sel-count">${thumbSelection.size} selected</span>
      <button type="button" class="btn-ghost" id="thumb-sel-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="thumb-sel-delete">Delete Selected</button>
    `;
    document.getElementById('thumb-sel-cancel').addEventListener('click', exitThumbSelectMode);
    document.getElementById('thumb-sel-delete').addEventListener('click', bulkDeleteSelectedThumbs);
  }
  async function bulkDeleteSelectedThumbs() {
    const n = thumbSelection.size;
    if (n === 0) return;
    if (!confirm(`Delete ${n} file${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const targets = Array.from(thumbSelection)
      .map((k) => state.thumbs[thumbKeyToIndex(k)])
      .filter(Boolean);
    const deletedIds = new Set(targets.map((t) => t.fileId).filter(Boolean));
    await Promise.all(targets.map((t) => deleteThumb(t).catch((e) => {
      console.warn('[bulk-delete] thumb delete failed:', e && e.message);
    })));
    // Concurrent per-thumb cache writes can race (read-modify-write). Do
    // one consolidating rewrite at the end so the cache reflects every
    // deletion regardless of interleaving.
    await reconcileCacheAfterBulkDelete(deletedIds);
    exitThumbSelectMode();
  }

  async function reconcileCacheAfterBulkDelete(deletedIds) {
    if (!deletedIds || deletedIds.size === 0) return;
    const folderId = state.currentProjectId;
    if (!folderId) return;
    try {
      const cacheKey = projectCacheKey(folderId);
      const cached = await window.DB.kvGet(cacheKey);
      if (cached && Array.isArray(cached.files)) {
        cached.files = cached.files.filter((f) => !deletedIds.has(f.id));
        cached.cachedAt = Date.now();
        await window.DB.kvSet(cacheKey, cached);
        console.log('[bulk-delete] cache reconciled:', deletedIds.size, 'IDs removed');
      }
    } catch (e) { console.warn('[bulk-delete] cache reconcile failed:', e); }
  }

  function attachThumbInteractions(strip) {
    strip.querySelectorAll('.thumb').forEach((thumbEl) => {
      const key = thumbEl.dataset.thumbKey;
      thumbEl.addEventListener('pointerdown', () => {
        clearLongPress();
        lpTimer = setTimeout(() => {
          lpSuppressClick = true;
          if (!thumbSelectMode) enterThumbSelectMode(key);
        }, 500);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
        thumbEl.addEventListener(evt, clearLongPress);
      });
    });
    if (!thumbsDocListenerAttached) {
      thumbsDocListenerAttached = true;
      // Tap outside any thumb (and outside the action bar) cancels selection.
      document.addEventListener('pointerdown', (ev) => {
        if (!thumbSelectMode) return;
        if (ev.target.closest('.thumb')) return;
        if (ev.target.closest('#thumb-action-bar')) return;
        exitThumbSelectMode();
      }, { capture: true });
    }
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
      // First-ever project open with no cache — skeleton shimmer.
      strip.innerHTML = `
        <div class="thumb-skeleton" aria-hidden="true">
          <div></div><div></div><div></div><div></div><div></div><div></div>
        </div>`;
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
        if (action === 'open') {
          if (thumbSelectMode) {
            const t = state.thumbs[idx];
            const key = String(t.queueId ?? t.fileId ?? `thumb-${idx}`);
            toggleThumbSelection(key);
          } else {
            openViewerForThumb(idx);
          }
        }
        else if (action === 'retry') retryThumb(state.thumbs[idx].queueId);
      });
    });

    attachThumbInteractions(strip);
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

    const selected = thumbSelectMode && thumbSelection.has(String(key));
    const selCls = thumbSelectMode ? (selected ? ' selected' : ' selectable') : '';
    const checkHtml = thumbSelectMode
      ? `<div class="thumb-check" aria-hidden="true">${selected ? '✓' : ''}</div>`
      : '';

    return `
      <div class="thumb ${cls} ${t.type}${selCls}" data-thumb-action="open" data-thumb-idx="${idx}" data-thumb-key="${key}">
        ${bgHtml}
        ${stateHtml}
        ${showProgress ? `<div class="thumb-progress"><div class="thumb-progress-bar" style="width:${pct}%"></div></div>` : ''}
        ${checkHtml}
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
    // Edited only the prefix portion. Reattach the original date suffix
    // (if any) so it can never change regardless of how many times the
    // project is renamed.
    const parsed = parseProjectName(state.currentProjectName || '');
    const sanitizedPrefix = window.Drive.sanitizeFolderName(input.value);
    if (!sanitizedPrefix) { cancelRename(); return; }
    const fullName = parsed.date
      ? `${sanitizedPrefix} ${parsed.date}`
      : sanitizedPrefix;
    if (fullName === state.currentProjectName) {
      cancelRename();
      return;
    }

    // Conflict check — warn if another folder under Site Visits already has
    // this name (case-insensitive match on the full dated name).
    try {
      const existing = await window.Drive.listProjectFolders({ pageSize: 200 });
      const conflict = existing.find(
        (p) => p.id !== state.currentProjectId &&
               p.name.toLowerCase() === fullName.toLowerCase()
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
      const updated = await window.Drive.renameFile(state.currentProjectId, fullName);
      state.currentProjectName = updated.name || fullName;
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

  // ---------- Gallery long-press → multi-select (mirror of capture pattern) ----------
  const gallerySelection = new Set();
  let gallerySelectMode = false;
  let galleryLpTimer = null;
  let galleryLpSuppressClick = false;
  let galleryDocListenerAttached = false;

  function clearGalleryLongPress() {
    if (galleryLpTimer) { clearTimeout(galleryLpTimer); galleryLpTimer = null; }
  }
  function enterGallerySelectMode(initialKey) {
    gallerySelectMode = true;
    gallerySelection.clear();
    if (initialKey) gallerySelection.add(String(initialKey));
    if (navigator.vibrate) try { navigator.vibrate(20); } catch (e) { /* ignore */ }
    updateGalleryListDOM();
    renderGalleryActionBar();
  }
  function exitGallerySelectMode() {
    gallerySelectMode = false;
    gallerySelection.clear();
    const bar = document.getElementById('gallery-action-bar');
    if (bar) bar.remove();
    updateGalleryListDOM();
  }
  function toggleGallerySelection(key) {
    const k = String(key);
    if (gallerySelection.has(k)) gallerySelection.delete(k);
    else gallerySelection.add(k);
    if (gallerySelection.size === 0) { exitGallerySelectMode(); return; }
    updateGalleryListDOM();
    renderGalleryActionBar();
  }
  function renderGalleryActionBar() {
    let bar = document.getElementById('gallery-action-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'gallery-action-bar';
      bar.className = 'thumb-action-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <span class="sel-count">${gallerySelection.size} selected</span>
      <button type="button" class="btn-ghost" id="gallery-sel-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="gallery-sel-delete">Delete Selected</button>
    `;
    document.getElementById('gallery-sel-cancel').addEventListener('click', exitGallerySelectMode);
    document.getElementById('gallery-sel-delete').addEventListener('click', bulkDeleteSelectedGallery);
  }
  async function bulkDeleteSelectedGallery() {
    const n = gallerySelection.size;
    if (n === 0) return;
    if (!confirm(`Delete ${n} file${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const ids = Array.from(gallerySelection);
    const files = ids
      .map((id) => (state.galleryFiles || []).find((f) => f.id === id))
      .filter(Boolean);
    const deletedIds = new Set(files.map((f) => f.id));
    await Promise.all(files.map((f) => deleteGalleryFile(f).catch((e) => {
      console.warn('[bulk-delete] gallery file failed:', e && e.message);
    })));
    // Final consolidating cache write — fixes any read-modify-write race
    // between per-file deleteGalleryFile cache updates running in parallel.
    await reconcileCacheAfterBulkDelete(deletedIds);
    exitGallerySelectMode();
  }
  function attachGalleryLongPress(root) {
    root.querySelectorAll('[data-gallery-key]').forEach((el) => {
      const key = el.dataset.galleryKey;
      el.addEventListener('pointerdown', () => {
        clearGalleryLongPress();
        galleryLpTimer = setTimeout(() => {
          galleryLpSuppressClick = true;
          if (!gallerySelectMode) enterGallerySelectMode(key);
        }, 500);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
        el.addEventListener(evt, clearGalleryLongPress);
      });
    });
    if (!galleryDocListenerAttached) {
      galleryDocListenerAttached = true;
      document.addEventListener('pointerdown', (ev) => {
        if (state.view !== 'gallery') return;
        if (!gallerySelectMode) return;
        if (ev.target.closest('[data-gallery-key]')) return;
        if (ev.target.closest('#gallery-action-bar')) return;
        exitGallerySelectMode();
      }, { capture: true });
    }
  }

  async function deleteGalleryFile(file) {
    if (!file) return;
    const mime = file.mimeType || '';
    // Stop any in-flight playback that might hold this file's blob.
    if ((mime.startsWith('audio/') || mime.startsWith('video/')) && window.VideoPlayer?.isOpen()) {
      try { window.VideoPlayer.close(); } catch (e) { /* ignore */ }
    }
    try {
      await window.Drive.deleteFile(file.id);
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
      return;
    }
    // Voice notes: also remove paired _transcript.txt sibling (if any).
    let transcriptId = null;
    if (mime.startsWith('audio/') && file.name) {
      const transcriptName = file.name.replace(/\.[^.]+$/, '_transcript.txt');
      try {
        const t = await window.Drive.findFileInFolder(state.currentProjectId, transcriptName);
        if (t) { transcriptId = t.id; await window.Drive.deleteFile(t.id); }
      } catch (e) { /* best-effort */ }
    }
    const kindLabel = mime.startsWith('audio/') ? 'voice recording'
      : mime.startsWith('video/') ? 'video'
      : mime.startsWith('image/') ? 'photo'
      : 'file';
    appendVisitLog(state.currentProjectId, `[DELETED ${kindLabel} ${file.name}]`).catch(() => {});

    // Invalidate any in-flight gallery refresh — its stale list would
    // otherwise re-include the file we just deleted.
    galleryLoadToken += 1;

    // In-memory: gallery list + capture-screen thumbs (they share a fileId).
    state.galleryFiles = (state.galleryFiles || []).filter((f) => f.id !== file.id && (transcriptId == null || f.id !== transcriptId));
    state.thumbs = state.thumbs.filter((t) => t.fileId !== file.id && (transcriptId == null || t.fileId !== transcriptId));

    // Persistent cache: keep next open from re-painting the deleted entry.
    try {
      const folderId = state.currentProjectId;
      const cached = await window.DB.kvGet(projectCacheKey(folderId));
      if (cached && Array.isArray(cached.files)) {
        cached.files = cached.files.filter((f) => f.id !== file.id && (transcriptId == null || f.id !== transcriptId));
        cached.cachedAt = Date.now();
        await window.DB.kvSet(projectCacheKey(folderId), cached);
      }
    } catch (e) { /* ignore */ }

    updateGalleryListDOM();
    toast('Deleted', 'success');
  }

  function updateGalleryListDOM() {
    const root = document.getElementById('gallery-main');
    if (!root) return;
    // Hide the `_metadata` subfolder from the gallery view so techs see
    // only their captures + notes (the metadata files live inside it).
    const allFiles = state.galleryFiles || [];
    const files = allFiles.filter((f) =>
      !(f.mimeType === 'application/vnd.google-apps.folder' && f.name === '_metadata'));
    const countEl = document.getElementById('gallery-count');
    if (countEl) countEl.textContent = `${files.length} files`;

    // First-ever open with no cache: skeleton. Otherwise cache paint already
    // populated `files` and we render normally even while a refresh runs.
    if (state.galleryLoading && files.length === 0) {
      root.innerHTML = `
        <div class="thumb-skeleton" aria-hidden="true">
          <div></div><div></div><div></div><div></div><div></div><div></div>
        </div>`;
      return;
    }
    if (files.length === 0) {
      root.innerHTML = '<div class="muted">No files yet — start capturing.</div>';
      return;
    }

    const images = files.filter((f) => (f.mimeType || '').startsWith('image/'));
    const videos = files.filter((f) => (f.mimeType || '').startsWith('video/'));
    const audios = files.filter((f) => (f.mimeType || '').startsWith('audio/'));
    const docs = files.filter((f) =>
      /\.txt$/i.test(f.name) && !(f.mimeType || '').startsWith('audio/'));

    const cellSel = (id) => gallerySelectMode && gallerySelection.has(String(id));
    const cellSelCls = (id) => gallerySelectMode ? (cellSel(id) ? ' selected' : ' selectable') : '';
    const checkBadge = (id) => gallerySelectMode
      ? `<div class="thumb-check" aria-hidden="true">${cellSel(id) ? '✓' : ''}</div>`
      : '';

    const photoCellHtml = (f) => `
      <div class="thumb gallery-thumb${cellSelCls(f.id)}" data-gallery-key="${escapeHtml(f.id)}" data-gallery-id="${escapeHtml(f.id)}" data-gallery-mime="${escapeHtml(f.mimeType || '')}">
        ${f.thumbnailLink ? `<img loading="lazy" alt="" src="${escapeHtml(upscaleDriveThumb(f.thumbnailLink))}" onerror="this.style.display='none'"/>` : ''}
        <span class="thumb-label">${escapeHtml(f.name)}</span>
        ${checkBadge(f.id)}
      </div>`;

    const videoCardHtml = (f) => `
      <div class="gallery-card video${cellSelCls(f.id)}" data-gallery-key="${escapeHtml(f.id)}" data-gallery-id="${escapeHtml(f.id)}" data-gallery-mime="${escapeHtml(f.mimeType || '')}" data-gallery-name="${escapeHtml(f.name)}">
        <div class="gallery-card-thumb">
          ${f.thumbnailLink ? `<img loading="lazy" alt="" src="${escapeHtml(upscaleDriveThumb(f.thumbnailLink))}" onerror="this.style.display='none'"/>` : ''}
          <div class="play-overlay">▶</div>
        </div>
        <div class="gallery-card-meta">
          <span class="gallery-card-name">${escapeHtml(f.name)}</span>
          <span class="gallery-card-size">${escapeHtml(fmtBytes(Number(f.size || 0)))}</span>
        </div>
        ${checkBadge(f.id)}
      </div>`;

    const audioCardHtml = (f) => `
      <div class="gallery-card audio${cellSelCls(f.id)}" data-gallery-key="${escapeHtml(f.id)}" data-gallery-id="${escapeHtml(f.id)}" data-gallery-mime="${escapeHtml(f.mimeType || '')}" data-gallery-name="${escapeHtml(f.name)}">
        <div class="gallery-card-thumb"><span aria-hidden="true">🎙</span></div>
        <div class="gallery-card-meta">
          <span class="gallery-card-name">${escapeHtml(f.name)}</span>
          <span class="gallery-card-size">${escapeHtml(fmtBytes(Number(f.size || 0)))}</span>
        </div>
        ${checkBadge(f.id)}
      </div>`;

    root.innerHTML = `
      ${images.length ? `
        <h3 class="section-h">Photos (${images.length})</h3>
        <div class="thumb-grid">
          ${images.map(photoCellHtml).join('')}
        </div>` : ''}
      ${videos.length ? `
        <h3 class="section-h">Videos (${videos.length})</h3>
        <div class="gallery-card-list">
          ${videos.map(videoCardHtml).join('')}
        </div>` : ''}
      ${audios.length ? `
        <h3 class="section-h">Voice notes (${audios.length})</h3>
        <div class="gallery-card-list">
          ${audios.map(audioCardHtml).join('')}
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

    // Card tap → toggle selection in select mode, otherwise open viewer.
    root.querySelectorAll('[data-gallery-key]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (galleryLpSuppressClick) { galleryLpSuppressClick = false; return; }
        const id = el.dataset.galleryId;
        if (gallerySelectMode) {
          toggleGallerySelection(id);
          return;
        }
        const mime = el.dataset.galleryMime || '';
        const name = el.dataset.galleryName || '';
        if (mime.startsWith('image/')) {
          annotateFromDrive(id);
        } else if (mime.startsWith('video/')) {
          const file = files.find((f) => f.id === id);
          window.VideoPlayer.open({
            fileId: id, name, kind: 'video',
            onClose: () => {},
            onDelete: file ? async () => { await deleteGalleryFile(file); } : undefined
          });
        } else if (mime.startsWith('audio/')) {
          const file = files.find((f) => f.id === id);
          window.VideoPlayer.open({
            fileId: id, name, kind: 'audio',
            onClose: () => {},
            onDelete: file ? async () => { await deleteGalleryFile(file); } : undefined
          });
        }
      });
    });

    attachGalleryLongPress(root);
  }
})();
