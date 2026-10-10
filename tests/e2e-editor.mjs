// Browser test for image editing and enhancement, using the phone-captured sample PDF.
// Usage: node tests/e2e-editor.mjs   (HEADED=1 to watch, PW_CHANNEL=chrome for Chrome)

import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import assert from 'assert/strict';
import { DIAGRAMS as D, PHONE } from './make-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
const URL = `http://localhost:${PORT}/`;
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'dc-editor-'));
const PDF = path.join(root, 'samples', 'phone-questions.pdf');

let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

async function waitFor(fn, what, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last})`);
}

/** Diagram rectangle (mm) on a phone page, after that page's tilt, with a margin. */
function tilted(d, phonePage, m = 3) {
  const a = (PHONE[phonePage - 1].angle * Math.PI) / 180;
  const cx = 105, cy = 148.5;
  const pts = [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]].map(([x, y]) => [
    cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  ]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [{ page: phonePage, x: Math.min(...xs) - m, y: Math.min(...ys) - m }, { page: phonePage, x: Math.max(...xs) + m, y: Math.max(...ys) + m }];
}

async function main() {
  if (!fs.existsSync(PDF)) throw new Error('Run "node tests/make-samples.mjs" first.');
  const server = spawn(process.execPath, ['server.js', String(PORT), '--no-open'], { cwd: root, stdio: 'ignore' });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: !process.env.HEADED });
  try {
    await waitFor(() => fetch(URL).then((r) => r.ok), 'server');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await context.addInitScript(() => {
      // Folder picker stand-in (see e2e.mjs for why the handle is swapped for a marker in IndexedDB)
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
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
    page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Test BW') : d.accept()));

    // ---- helpers
    /** Pixel statistics of a saved file: white share, dark share, grey (in-between) share, darkest value. */
    const fileStats = (name) => page.evaluate(async (n) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('images');
      const f = await (await dir.getFileHandle(n)).getFile();
      const bmp = await createImageBitmap(f);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let white = 0, dark = 0, grey = 0, min = 255;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        if (l >= 250) white++; else if (l < 90) dark++; else grey++;
        if (l < min) min = l;
      }
      const n2 = d.length / 4;
      return { w: c.width, h: c.height, size: f.size, white: white / n2, dark: dark / n2, grey: grey / n2, min, modified: f.lastModified };
    }, name);
    /** Median brightness of the stored original crop (to prove the page was not white to begin with). */
    const originalMedian = (name) => page.evaluate(async (n) => {
      const db = await new Promise((r) => { const q = indexedDB.open('diagram-cropper', 1); q.onsuccess = () => r(q.result); });
      const blob = await new Promise((r) => { const g = db.transaction('kv').objectStore('kv').get(`orig:${n}`); g.onsuccess = () => r(g.result); });
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const L = [];
      for (let i = 0; i < d.length; i += 16) L.push((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8);
      L.sort((a, b) => a - b);
      return L[Math.floor(L.length / 2)];
    }, name);
    const fileNames = () => page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('images', { create: true });
      const out = [];
      for await (const [n] of dir.entries()) out.push(n);
      return out.sort();
    });
    const item = (name) => page.evaluate((n) => JSON.parse(JSON.stringify(window.__dc.state.items.find((i) => i.name === n))), name);
    const active = () => page.locator('#activeName').textContent();
    const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
    async function drag([a, b]) {
      await page.evaluate(({ pg, y }) => { const v = window.__dc.viewer; v.scrollToY(v.pages[pg - 1].top + (y * 72) / 25.4 - 70); }, { pg: a.page, y: a.y });
      await page.waitForTimeout(400);
      const bb = await page.locator(`.pdf-page[data-page="${a.page}"]`).boundingBox();
      const mm = bb.width / 210;
      await page.mouse.move(bb.x + a.x * mm, bb.y + a.y * mm);
      await page.mouse.down();
      await page.mouse.move(bb.x + b.x * mm, bb.y + b.y * mm, { steps: 10 });
      await page.mouse.up();
      await page.waitForSelector('#cropPanel:not([hidden])');
    }
    /** Drag on the editor image, in fractions of its size. */
    async function edDrag(fx0, fy0, fx1, fy1) {
      const bb = await page.locator('#edOverlay').boundingBox();
      await page.mouse.move(bb.x + bb.width * fx0, bb.y + bb.height * fy0);
      await page.mouse.down();
      await page.mouse.move(bb.x + bb.width * fx1, bb.y + bb.height * fy1, { steps: 8 });
      await page.mouse.up();
    }
    const finalInfo = async () => {
      await waitFor(async () => /Final image: \d+/.test(await page.locator('#edInfo').textContent()), 'final size');
      const t = await page.locator('#edInfo').textContent();
      const m = t.match(/(\d+) × (\d+) px · ([\d.]+) (KB|MB)/);
      return { w: Number(m[1]), h: Number(m[2]), text: t };
    };

    // ---- setup: folder, names, phone PDF
    await page.goto(`${URL}samples/`);
    await page.evaluate(async () => {
      localStorage.clear();
      await new Promise((r) => { const q = indexedDB.deleteDatabase('diagram-cropper'); q.onsuccess = q.onerror = q.onblocked = r; });
      const rootDir = await navigator.storage.getDirectory();
      try { await rootDir.removeEntry('images', { recursive: true }); } catch { /* none */ }
    });
    await page.goto(URL);
    await page.waitForSelector('#setupDialog[open]');
    await page.click('#setupFolderBtn');
    await waitFor(async () => (await page.locator('#setupFolderStatus').textContent()).includes('images'), 'folder');
    await page.fill('#pasteArea', 'incline.png\npulley.png\ncircuit.png\nprism.png\nmolecule.png');
    await page.click('#checkPasteBtn');
    await page.click('#review >> text=Use these 5 names');
    await page.setInputFiles('#pdfInput', PDF);
    await page.waitForSelector('.pdf-page[data-page="1"] canvas');
    await page.click('#startBtn');
    assert.equal(await page.locator('#presetSelect option:checked').textContent(), 'Phone photo - clean (default)');
    log('Phone PDF open; default preset is "Phone photo - clean"');
    await shot('01-phone-pdf');

    // ---- 1. fast path: crop and Approve straight away
    await drag(tilted(D.q1, 1));
    await page.waitForTimeout(800); // let the cleaned-up preview arrive
    await shot('02-panel-preview');
    assert.ok(await page.locator('#cpWarn').isHidden(), `no false warnings on a good phone crop: ${await page.locator('#cpWarn').textContent()}`);
    await page.click('#approveBtn');
    await waitFor(async () => (await fileNames()).includes('incline.png'), 'incline.png');
    let st = await fileStats('incline.png');
    const med = await waitFor(() => originalMedian('incline.png'), 'original stored');
    console.log(`      incline.png ${st.w}x${st.h}: white ${(st.white * 100).toFixed(1)}%, grey ${(st.grey * 100).toFixed(1)}%, darkest ${st.min}; original paper median ${med}`);
    assert.ok(med < 235, `original crop has grey/yellow paper (median ${med})`);
    assert.ok(st.white > 0.55, `default preset gives a white background (${st.white})`);
    assert.ok(st.min < 70, 'lines stay dark');
    const it1 = await item('incline.png');
    assert.ok(!it1.warnings.includes('blurry'), `not flagged as blurry: ${it1.warnings}`);
    assert.equal(await active(), 'pulley.png');
    log(`Fast path: Approve without the editor -> white background (${(st.white * 100).toFixed(0)}% white, paper was ${med}/255), dark sharp lines`);

    // ---- 2. erase a stray piece of the neighbouring diagram
    const [a7, a7b] = tilted(D.q7a, 2);
    const [b7a, b7] = tilted({ ...D.q7b, w: 22 }, 2); // includes the left part of the molecule
    await drag([{ ...a7, y: Math.min(a7.y, b7a.y) }, { ...b7, y: Math.max(a7b.y, b7.y) }]);
    await page.click('#editBtn');
    await page.waitForSelector('#editorDialog[open]');
    await waitFor(async () => !(await page.locator('#edInfo').textContent()).includes('measuring'), 'first measure');
    const before = await finalInfo();
    await shot('03-editor-before-erase');
    await page.click('[data-tool="eraseBox"]');
    await edDrag(0.74, 0.0, 1.0, 1.0);
    await waitFor(async () => (await page.evaluate(() => 1)) && (await page.locator('#edInfo').textContent()) !== before.text, 'size changes');
    const after = await finalInfo();
    console.log(`      pulley.png before erase ${before.w}x${before.h}, after ${after.w}x${after.h}; ${await page.locator('#edSpeed').textContent()}`);
    assert.ok(after.w < before.w * 0.88, 'stray part removed, so the trimmed image is narrower');
    // undo / redo keep working
    await page.keyboard.press('Control+z');
    await waitFor(async () => (await finalInfo()).w === before.w, 'undo restores');
    await page.keyboard.press('Control+y');
    await waitFor(async () => (await finalInfo()).w === after.w, 'redo re-applies');
    await page.click('[data-compare="split"]');
    await page.waitForTimeout(400);
    await shot('04-editor-split');
    await page.click('[data-compare="split"]');
    await page.click('#edApprove');
    await waitFor(async () => (await fileNames()).includes('pulley.png'), 'pulley.png');
    st = await fileStats('pulley.png');
    assert.equal(st.w, after.w);
    const it2 = await item('pulley.png');
    assert.equal(it2.edit.ops.length, 1);
    assert.equal(it2.edit.ops[0].t, 'erasePoly');
    assert.equal(await active(), 'circuit.png');
    log(`Editor: erase box removed the stray molecule part (width ${before.w} -> ${after.w} px); Ctrl+Z / Ctrl+Y work; saved`);

    // ---- 3. fix the tilt with Auto deskew
    await drag(tilted(D.q3, 1, 4));
    await page.dblclick('#cpCanvas');
    await page.waitForSelector('#editorDialog[open]');
    await page.click('#edDeskew');
    await waitFor(async () => /Tilt fixed by/.test(await page.locator('#edDeskewInfo').textContent()), 'deskew');
    const deskewText = await page.locator('#edDeskewInfo').textContent();
    await page.waitForTimeout(500);
    await shot('05-editor-deskew');
    await page.click('#edApprove');
    await waitFor(async () => (await fileNames()).includes('circuit.png'), 'circuit.png');
    const it3 = await item('circuit.png');
    console.log(`      ${deskewText}; stored angle ${it3.edit.geom.deskew}`);
    assert.ok(Math.abs(it3.edit.geom.deskew - -PHONE[0].angle) < 0.8, `deskew angle ${it3.edit.geom.deskew} undoes the ${PHONE[0].angle}° tilt`);
    assert.equal(await active(), 'prism.png');
    log(`Auto deskew found ${it3.edit.geom.deskew}° for a page tilted by +${PHONE[0].angle}°; saved circuit.png`);

    // ---- 4. new preset, and apply it to all remaining images
    await page.click('#settingsBtn');
    await page.waitForSelector('#settingsDialog[open]');
    await page.click('#presetList li:has-text("Text-heavy")');
    await page.click('#pSaveAs'); // prompt answers "Test BW"
    await waitFor(async () => (await page.locator('#presetList li.sel').textContent()).includes('Test BW'), 'new preset');
    await shot('06-settings-page');
    await page.click('#settingsDialog [data-close]');
    await drag(tilted(D.q8, 2));
    await page.click('#editBtn');
    await page.waitForSelector('#editorDialog[open]');
    await page.selectOption('#edPreset', { label: 'Test BW' });
    await page.click('#edApplyRemaining');
    await waitFor(async () => (await item('molecule.png')).edit?.assigned, 'remaining assigned');
    const mol = await item('molecule.png');
    const testId = await page.evaluate(() => window.__dc.state.customPresets.find((p) => p.name === 'Test BW').id);
    assert.equal(mol.edit.presetId, testId);
    await page.click('#edApprove');
    await waitFor(async () => (await fileNames()).includes('prism.png'), 'prism.png');
    st = await fileStats('prism.png');
    assert.ok(st.grey < 0.03, `prism.png is black and white (${st.grey})`);
    log('Created preset "Test BW", applied it to all remaining images, prism.png saved in black and white');

    // ---- 5. re-process two Done images with the new preset
    const beforeRe = { incline: await fileStats('incline.png'), circuit: await fileStats('circuit.png') };
    await page.click('#reviewBtn');
    await page.waitForSelector('#reviewDialog[open]');
    await page.locator('#gallery .card:has-text("incline.png") .csel').check();
    await page.locator('#gallery .card:has-text("circuit.png") .csel').check();
    assert.equal(await page.locator('#gSelCount').textContent(), '2 selected');
    await page.selectOption('#gPreset', { label: 'Test BW' });
    await page.click('#gReprocess');
    await page.waitForSelector('#confirmDialog[open]');
    await page.click('#confirmOk');
    await waitFor(async () => (await item('incline.png')).edit.presetId === testId && (await item('circuit.png')).edit.presetId === testId, 'reprocessed');
    await waitFor(async () => (await fileStats('circuit.png')).modified !== beforeRe.circuit.modified, 'file rewritten');
    await shot('07-gallery');
    const afterRe = { incline: await fileStats('incline.png'), circuit: await fileStats('circuit.png') };
    for (const k of ['incline', 'circuit']) {
      console.log(`      ${k}.png grey ${(beforeRe[k].grey * 100).toFixed(1)}% -> ${(afterRe[k].grey * 100).toFixed(1)}%, ${beforeRe[k].size} -> ${afterRe[k].size} bytes`);
      assert.ok(afterRe[k].grey < 0.03, `${k} is now black and white`);
      assert.notEqual(afterRe[k].size, beforeRe[k].size);
    }
    assert.ok(Math.abs((await item('circuit.png')).edit.geom.deskew - it3.edit.geom.deskew) < 1e-9, 'manual deskew kept when re-processing');
    assert.deepEqual(await fileNames(), ['circuit.png', 'incline.png', 'prism.png', 'pulley.png']);
    log('Re-processed incline.png and circuit.png from their originals: files updated in place, same names, tilt fix kept');

    // ---- every tool and control, on a saved image (opened from the gallery), then closed without saving
    await page.locator('#gallery .card:has-text("pulley.png") .ci').click();
    await page.waitForSelector('#editorDialog[open]');
    await finalInfo();
    const ops = () => page.evaluate(() => window.__dc.editor.doc.ops.map((o) => o.t));
    const geom = () => page.evaluate(() => window.__dc.editor.doc.geom);
    const path3 = async (pts) => {
      const bb = await page.locator('#edOverlay').boundingBox();
      await page.mouse.move(bb.x + bb.width * pts[0][0], bb.y + bb.height * pts[0][1]);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) await page.mouse.move(bb.x + bb.width * x, bb.y + bb.height * y, { steps: 4 });
      await page.mouse.up();
    };
    const tri = [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3], [0.12, 0.25]];
    await page.click('[data-tool="erase"]');
    await edDrag(0.05, 0.9, 0.25, 0.92);
    await page.click('[data-tool="lasso"]');
    await path3(tri);
    await page.click('[data-tool="protect"]');
    await path3(tri.map(([x, y]) => [x + 0.3, y + 0.3]));
    await page.click('[data-tool="clone"]');
    await path3([[0.9, 0.9]]); // pick the copy-from point
    await edDrag(0.5, 0.1, 0.6, 0.12);
    await page.click('[data-tool="keep"]');
    await path3([[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]);
    assert.deepEqual(await ops(), ['erasePoly', 'erase', 'erasePoly', 'protect', 'clone', 'keep']);
    await page.click('[data-tool="crop"]');
    await page.waitForTimeout(300);
    await edDrag(0.0, 0.0, 0.05, 0.05); // drag the top-left handle in
    await page.keyboard.press('ArrowRight');
    const cr = (await geom()).crop;
    assert.ok(cr && cr.x0 > 0.04 && cr.y0 > 0.04, `fine crop set: ${JSON.stringify(cr)}`);
    await page.click('#edCropDone');
    await page.click('[data-tool="persp"]');
    await page.click('#edPerspApply');
    assert.ok((await geom()).persp, 'perspective set');
    await page.click('#edRotR');
    await page.click('#edFlipH');
    await page.locator('#edAngle').evaluate((el) => { el.value = '4.5'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
    const g = await geom();
    assert.deepEqual([g.rot90, g.flipH, g.angle], [90, true, 4.5]);
    for (const m of ['original', 'gray', 'bw', 'lineart', 'color']) await page.click(`#edSettings [data-mode="${m}"]`);
    await page.locator('#edSettings select').nth(2).selectOption('png8');
    await page.locator('#edSettings .sl-reset').first().click();
    await page.click('#edHold', { delay: 300 });
    await page.click('[data-compare="side"]');
    await page.waitForTimeout(400);
    await shot('08-editor-all-tools');
    await page.click('[data-compare="side"]');
    const info = await finalInfo();
    assert.match(info.text, /PNG-8/);
    const ms = await page.locator('#edSpeed').textContent();
    for (let k = 0; k < 6; k++) await page.click('#edUndo');
    for (let k = 0; k < 6; k++) await page.click('#edRedo');
    await page.click('#edBack');
    await waitFor(() => page.locator('#editorDialog').evaluate((d) => !d.open), 'editor closed');
    assert.equal((await item('pulley.png')).edit.ops.length, 1, 'closing without saving keeps the saved edit');
    log(`Smoke test of every tool, mode, compare view and output format in the editor (${ms}); closing without saving keeps the file`);
    await page.click('#reviewDialog [data-close]');

    // ---- 6. refresh: settings and presets come back
    await page.selectOption('#presetSelect', { label: 'Test BW' });
    await page.reload();
    await page.waitForSelector('.pdf-page[data-page="1"]');
    assert.equal(await page.locator('#presetSelect option:checked').textContent(), 'Test BW');
    const restored = await page.evaluate(() => ({
      presets: window.__dc.state.customPresets.map((p) => [p.name, p.settings.mode, p.settings.format]),
      mol: window.__dc.state.items.find((i) => i.name === 'molecule.png').edit,
      origs: Object.keys(window.__dc.state.origSizes).sort(),
    }));
    assert.deepEqual(restored.presets, [['Test BW', 'bw', 'png8']]);
    assert.equal(restored.mol.presetId, testId);
    assert.deepEqual(restored.origs, ['circuit.png', 'incline.png', 'prism.png', 'pulley.png']);
    await page.click('#settingsBtn');
    assert.match(await page.locator('#origUsage').textContent(), /4 original crops stored/);
    await page.click('#settingsDialog [data-close]');
    log('After refresh: custom preset, preset in use, per-image settings and 4 stored originals restored');

    // ---- 7. settings export / import round trip
    await page.click('#settingsBtn');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#setExport')]);
    const exported = path.join(shots, dl.suggestedFilename());
    await dl.saveAs(exported);
    const json = JSON.parse(fs.readFileSync(exported, 'utf8'));
    assert.equal(json.presets[0].name, 'Test BW');
    await page.setInputFiles('#settingsInput', exported);
    await waitFor(async () => (await page.evaluate(() => window.__dc.state.customPresets.length)) === 1, 'import (no duplicates)');
    log('Settings exported to JSON and imported back');

    assert.deepEqual(errors, [], `no console errors: ${errors.join('\n')}`);
    console.log(`\nAll editor checks passed. Screenshots: ${shots}`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('\nEDITOR E2E FAILED:', e); process.exit(1); });
