// Talks to the processing worker. Two workers: one for live previews, one for full-size saves,
// so saving never waits behind preview updates.

class WorkerClient {
  constructor() {
    this.worker = new Worker(new URL('./process-worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.latest = new Map(); // channel -> { running, next }
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data); else p.reject(new Error(e.data.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The image worker stopped.'));
      this.pending.clear();
    };
  }

  call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Sends pixels (a copy, so the caller keeps its own). */
  setImage(key, imageData, fullW, fullH) {
    const buf = imageData.data.slice().buffer;
    return this.call({ cmd: 'set', key, w: imageData.width, h: imageData.height, fullW: fullW || imageData.width, fullH: fullH || imageData.height, buf }, [buf]);
  }

  drop(key) { return this.call({ cmd: 'drop', key }).catch(() => {}); }

  render(key, settings, edit, opts) { return this.call({ cmd: 'render', key, settings, edit, opts }); }

  detect(key, x, y, o) { return this.call({ cmd: 'detect', key, x, y, o }).then((r) => r.box); }

  deskew(key, edit) { return this.call({ cmd: 'deskew', key, edit }).then((r) => r.angle); }

  /**
   * Only the newest request per channel runs; older queued ones resolve to null.
   * Keeps sliders smooth: the worker never falls behind.
   */
  renderLatest(channel, key, settings, edit, opts) {
    let ch = this.latest.get(channel);
    if (!ch) { ch = { running: false, next: null }; this.latest.set(channel, ch); }
    return new Promise((resolve, reject) => {
      if (ch.next) ch.next.resolve(null);
      ch.next = { key, settings, edit, opts, resolve, reject };
      const run = async () => {
        if (ch.running || !ch.next) return;
        const job = ch.next;
        ch.next = null;
        ch.running = true;
        try { job.resolve(await this.render(job.key, job.settings, job.edit, job.opts)); } catch (e) { job.reject(e); }
        ch.running = false;
        run();
      };
      run();
    });
  }
}

let preview = null;
let full = null;
export const previewWorker = () => (preview ||= new WorkerClient());
export const fullWorker = () => (full ||= new WorkerClient());

export function toImageData(o) {
  return new ImageData(o.d instanceof Uint8ClampedArray ? o.d : new Uint8ClampedArray(o.d), o.w, o.h);
}

export function canvasToImageData(c) {
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
}

/** Downscaled copy for fast previews (longest side at most `max`). */
export function downscale(imageData, max) {
  const f = Math.min(1, max / Math.max(imageData.width, imageData.height));
  if (f >= 1) return { data: imageData, s: 1 };
  const src = document.createElement('canvas');
  src.width = imageData.width;
  src.height = imageData.height;
  src.getContext('2d').putImageData(imageData, 0, 0);
  let cur = src;
  const tw = Math.max(1, Math.round(imageData.width * f));
  const th = Math.max(1, Math.round(imageData.height * f));
  while (cur.width / 2 > tw) {
    const n = document.createElement('canvas');
    n.width = Math.round(cur.width / 2);
    n.height = Math.round(cur.height / 2);
    const ctx = n.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, n.width, n.height);
    cur = n;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, tw, th);
  return { data: canvasToImageData(out), s: tw / imageData.width };
}

export function imageDataToCanvas(id) {
  const c = document.createElement('canvas');
  c.width = id.width;
  c.height = id.height;
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

export async function blobToImageData(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Full-size render and encode in the save worker. Returns { blob, w, h, stats, deskewUsed }. */
let finalSeq = 0;
export async function renderFinal(imageData, settings, edit) {
  const w = fullWorker();
  const key = `final-${++finalSeq}`;
  await w.setImage(key, imageData);
  try {
    const r = await w.render(key, settings, edit, {
      encode: { format: settings.format, quality: settings.jpgQuality }, stats: true, noPixels: true,
    });
    return { blob: r.blob, w: r.finalW, h: r.finalH, stats: r.stats, deskewUsed: r.deskewUsed };
  } finally {
    w.drop(key);
  }
}
