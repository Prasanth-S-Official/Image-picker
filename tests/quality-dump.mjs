// Crops sample diagrams with a preset and writes the saved files (and originals) to a folder for inspection.
// Usage: node tests/quality-dump.mjs <outDir> [presetName]

import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { DIAGRAMS as D, PHONE } from './make-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'quality-out');
const presetName = process.argv[3] || '';
fs.mkdirSync(out, { recursive: true });
const PORT = 5195;

const tilt = (d, ang, m = 3) => {
  const a = (ang * Math.PI) / 180;
  const pts = [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]].map(([x, y]) => [
    105 + (x - 105) * Math.cos(a) - (y - 148.5) * Math.sin(a), 148.5 + (x - 105) * Math.sin(a) + (y - 148.5) * Math.cos(a)]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
};

const server = spawn(process.execPath, ['server.js', String(PORT), '--no-open'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const MARK = '__test_opfs_images__';
    let handle = null;
    const ready = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('images', { create: true })).then((h) => { handle = h; return h; });
    window.showDirectoryPicker = () => ready;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) { return put.call(this, v && v.kind === 'directory' && v === handle ? MARK : v, k); };
    const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
    Object.defineProperty(IDBRequest.prototype, 'result', { get() { const v = desc.get.call(this); return v === MARK ? handle : v; } });
  });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/samples/`);
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((r) => { const q = indexedDB.deleteDatabase('diagram-cropper'); q.onsuccess = q.onerror = q.onblocked = r; });
    const rd = await navigator.storage.getDirectory();
    try { await rd.removeEntry('images', { recursive: true }); } catch { /* none */ }
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#setupDialog[open]');
  await page.click('#setupFolderBtn');
  await page.waitForFunction(() => document.querySelector('#setupFolderStatus').textContent.includes('images'));
  const jobs = [
    ['clean', 'sample-questions.pdf', 'c_incline', 1, D.q1, 0], ['clean', 'sample-questions.pdf', 'c_circuit', 1, D.q3, 0],
    ['clean', 'sample-questions.pdf', 'c_graph', 2, D.q4, 0], ['clean', 'sample-questions.pdf', 'c_pulley', 3, D.q7a, 0],
    ['phone', 'phone-questions.pdf', 'p_incline', 1, D.q1, PHONE[0].angle], ['phone', 'phone-questions.pdf', 'p_circuit', 1, D.q3, PHONE[0].angle],
    ['phone', 'phone-questions.pdf', 'p_pulley', 2, D.q7a, PHONE[1].angle], ['phone', 'phone-questions.pdf', 'p_prism', 2, D.q8, PHONE[1].angle],
  ];
  await page.fill('#pasteArea', jobs.map((j) => `${j[2]}.png`).join('\n'));
  await page.click('#checkPasteBtn');
  await page.click('#review >> text=Use these');
  await page.click('#startBtn');
  if (presetName) await page.selectOption('#presetSelect', { label: presetName });
  let current = '';
  for (const [, pdf, name, pg, d, ang] of jobs) {
    if (pdf !== current) {
      await page.setInputFiles('#pdfInput', path.join(root, 'samples', pdf));
      await page.waitForFunction((n) => window.__dc.state.currentPdf === n, pdf);
      await page.waitForSelector('.pdf-page[data-page="1"] canvas');
      current = pdf;
    }
    const [x0, y0, x1, y1] = tilt(d, ang);
    await page.evaluate(({ pg, x0, y0, x1, y1 }) => {
      const v = window.__dc.viewer;
      const p = v.pages[pg - 1];
      const k = 72 / 25.4;
      v.setBox({ x0: p.left + x0 * k, y0: p.top + y0 * k, x1: p.left + x1 * k, y1: p.top + y1 * k });
    }, { pg, x0, y0, x1, y1 });
    await page.evaluate(() => document.getElementById('approveBtn').click());
    await page.waitForFunction((n) => window.__dc.state.items.find((i) => i.name === n)?.status === 'done', `${name}.png`, { timeout: 20000 });
  }
  const files = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('images');
    const res = {};
    for await (const [n, h] of dir.entries()) {
      const b = new Uint8Array(await (await h.getFile()).arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      res[n] = btoa(s);
    }
    await new Promise((r) => setTimeout(r, 800)); // originals are stored in the background
    const db = await new Promise((r) => { const q = indexedDB.open('diagram-cropper', 1); q.onsuccess = () => r(q.result); });
    const keys = await new Promise((r) => { const g = db.transaction('kv').objectStore('kv').getAllKeys(); g.onsuccess = () => r(g.result); });
    for (const k of keys.filter((x) => String(x).startsWith('orig:'))) {
      const blob = await new Promise((r) => { const g = db.transaction('kv').objectStore('kv').get(k); g.onsuccess = () => r(g.result); });
      const b = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      res[`ORIG_${String(k).slice(5)}`] = btoa(s);
    }
    return res;
  });
  for (const [n, b64] of Object.entries(files)) fs.writeFileSync(path.join(out, n), Buffer.from(b64, 'base64'));
  console.log(`Wrote ${Object.keys(files).length} files to ${out}`);
} finally {
  await browser.close();
  server.kill();
}
