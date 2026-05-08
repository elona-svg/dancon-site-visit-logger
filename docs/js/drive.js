// Google Drive v3 helpers.
// Multipart upload uses XHR so we can report progress per file. Resumable
// upload also uses XHR with progress for >5MB files. All upload paths and
// the text-file PATCH are wrapped in withRetry for transient errors.
window.Drive = (function () {
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  async function authedFetch(input, init = {}, retry = true) {
    const token = await window.Auth.getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401 && retry) {
      await window.Auth.getAccessToken(true);
      return authedFetch(input, init, false);
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
    const token = await window.Auth.getAccessToken(retriedOn401);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method, opts.url, true);
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
          try { resolve(await _authedXhr(opts, true)); }
          catch (e) { reject(e); }
        } else {
          reject(new Error(`(${xhr.status}) ${xhr.statusText || ''} ${xhr.responseText || ''}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Request timed out'));
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
      return data;
    });
  }

  async function uploadResumable({ folderId, fileName, mimeType, blob, onProgress }) {
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
        throw new Error(`Resumable init failed (${r.status}): ${text || r.statusText}`);
      }
      return r;
    });

    const sessionUrl = initRes.headers.get('Location');
    if (!sessionUrl) throw new Error('Resumable session URL missing');

    return withRetry(() => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl, true);
      xhr.setRequestHeader('Content-Type', mimeType || 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve({}); }
        } else {
          reject(new Error(`(${xhr.status}) Upload PUT failed: ${xhr.responseText || ''}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(blob);
    }));
  }

  async function uploadFile(opts) {
    const big = opts.blob.size > 5 * 1024 * 1024;
    return big ? uploadResumable(opts) : uploadMultipart(opts);
  }

  // -------- Project ownership marker + metadata folder --------
  // Every project folder we create has a `_metadata` subfolder that holds
  // the `.dancon-project` marker, `gps.txt`, and `visit_log.txt` — keeping
  // those out of sight when office staff browse the project in Drive.
  // `notes.txt` stays in the project root so it remains visible.
  // Legacy projects (pre-2026-05-08) keep the marker + gps + log in the
  // project root; we read from there as a fallback.
  const MARKER_FILENAME = '.dancon-project';
  const METADATA_FOLDER_NAME = '_metadata';

  async function findProjectMarker(folderId) {
    // Check root first (legacy), then _metadata/.
    const rootMarker = await findFileInFolder(folderId, MARKER_FILENAME);
    if (rootMarker) return rootMarker;
    const metaId = await findMetadataFolderId(folderId, { createIfMissing: false });
    if (!metaId) return null;
    return findFileInFolder(metaId, MARKER_FILENAME);
  }

  async function createProjectMarker(folderId, payload) {
    const text = JSON.stringify(payload || {}, null, 2);
    // Marker for new projects lives inside _metadata/.
    const metaId = await findMetadataFolderId(folderId, { createIfMissing: true });
    return uploadMultipart({
      folderId: metaId,
      fileName: MARKER_FILENAME,
      mimeType: 'application/json',
      blob: new Blob([text], { type: 'application/json' })
    });
  }

  // Returns the `_metadata` subfolder ID for a project. With
  // `createIfMissing: true` it creates the folder on first use.
  async function findMetadataFolderId(projectId, { createIfMissing = false } = {}) {
    const q = encodeURIComponent(
      `'${projectId}' in parents and name='${escapeQ(METADATA_FOLDER_NAME)}' and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (res.ok) {
      const data = await res.json();
      if (data.files && data.files.length > 0) return data.files[0].id;
    }
    if (!createIfMissing) return null;
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
    return created.id;
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
    listAllMetadataFolders,
    findMetadataFolderId,
    findMetadataFile,
    downloadFileText,
    updateFileContent,
    appendToTextFile,
    sanitizeFolderName,
    isNotFound,
    isTransient
  };
})();
