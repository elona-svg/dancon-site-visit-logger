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

  function escapeQ(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function sanitizeFolderName(name) {
    // Drive doesn't ban many chars, but slashes/colons/quotes hurt downstream.
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

  async function listProjectFolders({ pageSize = 50 } = {}) {
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
      `${API}/files?q=${q}&fields=files(id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink)&orderBy=createdTime&pageSize=${pageSize}&supportsAllDrives=true&includeItemsFromAllDrives=true`
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
  // multipart/related upload — one round trip for files <~5MB, fine for most photos.
  async function uploadMultipart({ folderId, fileName, mimeType, blob }) {
    const metadata = { name: fileName, parents: [folderId] };
    const boundary = '-------dancon' + Math.random().toString(36).slice(2);
    const head =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;

    const body = new Blob([head, blob, tail]);

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
      throw new Error(`Upload failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  // For larger files (videos), use resumable upload to survive flaky connections.
  async function uploadResumable({ folderId, fileName, mimeType, blob, onProgress }) {
    const metadata = { name: fileName, parents: [folderId] };
    const initRes = await authedFetch(
      `${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(blob.size)
        },
        body: JSON.stringify(metadata)
      }
    );
    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '');
      throw new Error(`Resumable init failed: ${initRes.status} ${text}`);
    }
    const sessionUrl = initRes.headers.get('Location');
    if (!sessionUrl) throw new Error('Resumable session URL missing');

    // PUT in one shot — for the ~tens-of-MB range that MediaRecorder produces,
    // a single PUT is fine. Server-side resume kicks in on retry if it fails.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl, true);
      xhr.setRequestHeader('Content-Type', mimeType);
      xhr.upload.onprogress = (ev) => {
        if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve({}); }
        } else {
          reject(new Error(`Upload PUT failed: ${xhr.status} ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(blob);
    });
  }

  // Picks single-shot vs resumable based on size.
  async function uploadFile(opts) {
    const big = opts.blob.size > 5 * 1024 * 1024;
    return big ? uploadResumable(opts) : uploadMultipart(opts);
  }

  // -------- Text-file append (notes.txt, visit_log.txt) --------
  // Strategy: if the file exists, download, append, PATCH-update content.
  //           If not, create new file with the content.
  async function downloadFileText(fileId) {
    const res = await authedFetch(
      `${API}/files/${fileId}?alt=media&supportsAllDrives=true`
    );
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.text();
  }

  async function updateFileContent(fileId, blob, mimeType) {
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
      throw new Error(`Update failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async function appendToTextFile({ folderId, fileName, lineOrText }) {
    const existing = await findFileInFolder(folderId, fileName);
    if (existing) {
      const current = await downloadFileText(existing.id);
      const next = current.endsWith('\n') || current.length === 0
        ? current + lineOrText
        : current + '\n' + lineOrText;
      const blob = new Blob([next], { type: 'text/plain' });
      return updateFileContent(existing.id, blob, 'text/plain');
    }
    const blob = new Blob([lineOrText], { type: 'text/plain' });
    return uploadMultipart({ folderId, fileName, mimeType: 'text/plain', blob });
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
