// Saving images into the chosen folder (File System Access API),
// with a download fallback for browsers that cannot write to folders.

import * as db from './db.js';
import { IMAGE_EXT_RE } from './names.js';

export const supported = typeof window.showDirectoryPicker === 'function';

let dir = null;
/** lowercase file name -> actual file name on disk */
let files = new Map();

export const isReady = () => !supported || !!dir;
export const name = () => (dir ? dir.name : '');
export const fileNames = () => [...files.values()];
export const hasFile = (n) => files.get(n.toLowerCase()) === n;
export const caseMismatch = (n) => {
  const actual = files.get(n.toLowerCase());
  return actual && actual !== n ? actual : null;
};

/** Plain-language message for a file system error. */
export function explain(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return 'The browser is not allowed to save in this folder. Click "Change folder" and choose "Allow" (or "Edit files") when the browser asks.';
  }
  if (n === 'NotFoundError') return 'The folder was not found. It may have been moved, renamed or deleted. Click "Change folder" and choose it again.';
  if (n === 'NoModificationAllowedError' || n === 'InvalidStateError') {
    return 'The file is locked or read-only. Close any program that has it open (for example an image viewer) and try again.';
  }
  if (n === 'QuotaExceededError') return 'The disk is full. Free some space and try again.';
  if (n === 'TypeError' && /name/i.test(err.message || '')) return 'This file name is not allowed by the system. Use "Fix automatically" on the name.';
  return `Could not save: ${err && err.message ? err.message : err}`;
}

/** Opens the folder picker. Returns the handle, or null if the user cancelled. */
export async function pick() {
  try {
    return await window.showDirectoryPicker({ id: 'diagram-cropper-images', mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

/** Confirms we can write to the folder by writing and deleting a small test file. */
export async function checkWritable(handle) {
  const testName = '.diagram-cropper-write-test.tmp';
  try {
    if (handle.requestPermission) {
      const p = await handle.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') return { ok: false, message: 'Permission to save in this folder was not given. Click "Change folder" and choose "Allow" (or "Edit files") when the browser asks.' };
    }
    const fh = await handle.getFileHandle(testName, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob(['ok']));
    await w.close();
    await handle.removeEntry(testName);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

/** Use this folder from now on. Remembers it for "Reconnect folder". */
export async function connect(handle) {
  dir = handle;
  await db.set('dirHandle', handle);
  await scan();
}

export function disconnect() {
  dir = null;
  files = new Map();
}

/** The folder handle saved last time, if any (not yet connected). */
export async function savedHandle() {
  if (!supported) return null;
  const h = await db.get('dirHandle');
  return h || null;
}

/** Reconnect to the saved folder. `ask` must be true only inside a click handler. */
export async function reconnect(ask) {
  const h = await savedHandle();
  if (!h) return { ok: false, message: 'No folder was saved. Click "Choose images folder".' };
  try {
    let p = h.queryPermission ? await h.queryPermission({ mode: 'readwrite' }) : 'granted';
    if (p !== 'granted' && ask) p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') return { ok: false, needsClick: true, name: h.name };
    dir = h;
    await scan();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: explain(e), name: h.name };
  }
}

/** Reads the folder listing. Returns the image file names found. */
export async function scan() {
  files = new Map();
  if (!dir) return [];
  for await (const [entryName, entry] of dir.entries()) {
    if (entry.kind === 'file' && IMAGE_EXT_RE.test(entryName)) files.set(entryName.toLowerCase(), entryName);
  }
  return fileNames();
}

/** Returns the file's contents as a Blob, or null when it does not exist. */
export async function readFile(fileName) {
  if (!supported) return (await db.get(`blob:${fileName}`)) || null;
  if (!dir) return null;
  const actual = files.get(fileName.toLowerCase());
  if (actual !== fileName) return null;
  try {
    const fh = await dir.getFileHandle(fileName);
    const f = await fh.getFile();
    // copy into memory so the data survives the file being overwritten
    return new Blob([await f.arrayBuffer()], { type: f.type });
  } catch (e) {
    if (e.name === 'NotFoundError') { files.delete(fileName.toLowerCase()); return null; }
    throw e;
  }
}

/** Writes a file with exactly this name (replaces a file that differs only in capital letters). */
export async function writeFile(fileName, blob, { quiet = false } = {}) {
  if (!supported) {
    await db.set(`blob:${fileName}`, blob);
    if (!quiet) download(blob, fileName);
    return;
  }
  if (!dir) throw Object.assign(new Error('Choose the images folder first.'), { name: 'NoFolder' });
  const clash = caseMismatch(fileName);
  if (clash) await dir.removeEntry(clash);
  const fh = await dir.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    throw e;
  }
  files.set(fileName.toLowerCase(), fileName);
}

/** Object URL for showing a saved image (cheap: does not copy the file). Null if missing. */
export async function fileUrl(fileName) {
  if (!supported) {
    const b = await db.get(`blob:${fileName}`);
    return b ? URL.createObjectURL(b) : null;
  }
  if (!dir || files.get(fileName.toLowerCase()) !== fileName) return null;
  try {
    const f = await (await dir.getFileHandle(fileName)).getFile();
    return URL.createObjectURL(f);
  } catch {
    return null;
  }
}

export async function removeFile(fileName) {
  if (!supported) { await db.del(`blob:${fileName}`); return; }
  if (!dir) return;
  try { await dir.removeEntry(fileName); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  files.delete(fileName.toLowerCase());
}

export function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
