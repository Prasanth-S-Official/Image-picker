// Image clean-up after cropping: trim white border, limit width, add white padding.

const WHITE = 245; // a pixel counts as white when all channels are at least this
const MIN_WARN = 100;

export const isSmall = (w, h) => w < MIN_WARN || h < MIN_WARN;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Bounding box of non-white pixels, or null if the image is blank. */
export function contentBounds(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const isInk = (i) => data[i + 3] > 16 && (data[i] < WHITE || data[i + 1] < WHITE || data[i + 2] < WHITE);
  let top = -1, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (isInk(row + x * 4)) {
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        break;
      }
    }
  }
  if (top < 0) return null;
  for (let y = top; y <= bottom; y++) {
    const row = y * w * 4;
    for (let x = w - 1; x > right; x--) {
      if (isInk(row + x * 4)) { right = x; break; }
    }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * Which edges of the crop have ink right at the border (the box may cut through the diagram).
 * Returns a list like ['top', 'right'].
 */
/** Brightness of the paper: 90th percentile, so grey phone photos are judged against their own paper. */
function inkLimit(data) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 16) { hist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++; n++; }
  let acc = 0;
  let paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.1) { paper = v; break; } }
  return Math.min(200, paper - 55);
}

/** True when the crop has any real ink (not just paper and grain). */
export function hasInk(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const lim = inkLimit(data);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 16 && ((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8) < lim) n++;
  }
  return n > Math.max(3, w * h * 0.0003);
}

export function inkOnEdges(canvas) {
  const { width: w, height: h } = canvas;
  if (w < 8 || h < 8) return [];
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const lim = inkLimit(data);
  const dark = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i + 3] > 16 && ((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8) < lim;
  };
  const countRow = (y) => { let n = 0; for (let x = 0; x < w; x++) if (dark(x, y)) n++; return n; };
  const countCol = (x) => { let n = 0; for (let y = 0; y < h; y++) if (dark(x, y)) n++; return n; };
  // ink must touch the edge line and the line just inside it, and cover more than a speck
  const hitRow = (a, b) => Math.min(countRow(a), countRow(b)) > Math.max(2, w * 0.01);
  const hitCol = (a, b) => Math.min(countCol(a), countCol(b)) > Math.max(2, h * 0.01);
  const out = [];
  if (hitRow(0, 1)) out.push('top');
  if (hitRow(h - 1, h - 2)) out.push('bottom');
  if (hitCol(0, 1)) out.push('left');
  if (hitCol(w - 1, w - 2)) out.push('right');
  return out;
}

/** Scale down in halving steps for a smooth result. */
function scaleDown(src, targetW) {
  let cur = src;
  while (cur.width / 2 > targetW) {
    const next = makeCanvas(cur.width / 2, cur.height / 2);
    const ctx = next.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  const out = makeCanvas(targetW, (cur.height * targetW) / cur.width);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

/**
 * Apply settings to a cropped canvas.
 * settings: { trim: bool, padding: px, maxWidth: px or 0 }
 * `pixelScale` converts settings px (defined for the saved image) to this canvas' px (used for previews).
 */
export function finish(canvas, settings, pixelScale = 1) {
  let cur = canvas;
  if (settings.trim) {
    const b = contentBounds(cur);
    if (b && (b.w < cur.width || b.h < cur.height)) {
      const t = makeCanvas(b.w, b.h);
      t.getContext('2d').drawImage(cur, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      cur = t;
    }
  }
  const pad = Math.max(0, Math.min(20, Number(settings.padding) || 0)) * pixelScale;
  const maxW = (Number(settings.maxWidth) || 0) * pixelScale;
  if (maxW > 0 && cur.width + 2 * pad > maxW) {
    cur = scaleDown(cur, Math.max(1, Math.round(maxW - 2 * pad)));
  }
  if (pad > 0) {
    const p = Math.round(pad);
    const t = makeCanvas(cur.width + 2 * p, cur.height + 2 * p);
    const ctx = t.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, t.width, t.height);
    ctx.drawImage(cur, p, p);
    cur = t;
  }
  return cur;
}

export function toBlob(canvas, mime) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image. The crop may be too large.'))), mime, 0.92);
  });
}

export { makeCanvas };
