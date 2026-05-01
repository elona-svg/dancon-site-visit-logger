// IndexedDB wrapper.
// Stores: uploadQueue (pending uploads with raw Blob), kv (small JSON values).
window.DB = (function () {
  const DB_NAME = 'dancon-svl';
  const DB_VERSION = 2;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('uploadQueue')) {
          const store = db.createObjectStore('uploadQueue', { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode = 'readonly') {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- KV ----
  async function kvGet(key) {
    const store = await tx('kv');
    return reqToPromise(store.get(key));
  }
  async function kvSet(key, value) {
    const store = await tx('kv', 'readwrite');
    return reqToPromise(store.put(value, key));
  }
  async function kvDelete(key) {
    const store = await tx('kv', 'readwrite');
    return reqToPromise(store.delete(key));
  }

  // ---- Upload queue ----
  // Item shape: { id, projectId, projectName, fileName, mimeType, blob,
  //               status: 'pending'|'uploading'|'success'|'error',
  //               attempts, lastError, createdAt, kind, meta }
  async function queueAdd(item) {
    const store = await tx('uploadQueue', 'readwrite');
    const toSave = {
      ...item,
      status: item.status || 'pending',
      attempts: item.attempts || 0,
      createdAt: item.createdAt || Date.now()
    };
    const id = await reqToPromise(store.add(toSave));
    return { ...toSave, id };
  }

  async function queueUpdate(id, patch) {
    const store = await tx('uploadQueue', 'readwrite');
    const current = await reqToPromise(store.get(id));
    if (!current) return null;
    const next = { ...current, ...patch };
    await reqToPromise(store.put(next));
    return next;
  }

  async function queueDelete(id) {
    const store = await tx('uploadQueue', 'readwrite');
    return reqToPromise(store.delete(id));
  }

  async function queueAll() {
    const store = await tx('uploadQueue');
    return reqToPromise(store.getAll());
  }

  async function queuePending() {
    const all = await queueAll();
    return all.filter((i) => i.status === 'pending' || i.status === 'error');
  }

  async function queueClearSuccess() {
    const all = await queueAll();
    const store = await tx('uploadQueue', 'readwrite');
    await Promise.all(
      all.filter((i) => i.status === 'success').map((i) => reqToPromise(store.delete(i.id)))
    );
  }

  return {
    open,
    kvGet,
    kvSet,
    kvDelete,
    queueAdd,
    queueUpdate,
    queueDelete,
    queueAll,
    queuePending,
    queueClearSuccess
  };
})();
