// Background worker: runs the image pipeline so the page never freezes.
// Images are sent once ("set") and then rendered many times with different settings.
// Each stage is cached, so painting an erase stroke does not redo the colour clean-up.

import * as P from './pipeline.js';
import { encodePng8 } from './png8.js';

const images = new Map(); // key -> { img, fullW, fullH, cache }

const APPEARANCE_KEYS = ['adaptive', 'mode', 'whiteBg', 'shadow', 'keepColor', 'protectLines', 'enhance', 'brightness', 'contrast',
  'gamma', 'exposure', 'highlights', 'shadows', 'whitePoint', 'blackPoint', 'sharpen', 'denoise', 'despeckle', 'threshold'];

function geoOf(entry, geom) {
  const sig = JSON.stringify([geom.persp || null, geom.rot90 || 0, geom.angle || 0, geom.deskew || 0, !!geom.flipH, !!geom.flipV]);
  const c = entry.cache;
  if (c.geoSig === sig) return c.geo;
  const T = P.geoTransform(geom, entry.fullW, entry.fullH);
  const s = entry.img.w / entry.fullW;
  let img;
  if (T.identity) img = entry.img;
  else {
    const S = [s, 0, 0, 0, s, 0, 0, 0, 1];
    const Si = [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1];
    img = P.warp(entry.img, P.mul(S, P.mul(T.H, Si)), Math.max(1, Math.round(T.W * s)), Math.max(1, Math.round(T.Hh * s)));
  }
  c.geoSig = sig;
  c.geo = { img, T, s };
  c.procSig = null;
  c.base = {};
  return c.geo;
}

function render(msg) {
  const entry = images.get(msg.key);
  if (!entry) throw new Error('Image not loaded');
  const st = msg.settings;
  const edit = msg.edit || {};
  const geom = { ...(edit.geom || {}) };
  const opts = msg.opts || {};
  let deskewUsed = null;
  if (st.autoDeskew && (geom.deskew === null || geom.deskew === undefined)) {
    const base = geoOf(entry, { ...geom, angle: 0, deskew: 0 });
    geom.deskew = P.detectSkew(base.img);
    deskewUsed = geom.deskew;
  }
  const geo = geoOf(entry, geom);
  const { img: gimg, T, s } = geo;
  const map = (p) => { const q = P.applyH(T.H, p[0], p[1]); return [q[0] * s, q[1] * s]; };
  const ops = edit.ops || [];
  const protectOps = ops.filter((o) => o.t === 'protect');
  const procSig = JSON.stringify([APPEARANCE_KEYS.map((k) => st[k]), protectOps]);
  const c = entry.cache;
  if (c.procSig !== procSig) {
    const mask = P.protectMask(ops, gimg.w, gimg.h, map);
    c.proc = P.processAppearance(gimg, st, s, mask, c.base || (c.base = {}));
    c.procSig = procSig;
  }
  const cleaned = P.applyOps(P.copyImg(c.proc), ops, map, s);
  const crop = geom.crop || null;
  const out = { geoW: gimg.w, geoH: gimg.h, deskewUsed, s };
  const cropped = crop ? P.finishOutput(cleaned, { trim: false, padding: 0 }, crop, 1).img : cleaned;
  out.working = opts.crop === false ? cleaned : cropped;
  if (opts.before) {
    const b = crop && opts.crop !== false ? P.finishOutput(gimg, { trim: false, padding: 0 }, crop, 1).img : P.copyImg(gimg);
    out.before = b;
  }
  if (opts.final || opts.encode || opts.stats) {
    const fin = P.finishOutput(cropped, st, null, s);
    out.final = fin.img;
    if (fin.trimBox && opts.crop !== false) out.trimBox = fin.trimBox;
    if (opts.stats) out.stats = P.qualityStats(fin.img);
  } else if (st.trim) {
    const b = P.contentBox(out.working);
    if (b) out.trimBox = b;
  }
  return out;
}

async function encode(img, fmt, quality) {
  if (fmt === 'png8') return encodePng8(img);
  const oc = new OffscreenCanvas(img.w, img.h);
  oc.getContext('2d').putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
  return oc.convertToBlob(fmt === 'jpg' ? { type: 'image/jpeg', quality: (quality || 90) / 100 } : { type: 'image/png' });
}

const pack = (img) => (img ? { w: img.w, h: img.h, d: img.d } : undefined);

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === 'set') {
      images.set(msg.key, { img: { w: msg.w, h: msg.h, d: new Uint8ClampedArray(msg.buf) }, fullW: msg.fullW, fullH: msg.fullH, cache: {} });
      self.postMessage({ id: msg.id, ok: true });
    } else if (msg.cmd === 'drop') {
      images.delete(msg.key);
      self.postMessage({ id: msg.id, ok: true });
    } else if (msg.cmd === 'detect') {
      const entry = images.get(msg.key);
      if (!entry) throw new Error('Page not loaded');
      self.postMessage({ id: msg.id, ok: true, box: P.findDiagram(entry.img, msg.x, msg.y, msg.o) });
    } else if (msg.cmd === 'deskew') {
      const entry = images.get(msg.key);
      const geom = { ...((msg.edit && msg.edit.geom) || {}), angle: 0, deskew: 0 };
      const base = geoOf(entry, geom);
      self.postMessage({ id: msg.id, ok: true, angle: P.detectSkew(base.img) });
    } else if (msg.cmd === 'render') {
      const r = render(msg);
      const res = { id: msg.id, ok: true, geoW: r.geoW, geoH: r.geoH, s: r.s, deskewUsed: r.deskewUsed, trimBox: r.trimBox, stats: r.stats };
      const transfer = [];
      if (msg.opts && msg.opts.encode) {
        res.blob = await encode(r.final, msg.opts.encode.format, msg.opts.encode.quality);
        res.finalW = r.final.w;
        res.finalH = r.final.h;
      }
      if (!(msg.opts && msg.opts.noPixels)) {
        // never transfer a cached buffer
        const own = (img) => (img === r.working && (img.d.buffer === images.get(msg.key).img.d.buffer) ? P.copyImg(img) : img);
        res.working = pack(own(r.working));
        transfer.push(res.working.d.buffer);
        if (r.before) { res.before = pack(own(r.before)); if (!transfer.includes(res.before.d.buffer)) transfer.push(res.before.d.buffer); }
        if (r.final && msg.opts && msg.opts.final) {
          res.final = pack(r.final === r.working ? P.copyImg(r.final) : r.final);
          if (!transfer.includes(res.final.d.buffer)) transfer.push(res.final.d.buffer);
        }
      }
      self.postMessage(res, transfer);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};
