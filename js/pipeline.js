// Image processing pipeline. Pure functions on { w, h, d } images (d = RGBA Uint8ClampedArray).
// Used by the web worker (heavy work) and by the main thread (geometry maths for the editor).
//
// Order: geometry (perspective, rotate, flip, tilt) -> clean-up and tone -> mode -> despeckle
//        -> edit steps (erase, clone, keep) -> fine crop -> trim -> resize -> padding

// ============================================================ basics

export function newImg(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  d.fill(255);
  return { w, h, d };
}

export const copyImg = (a) => ({ w: a.w, h: a.h, d: new Uint8ClampedArray(a.d) });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function lumArray(img) {
  const { w, h, d } = img;
  const L = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return L;
}

function subImg(img, x, y, w, h) {
  x = clamp(Math.round(x), 0, img.w - 1);
  y = clamp(Math.round(y), 0, img.h - 1);
  w = clamp(Math.round(w), 1, img.w - x);
  h = clamp(Math.round(h), 1, img.h - y);
  const out = newImg(w, h);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.w + x) * 4;
    out.d.set(img.d.subarray(s, s + w * 4), r * w * 4);
  }
  return out;
}

// ============================================================ 3x3 matrices

export const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}

export function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return I3.slice();
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function applyH(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Homography that maps the 4 points `q` (tl, tr, br, bl) onto a W x H rectangle. */
export function quadToRect(q, W, H) {
  const dst = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [];
  const bv = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = q[k];
    const [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bv.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bv.push(v);
  }
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [bv[col], bv[piv]] = [bv[piv], bv[col]];
    const p = A[col][col] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / p;
      if (!f) continue;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      bv[r] -= f * bv[col];
    }
  }
  const hvec = bv.map((v, r) => v / (A[r][r] || 1e-12));
  return [...hvec, 1];
}

/**
 * Geometry for an edit: maps original-crop pixels to output pixels.
 * geom: { persp: [[x,y] x4] | null, rot90, angle, deskew, flipH, flipV } (angles in degrees)
 */
export function geoTransform(geom, w, h) {
  const g = geom || {};
  let P = I3;
  let rw = w;
  let rh = h;
  const q = g.persp;
  if (q && q.length === 4) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    rw = Math.max(1, Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2]))));
    rh = Math.max(1, Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2]))));
    P = quadToRect(q, rw, rh);
  }
  const deg = (g.rot90 || 0) + (g.angle || 0) + (g.deskew || 0);
  const t = (deg * Math.PI) / 180;
  const snap = (v) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
  const c = snap(Math.cos(t));
  const s = snap(Math.sin(t));
  const fx = g.flipH ? -1 : 1;
  const fy = g.flipV ? -1 : 1;
  const M = [c * fx, -s * fy, 0, s * fx, c * fy, 0, 0, 0, 1];
  const identity = !(q && q.length === 4) && Math.abs(deg % 360) < 1e-9 && fx === 1 && fy === 1;
  if (identity) return { H: I3.slice(), W: w, Hh: h, identity: true };
  const W2 = Math.max(1, Math.round(Math.abs(M[0]) * rw + Math.abs(M[1]) * rh));
  const H2 = Math.max(1, Math.round(Math.abs(M[3]) * rw + Math.abs(M[4]) * rh));
  const T1 = [1, 0, -rw / 2, 0, 1, -rh / 2, 0, 0, 1];
  const T2 = [1, 0, W2 / 2, 0, 1, H2 / 2, 0, 0, 1];
  return { H: mul(T2, mul(M, mul(T1, P))), W: W2, Hh: H2, identity: false };
}

/** Resample `src` through homography H (src -> out) into a W x Hh image. Outside is white. */
export function warp(src, H, W, Hh) {
  const Hi = inv(H);
  const out = newImg(W, Hh);
  const { w: sw, h: sh, d: sd } = src;
  const od = out.d;
  for (let y = 0; y < Hh; y++) {
    const py = y + 0.5;
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const ww = Hi[6] * px + Hi[7] * py + Hi[8];
      const sx = (Hi[0] * px + Hi[1] * py + Hi[2]) / ww - 0.5;
      const sy = (Hi[3] * px + Hi[4] * py + Hi[5]) / ww - 0.5;
      if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) { od[(y * W + x) * 4 + 3] = 0; continue; }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const ax = sx - x0;
      const ay = sy - y0;
      const xa = clamp(x0, 0, sw - 1);
      const xb = clamp(x0 + 1, 0, sw - 1);
      const ya = clamp(y0, 0, sh - 1);
      const yb = clamp(y0 + 1, 0, sh - 1);
      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;
      const o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * ax;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * ax;
        od[o + ch] = top + (bot - top) * ay;
      }
    }
  }
  return out;
}

// ============================================================ tilt detection

/** Angle (degrees) that makes lines in the image horizontal/vertical. Range -15..15. */
export function detectSkew(img) {
  const f = Math.max(1, Math.ceil(Math.max(img.w, img.h) / 700));
  const { w, d } = img;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.h; y += f) {
    for (let x = 0; x < w; x += f) {
      const i = (y * w + x) * 4;
      sum += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      n++;
    }
  }
  const thr = Math.min(150, (sum / Math.max(1, n)) * 0.72);
  let xs = [];
  let ys = [];
  for (let y = 0; y < img.h; y += f) {
    for (let x = 0; x < w; x += f) {
      const i = (y * w + x) * 4;
      if (((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) < thr) { xs.push(x / f); ys.push(y / f); }
    }
  }
  if (xs.length < 40) return 0;
  if (xs.length > 50000) {
    const step = Math.ceil(xs.length / 50000);
    xs = xs.filter((_, i) => i % step === 0);
    ys = ys.filter((_, i) => i % step === 0);
  }
  const W = img.w / f;
  const H = img.h / f;
  const size = Math.ceil(Math.hypot(W, H)) * 2 + 4;
  const off = size / 2;
  const hy = new Int32Array(size);
  const hx = new Int32Array(size);
  const score = (deg) => {
    const t = (deg * Math.PI) / 180;
    const s = Math.sin(t);
    const c = Math.cos(t);
    hy.fill(0);
    hx.fill(0);
    for (let k = 0; k < xs.length; k++) {
      hy[Math.round(xs[k] * s + ys[k] * c + off)]++;
      hx[Math.round(xs[k] * c - ys[k] * s + off)]++;
    }
    let v = 0;
    for (let k = 0; k < size; k++) v += hy[k] * hy[k] + hx[k] * hx[k];
    return v;
  };
  let best = 0;
  let bestScore = -1;
  for (let a = -15; a <= 15.0001; a += 0.5) {
    const sc = score(a);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  const coarse = best;
  for (let a = coarse - 0.5; a <= coarse + 0.5001; a += 0.05) {
    const sc = score(a);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return Math.round(best * 100) / 100;
}

// ============================================================ clean-up steps

function boxBlurChannel(src, dst, w, h, r, tmp) {
  // horizontal
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / (2 * r + 1);
      acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
}

/** Typical camera grain (standard deviation of brightness), measured robustly so edges do not count. */
export function noiseSigma(img) {
  const { w, h } = img;
  const L = lumArray(img);
  const vals = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      vals.push(Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]));
    }
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  // for pure noise the 4-neighbour Laplacian has std sqrt(20) * sigma; median / 0.6745 estimates its std
  return (vals[Math.floor(vals.length / 2)] * 1.4826) / Math.sqrt(20);
}

/** Replaces single-pixel spikes (much brighter or darker than all 8 neighbours) with the neighbours' average. */
function removeSpikes(img, margin) {
  const { w, h, d } = img;
  const L = lumArray(img);
  const out = copyImg(img);
  const od = out.d;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      let mn = 255, mx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = p + dy * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const v = L[row + dx];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      const l = L[p];
      if (l <= mx + margin && l >= mn - margin) continue;
      let r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = (p + dy * w + dx) * 4;
          r += d[j]; g += d[j + 1]; b += d[j + 2];
        }
      }
      const i = p * 4;
      od[i] = r / 8; od[i + 1] = g / 8; od[i + 2] = b / 8;
    }
  }
  return out;
}

/**
 * Edge-preserving smoothing (bilateral filter, done as a horizontal and a vertical pass).
 * How strong it is follows the grain actually measured in the crop, so clean areas and sharp lines are kept.
 */
function denoise(img, strength) {
  const { w, h } = img;
  const sigma = clamp(noiseSigma(img), 0.8, 30);
  const k = strength / 100;
  const range = Math.max(5, sigma * (2 + 3 * k)); // colour distance treated as "the same surface"
  const lut = new Float32Array(766);
  for (let i = 0; i < 766; i++) lut[i] = Math.exp(-(i * i) / (2 * (range * 1.7) ** 2));
  const R = 3;
  const ws = [];
  for (let t = -R; t <= R; t++) ws.push(Math.exp(-(t * t) / (2 * 2 * 2)));
  const pass = (src, horizontal) => {
    const sd = src.d;
    const out = newImg(w, h);
    const od = out.d;
    const stride = horizontal ? 4 : w * 4; // byte step between neighbours along the filter
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = (y * w + x) * 4;
        const pos = horizontal ? x : y;
        const len = horizontal ? w : h;
        const a0 = pos < R ? -pos : -R;
        const a1 = pos + R >= len ? len - 1 - pos : R;
        const cr = sd[c], cg = sd[c + 1], cb = sd[c + 2];
        let r = 0, g = 0, b = 0, sw = 0;
        for (let t = a0; t <= a1; t++) {
          const j = c + t * stride;
          const vr = sd[j], vg = sd[j + 1], vb = sd[j + 2];
          const dr = vr - cr, dg = vg - cg, db = vb - cb;
          const wt = ws[t + R] * lut[(dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db)];
          r += vr * wt; g += vg * wt; b += vb * wt; sw += wt;
        }
        od[c] = r / sw; od[c + 1] = g / sw; od[c + 2] = b / sw; od[c + 3] = sd[c + 3];
      }
    }
    return out;
  };
  let cur = pass(pass(removeSpikes(img, Math.max(6, sigma * 1.5)), true), false);
  if (k > 0.7 || sigma > 4) cur = pass(pass(cur, true), false);
  return cur;
}

/**
 * True when the crop is already clean (white paper, no grain) — typical of digital PDFs.
 * Such crops are left untouched, so their colours and light fills stay exactly as they are.
 */
export function isCleanSource(img) {
  const { w, h, d } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000)));
  let n = 0, white = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      n++;
      if (Math.min(d[i], d[i + 1], d[i + 2]) >= 250) white++;
    }
  }
  if (!n) return true;
  // enough pure white paper, and almost no grain
  return white >= n * 0.2 && noiseSigma(img) < 1.2;
}

/** Paper colour estimate on a coarse grid (bright pixels, spread over ink, then smoothed). */
function estimateBackground(img, outside) {
  const { w, h, d } = img;
  const cs = Math.max(4, Math.ceil(Math.max(w, h) / 40));
  const gw = Math.ceil(w / cs);
  const gh = Math.ceil(h / cs);
  const n = gw * gh;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), Lg = new Float32Array(n);
  const hist = new Int32Array(64);
  // 1. each patch: the mean colour of its brightest 20% (paper, if there is any)
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      const x0 = gx * cs, y0 = gy * cs, x1 = Math.min(w, x0 + cs), y1 = Math.min(h, y0 + cs);
      let cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (outside && outside[y * w + x]) continue;
          const i = (y * w + x) * 4;
          hist[((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >> 2]++;
          cnt++;
        }
      }
      const k = gy * gw + gx;
      if (cnt < (x1 - x0) * (y1 - y0) * 0.1) { Lg[k] = -1; continue; }
      let acc = 0, cut = 63;
      for (; cut > 0; cut--) { acc += hist[cut]; if (acc >= cnt * 0.2) break; }
      let r = 0, g = 0, b = 0, m = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (outside && outside[y * w + x]) continue;
          const i = (y * w + x) * 4;
          if ((((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >> 2) >= cut) { r += d[i]; g += d[i + 1]; b += d[i + 2]; m++; }
        }
      }
      R[k] = r / m; G[k] = g / m; B[k] = b / m;
      Lg[k] = (R[k] * 77 + G[k] * 150 + B[k] * 29) / 256;
    }
  }
  // 2. the paper's tint: median tint of the brightest 10% of patches
  const chroma = (k) => { const s3 = Math.max(1, R[k] + G[k] + B[k]); return [R[k] / s3, G[k] / s3, B[k] / s3]; };
  const valid = [];
  for (let k = 0; k < n; k++) if (Lg[k] >= 0) valid.push(k);
  valid.sort((a, b) => Lg[b] - Lg[a]);
  const top = valid.slice(0, Math.max(1, Math.ceil(valid.length * 0.1)));
  const med = (arr) => { const s2 = [...arr].sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)]; };
  const pc = top.length ? [0, 1, 2].map((c) => med(top.map((k) => chroma(k)[c]))) : [1 / 3, 1 / 3, 1 / 3];
  // 3. patches with a different tint (light coloured fills) or much darker than their brightest
  //    neighbours (inside dense ink) are not paper
  const paper = new Uint8Array(n);
  for (const k of valid) {
    const c = chroma(k);
    paper[k] = Math.abs(c[0] - pc[0]) + Math.abs(c[1] - pc[1]) + Math.abs(c[2] - pc[2]) < 0.02 ? 1 : 0;
  }
  // paper is one connected sheet: a "paper" patch with few paper neighbours is really part of a fill
  for (let it = 0; it < 2; it++) {
    const keep = new Uint8Array(n);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const k = gy * gw + gx;
        if (!paper[k]) continue;
        let nb = 0, tot = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const yy = gy + dy, xx = gx + dx;
          if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
          tot++;
          if (paper[yy * gw + xx]) nb++;
        }
        keep[k] = nb >= Math.min(3, tot) ? 1 : 0;
      }
    }
    paper.set(keep);
  }
  const rad = 2;
  const R2 = new Float32Array(n).fill(-1), G2 = new Float32Array(n), B2 = new Float32Array(n);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let best = -1, bk = -1;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = gy + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = gx + dx;
          if (xx < 0 || xx >= gw) continue;
          const q = yy * gw + xx;
          if (paper[q] && Lg[q] > best) { best = Lg[q]; bk = q; }
        }
      }
      const k = gy * gw + gx;
      if (bk >= 0 && paper[k]) { R2[k] = R[bk]; G2[k] = G[bk]; B2[k] = B[bk]; }
    }
  }
  // 4. fill the gaps (fills, dense ink, rotated corners) by growing the paper estimate in from the sides
  for (let guard = 0; guard < 200; guard++) {
    const fill = [];
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const k = gy * gw + gx;
        if (R2[k] >= 0) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = gy + dy, xx = gx + dx;
          if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
          const q = yy * gw + xx;
          if (R2[q] >= 0) { r += R2[q]; g += G2[q]; b += B2[q]; c++; }
        }
        if (c) fill.push([k, r / c, g / c, b / c]);
      }
    }
    if (!fill.length) break;
    for (const [k, r, g, b] of fill) { R2[k] = r; G2[k] = g; B2[k] = b; }
  }
  for (let k = 0; k < n; k++) if (R2[k] < 0) { R2[k] = 255; G2[k] = 255; B2[k] = 255; }
  const tmp = new Float32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    boxBlurChannel(R2, R2, gw, gh, 1, tmp);
    boxBlurChannel(G2, G2, gw, gh, 1, tmp);
    boxBlurChannel(B2, B2, gw, gh, 1, tmp);
  }
  // overall paper colour: median of the grid
  const sorted = Array.from(R2.keys()).sort((a, b) => (R2[a] + G2[a] + B2[a]) - (R2[b] + G2[b] + B2[b]));
  const mid = sorted[Math.floor(sorted.length / 2)];
  return { cs, gw, gh, R: R2, G: G2, B: B2, global: [R2[mid], G2[mid], B2[mid]] };
}

/** Removes paper colour and/or uneven light. */
function flatten(img, whiteBg, shadow, outside) {
  const { w, h, d } = img;
  const bg = estimateBackground(img, outside);
  const out = newImg(w, h);
  const od = out.d;
  const [gr, gg, gb] = bg.global;
  const gl = (gr * 77 + gg * 150 + gb * 29) / 256;
  const { cs, gw, gh } = bg;
  const BR = bg.R, BG = bg.G, BB = bg.B;
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / cs - 0.5, 0, gh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / cs - 0.5, 0, gw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), ax = fx - x0;
      const k00 = y0 * gw + x0, k10 = y0 * gw + x1, k01 = y1 * gw + x0, k11 = y1 * gw + x1;
      let br = gr, bgc = gg, bb = gb;
      if (shadow) {
        const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
        br = BR[k00] * w00 + BR[k10] * w10 + BR[k01] * w01 + BR[k11] * w11;
        bgc = BG[k00] * w00 + BG[k10] * w10 + BG[k01] * w01 + BG[k11] * w11;
        bb = BB[k00] * w00 + BB[k10] * w10 + BB[k01] * w01 + BB[k11] * w11;
      }
      const i = (y * w + x) * 4;
      if (whiteBg) {
        od[i] = (d[i] * 255) / Math.max(40, br);
        od[i + 1] = (d[i + 1] * 255) / Math.max(40, bgc);
        od[i + 2] = (d[i + 2] * 255) / Math.max(40, bb);
      } else {
        // flatten the light only, keep the paper tone
        const f = gl / Math.max(40, (br * 77 + bgc * 150 + bb * 29) / 256);
        od[i] = d[i] * f; od[i + 1] = d[i + 1] * f; od[i + 2] = d[i + 2] * f;
      }
    }
  }
    if (whiteBg) {
    // grain lifts the brightest pixels, so the paper ends up a little grey: measure where the paper
    // really is now (middle brightness of bright, neutral pixels) and lift it to about 250
    const hist = new Int32Array(256);
    let cnt = 0;
    const st = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000)));
    for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
      const i = (y * w + x) * 4;
      if (outside && outside[y * w + x]) continue;
      const mx = Math.max(od[i], od[i + 1], od[i + 2]), mn = Math.min(od[i], od[i + 1], od[i + 2]);
      const l = (od[i] * 77 + od[i + 1] * 150 + od[i + 2] * 29) >> 8;
      if (l >= 190 && mx - mn <= 24) { hist[l]++; cnt++; }
    }
    let acc = 0, med = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cnt / 2) { med = v; break; } }
    if (cnt > 50 && med < 250) {
      const gain = 250 / Math.max(190, med);
      for (let i = 0; i < od.length; i += 4) { od[i] *= gain; od[i + 1] *= gain; od[i + 2] *= gain; }
    }
  }
  return out;
}

function percentileLum(img, p) {
  const L = lumArray(img);
  const hist = new Int32Array(256);
  for (let i = 0; i < L.length; i++) hist[L[i]]++;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= L.length * p) return v; }
  return 255;
}

function toneLut(st, black, white, contrast) {
  const lut = new Uint8ClampedArray(256);
  const ev = Math.pow(2, st.exposure || 0);
  const bp = black / 255;
  const wp = Math.max(bp + 0.02, white / 255);
  const c = clamp(contrast, -99, 99);
  const cf = (100 + c) / (100 - c);
  const gamma = clamp(st.gamma || 1, 0.1, 5);
  const sh = (st.shadows || 0) / 100;
  const hl = (st.highlights || 0) / 100;
  const br = (st.brightness || 0) / 200;
  for (let v = 0; v < 256; v++) {
    let x = (v / 255) * ev;
    x = (x - bp) / (wp - bp);
    x += br;
    x = (x - 0.5) * cf + 0.5;
    x = clamp(x, 0, 1);
    x += sh * 1.5 * x * (1 - x) * (1 - x);
    x += hl * 1.5 * x * x * (1 - x);
    x = Math.pow(clamp(x, 0, 1), 1 / gamma);
    lut[v] = Math.round(x * 255);
  }
  return lut;
}

/** 3x3 minimum and maximum, as two fast separable passes. */
function minMax3(src, w, h, lo, hi, tl, th) {
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[r + (x > 0 ? x - 1 : 0)], b = src[r + x], c = src[r + (x < w - 1 ? x + 1 : x)];
      tl[r + x] = a < b ? (a < c ? a : c) : (b < c ? b : c);
      th[r + x] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w, me = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const a = tl[up + x], b = tl[me + x], c = tl[dn + x];
      lo[me + x] = a < b ? (a < c ? a : c) : (b < c ? b : c);
      const e = th[up + x], f = th[me + x], g = th[dn + x];
      hi[me + x] = e > f ? (e > g ? e : g) : (f > g ? f : g);
    }
  }
}

/**
 * Unsharp mask on brightness only (the same change is added to all three colours: no colour fringes).
 * Differences smaller than `threshold` are treated as grain and barely sharpened.
 */
function sharpen(img, amount, radius, protect, threshold = 6) {
  const { w, h, d } = img;
  const n = w * h;
  const out = newImg(w, h);
  const od = out.d;
  const L = new Float32Array(n), bl = new Float32Array(n), tmp = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) L[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256;
  boxBlurChannel(L, bl, w, h, radius, tmp);
  let lo = null, hi = null;
  if (protect) {
    // no halos: results stay within the 3x3 neighbourhood's range, so thin lines keep their width
    lo = new Float32Array(n); hi = new Float32Array(n);
    minMax3(L, w, h, lo, hi, tmp, new Float32Array(n));
  }
  const inv = 1 / threshold;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const diff = L[p] - bl[p];
    const ad = diff < 0 ? -diff : diff;
    const g = ad < threshold ? (ad * inv) * (ad * inv) : 1;
    let v = L[p] + amount * diff * g;
    if (protect) { if (v < lo[p]) v = lo[p]; else if (v > hi[p]) v = hi[p]; }
    const delta = v - L[p];
    od[i] = d[i] + delta; od[i + 1] = d[i + 1] + delta; od[i + 2] = d[i + 2] + delta; od[i + 3] = d[i + 3];
  }
  return out;
}

function adaptiveThreshold(img, strength, soft, radius) {
  const { w, h } = img;
  const L = lumArray(img);
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += L[y * w + x];
      S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row;
    }
  }
  const k = 0.3 - (strength / 100) * 0.26; // strength 50 -> 0.17
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const area = (y1 - y0) * (x1 - x0);
      const sum = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
      const mean = sum / area;
      const t = Math.min(mean * (1 - k), 225);
      const l = L[y * w + x];
      let v;
      if (l < 50) v = 0;
      else if (soft) v = clamp(((l - t * 0.82) / (t * 0.3)) * 255, 0, 255);
      else v = l < t ? 0 : 255;
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Removes small dark spots (paper grain, dust). Long thin lines are kept because their extent is large. */
function despeckle(img, size, protectMask) {
  const { w, h, d } = img;
  const L = lumArray(img);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || L[start] >= 170) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    comp.length = 0;
    let big = false;
    while (sp) {
      const p = stack[--sp];
      comp.push(p);
      const x = p % w, y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (maxX - minX >= size || maxY - minY >= size) big = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!seen[q] && L[q] < 170) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    if (big) continue;
    // only specks lying on light paper are dust; dark grains inside a coloured fill are left alone.
    // A removed speck takes the colour of its surroundings.
    let rr = 0, rg = 0, rb = 0, rn = 0;
    const ex0 = Math.max(0, minX - 2), ex1 = Math.min(w - 1, maxX + 2), ey0 = Math.max(0, minY - 2), ey1 = Math.min(h - 1, maxY + 2);
    for (let yy = ey0; yy <= ey1; yy++) {
      for (let xx = ex0; xx <= ex1; xx++) {
        if (xx >= minX && xx <= maxX && yy >= minY && yy <= maxY) continue;
        const q = (yy * w + xx) * 4;
        rr += d[q]; rg += d[q + 1]; rb += d[q + 2]; rn++;
      }
    }
    if (!rn) continue;
    rr /= rn; rg /= rn; rb /= rn;
    if ((rr * 77 + rg * 150 + rb * 29) / 256 < 215) continue;
    for (const p of comp) {
      if (protectMask && protectMask[p]) continue;
      const i = p * 4;
      d[i] = rr; d[i + 1] = rg; d[i + 2] = rb;
    }
  }
}

const isNeutral = (st) => st.mode === 'original' && !st.whiteBg && !st.shadow && !st.enhance && !st.sharpen
  && !st.denoise && !st.despeckle && !st.brightness && !st.contrast && (st.gamma || 1) === 1 && !st.exposure
  && !st.highlights && !st.shadows && (st.whitePoint ?? 255) === 255 && !(st.blackPoint);

/**
 * Makes paper pure white, judged by the neighbourhood (5x5) rather than single pixels:
 * bright, neutral and ink-free surroundings become white, so camera grain and faint dots disappear,
 * while coloured fills and the soft edges of lines are kept.
 */
function whitenPaper(img, s) {
  const { w, h, d } = img;
  const n = w * h;
  const r = Math.max(1, Math.round(2 * s));
  const Rm = new Float32Array(n), Gm = new Float32Array(n), Bm = new Float32Array(n);
  const src = new Float32Array(n), tmp = new Float32Array(n), L = new Float32Array(n);
  for (let ch = 0; ch < 3; ch++) {
    for (let p = 0; p < n; p++) src[p] = d[p * 4 + ch];
    boxBlurChannel(src, ch === 0 ? Rm : ch === 1 ? Gm : Bm, w, h, r, tmp);
  }
  for (let p = 0, i = 0; p < n; p++, i += 4) L[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256;
  const lo = new Float32Array(n), hi = new Float32Array(n), t2 = new Float32Array(n);
  minMax3(L, w, h, lo, hi, tmp, t2);
  const lo2 = new Float32Array(n);
  minMax3(lo, w, h, lo2, hi, tmp, t2); // 5x5 minimum
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (lo2[p] < 150) continue; // ink nearby: keep the soft edge of the line
    const mr = Rm[p], mg = Gm[p], mb = Bm[p];
    const mx = mr > mg ? (mr > mb ? mr : mb) : (mg > mb ? mg : mb);
    const mn = mr < mg ? (mr < mb ? mr : mb) : (mg < mb ? mg : mb);
    if (mx - mn > 14) continue; // coloured area (a fill): keep it
    const ml = (mr * 77 + mg * 150 + mb * 29) / 256;
    if (ml < 222) continue;
    const t = ml >= 236 ? 1 : (ml - 222) / 14;
    d[i] += (255 - d[i]) * t; d[i + 1] += (255 - d[i + 1]) * t; d[i + 2] += (255 - d[i + 2]) * t;
  }
}

/**
 * Background, clarity, tone and mode. `s` = pixel scale versus the full-size image (sizes are in full-size pixels).
 * `protect` = mask of pixels the automatic clean-up must not change.
 */
export function processAppearance(src, st, s, protect, cache) {
  // pixels outside the picture (corners left by rotating) are marked with alpha 0
  let outside = null;
  for (let i = 3; i < src.d.length; i += 4) {
    if (src.d[i] === 0) { outside = new Uint8Array(src.w * src.h); break; }
  }
  if (outside) for (let p = 0; p < outside.length; p++) outside[p] = src.d[p * 4 + 3] === 0 ? 1 : 0;
  const whiten = (im) => {
    if (outside) for (let p = 0, i = 0; p < outside.length; p++, i += 4) if (outside[p]) { im.d[i] = im.d[i + 1] = im.d[i + 2] = im.d[i + 3] = 255; }
    return im;
  };
  if (isNeutral(st)) return whiten(copyImg(src));
  // already clean (digital PDF): only the changes the user asked for by hand
  const clean = st.adaptive !== false && isCleanSource(src);
  // grain removal and paper flattening are the slow part: keep them while other sliders move
  const baseKey = JSON.stringify([clean, st.denoise, st.whiteBg, st.shadow]);
  let img;
  if (cache && cache.key === baseKey && cache.src === src) img = cache.img;
  else {
    img = src;
    if (!clean && (st.whiteBg || st.shadow)) img = flatten(img, st.whiteBg, st.shadow, outside);
    if (!clean && st.denoise > 0) img = denoise(img, st.denoise);
    if (cache) cache.grain = noiseSigma(img);
    if (cache) { cache.key = baseKey; cache.src = src; cache.img = img; }
  }

  const e = clean ? 0 : (st.enhance || 0) / 100;
  let black = st.blackPoint || 0;
  let white = st.whitePoint ?? 255;
  if (e > 0) {
    black = Math.max(black, percentileLum(img, 0.01) * e);
    const p99 = percentileLum(img, 0.9);
    if (!st.whiteBg) white = Math.min(white, 255 - (255 - p99) * e);
  }
  // (paper is made white separately below, so light fills are not pushed to white here)
  const lut = toneLut(st, black, white, st.contrast || 0);
  let out = copyImg(img);
  const od = out.d;
  for (let i = 0; i < od.length; i += 4) { od[i] = lut[od[i]]; od[i + 1] = lut[od[i + 1]]; od[i + 2] = lut[od[i + 2]]; }

  const amt = clean ? 0 : ((st.sharpen || 0) / 100) * 1.4 + e * 0.4;
  const grain = cache && cache.grain !== undefined ? cache.grain : noiseSigma(img);
  if (amt > 0.01) out = sharpen(out, amt, Math.max(1, Math.round(2 * s)), st.protectLines !== false, Math.max(4, grain * 3));

  const safe = protect ? copyImg(out) : null;
  const { w, h } = out;
  const d = out.d;
  const mode = st.mode || 'color';
  if (mode === 'color' && !clean) {
    // livelier colours in mid tones only: black lines and white paper stay neutral
    const f = 0.08 + e * 0.14;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      const wgt = clamp((l - 50) / 90, 0, 1) * clamp((248 - l) / 40, 0, 1);
      if (!wgt) continue;
      const g = 1 + f * wgt;
      d[i] = l + (d[i] - l) * g; d[i + 1] = l + (d[i + 1] - l) * g; d[i + 2] = l + (d[i + 2] - l) * g;
    }
  } else if (mode === 'gray' || mode === 'bw' || mode === 'lineart') {
    const L = lumArray(out);
    const bin = mode === 'gray' ? null
      : adaptiveThreshold(out, st.threshold ?? 50, mode === 'lineart', Math.max(6, Math.round(24 * s)));
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const sat = mx ? (mx - mn) / mx : 0;
      if (st.keepColor && sat > 0.28 && mx > 40 && L[p] < 238) {
        // keep coloured lines, a little stronger
        continue;
      }
      const v = bin ? bin[p] : L[p];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  if (st.despeckle > 0 && !clean) despeckle(out, Math.max(1, Math.round(st.despeckle * s)), protect);
  if (st.whiteBg && !clean) whitenPaper(out, s);
  if (protect && safe) {
    const gray = mode === 'gray' || mode === 'bw' || mode === 'lineart';
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (!protect[p]) continue;
      if (gray) {
        const l = (safe.d[i] * 77 + safe.d[i + 1] * 150 + safe.d[i + 2] * 29) >> 8;
        d[i] = d[i + 1] = d[i + 2] = l;
      } else {
        d[i] = safe.d[i]; d[i + 1] = safe.d[i + 1]; d[i + 2] = safe.d[i + 2];
      }
    }
  }
  return whiten(out);
}

// ============================================================ edit steps (erase, clone, keep, protect)

function stamp(mask, w, h, cx, cy, r, soft) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (dd > 1) continue;
      const a = soft ? (dd < 0.5 ? 255 : Math.round(255 * (1 - (dd - 0.5) / 0.5))) : 255;
      const k = y * w + x;
      if (a > mask[k]) mask[k] = a;
    }
  }
}

function strokeCenters(pts, r) {
  const out = [];
  if (!pts.length) return out;
  out.push(pts[0]);
  const step = Math.max(0.75, r / 3);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, i - 1 + k / n]);
  }
  return out;
}

export function fillPoly(mask, w, h, pts, val = 255) {
  if (pts.length < 3) return;
  let minY = h, maxY = 0;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const ys = Math.max(0, Math.floor(minY));
  const ye = Math.min(h - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = ys; y <= ye; y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[j];
      if ((y1 > py) !== (y2 > py)) xs.push(x1 + ((py - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.round(xs[k]));
      const b = Math.min(w, Math.round(xs[k + 1]));
      for (let x = a; x < b; x++) mask[y * w + x] = val;
    }
  }
}

function blendWhite(img, mask) {
  const d = img.d;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const a = mask[p];
    if (!a) continue;
    const f = a / 255;
    d[i] += (255 - d[i]) * f; d[i + 1] += (255 - d[i + 1]) * f; d[i + 2] += (255 - d[i + 2]) * f;
  }
}

/** Mask of "protect" areas in output coordinates. `map` converts original-crop points to output pixels. */
export function protectMask(ops, w, h, map) {
  const list = (ops || []).filter((o) => o.t === 'protect');
  if (!list.length) return null;
  const m = new Uint8Array(w * h);
  for (const o of list) fillPoly(m, w, h, o.pts.map(map), 1);
  return m;
}

/** Applies erase / erase area / keep only / clone steps. `k` scales sizes (full-size px -> output px). */
export function applyOps(img, ops, map, k) {
  const { w, h } = img;
  for (const o of ops || []) {
    if (o.t === 'protect') continue;
    const P = o.pts.map(map);
    if (o.t === 'erase') {
      const m = new Uint8Array(w * h);
      const r = Math.max(0.75, (o.size * k) / 2);
      for (const c of strokeCenters(P, r)) stamp(m, w, h, c[0], c[1], r, o.soft);
      blendWhite(img, m);
    } else if (o.t === 'erasePoly') {
      const m = new Uint8Array(w * h);
      fillPoly(m, w, h, P);
      blendWhite(img, m);
    } else if (o.t === 'keep') {
      const m = new Uint8Array(w * h).fill(255);
      fillPoly(m, w, h, P, 0);
      blendWhite(img, m);
    } else if (o.t === 'clone') {
      const Q = o.pts.map((p) => map([p[0] + o.off[0], p[1] + o.off[1]]));
      const snap = new Uint8ClampedArray(img.d);
      const d = img.d;
      const r = Math.max(0.75, (o.size * k) / 2);
      for (const c of strokeCenters(P, r)) {
        // matching source point along the source path
        const seg = c[2] === undefined ? 0 : c[2];
        const i0 = Math.min(Q.length - 1, Math.floor(seg));
        const i1 = Math.min(Q.length - 1, i0 + 1);
        const t = seg - Math.floor(seg);
        const P0 = P[i0], P1 = P[i1];
        const px = P0[0] + (P1[0] - P0[0]) * t, py = P0[1] + (P1[1] - P0[1]) * t;
        const qx = Q[i0][0] + (Q[i1][0] - Q[i0][0]) * t, qy = Q[i0][1] + (Q[i1][1] - Q[i0][1]) * t;
        const ox = qx - px, oy = qy - py;
        const x0 = Math.max(0, Math.floor(c[0] - r)), x1 = Math.min(w - 1, Math.ceil(c[0] + r));
        const y0 = Math.max(0, Math.floor(c[1] - r)), y1 = Math.min(h - 1, Math.ceil(c[1] + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dd = Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1]) / r;
            if (dd > 1) continue;
            const a = o.soft ? (dd < 0.5 ? 1 : 1 - (dd - 0.5) / 0.5) : 1;
            const sx = clamp(Math.round(x + ox), 0, w - 1), sy = clamp(Math.round(y + oy), 0, h - 1);
            const si = (sy * w + sx) * 4, di = (y * w + x) * 4;
            for (let ch = 0; ch < 3; ch++) d[di + ch] += (snap[si + ch] - d[di + ch]) * a;
          }
        }
      }
    }
  }
  return img;
}

// ============================================================ output: trim, resize, pad

export function contentBox(img, white = 245) {
  const { w, h, d } = img;
  let top = -1, bottom = -1, left = w, right = -1;
  const ink = (i) => d[i] < white || d[i + 1] < white || d[i + 2] < white;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ink((y * w + x) * 4)) {
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        break;
      }
    }
  }
  if (top < 0) return null;
  for (let y = top; y <= bottom; y++) {
    for (let x = w - 1; x > right; x--) if (ink((y * w + x) * 4)) { right = x; break; }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Area-average resize (for shrinking). */
export function resize(img, W, H) {
  if (W === img.w && H === img.h) return img;
  const pass = (src, sw, sh, dw, dh, horizontal) => {
    const out = new Float32Array(dw * dh * 3);
    const n = horizontal ? sw : sh;
    const m = horizontal ? dw : dh;
    const ratio = n / m;
    const lines = horizontal ? sh : sw;
    for (let o = 0; o < m; o++) {
      const a = o * ratio, b = a + ratio;
      const i0 = Math.floor(a), i1 = Math.min(n - 1, Math.ceil(b) - 1);
      for (let l = 0; l < lines; l++) {
        let r = 0, g = 0, bl = 0, wsum = 0;
        for (let i = i0; i <= i1; i++) {
          const wgt = Math.min(b, i + 1) - Math.max(a, i);
          if (wgt <= 0) continue;
          const si = horizontal ? (l * sw + i) * 3 : (i * sw + l) * 3;
          r += src[si] * wgt; g += src[si + 1] * wgt; bl += src[si + 2] * wgt; wsum += wgt;
        }
        const di = horizontal ? (l * dw + o) * 3 : (o * dw + l) * 3;
        out[di] = r / wsum; out[di + 1] = g / wsum; out[di + 2] = bl / wsum;
      }
    }
    return out;
  };
  const src = new Float32Array(img.w * img.h * 3);
  for (let p = 0; p < img.w * img.h; p++) { src[p * 3] = img.d[p * 4]; src[p * 3 + 1] = img.d[p * 4 + 1]; src[p * 3 + 2] = img.d[p * 4 + 2]; }
  const hpass = pass(src, img.w, img.h, W, img.h, true);
  const vpass = pass(hpass, W, img.h, W, H, false);
  const out = newImg(W, H);
  for (let p = 0; p < W * H; p++) { out.d[p * 4] = vpass[p * 3]; out.d[p * 4 + 1] = vpass[p * 3 + 1]; out.d[p * 4 + 2] = vpass[p * 3 + 2]; }
  return out;
}

export function pad(img, p) {
  if (p <= 0) return img;
  const out = newImg(img.w + 2 * p, img.h + 2 * p);
  for (let y = 0; y < img.h; y++) out.d.set(img.d.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((y + p) * out.w + p) * 4);
  return out;
}

/** Fine crop (normalised box), trim, max size, padding. Sizes in full-size px, scaled by `s`. */
export function finishOutput(img, st, crop, s) {
  let out = img;
  if (crop) out = subImg(out, crop.x0 * out.w, crop.y0 * out.h, (crop.x1 - crop.x0) * out.w, (crop.y1 - crop.y0) * out.h);
  let trimBox = null;
  if (st.trim) {
    const b = contentBox(out);
    if (b) { trimBox = b; if (b.w < out.w || b.h < out.h) out = subImg(out, b.x, b.y, b.w, b.h); }
  }
  const p = Math.round(clamp(Number(st.padding) || 0, 0, 40) * s);
  const maxW = (Number(st.maxWidth) || 0) * s;
  const maxH = (Number(st.maxHeight) || 0) * s;
  let f = 1;
  if (maxW > 0 && out.w + 2 * p > maxW) f = Math.min(f, (maxW - 2 * p) / out.w);
  if (maxH > 0 && out.h + 2 * p > maxH) f = Math.min(f, (maxH - 2 * p) / out.h);
  if (f < 1) out = resize(out, Math.max(1, Math.round(out.w * f)), Math.max(1, Math.round(out.h * f)));
  return { img: pad(out, p), trimBox };
}

// ============================================================ quality check

/** Numbers used to flag images that look wrong. */
export function qualityStats(img) {
  const { w, h } = img;
  const L = lumArray(img);
  let ink = 0, sum = 0;
  for (let i = 0; i < L.length; i++) { sum += L[i]; if (L[i] < 160) ink++; }
  const hist = new Int32Array(1100);
  let edges = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
      const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
      const g = Math.min(1099, Math.round(Math.hypot(gx, gy)));
      if (g > 40) { hist[g]++; edges++; }
    }
  }
  let sharp = null;
  if (edges > 60) {
    let acc = 0;
    for (let g = 1099; g >= 0; g--) { acc += hist[g]; if (acc >= edges * 0.1) { sharp = g; break; } }
  }
  return { w, h, ink: ink / L.length, mean: sum / L.length, sharp };
}

export function qualityFlags(q) {
  const out = [];
  if (q.ink < 0.002) out.push('nearlyBlank');
  if (q.mean < 110) out.push('dark');
  if (q.w < 100 || q.h < 100) out.push('small');
  if (q.sharp !== null && q.sharp < 220) out.push('blurry');
  return out;
}

// ============================================================ click to crop: find the diagram under a point

/** Grows a binary mask by r pixels (square window), in two fast passes. */
function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let run = -1e9; // last ink position
    for (let x = 0; x < w; x++) { if (mask[row + x]) run = x; if (x - run <= r) tmp[row + x] = 1; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (mask[row + x]) run = x; if (run - x <= r) tmp[row + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (y - run <= r) out[y * w + x] = 1; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/**
 * Finds the diagram under (cx, cy) on a page image.
 * o: { r: grouping distance px, gap: extra distance for labels px, minSize px }
 * Returns { x0, y0, x1, y1 } in image pixels, or { error } with a plain reason.
 */
export function findDiagram(img, cx, cy, o = {}) {
  const { w, h, d } = img;
  const r = Math.max(2, Math.round(o.r || 5));
  const gap = Math.max(1, Math.round(o.gap || 8));
  const minSize = o.minSize || 25;

  // 1. ink mask: darker than the local paper (works with shadows and grey paper)
  const L0 = lumArray(img);
  const L = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const src = Float32Array.from(L0);
  boxBlurChannel(src, L, w, h, 1, tmp); // tame camera grain
  const mean = new Float32Array(w * h);
  boxBlurChannel(L, mean, w, h, Math.max(8, Math.round(r * 3)), tmp);
  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  for (let i = 0; i < w * h; i++) {
    const m = mean[i];
    if (L[i] < m - Math.max(14, m * 0.1) && L[i] < 235) { ink[i] = 1; inkCount++; }
  }
  // colour: saturated pixels (fills, coloured curves) count as ink too
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx > 40 && (mx - mn) / mx > 0.35 && !ink[p]) { ink[p] = 1; inkCount++; }
  }
  if (inkCount < 20) return { error: 'This page looks empty here.' };

  // 2. group nearby strokes into blocks
  const grown = dilate(ink, w, h, r);
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    const id = comps.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    while (sp) {
      const q = stack[--sp];
      const x = q % w, y = (q - x) / w;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && grown[q - 1] && label[q - 1] < 0) { label[q - 1] = id; stack[sp++] = q - 1; }
      if (x < w - 1 && grown[q + 1] && label[q + 1] < 0) { label[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && grown[q - w] && label[q - w] < 0) { label[q - w] = id; stack[sp++] = q - w; }
      if (y < h - 1 && grown[q + w] && label[q + w] < 0) { label[q + w] = id; stack[sp++] = q + w; }
    }
    // shrink back by the grouping distance so the box hugs the real ink
    comps.push({ id, x0: Math.min(x0 + r, x1 - r), y0: Math.min(y0 + r, y1 - r), x1: Math.max(x1 - r, x0 + r), y1: Math.max(y1 - r, y0 + r), n });
  }
  // ignore the whole page border / huge blocks (a photographed page edge, a frame around everything)
  const pageArea = w * h;
  const usable = comps.filter((c) => (c.x1 - c.x0) * (c.y1 - c.y0) < pageArea * 0.8);
  if (!usable.length) return { error: 'Could not tell the diagram apart from the rest of the page.' };

  // 3. the block under the click, or the smallest block around it, or the nearest one
  const px = Math.round(cx), py = Math.round(cy);
  let pick = null;
  const under = px >= 0 && py >= 0 && px < w && py < h ? label[py * w + px] : -1;
  if (under >= 0 && usable.some((c) => c.id === under)) pick = usable.find((c) => c.id === under);
  if (!pick) {
    const around = usable.filter((c) => px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1)
      .sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
    pick = around[0] || null;
  }
  if (!pick) {
    let best = null, bd = gap * 3;
    for (const c of usable) {
      const dx = Math.max(0, c.x0 - px, px - c.x1);
      const dy = Math.max(0, c.y0 - py, py - c.y1);
      const dd = Math.hypot(dx, dy);
      if (dd < bd) { bd = dd; best = c; }
    }
    pick = best;
  }
  if (!pick) return { error: 'No diagram found here. Click on the diagram itself.' };

  // 4. add small nearby pieces (labels such as "Fig. 1", "2 kg") but not neighbouring text lines
  const box = { x0: pick.x0, y0: pick.y0, x1: pick.x1, y1: pick.y1 };
  const used = new Set([pick.id]);
  for (let changed = true; changed;) {
    changed = false;
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    for (const c of usable) {
      if (used.has(c.id)) continue;
      const dx = Math.max(0, c.x0 - box.x1, box.x0 - c.x1);
      const dy = Math.max(0, c.y0 - box.y1, box.y0 - c.y1);
      if (dx > gap || dy > gap) continue;
      const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
      const smallPiece = cw * ch <= bw * bh * 0.25 && cw <= bw * 0.6;
      const inside = c.x0 >= box.x0 && c.x1 <= box.x1 && c.y0 >= box.y0 && c.y1 <= box.y1;
      if (!smallPiece && !inside) continue;
      used.add(c.id);
      box.x0 = Math.min(box.x0, c.x0); box.y0 = Math.min(box.y0, c.y0);
      box.x1 = Math.max(box.x1, c.x1); box.y1 = Math.max(box.y1, c.y1);
      changed = true;
    }
  }
  if (box.x1 - box.x0 < minSize || box.y1 - box.y0 < minSize) return { error: 'Only a small mark was found here. Drag a box around the diagram instead.' };

  // 5. a caption just above or below ("Fig. 1", "Structure X"): one short line, no wider than the diagram,
  //    sitting within the diagram's width. Question text is a paragraph or a wider line, so it is left out.
  const lineMax = o.lineMax || 30;
  const capGap = o.captionGap || 60;
  for (const side of ['above', 'below']) {
    let best = null, bestGap = capGap;
    for (const c of usable) {
      if (used.has(c.id)) continue;
      const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
      if (ch > lineMax || cw > (box.x1 - box.x0)) continue;
      if (c.x0 < box.x0 - gap || c.x1 > box.x1 + gap) continue;
      const dy = side === 'below' ? c.y0 - box.y1 : box.y0 - c.y1;
      if (dy < 0 || dy >= bestGap) continue;
      // nothing else may sit between the diagram and the caption
      const blocked = usable.some((o2) => o2.id !== c.id && !used.has(o2.id) && o2.x1 > c.x0 && o2.x0 < c.x1
        && (side === 'below' ? o2.y0 >= box.y1 && o2.y1 <= c.y0 : o2.y1 <= box.y0 && o2.y0 >= c.y1));
      if (blocked) continue;
      best = c;
      bestGap = dy;
    }
    if (best) {
      used.add(best.id);
      box.x0 = Math.min(box.x0, best.x0); box.y0 = Math.min(box.y0, best.y0);
      box.x1 = Math.max(box.x1, best.x1); box.y1 = Math.max(box.y1, best.y1);
    }
  }
  return box;
}

// for tests and profiling
export const internals = { denoise, flatten, sharpen, despeckle, dilate, estimateBackground };
