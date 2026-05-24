// Google Drive v3 helpers.
// Multipart upload uses XHR so we can report progress per file. Resumable
// upload also uses XHR with progress for >5MB files. All upload paths and
// the text-file PATCH are wrapped in withRetry for transient errors.
window.Drive = (function () {
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  async function authedFetch(input, init = {}, retry = true) {
    try { console.log('[drive][authedFetch] url=', input, 'method=', init && init.method, 'authStatus=', window.Auth.getTokenStatus()); } catch (e) {}
    const token = await window.Auth.getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    // Enforce a 60s timeout for Drive network calls to avoid 15s hard timeouts
    const controller = new AbortController();
    const timeoutMs = ('timeoutMs' in init) ? init.timeoutMs : 60000;
    const to = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(input, { ...init, headers, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms contacting ${input}`);
      throw new Error(`Network error contacting ${input}: ${err && err.message ? err.message : String(err)}`);
    } finally {
      clearTimeout(to);
    }
    if (res.status === 401 && retry) {
      console.warn('[drive][authedFetch] received 401, forcing token refresh');
      await window.Auth.getAccessToken(true);
      return authedFetch(input, init, false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} - ${text}`);
    }
    return res;
  }

  function statusFromError(err) {
    const msg = String(err && err.message || err);
    const m = msg.match(/\((\d{3})\)/) || msg.match(/(\d{3})/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function isTransient(err) {
    const status = statusFromError(err);
    if (!status) return true; // network error → retry
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  function isNotFound(err) {
    return statusFromError(err) === 404;
  }

  async function withRetry(fn, { retries = 4, baseMs = 1000 } = {}) {
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      try { return await fn(attempt); }
      catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === retries) throw err;
        const delay = Math.min(20000, baseMs * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
      }
    }
    throw lastErr;
  }

  function escapeQ(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function sanitizeFolderName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  }

  // ---- Authed XHR helper for upload progress ----
  // 401 → force-refresh token and retry once. Any other non-2xx → reject so
  // the outer withRetry can decide whether the status is transient.
  async function authedXhr(opts) { return _authedXhr(opts, false); }
  async function _authedXhr(opts, retriedOn401) {
    try { console.log('[drive][authedXhr] url=', opts.url, 'method=', opts.method, 'retriedOn401=', retriedOn401, 'authStatus=', window.Auth.getTokenStatus()); } catch (e) {}
    const token = await window.Auth.getAccessToken(retriedOn401);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method, opts.url, true);
      // set a 60s timeout for XHR uploads (avoid 15s default network drops)
      xhr.timeout = opts.timeoutMs || 60000;
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      Object.entries(opts.headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (opts.onProgress && xhr.upload) {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) opts.onProgress(ev.loaded / ev.total);
        };
      }
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve({ status: xhr.status, data: xhr.responseText ? JSON.parse(xhr.responseText) : null, raw: xhr }); }
          catch { resolve({ status: xhr.status, data: null, raw: xhr }); }
        } else if (xhr.status === 401 && !retriedOn401) {
          try { console.warn('[drive][authedXhr] xhr 401, retrying with refreshed token'); resolve(await _authedXhr(opts, true)); }
          catch (e) { reject(e); }
        } else {
          reject(new Error(`(${xhr.status}) ${xhr.statusText || ''} ${xhr.responseText || ''}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error contacting ${opts.url}`));
      xhr.ontimeout = () => reject(new Error(`Request timed out after ${xhr.timeout}ms contacting ${opts.url}`));
      xhr.send(opts.body);
    });
  }

  // -------- Folders --------
  // New projects get an MM-DD-YYYY date suffix appended to the folder
  // name. This is preserved through rename — the suffix is part of the
  // folder identity, not part of what techs edit. On reopen we look for
  // exact-name (legacy projects without a date) OR `<name> MM-DD-YYYY`
  // (current projects) to decide whether to reuse vs create.
  const PROJECT_DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
  function todayDateStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
  }
  async function ensureProjectFolder(rawName) {
    const baseName = sanitizeFolderName(rawName);
    if (!baseName) throw new Error('Empty project name');
    // Drive `name contains` is a substring match — we filter the results
    // client-side to either exact (legacy) or `<baseName> MM-DD-YYYY`.
    const q = encodeURIComponent(
      `'${window.CONFIG.SITE_VISITS_FOLDER_ID}' in parents and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false and ` +
      `name contains '${escapeQ(baseName)}'`
    );
    const findRes = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,name,createdTime,modifiedTime)&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!findRes.ok) throw new Error(`Drive find folder failed: ${findRes.status}`);
    const data = await findRes.json();
    const files = data.files || [];
    const match = files.find((f) => {
      if (f.name === baseName) return true; // legacy, no date
      if (f.name.startsWith(baseName + ' ')) {
        const tail = f.name.slice(baseName.length + 1);
        return PROJECT_DATE_RE.test(tail);
      }
      return false;
    });
    if (match) {
      return { id: match.id, name: match.name, created: false };
    }
    const newName = `${baseName} ${todayDateStr()}`;
    const createRes = await authedFetch(`${API}/files?supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [window.CONFIG.SITE_VISITS_FOLDER_ID]
      })
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      throw new Error(`Drive create folder failed: ${createRes.status} ${text}`);
    }
    const created = await createRes.json();
    return { id: created.id, name: created.name, created: true };
  }

  async function listProjectFolders({ pageSize = 100 } = {}) {
    const q = encodeURIComponent(
      `'${window.CONFIG.SITE_VISITS_FOLDER_ID}' in parents and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,name,modifiedTime,createdTime)&orderBy=modifiedTime desc&pageSize=${pageSize}&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive list folders failed: ${res.status}`);
    const data = await res.json();
    return data.files || [];
  }

  async function listFolderFiles(folderId, { pageSize = 200 } = {}) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink,webContentLink)&orderBy=createdTime&pageSize=${pageSize}&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive list files failed: ${res.status}`);
    const data = await res.json();
    return data.files || [];
  }

  async function findFileInFolder(folderId, fileName) {
    const q = encodeURIComponent(
      `'${folderId}' in parents and name='${escapeQ(fileName)}' and trashed=false`
    );
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive findFile failed: ${res.status}`);
    const data = await res.json();
    if (!data.files || data.files.length === 0) return null;
    // If duplicates exist, prefer the most recently modified one — newer
    // tends to be the file the team is actually editing.
    data.files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
    return data.files[0];
  }

  // -------- Uploads --------
  async function uploadMultipart({ folderId, fileName, mimeType, blob, onProgress }) {
    try { console.log('[drive] uploadMultipart start', { fileName, mimeType, size: blob && blob.size, folderId }); } catch (e) {}
    const metadata = { name: fileName, parents: [folderId] };
    const boundary = 'dancon_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const head =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = new Blob([head, blob, tail], { type: `multipart/related; boundary=${boundary}` });

    return withRetry(async () => {
      const { data } = await authedXhr({
        method: 'POST',
        url: `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size`,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
        onProgress
      });
      try { console.log('[drive] uploadMultipart success', { fileName, id: data && data.id }); } catch (e) {}
      return data;
    });
  }

  // Resumable upload that actually resumes on failure.
  // Drive resumable protocol: POST init returns a session URL; PUTs to that
  // URL upload bytes. If a PUT fails mid-stream we query "PUT with
  // Content-Range: bytes */<total>" — server replies 308 with a Range header
  // telling us how many bytes it received, and we PUT only the remaining
  // slice. Survives weak-signal disconnects without restarting from byte 0.
  async function uploadResumable({ folderId, fileName, mimeType, blob, onProgress }) {
    try { console.log('[drive] uploadResumable start', { fileName, mimeType, size: blob && blob.size, folderId }); } catch (e) {}
    const metadata = { name: fileName, parents: [folderId] };

    const initRes = await withRetry(async () => {
      const r = await authedFetch(
        `${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mimeType || 'application/octet-stream',
            'X-Upload-Content-Length': String(blob.size)
          },
          body: JSON.stringify(metadata)
        }
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        console.error('[drive] resumable init failed', { status: r.status, body: text });
        throw new Error(`Resumable init failed (${r.status}): ${text || r.statusText}`);
      }
      return r;
    });

    const sessionUrl = initRes.headers.get('Location');
    try { console.log('[drive] resumable sessionUrl=', sessionUrl && sessionUrl.slice(0, 120)); } catch (e) {}
    if (!sessionUrl) throw new Error('Resumable session URL missing');

    return resumablePutWithResume(sessionUrl, blob, mimeType, onProgress);
  }

  async function resumablePutWithResume(sessionUrl, blob, mimeType, onProgress) {
    const MAX_RESUME_ATTEMPTS = 5;
    const total = blob.size;
    let startByte = 0;
    let attempt = 0;
    let lastErr;

    while (attempt < MAX_RESUME_ATTEMPTS) {
      try {
        const result = await putResumableSlice(sessionUrl, blob, startByte, total, mimeType, onProgress);
        return result;
      } catch (err) {
        lastErr = err;
        attempt += 1;
        console.warn(`[drive] resumable PUT attempt ${attempt} failed (startByte=${startByte}):`, err && err.message);
        if (attempt >= MAX_RESUME_ATTEMPTS) throw err;

        const backoff = Math.min(8000, 1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, backoff));

        try {
          const received = await queryResumableProgress(sessionUrl, total);
          if (received === null) throw new Error(`Resumable session lost mid-upload: ${err.message}`);
          if (received >= total) {
            // Server got everything — prior PUT may have succeeded right as the
            // socket died. Treat as success (caller may not get the file id).
            console.log('[drive] resumable: server reports complete on resume query');
            return {};
          }
          startByte = received;
          console.log(`[drive] resumable: resuming from byte ${startByte} of ${total}`);
        } catch (qErr) {
          console.warn('[drive] resumable: progress query failed:', qErr && qErr.message);
          // Keep prior startByte and try again — Drive accepts re-PUT from 0
          // and a follow-up failure will re-query.
        }
      }
    }
    throw lastErr;
  }

  function putResumableSlice(sessionUrl, blob, startByte, total, mimeType, onProgress) {
    const slice = startByte === 0 ? blob : blob.slice(startByte);
    const endByte = total - 1;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl, true);
      xhr.timeout = 120000;
      if (startByte > 0) {
        xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${endByte}/${total}`);
      }
      xhr.setRequestHeader('Content-Type', mimeType || 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (onProgress && ev.lengthComputable) {
          onProgress((startByte + ev.loaded) / total);
        }
      };
      xhr.ontimeout = () => reject(new Error(`Request timed out after ${xhr.timeout}ms during PUT at byte ${startByte}`));
      xhr.onerror = () => reject(new Error(`Network error contacting resumable session at byte ${startByte}`));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve({}); }
        } else if (xhr.status === 308) {
          const range = xhr.getResponseHeader('Range');
          const m = range && range.match(/bytes=0-(\d+)/);
          const received = m ? parseInt(m[1], 10) + 1 : startByte;
          const err = new Error(`Partial PUT (308): server received ${received} of ${total}`);
          err._partial = true;
          err._received = received;
          reject(err);
        } else {
          reject(new Error(`(${xhr.status}) Upload PUT failed: ${xhr.responseText || ''}`));
        }
      };
      xhr.send(slice);
    });
  }

  function queryResumableProgress(sessionUrl, total) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl, true);
      xhr.timeout = 20000;
      xhr.setRequestHeader('Content-Range', `bytes */${total}`);
      xhr.ontimeout = () => reject(new Error('Resume query timed out'));
      xhr.onerror = () => reject(new Error('Resume query network error'));
      xhr.onload = () => {
        if (xhr.status === 308) {
          const range = xhr.getResponseHeader('Range');
          if (!range) { resolve(0); return; }
          const m = range.match(/bytes=0-(\d+)/);
          resolve(m ? parseInt(m[1], 10) + 1 : 0);
        } else if (xhr.status >= 200 && xhr.status < 300) {
          resolve(total);
        } else if (xhr.status === 404 || xhr.status === 410) {
          resolve(null);
        } else {
          reject(new Error(`Resume query failed (${xhr.status}): ${xhr.responseText || ''}`));
        }
      };
      xhr.send(null);
    });
  }

  // All user-content uploads go through resumable so flaky connections can
  // pick up where they left off. Multipart is reserved for tiny metadata
  // writes (notes.txt, visit_log.txt, .dancon-project marker) where the
  // resumable round-trip is overhead and restart-from-zero costs nothing.
  async function uploadFile(opts) {
    return uploadResumable(opts);
  }

  // -------- Singleton metadata writes (mutex + upsert) --------
  // Some files inside a project are "singletons" — only one copy must
  // ever exist (.dancon-project, gps.txt, visit_log.txt, the _metadata
  // folder itself). Concurrent writers + Drive's eventually-consistent
  // index lag have produced duplicates in the past. This serializes
  // writes per (folderId, fileName) so a second writer never runs its
  // existence-check until the first writer's create has fully landed,
  // and tracks the just-created file ID in memory so a second writer
  // can update by id even when Drive's name search hasn't indexed yet.
  const singletonLocks = new Map();
  const singletonIdCache = new Map();
  function singletonKey(folderId, fileName) { return `${folderId}::${fileName}`; }

  function withSingletonLock(folderId, fileName, fn) {
    const key = singletonKey(folderId, fileName);
    const prev = singletonLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn); // run fn regardless of prev's outcome
    singletonLocks.set(key, next.catch(() => {}));
    return next;
  }

  async function upsertSingletonFile({ folderId, fileName, mimeType, blob, onProgress }) {
    return withSingletonLock(folderId, fileName, async () => {
      const key = singletonKey(folderId, fileName);
      // In-memory id cache — survives Drive index lag from a recent
      // create in this same locked chain.
      const cachedId = singletonIdCache.get(key);
      if (cachedId) {
        try {
          return await updateFileContent(cachedId, blob, mimeType);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          singletonIdCache.delete(key); // dead id, fall through to re-find
        }
      }
      const existing = await findFileInFolder(folderId, fileName);
      if (existing) {
        singletonIdCache.set(key, existing.id);
        return updateFileContent(existing.id, blob, mimeType);
      }
      const created = await uploadMultipart({ folderId, fileName, mimeType, blob, onProgress });
      if (created?.id) singletonIdCache.set(key, created.id);
      return created;
    });
  }

  // -------- Project ownership marker + metadata folder --------
  // Project layout:
  //   <project>/
  //     notes.txt                  (visible to office staff)
  //     _metadata/
  //       gps.txt                  (pinned location)
  //       visit_log.txt            (audit trail + project metadata header)
  //
  // v39+: project metadata (createdAt, createdBy, project ID) is the
  // header block at the top of visit_log.txt. The presence of visit_log.txt
  // IS the project-ownership marker.
  // Legacy projects:
  //   pre-v37: `.dancon-project` + gps.txt + visit_log.txt in root
  //   v37/v38: `.dancon-project` + gps.txt + visit_log.txt in _metadata/
  //   v39+: visit_log.txt (with metadata header) + gps.txt in _metadata/
  // Old `.dancon-project` files are still recognized as markers and never
  // touched — we just stop creating new ones.
  const MARKER_FILENAME = '.dancon-project';
  const METADATA_FOLDER_NAME = '_metadata';
  const VISIT_LOG_FILENAME = 'visit_log.txt';

  // True if the project has been initialized by the app: any of
  // `.dancon-project` (legacy) or `visit_log.txt` (v39+) in either the
  // project root or the `_metadata/` subfolder.
  async function findProjectMarker(folderId) {
    const rootDancon = await findFileInFolder(folderId, MARKER_FILENAME);
    if (rootDancon) return rootDancon;
    const rootVisitLog = await findFileInFolder(folderId, VISIT_LOG_FILENAME);
    if (rootVisitLog) return rootVisitLog;
    const metaId = await findMetadataFolderId(folderId, { createIfMissing: false });
    if (!metaId) return null;
    const metaDancon = await findFileInFolder(metaId, MARKER_FILENAME);
    if (metaDancon) return metaDancon;
    return findFileInFolder(metaId, VISIT_LOG_FILENAME);
  }

  function fmtMetadataTime(d) {
    const date = d ? new Date(d) : new Date();
    if (isNaN(date.getTime())) return String(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
           `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // v39+: writes the project metadata as the header block at the top of
  // `visit_log.txt` instead of creating a separate `.dancon-project`
  // file. Idempotent — if visit_log.txt already exists, leaves it
  // alone (the existing log entries must NOT be clobbered).
  async function createProjectMarker(folderId, payload) {
    const metaId = await findMetadataFolderId(folderId, { createIfMissing: true });
    return withSingletonLock(metaId, VISIT_LOG_FILENAME, async () => {
      const key = singletonKey(metaId, VISIT_LOG_FILENAME);
      // If visit_log.txt already exists (created by a peer in this lock
      // chain, or by a prior run), return it untouched — never clobber.
      const cachedId = singletonIdCache.get(key);
      if (cachedId) {
        try { return { id: cachedId, created: false }; }
        catch (e) { singletonIdCache.delete(key); }
      }
      const existing = await findFileInFolder(metaId, VISIT_LOG_FILENAME);
      if (existing) {
        singletonIdCache.set(key, existing.id);
        return existing;
      }
      const header =
        '=== PROJECT METADATA ===\n' +
        `Created: ${fmtMetadataTime(payload?.createdAt)}\n` +
        `Created by: ${payload?.createdBy || 'unknown'}\n` +
        `App version: ${payload?.appVersion || 'unknown'}\n` +
        `Project ID: ${payload?.projectId || 'unknown'}\n` +
        '============================\n\n';
      const blob = new Blob([header], { type: 'text/plain' });
      const created = await uploadMultipart({
        folderId: metaId,
        fileName: VISIT_LOG_FILENAME,
        mimeType: 'text/plain',
        blob
      });
      if (created?.id) singletonIdCache.set(key, created.id);
      return created;
    });
  }

  // Returns the `_metadata` subfolder ID for a project. With
  // `createIfMissing: true` the create-path is serialized via the
  // singleton lock + re-checked inside the lock, so two parallel
  // callers can never both create the folder.
  async function findMetadataFolderId(projectId, { createIfMissing = false } = {}) {
    async function lookup() {
      const q = encodeURIComponent(
        `'${projectId}' in parents and name='${escapeQ(METADATA_FOLDER_NAME)}' and ` +
        `mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      const res = await authedFetch(
        `${API}/files?q=${q}&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.files && data.files.length > 0 ? data.files[0].id : null;
    }
    // Fast path: in-memory cache hit from a recent create in this session.
    const cacheKey = singletonKey(projectId, METADATA_FOLDER_NAME);
    const cachedId = singletonIdCache.get(cacheKey);
    if (cachedId) return cachedId;
    let id = await lookup();
    if (id) { singletonIdCache.set(cacheKey, id); return id; }
    if (!createIfMissing) return null;
    return withSingletonLock(projectId, METADATA_FOLDER_NAME, async () => {
      // Re-check inside the lock — a peer in the same lock chain may
      // have just created it.
      const cachedId2 = singletonIdCache.get(cacheKey);
      if (cachedId2) return cachedId2;
      const found = await lookup();
      if (found) { singletonIdCache.set(cacheKey, found); return found; }
      const createRes = await authedFetch(`${API}/files?supportsAllDrives=true&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: METADATA_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [projectId]
        })
      });
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => '');
        throw new Error(`Drive create _metadata failed: ${createRes.status} ${text}`);
      }
      const created = await createRes.json();
      singletonIdCache.set(cacheKey, created.id);
      return created.id;
    });
  }

  // Resolve a metadata file (.dancon-project / gps.txt / visit_log.txt) to
  // its existing location: root (legacy) takes precedence over _metadata/.
  // Returns { file, parentId } or null. Callers writing the file should
  // reuse parentId so a legacy project keeps its root layout.
  async function findMetadataFile(projectId, fileName) {
    const rootFile = await findFileInFolder(projectId, fileName);
    if (rootFile) return { file: rootFile, parentId: projectId };
    const metaId = await findMetadataFolderId(projectId, { createIfMissing: false });
    if (!metaId) return null;
    const metaFile = await findFileInFolder(metaId, fileName);
    if (metaFile) return { file: metaFile, parentId: metaId };
    return null;
  }

  // Returns every `.dancon-project` marker we own. Each entry has the
  // marker's `id` plus a `parents` array — the parent is either the
  // project folder (legacy) or the project's _metadata/ folder (current).
  async function listAllProjectMarkers({ pageSize = 500 } = {}) {
    const q = encodeURIComponent(`name='${escapeQ(MARKER_FILENAME)}' and trashed=false`);
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,parents,createdTime)&pageSize=${pageSize}` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive list markers failed: ${res.status}`);
    const data = await res.json();
    return data.files || [];
  }

  // Returns every `visit_log.txt` we own. v39+ uses visit_log.txt as the
  // project-ownership marker (the metadata header is embedded as the
  // first lines). Each entry has parents that are either the project
  // folder (legacy root-layout) or the project's `_metadata/` folder
  // (current layout); discovery resolves both via the metaFolders map.
  async function listAllVisitLogs({ pageSize = 500 } = {}) {
    const q = encodeURIComponent(`name='${escapeQ(VISIT_LOG_FILENAME)}' and trashed=false`);
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,parents)&pageSize=${pageSize}` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive list visit_log files failed: ${res.status}`);
    const data = await res.json();
    return data.files || [];
  }

  // Returns every `_metadata` folder we own. The parent of each is the
  // project folder ID — used for home discovery in tandem with the marker
  // query so new projects (whose marker lives inside _metadata/) are
  // recognized as ours.
  async function listAllMetadataFolders({ pageSize = 500 } = {}) {
    const q = encodeURIComponent(
      `name='${escapeQ(METADATA_FOLDER_NAME)}' and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,parents)&pageSize=${pageSize}` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive list _metadata folders failed: ${res.status}`);
    const data = await res.json();
    return data.files || [];
  }

  // -------- Rename --------
  async function renameFile(fileId, newName) {
    const name = sanitizeFolderName(newName);
    if (!name) throw new Error('Empty name');
    return withRetry(async () => {
      const res = await authedFetch(
        `${API}/files/${fileId}?supportsAllDrives=true&fields=id,name,modifiedTime`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Rename failed (${res.status}): ${text || res.statusText}`);
      }
      return res.json();
    });
  }

  // -------- Delete (move to trash) --------
  // Switched from DELETE (permanent) to PATCH {trashed:true}. Trash is the
  // standard Drive pattern, works reliably with `drive.file` scope, and
  // gives a 30-day recovery window for accidental deletions. The
  // `trashed=false` filter on listProjectFolders / listAllProjectMarkers /
  // listFolderFiles already hides trashed items from the app.
  async function deleteFile(fileId) {
    return withRetry(async () => {
      const res = await authedFetch(`${API}/files/${fileId}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '');
        console.warn(`[drive] trash failed for ${fileId}: status=${res.status} body=${text}`);
        throw new Error(`Delete failed (${res.status}): ${text || res.statusText}`);
      }
      console.log(`[drive] trashed file ${fileId}: status=${res.status}`);
      return true;
    });
  }

  // -------- Text-file append --------
  async function downloadFileText(fileId) {
    return withRetry(async () => {
      const res = await authedFetch(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
      if (!res.ok) throw new Error(`(${res.status}) Download failed`);
      return res.text();
    });
  }

  async function updateFileContent(fileId, blob, mimeType) {
    return withRetry(async () => {
      const { data } = await authedXhr({
        method: 'PATCH',
        url: `${UPLOAD}/files/${fileId}?uploadType=media&supportsAllDrives=true&fields=id,name,size`,
        headers: { 'Content-Type': mimeType },
        body: blob
      });
      return data;
    });
  }

  // Append text to a file inside a folder. Critical correctness rules:
  //   1. If we have a cachedFileId, USE IT. Only treat 404 as "file gone".
  //      Network/5xx errors propagate to the caller — they MUST NOT cause
  //      a silent fallback to creation, which would create duplicates.
  //   2. On cache miss (no id supplied), search 3x with backoff to handle
  //      Drive's eventually-consistent index after a recent create.
  //   3. Only as a last resort, create a new file.
  //
  // After creating, callers should write the returned id to their cache
  // immediately to short-circuit subsequent calls.
  async function appendToTextFile({ folderId, fileName, lineOrText, cachedFileId }) {
    if (cachedFileId) {
      try {
        const current = await downloadFileText(cachedFileId);
        const next = (current.length === 0 || current.endsWith('\n'))
          ? current + lineOrText
          : current + '\n' + lineOrText;
        const blob = new Blob([next], { type: 'text/plain' });
        const updated = await updateFileContent(cachedFileId, blob, 'text/plain');
        return { id: updated.id || cachedFileId, created: false };
      } catch (err) {
        if (!isNotFound(err)) throw err; // transient → propagate, do NOT create dup
        // 404: cached id is dead — fall through to search/create.
      }
    }

    // Search with retry to handle eventual consistency.
    let found = null;
    for (let i = 0; i < 3 && !found; i += 1) {
      try { found = await findFileInFolder(folderId, fileName); }
      catch (e) { if (!isTransient(e)) throw e; }
      if (!found && i < 2) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
    if (found) {
      const current = await downloadFileText(found.id);
      const next = (current.length === 0 || current.endsWith('\n'))
        ? current + lineOrText
        : current + '\n' + lineOrText;
      const blob = new Blob([next], { type: 'text/plain' });
      const updated = await updateFileContent(found.id, blob, 'text/plain');
      return { id: updated.id || found.id, created: false };
    }

    // Last resort: create.
    const blob = new Blob([lineOrText], { type: 'text/plain' });
    const created = await uploadMultipart({ folderId, fileName, mimeType: 'text/plain', blob });
    return { id: created.id, created: true };
  }

  return {
    ensureProjectFolder,
    listProjectFolders,
    listFolderFiles,
    findFileInFolder,
    uploadFile,
    uploadMultipart,
    uploadResumable,
    deleteFile,
    renameFile,
    findProjectMarker,
    createProjectMarker,
    listAllProjectMarkers,
    listAllVisitLogs,
    listAllMetadataFolders,
    findMetadataFolderId,
    findMetadataFile,
    upsertSingletonFile,
    withSingletonLock,
    downloadFileText,
    updateFileContent,
    appendToTextFile,
    sanitizeFolderName,
    isNotFound,
    isTransient
  };
})();
