// Small IndexedDB key-value store for things localStorage cannot hold:
// the folder handle, the loaded Excel file, recent PDFs, and images saved in download mode.

const DB_NAME = 'diagram-cropper';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function get(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; }
}

export async function set(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); return true; } catch (e) { console.warn('IndexedDB write failed', key, e); return false; }
}

export async function del(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}

export async function keys() {
  try { return await tx('readonly', (s) => s.getAllKeys()); } catch { return []; }
}
