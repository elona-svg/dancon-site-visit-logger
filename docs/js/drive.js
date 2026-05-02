// Google Drive v3 helpers.
// All calls go through authedFetch which lazily refreshes the access token.
window.Drive = (function () {
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  async function authedFetch(input, init = {}, retry = true) {
    const token = await window.Auth.getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401 && retry) {
      // Token went stale mid-request (clock drift, revoke). Force a silent
      // refresh once; if that fails, the error propagates and the queue
      // runner will mark the upload as errored without a popup loop.
      await window.Auth.getAccessToken(true);
      return authedFetch(input, init, false);
    }
    return res;
  }

  // Wrap any async operation with exponential backoff for transient errors.
  // Retriable: network errors, 5xx, 429, 408. Auth (401) is handled inside
  // authedFetch already; permanent 4xx pass through immediately.
  async function withRetry(fn, { retries = 4, baseMs = 1000 } = {}) {
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        const msg = String(err && err.message || err);
        const m = msg.match(/(\d{3})/); // pull a status code if we embedded one
        const status = m ? parseInt(m[1], 10) : 0;
        const transient =
          !status ||
          status === 408 || status === 429 ||
          (status >= 500 && status < 600);
        if (!transient || attempt === retries) throw err;
        const delay = Math.min(30000, baseMs * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
      }
    }
    throw lastErr;
  }

  function escapeQ(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function sanitizeFolderName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  }

  // -------- Folders --------
  async function ensureProjectFolder(rawName) {
    const name = sanitizeFolderName(rawName);
    if (!name) throw new Error('Empty project name');

    const q = encodeURIComponent(
      `name='${escapeQ(name)}' and ` +
      `'${window.CONFIG.SITE_VISITS_FOLDER_ID}' in parents and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const findRes = await authedFetch(
      `${API}/files?q=${q}&fields=files(id,name,createdTime,modifiedTime)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!findRes.ok) throw new Error(`Drive find folder failed: ${findRes.status}`);
    const data = await findRes.json();
    if (data.files && data.files.length > 0) {
      return { id: data.files[0].id, name: data.files[0].name, created: false };
    }

    const createRes = await authedFetch(`${API}/files?supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
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
      `${API}/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!res.ok) throw new Error(`Drive findFile failed: ${res.status}`);
    const data = await res.json();
    return (data.files && data.files[0]) || null;
  }

  // -------- Uploads --------
  async function uploadMultipart({ folderId, fileName, mimeType, blob }) {
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
      const res = await authedFetch(
        `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed (${res.status}): ${text || res.statusText}`);
      }
      return res.json();
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
          reject(new Error(`Upload PUT failed (${xhr.status}): ${xhr.responseText || ''}`));
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

  // -------- Text-file append --------
  async function downloadFileText(fileId) {
    const res = await authedFetch(
      `${API}/files/${fileId}?alt=media&supportsAllDrives=true`
    );
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res.text();
  }

  async function updateFileContent(fileId, blob, mimeType) {
    return withRetry(async () => {
      const res = await authedFetch(
        `${UPLOAD}/files/${fileId}?uploadType=media&supportsAllDrives=true&fields=id,name,size`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': mimeType },
          body: blob
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Update failed (${res.status}): ${text || res.statusText}`);
      }
      return res.json();
    });
  }

  // Append text to a file inside a folder. If `cachedFileId` is supplied
  // (e.g. from a previous successful append), we PATCH directly without a
  // search query — this avoids the "duplicate file" bug caused by Drive's
  // eventually-consistent search index. On a cache miss, we search; if no
  // file exists, we create one. Returns the file id (caller should cache it).
  async function appendToTextFile({ folderId, fileName, lineOrText, cachedFileId }) {
    // Path 1: we know the id — fast path, no search.
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
        // Cache miss-path: file might have been deleted. Fall through to search.
        console.warn('cached fileId failed, falling back to search:', err.message);
      }
    }

    // Path 2: search for an existing file in the folder.
    const existing = await findFileInFolder(folderId, fileName);
    if (existing) {
      const current = await downloadFileText(existing.id);
      const next = (current.length === 0 || current.endsWith('\n'))
        ? current + lineOrText
        : current + '\n' + lineOrText;
      const blob = new Blob([next], { type: 'text/plain' });
      const updated = await updateFileContent(existing.id, blob, 'text/plain');
      return { id: updated.id || existing.id, created: false };
    }

    // Path 3: create a new file.
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
    downloadFileText,
    updateFileContent,
    appendToTextFile,
    sanitizeFolderName
  };
})();
