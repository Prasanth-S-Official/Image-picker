// Browser test for "click a diagram to select it" on the clean and the phone-captured sample PDFs.
// Usage: node tests/e2e-click.mjs   (HEADED=1 to watch)

import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import assert from 'assert/strict';
import { DIAGRAMS as D, PHONE } from './make-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5196;
const URL = `http://localhost:${PORT}/`;
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'dc-click-'));

let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

async function waitFor(fn, what, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last})`);
}

/** Rectangle after a page tilt (for the phone PDF). */
function tiltRect(d, angle) {
  const a = (angle * Math.PI) / 180;
  const cx = 105, cy = 148.5;
  const pts = [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]].map(([x, y]) => [
    cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

async function main() {
  const server = spawn(process.execPath, ['server.js', String(PORT), '--no-open'], { cwd: root, stdio: 'ignore' });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: !process.env.HEADED });
  try {
    await waitFor(() => fetch(URL).then((r) => r.ok), 'server');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      const MARK = '__test_opfs_images__';
      let handle = null;
      const ready = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('images', { create: true })).then((h) => { handle = h; return h; });
      window.showDirectoryPicker = () => ready;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) { return put.call(this, value && value.kind === 'directory' && value === handle ? MARK : value, key); };
      const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
      Object.defineProperty(IDBRequest.prototype, 'result', { get() { const v = desc.get.call(this); return v === MARK ? handle : v; } });
    });
    const page = await context.newPage();
    const errors = [];
    const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });

    await page.goto(`${URL}samples/`);
    await page.evaluate(async () => {
      localStorage.clear();
      localStorage.setItem('diagram-cropper-state-v1', JSON.stringify({ settings: { autoName: false } })); // these tests use a names list
      await new Promise((r) => { const q = indexedDB.deleteDatabase('diagram-cropper'); q.onsuccess = q.onerror = q.onblocked = r; });
      const rootDir = await navigator.storage.getDirectory();
      try { await rootDir.removeEntry('images', { recursive: true }); } catch { /* none */ }
    });
    await page.goto(URL);
    await page.waitForSelector('#setupDialog[open]');
    await page.click('#setupFolderBtn');
    await waitFor(async () => (await page.locator('#setupFolderStatus').textContent()).includes('images'), 'folder');
    await page.fill('#pasteArea', 'click1.png\nclick2.png');
    await page.click('#checkPasteBtn');
    await page.click('#review >> text=Use these 2 names');

    /** Click at (x, y) mm on a page; returns the box in page mm, or null. */
    async function clickAt(pg, x, y) {
      await page.keyboard.press('Escape');
      await page.evaluate(({ pg, y }) => { const v = window.__dc.viewer; v.scrollToY(v.pages[pg - 1].top + (y * 72) / 25.4 - 250); }, { pg, y });
      await page.waitForTimeout(250);
      const bb = await page.locator(`.pdf-page[data-page="${pg}"]`).boundingBox();
      const mm = bb.width / 210;
      await page.mouse.click(bb.x + x * mm, bb.y + y * mm);
      await page.waitForTimeout(100);
      await waitFor(() => page.evaluate(() => !document.querySelector('.pdf-scroller').classList.contains('finding')), 'detection');
      return page.evaluate((pg) => {
        const v = window.__dc.viewer;
        const b = v.box;
        if (!b) return null;
        const p = v.pages[pg - 1];
        const k = 25.4 / 72;
        return { x0: (b.x0 - p.left) * k, y0: (b.y0 - p.top) * k, x1: (b.x1 - p.left) * k, y1: (b.y1 - p.top) * k };
      }, pg);
    }

    /** Real ink bounds (mm) of a diagram slot on the clean PDF (the drawings do not fill their slots). */
    async function inkMm(pg, d) {
      return page.evaluate(async ({ pg, d }) => {
        const v = window.__dc.viewer;
        const s = 2;
        const id = await v.pageImageData(pg - 1, s);
        const k = (72 / 25.4) * s;
        const X0 = Math.round(d.x * k), Y0 = Math.round(d.y * k), X1 = Math.round((d.x + d.w) * k), Y1 = Math.round((d.y + d.h) * k);
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = Y0; y < Y1; y++) {
          for (let x = X0; x < X1; x++) {
            const i = (y * id.width + x) * 4;
            if (id.data[i] < 200 || id.data[i + 1] < 200 || id.data[i + 2] < 200) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          }
        }
        return { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k };
      }, { pg, d });
    }

    /** The box must sit around the diagram: not more than `slack` mm outside it, and cover most of it. */
    function check(name, box, d, slack = 3, cover = 0.6) {
      assert.ok(box, `${name}: a box was found`);
      const f = (v) => v.toFixed(1);
      const where = `${name}: box ${f(box.x0)},${f(box.y0)} - ${f(box.x1)},${f(box.y1)} vs diagram ${f(d.x)},${f(d.y)} - ${f(d.x + d.w)},${f(d.y + d.h)}`;
      assert.ok(box.x0 >= d.x - slack && box.y0 >= d.y - slack && box.x1 <= d.x + d.w + slack && box.y1 <= d.y + d.h + slack, `${where} (too big: includes something else)`);
      assert.ok(box.x1 - box.x0 >= d.w * cover && box.y1 - box.y0 >= d.h * cover, `${where} (too small)`);
      return where;
    }

    // ---- clean PDF
    await page.setInputFiles('#pdfInput', path.join(root, 'samples', 'sample-questions.pdf'));
    await page.waitForSelector('.pdf-page[data-page="1"] canvas');
    await page.click('#startBtn');
    const clean = [
      ['incline (click on a line)', 1, D.q1, D.q1.x + D.q1.w * 0.5, D.q1.y + D.q1.h * 0.83],
      ['circuit (click inside the loop)', 1, D.q3, D.q3.x + D.q3.w * 0.5, D.q3.y + D.q3.h * 0.5],
      ['graph', 2, D.q4, D.q4.x + D.q4.w * 0.45, D.q4.y + D.q4.h * 0.5],
      ['lens', 2, D.q5, D.q5.x + D.q5.w * 0.5, D.q5.y + D.q5.h * 0.5],
      ['pulley (next to another diagram)', 3, D.q7a, D.q7a.x + D.q7a.w * 0.35, D.q7a.y + D.q7a.h * 0.5],
      ['molecule (next to another diagram)', 3, D.q7b, D.q7b.x + D.q7b.w * 0.5, D.q7b.y + D.q7b.h * 0.3],
      ['prism', 3, D.q8, D.q8.x + D.q8.w * 0.5, D.q8.y + D.q8.h * 0.6],
    ];
    const ink = {};
    for (const [name, pg, d] of clean) ink[name] = await inkMm(pg, d);
    const t0 = Date.now();
    for (const [name, pg, , x, y] of clean) {
      const box = await clickAt(pg, x, y);
      console.log(`      ${check(name, box, ink[name], 3, 0.85)}`);
    }
    log(`Clean PDF: one click selects each of ${clean.length} diagrams, without text or the neighbouring diagram (${Math.round((Date.now() - t0) / clean.length)} ms per click incl. scrolling)`);
    await clickAt(3, D.q8.x + D.q8.w * 0.5, D.q8.y + D.q8.h * 0.6);
    await shot('01-clean-click');

    // clicking empty paper: no box, just a hint
    let none = await clickAt(1, 150, 125);
    assert.equal(none, null, 'no box on empty paper');
    assert.match(await page.locator('#toasts').textContent(), /drag a box/);
    log('Clicking empty paper selects nothing and says "drag a box instead"');

    // click then Enter saves (the full fast path)
    await clickAt(1, D.q3.x + D.q3.w * 0.5, D.q3.y + D.q3.h * 0.5);
    await page.waitForSelector('#cropPanel:not([hidden])');
    await page.keyboard.press('Enter');
    await waitFor(() => page.evaluate(() => window.__dc.state.items[0].status === 'done'), 'saved');
    assert.equal(await page.locator('#activeName').textContent(), 'click2.png');
    log('Click + Enter saved click1.png and moved to the next name');

    // ---- phone PDF (grey paper, shadows, tilt)
    await page.setInputFiles('#pdfInput', path.join(root, 'samples', 'phone-questions.pdf'));
    await waitFor(() => page.evaluate(() => window.__dc.state.currentPdf === 'phone-questions.pdf'), 'phone pdf');
    await page.waitForSelector('.pdf-page[data-page="1"] canvas');
    const phone = [
      ['incline', 1, D.q1, 0.5, 0.83, 'incline (click on a line)'], ['circuit', 1, D.q3, 0.5, 0.5, 'circuit (click inside the loop)'],
      ['pulley', 2, D.q7a, 0.35, 0.5, 'pulley (next to another diagram)'], ['molecule', 2, D.q7b, 0.5, 0.3, 'molecule (next to another diagram)'],
      ['prism', 2, D.q8, 0.5, 0.6, 'prism'],
    ];
    for (const [name, pg, d0, fx, fy, cleanName] of phone) {
      const ang = PHONE[pg - 1].angle;
      const d = tiltRect(ink[cleanName], ang);
      // click point: the same spot of the diagram, after the tilt
      const a = (ang * Math.PI) / 180;
      const px = d0.x + d0.w * fx, py = d0.y + d0.h * fy;
      const x = 105 + (px - 105) * Math.cos(a) - (py - 148.5) * Math.sin(a);
      const y = 148.5 + (px - 105) * Math.sin(a) + (py - 148.5) * Math.cos(a);
      const box = await clickAt(pg, x, y);
      console.log(`      ${check(`phone ${name}`, box, d, 4, 0.85)}`);
    }
    await clickAt(1, 105 + (D.q3.x + D.q3.w / 2 - 105), D.q3.y + D.q3.h / 2 + 3);
    await shot('02-phone-click');
    log(`Phone PDF (grey paper, shadows, tilt): one click selects each of ${phone.length} diagrams`);

    assert.deepEqual(errors, [], `no console errors: ${errors.join('\n')}`);
    console.log(`\nAll click-to-crop checks passed. Screenshots: ${shots}`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('\nCLICK E2E FAILED:', e); process.exit(1); });
