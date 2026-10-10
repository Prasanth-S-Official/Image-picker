// Image quality checks on synthetic diagrams with known answers. Runs in Node (no browser).
// Usage: node tests/unit-quality.mjs

import assert from 'assert/strict';
import * as P from '../js/pipeline.js';
import { BUILT_IN } from '../js/presets.js';

const W = 900, H = 600;
const phone = BUILT_IN.find((p) => p.id === 'phone').settings;

/** Clean digital diagram: white paper, black frame and diagonal, light blue fill, orange block. */
function cleanDiagram() {
  const img = P.newImg(W, H);
  const set = (x, y, r, g, b) => { const i = (y * W + x) * 4; img.d[i] = r; img.d[i + 1] = g; img.d[i + 2] = b; };
  for (let y = 150; y < 500; y++) for (let x = 150; x < 750; x++) set(x, y, 221, 232, 245); // light blue fill
  for (let y = 250; y < 330; y++) for (let x = 380; x < 500; x++) set(x, y, 244, 177, 131); // orange block
  for (let x = 100; x < 800; x++) for (let t = 0; t < 5; t++) { set(x, 100 + t, 17, 34, 51); set(x, 540 + t, 17, 34, 51); }
  for (let y = 100; y < 545; y++) for (let t = 0; t < 5; t++) { set(100 + t, y, 17, 34, 51); set(795 + t, y, 17, 34, 51); }
  return img;
}

/** The same diagram "photographed": yellow paper, a shadow across it, and camera grain. */
function phoneVersion(src, sigma = 8, seed = 7) {
  const img = P.copyImg(src);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const light = 0.62 + 0.3 * (x / W) * 0.6 + 0.3 * (y / H) * 0.4; // darker top-left
      const paper = [232, 223, 196];
      for (let c = 0; c < 3; c++) img.d[i + c] = (src.d[i + c] / 255) * paper[c] * light + gauss() * sigma;
    }
  }
  return img;
}

const px = (img, x, y) => { const i = (y * img.w + x) * 4; return [img.d[i], img.d[i + 1], img.d[i + 2]]; };
const lum = ([r, g, b]) => (r * 77 + g * 150 + b * 29) / 256;
function regionStats(img, x0, y0, x1, y1) {
  let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const p = px(img, x, y);
    const l = lum(p);
    n++; sr += p[0]; sg += p[1]; sb += p[2]; sl += l; sl2 += l * l;
  }
  const m = sl / n;
  return { r: sr / n, g: sg / n, b: sb / n, lum: m, sd: Math.sqrt(Math.max(0, sl2 / n - m * m)) };
}

let count = 0;
const t = (name, fn) => { fn(); count++; console.log(`  ok  ${name}`); };

const clean = cleanDiagram();
const noisy = phoneVersion(clean);

t('grain is measured correctly (per-channel sigma 8 -> brightness grain about 5.4)', () => {
  const s = P.noiseSigma(noisy);
  assert.ok(s > 4.3 && s < 6.8, `measured ${s.toFixed(2)}`);
  assert.ok(P.noiseSigma(clean) < 0.5);
});

t('clean digital crops are recognised and left exactly as they are', () => {
  assert.equal(P.isCleanSource(clean), true);
  assert.equal(P.isCleanSource(noisy), false);
  const out = P.processAppearance(clean, phone, 1, null);
  let maxDiff = 0;
  for (let i = 0; i < out.d.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out.d[i] - clean.d[i]));
  assert.equal(maxDiff, 0, 'no pixel changed');
});

const t0 = Date.now();
const out = P.processAppearance(noisy, phone, 1, null);
const ms = Date.now() - t0;

t('phone photo: paper becomes pure, even white (shadow and yellow removed)', () => {
  for (const [x0, y0] of [[10, 10], [820, 20], [20, 560], [830, 560], [450, 570]]) {
    const r = regionStats(out, x0, y0, x0 + 40, y0 + 20);
    assert.ok(r.lum >= 252, `paper at ${x0},${y0}: ${r.lum.toFixed(1)}`);
    assert.ok(r.sd < 3, `paper grain at ${x0},${y0}: sd ${r.sd.toFixed(2)}`);
  }
});

t('phone photo: light blue fill is kept (not washed to white)', () => {
  const f = regionStats(out, 200, 380, 350, 480);
  assert.ok(f.b - f.r >= 12, `fill blue tint ${(f.b - f.r).toFixed(1)} (original 24)`);
  assert.ok(f.lum < 248, `fill still visible: ${f.lum.toFixed(1)}`);
});

t('phone photo: grain inside the fill is strongly reduced', () => {
  // grain relative to brightness (the photo's fill is darker, and brightening scales grain too)
  const rb = regionStats(noisy, 600, 200, 720, 320);
  const ra = regionStats(out, 600, 200, 720, 320);
  const before = rb.sd / rb.lum, after = ra.sd / ra.lum;
  assert.ok(after < before * 0.45, `relative grain ${(before * 100).toFixed(2)}% -> ${(after * 100).toFixed(2)}%`);
});

t('phone photo: lines are dark and neutral, orange keeps its colour', () => {
  const line = regionStats(out, 300, 101, 600, 104);
  assert.ok(line.lum < 70, `line brightness ${line.lum.toFixed(1)}`);
  const o = regionStats(out, 400, 265, 480, 315);
  assert.ok(o.r - o.b > 70, `orange stays orange (r-b ${(o.r - o.b).toFixed(1)})`);
});

t('phone photo: line edges are clean and straight (no wobble from grain)', () => {
  // the top line starts at row 100: its edge should be found at the same row in almost every column
  const rows = {};
  for (let x = 200; x < 700; x += 2) {
    let y = 90;
    while (y < 110 && lum(px(out, x, y)) >= 128) y++;
    rows[y] = (rows[y] || 0) + 1;
  }
  const most = Math.max(...Object.values(rows));
  assert.ok(most / 250 >= 0.95, `edge rows: ${JSON.stringify(rows)}`);
  assert.ok(regionStats(out, 200, 80, 700, 94).lum >= 250, 'paper right above the line is white');
});

console.log(`${count} quality tests passed (phone clean-up of ${W}x${H} took ${ms} ms)`);
