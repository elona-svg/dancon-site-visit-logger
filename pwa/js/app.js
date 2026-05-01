// Top-level app: state, screens, upload queue runner, glue between modules.
(function () {
  const { escapeHtml, fmtTimestampForFilename, fmtDateTime, fmtBytes, fmtRelative, toast } = window.UI;

  const state = {
    user: null,
    isOnline: navigator.onLine,
    booting: true,
    initError: null,

    // Project context
    currentProjectId: null,
    currentProjectName: null,

    // Browse
    projects: [],         // [{id, name, modifiedTime}]
    projectsLoading: false,
    projectFilter: '',

    // Capture
    queueCounts: { pending: 0, uploading: 0, error: 0, success: 0 },

    // Gallery
    galleryFiles: [],
    galleryLoading: false,

    // View
    view: 'login' // 'login' | 'home' | 'capture' | 'gallery'
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
  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    try {
      await window.DB.open();
      await window.Auth.init();
      window.Auth.onChange(({ user }) => {
        state.user = user;
        scheduleRender();
      });
      state.user = window.Auth.getUser();
      if (state.user && !window.Auth.isSignedIn()) {
        // Cached user but token not in memory — try silent token refresh.
        try { await window.Auth.getAccessToken(); } catch (e) { /* user must click sign in */ }
      }
      state.view = state.user && window.Auth.isSignedIn() ? 'home' : 'login';
      state.booting = false;
      scheduleRender();

      if (state.view === 'home') await loadProjects();
      runQueue();
    } catch (err) {
      state.booting = false;
      state.initError = err.message || String(err);
      console.error(err);
      scheduleRender();
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

  // ---------- Auth handlers ----------
  async function onSignInClick() {
    try {
      await window.Auth.signIn();
      state.user = window.Auth.getUser();
      state.view = 'home';
      scheduleRender();
      await loadProjects();
      runQueue();
    } catch (err) {
      toast(err.message || 'Sign in failed', 'error', 6000);
    }
  }
  async function onSignOutClick() {
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
    scheduleRender();
    try {
      const folders = await window.Drive.listProjectFolders({ pageSize: 100 });
      state.projects = folders;
    } catch (err) {
      console.error(err);
      toast(`Could not list projects: ${err.message}`, 'error');
    } finally {
      state.projectsLoading = false;
      scheduleRender();
    }
  }

  async function openOrCreateProject(rawName) {
    const name = window.Drive.sanitizeFolderName(rawName);
    if (!name) { toast('Type a project name', 'warn'); return; }
    try {
      const { id, name: actualName, created } = await window.Drive.ensureProjectFolder(name);
      state.currentProjectId = id;
      state.currentProjectName = actualName;
      state.view = 'capture';
      scheduleRender();
      if (created) toast(`Created "${actualName}"`, 'info');
      maybeCaptureGPS(id, actualName);
    } catch (err) {
      console.error(err);
      toast(`Could not open project: ${err.message}`, 'error', 6000);
    }
  }

  async function openProject(id, name) {
    state.currentProjectId = id;
    state.currentProjectName = name;
    state.view = 'capture';
    scheduleRender();
    maybeCaptureGPS(id, name);
  }

  function leaveProject() {
    state.currentProjectId = null;
    state.currentProjectName = null;
    state.view = 'home';
    scheduleRender();
    loadProjects();
  }

  // ---------- GPS (once per folder) ----------
  async function maybeCaptureGPS(folderId, folderName) {
    if (!('geolocation' in navigator)) return;
    try {
      const existing = await window.Drive.findFileInFolder(folderId, 'gps.txt');
      if (existing) return; // already captured
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
          // Re-check in case of race with another teammate.
          const existing = await window.Drive.findFileInFolder(folderId, 'gps.txt');
          if (existing) return;
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

  // ---------- Visit log ----------
  async function appendVisitLog(folderId, summary) {
    const line = `${fmtDateTime()} — ${state.user?.name || 'unknown'} — ${summary}\n`;
    try {
      await window.Drive.appendToTextFile({
        folderId,
        fileName: 'visit_log.txt',
        lineOrText: line
      });
    } catch (err) {
      console.warn('visit_log append failed:', err.message);
    }
  }

  // ---------- Filename builder ----------
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
  function pad2(n) { return String(n).padStart(2, '0'); }

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

  // ---------- Capture handlers ----------
  function startPhoto() {
    if (!ensureProject()) return;
    window.Camera.open({
      kind: 'photo',
      onCapture: (blob, mime, kind) => enqueueCapture(blob, mime, kind),
      onClose: () => scheduleRender()
    });
  }
  function startVideo() {
    if (!ensureProject()) return;
    window.Camera.open({
      kind: 'video',
      onCapture: (blob, mime, kind) => enqueueCapture(blob, mime, kind),
      onClose: () => scheduleRender()
    });
  }
  function startAudio() {
    if (!ensureProject()) return;
    window.AudioNote.open({
      onCapture: (blob, mime, kind) => enqueueCapture(blob, mime, kind),
      onClose: () => scheduleRender()
    });
  }
  function startNote() {
    if (!ensureProject()) return;
    const folderId = state.currentProjectId;
    window.Notes.open({
      onSave: async (text) => {
        const stamp = fmtDateTime();
        const tech = state.user?.name || 'unknown';
        const block = `\n--- ${stamp} — ${tech} ---\n${text}\n`;
        await window.Drive.appendToTextFile({
          folderId,
          fileName: 'notes.txt',
          lineOrText: block
        });
        toast('Note saved', 'success');
        await appendVisitLog(folderId, 'added text note');
      },
      onClose: () => scheduleRender()
    });
  }

  function ensureProject() {
    if (!state.currentProjectId) {
      toast('Open a project first', 'warn');
      return false;
    }
    return true;
  }

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
    await refreshQueueCounts();
    toast(`Queued ${kind}: ${fileName}`, 'info', 1800);
    runQueue();
  }

  // ---------- Upload queue runner ----------
  async function refreshQueueCounts() {
    const all = await window.DB.queueAll();
    const counts = { pending: 0, uploading: 0, error: 0, success: 0 };
    for (const item of all) counts[item.status] = (counts[item.status] || 0) + 1;
    state.queueCounts = counts;
    scheduleRender();
  }

  async function runQueue() {
    if (queueRunnerActive) return;
    if (!state.isOnline) { await refreshQueueCounts(); return; }
    if (!window.Auth.isSignedIn()) {
      try { await window.Auth.getAccessToken(); }
      catch (e) { await refreshQueueCounts(); return; }
    }

    queueRunnerActive = true;
    try {
      while (true) {
        const pending = await window.DB.queuePending();
        if (pending.length === 0) break;
        // Sort by attempts asc then createdAt asc — give failed items a chance later.
        pending.sort((a, b) => (a.attempts - b.attempts) || (a.createdAt - b.createdAt));
        const item = pending[0];

        await window.DB.queueUpdate(item.id, { status: 'uploading' });
        await refreshQueueCounts();

        try {
          await window.Drive.uploadFile({
            folderId: item.projectId,
            fileName: item.fileName,
            mimeType: item.mimeType,
            blob: item.blob
          });
          await appendVisitLog(item.projectId,
            `uploaded ${item.kind || 'file'}: ${item.fileName} (${fmtBytes(item.blob.size)})`);
          await window.DB.queueUpdate(item.id, { status: 'success' });
          // Successful items can drop out of the queue immediately.
          await window.DB.queueDelete(item.id);
        } catch (err) {
          console.error('Upload failed', err);
          const attempts = (item.attempts || 0) + 1;
          await window.DB.queueUpdate(item.id, {
            status: 'error',
            attempts,
            lastError: err.message || String(err)
          });
          await refreshQueueCounts();

          // Backoff before next pass — but only block if there are remaining errors.
          const delay = Math.min(
            window.CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempts - 1),
            window.CONFIG.RETRY_MAX_DELAY
          );
          await new Promise((r) => setTimeout(r, delay));
          if (attempts >= 6) {
            // Stop the auto-runner; user can hit Retry to try again.
            break;
          }
        }
        await refreshQueueCounts();
      }
    } finally {
      queueRunnerActive = false;
      await refreshQueueCounts();
    }
  }

  async function retryAllErrored() {
    const all = await window.DB.queueAll();
    for (const item of all.filter((i) => i.status === 'error')) {
      await window.DB.queueUpdate(item.id, { status: 'pending', attempts: 0, lastError: null });
    }
    runQueue();
  }
  async function retryItem(id) {
    await window.DB.queueUpdate(id, { status: 'pending', attempts: 0, lastError: null });
    runQueue();
  }
  async function discardItem(id) {
    await window.DB.queueDelete(id);
    await refreshQueueCounts();
  }

  // ---------- Gallery ----------
  async function openGallery() {
    if (!ensureProject()) return;
    state.view = 'gallery';
    state.galleryLoading = true;
    state.galleryFiles = [];
    scheduleRender();
    try {
      const files = await window.Drive.listFolderFiles(state.currentProjectId);
      // Hide bookkeeping files from the visual gallery; surface them as a small footer.
      state.galleryFiles = files;
    } catch (err) {
      toast(`Could not load gallery: ${err.message}`, 'error');
    } finally {
      state.galleryLoading = false;
      scheduleRender();
    }
  }
  function closeGallery() { state.view = 'capture'; scheduleRender(); }

  async function annotateFile(fileId) {
    // Fetch raw bytes so we can re-upload an annotated copy. Drive returns
    // image bytes via alt=media when the user has read access.
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
        // Insert "_annotated" before the seq for clarity.
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
        // Refresh gallery in the background.
        setTimeout(openGallery, 1500);
      },
      onClose: () => scheduleRender()
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
        <div class="screen error-screen">
          <h2>Setup needed</h2>
          <p class="muted">${escapeHtml(state.initError)}</p>
          <p class="muted small">Edit <code>js/config.js</code> and set <code>CLIENT_ID</code>. See README.md.</p>
        </div>
      `;
      return;
    }
    if (state.view === 'login') return renderLogin(app);
    if (state.view === 'home') return renderHome(app);
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
    const filter = state.projectFilter.trim().toLowerCase();
    const filtered = filter
      ? state.projects.filter((p) => p.name.toLowerCase().includes(filter))
      : state.projects;

    app.innerHTML = `
      <div class="screen home-screen">
        <header class="topbar">
          <div>
            <div class="topbar-title">Site Visits</div>
            <div class="topbar-sub">${escapeHtml(state.user?.name || '')} ${state.isOnline ? '' : '<span class="badge offline">offline</span>'}</div>
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
                value="${escapeHtml(state.projectFilter)}"
                autocomplete="off"
                autocapitalize="words"
              />
              <button class="btn-primary" id="open-btn">Open</button>
            </div>
            <p class="muted small">Type to filter recent sites, or tap Open to create a new one.</p>
          </label>

          <section class="recent">
            <h2 class="section-h">Recent sites</h2>
            ${state.projectsLoading
              ? '<div class="muted">Loading…</div>'
              : (filtered.length === 0
                  ? '<div class="muted">No matching projects.</div>'
                  : filtered.slice(0, 50).map((p) => `
                    <button class="list-row" data-project-id="${escapeHtml(p.id)}" data-project-name="${escapeHtml(p.name)}">
                      <div class="list-row-main">
                        <div class="list-row-title">${escapeHtml(p.name)}</div>
                        <div class="list-row-sub">${escapeHtml(fmtRelative(p.modifiedTime))}</div>
                      </div>
                      <span class="list-row-chev">›</span>
                    </button>
                  `).join('')
                )
            }
          </section>
        </main>
      </div>
    `;

    const input = document.getElementById('project-input');
    input.addEventListener('input', (e) => {
      state.projectFilter = e.target.value;
      // Re-render only the list portion (cheap; dom is small).
      scheduleRender();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        openOrCreateProject(state.projectFilter);
      }
    });
    document.getElementById('open-btn').addEventListener('click', () => openOrCreateProject(state.projectFilter));
    document.getElementById('signout-btn').addEventListener('click', onSignOutClick);
    app.querySelectorAll('.list-row').forEach((row) => {
      row.addEventListener('click', () => {
        openProject(row.dataset.projectId, row.dataset.projectName);
      });
    });
  }

  function renderCapture(app) {
    const counts = state.queueCounts || {};
    const queueText = describeQueue(counts);
    app.innerHTML = `
      <div class="screen capture-screen">
        <header class="topbar">
          <button class="btn-ghost back-btn" id="back-btn">‹ Sites</button>
          <div class="topbar-title-center">
            <div class="topbar-title">${escapeHtml(state.currentProjectName)}</div>
            ${state.isOnline ? '' : '<div class="badge offline">offline</div>'}
          </div>
          <button class="btn-ghost" id="gallery-btn">Files</button>
        </header>

        <main class="capture-main">
          <div class="capture-grid">
            <button class="action-tile photo" id="btn-photo">
              <span class="action-glyph">📷</span>
              <span class="action-label">Photo</span>
            </button>
            <button class="action-tile video" id="btn-video">
              <span class="action-glyph">🎥</span>
              <span class="action-label">Video</span>
            </button>
            <button class="action-tile audio" id="btn-audio">
              <span class="action-glyph">🎙️</span>
              <span class="action-label">Voice</span>
            </button>
            <button class="action-tile note" id="btn-note">
              <span class="action-glyph">📝</span>
              <span class="action-label">Note</span>
            </button>
          </div>

          <div class="queue-strip ${counts.error ? 'has-error' : ''}">
            <div class="queue-label">${queueText}</div>
            ${counts.error
              ? '<button class="btn-secondary small" id="retry-all">Retry failed</button>'
              : ''}
          </div>
        </main>
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', leaveProject);
    document.getElementById('gallery-btn').addEventListener('click', openGallery);
    document.getElementById('btn-photo').addEventListener('click', startPhoto);
    document.getElementById('btn-video').addEventListener('click', startVideo);
    document.getElementById('btn-audio').addEventListener('click', startAudio);
    document.getElementById('btn-note').addEventListener('click', startNote);
    document.getElementById('retry-all')?.addEventListener('click', retryAllErrored);
  }

  function describeQueue(c) {
    const parts = [];
    if (c.uploading) parts.push(`${c.uploading} uploading`);
    if (c.pending) parts.push(`${c.pending} queued`);
    if (c.error) parts.push(`${c.error} failed`);
    if (parts.length === 0) return 'All uploads up to date ✓';
    return parts.join(' · ');
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
          <button class="btn-ghost" id="g-refresh">Refresh</button>
        </header>
        <main class="gallery-main">
          ${state.galleryLoading ? '<div class="muted">Loading…</div>' : ''}

          ${images.length ? `
            <h3 class="section-h">Photos (${images.length})</h3>
            <div class="thumb-grid">
              ${images.map((f) => `
                <button class="thumb" data-file-id="${escapeHtml(f.id)}" data-mime="${escapeHtml(f.mimeType)}">
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
      b.addEventListener('click', () => annotateFile(b.dataset.fileId));
    });
  }

  // ---------- Boot first paint ----------
  function firstPaint() {
    document.getElementById('app').innerHTML = '<div class="boot">Loading…</div>';
  }
  firstPaint();
})();
