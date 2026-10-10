// End-to-end test in a real browser (Edge or Chrome via playwright-core).
// The folder picker cannot be clicked by a script, so showDirectoryPicker is pointed at a
// folder in the browser's private file system (same File System Access API, same code path).
//
// Usage: node tests/e2e.mjs            (set HEADED=1 to watch, PW_CHANNEL=chrome to use Chrome)

import { chromium } from 'playwright-core';
import XLSX from 'xlsx';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import assert from 'assert/strict';
import { DIAGRAMS as D } from './make-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const URL = `http://localhost:${PORT}/`;
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'dc-shots-'));
const PDF = path.join(root, 'samples', 'sample-questions.pdf');
const XLSX_FILE = path.join(root, 'samples', 'sample-questions.xlsx');

let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

async function waitFor(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last})`);
}

async function main() {
  if (!fs.existsSync(PDF)) throw new Error('Run "node tests/make-samples.mjs" first.');
  const server = spawn(process.execPath, ['server.js', String(PORT), '--no-open'], { cwd: root, stdio: 'ignore' });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: !process.env.HEADED });
  try {
    await waitFor(() => fetch(URL).then((r) => r.ok), 'server');
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
    await context.addInitScript(() => {
      // Test stand-in for the folder picker: a folder in the browser's private file system.
      // Chromium crashes when an OPFS handle is read back from IndexedDB after a reload (a browser bug
      // that does not affect real folders), so the stub stores a marker and swaps the handle back in.
      const MARK = '__test_opfs_images__';
      let handle = null;
      const ready = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('images', { create: true })).then((h) => { handle = h; return h; });
      window.showDirectoryPicker = () => ready;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        return put.call(this, value && value.kind === 'directory' && value === handle ? MARK : value, key);
      };
      const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
      Object.defineProperty(IDBRequest.prototype, 'result', {
        get() { const v = desc.get.call(this); return v === MARK ? handle : v; },
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400 && !/\/samples\/$|favicon\.ico$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });

    // ---- helpers running in the page
    const files = () => page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('images', { create: true });
      const out = {};
      for await (const [n, h] of dir.entries()) {
        const f = await h.getFile();
        const bmp = await createImageBitmap(f);
        const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
        out[n] = { size: f.size, w: bmp.width, h: bmp.height, png: head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 };
      }
      return out;
    });
    const active = () => page.locator('#activeName').textContent();
    const status = (name) => page.evaluate((n) => window.__dc.state.items.find((i) => i.name === n)?.status, name);
    const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });

    /** Drag from a point on one page to a point on (maybe another) page, in mm. */
    async function drag(a, b) {
      await page.evaluate(({ pg, y }) => {
        const v = window.__dc.viewer;
        v.scrollToY(v.pages[pg - 1].top + (y * 72) / 25.4 - 70);
      }, { pg: a.page, y: a.y });
      await page.waitForTimeout(350);
      const pt = async (p) => {
        const bb = await page.locator(`.pdf-page[data-page="${p.page}"]`).boundingBox();
        const mm = bb.width / 210;
        return { x: bb.x + p.x * mm, y: bb.y + p.y * mm };
      };
      const A = await pt(a);
      const B = await pt(b);
      await page.mouse.move(A.x, A.y);
      await page.mouse.down();
      await page.mouse.move(B.x, B.y, { steps: 10 });
      await page.mouse.up();
    }
    const around = (d, m = 2.5) => [
      { page: d.page, x: d.x - m, y: d.y - m },
      { page: d.page, x: d.x + d.w + m, y: d.y + d.h + m },
    ];

    // ---- fresh start, with one image already in the folder (tests resume)
    await page.goto(`${URL}samples/`);
    await page.evaluate(async () => {
      localStorage.clear();
      localStorage.setItem('diagram-cropper-state-v1', JSON.stringify({ settings: { autoName: false } })); // these tests use a names list
      await new Promise((r) => { const q = indexedDB.deleteDatabase('diagram-cropper'); q.onsuccess = q.onerror = q.onblocked = r; });
      const rootDir = await navigator.storage.getDirectory();
      try { await rootDir.removeEntry('images', { recursive: true }); } catch { /* none */ }
      const dir = await rootDir.getDirectoryHandle('images', { create: true });
      const c = new OffscreenCanvas(300, 200);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 300, 200); ctx.fillStyle = '#c00'; ctx.fillRect(40, 40, 200, 100);
      const w = await (await dir.getFileHandle('q8_fig1.png', { create: true })).createWritable();
      await w.write(await c.convertToBlob({ type: 'image/png' }));
      await w.close();
    });
    await page.goto(URL);
    await page.waitForSelector('#setupDialog[open]');
    log('Setup opens on first run');

    // cropping is blocked before a folder is chosen
    assert.match(await page.locator('#banner').textContent(), /Choose the images folder first/);

    await page.click('#setupFolderBtn');
    await waitFor(async () => (await page.locator('#setupFolderStatus').textContent()).includes('images'), 'folder chosen');
    log('Chose images folder (write check passed)');

    await page.click('#tabExcel');
    await page.setInputFiles('#excelInput', XLSX_FILE);
    await page.waitForSelector('#review:not([hidden])');
    assert.equal(await page.locator('#colImage option:checked').textContent(), 'C: imagePath');
    assert.equal(await page.locator('#colQno option:checked').textContent(), 'A: qno');
    assert.equal(await page.locator('#colText option:checked').textContent(), 'B: text');
    const review = await page.locator('#review').textContent();
    assert.match(review, /8 names found \(1 repeated removed\)/);
    assert.match(review, /Q4 Fig 1\.PNG/);
    assert.match(review, /1 of these already has a file/);
    log('Excel columns detected; problem name "Q4 Fig 1.PNG" flagged; duplicate removed');
    await shot('01-setup-review');
    await page.click('#review >> text=Fix automatically');
    assert.match(await page.locator('#review').textContent(), /q4_fig_1\.png/);
    await page.click('#review >> text=Use these 8 names');
    await waitFor(async () => (await page.evaluate(() => window.__dc.state.items.length)) === 8, 'names loaded');
    assert.equal(await status('q8_fig1.png'), 'done');
    assert.deepEqual(await page.evaluate(() => window.__dc.state.items.map((i) => i.name)),
      ['q1_fig1.png', 'q3_fig1.png', 'q4_fig_1.png', 'q5_fig1.png', 'q6_fig1.png', 'q7_fig1.png', 'q7_fig2.png', 'q8_fig1.png']);
    log('Names loaded and fixed; q8_fig1.png already in folder marked Done');

    await page.setInputFiles('#pdfInput', PDF);
    await waitFor(() => page.locator('#setupPdfStatus').textContent().then((t) => t.includes('3 pages')), 'pdf loaded');
    await page.click('#startBtn');
    await page.waitForSelector('.pdf-page[data-page="1"] canvas');
    assert.equal(await active(), 'q1_fig1.png');
    assert.match(await page.locator('#progressText').textContent(), /1 \/ 8 done/);
    log('PDF open, all pages in one scroll; active name is q1_fig1.png');
    await shot('02-ready');

    await waitFor(async () => (await page.locator('#findInfo').textContent()).includes('Q1 is on page 1'), 'Q1 found in PDF');
    assert.ok(await page.locator('.q-marker').isVisible(), 'question marker shown');
    log('Question finder: "Q1 is on page 1" with a marker on the page');

    // ---- crop checks: empty box blocks Approve
    await drag({ page: 1, x: 120, y: 60 }, { page: 1, x: 190, y: 100 });
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.match(await page.locator('#cpWarn').textContent(), /empty/);
    assert.ok(await page.locator('#approveBtn').isDisabled(), 'approve disabled for an empty box');
    await page.keyboard.press('Escape');

    // ---- crop checks: box full of question text
    await drag({ page: 1, x: 15, y: 104 }, { page: 1, x: 195, y: 150 });
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.match(await page.locator('#cpWarn').textContent(), /a lot of text/);
    await page.keyboard.press('Escape');

    // ---- crop checks: box cutting through the diagram
    await drag({ page: 1, x: D.q1.x - 2, y: D.q1.y - 2 }, { page: 1, x: D.q1.x + D.q1.w / 2, y: D.q1.y + D.q1.h + 2 });
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.match(await page.locator('#cpWarn').textContent(), /touches the right edge/);
    await shot('03a-cut-warning');
    await page.keyboard.press('Escape');
    log('Crop checks: empty box blocked, text-heavy box and cut-off diagram warned');

    // ---- 1st approve: q1 (mouse)
    await drag(...around(D.q1));
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.equal(await page.locator('#cpName').textContent(), 'q1_fig1.png');
    assert.ok(await page.locator('#cpWarn').isHidden(), `no warnings for a good crop: ${await page.locator('#cpWarn').textContent()}`);
    await shot('03-crop-panel');
    await page.click('#approveBtn');
    await waitFor(async () => (await files())['q1_fig1.png'], 'q1 file');
    assert.equal(await active(), 'q3_fig1.png');
    assert.ok(await page.locator('.crop-box').isHidden(), 'crop box cleared after approve');
    assert.ok(await page.locator('#savedCard').isVisible(), 'saved thumbnail shown');
    await shot('04-after-approve');
    log('Approved q1_fig1.png -> file written, box cleared, next name q3_fig1.png active');

    // ---- crop checks: same area again, and far from the active question
    await drag(...around(D.q1));
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.match(await page.locator('#cpWarn').textContent(), /already saved as q1_fig1\.png/);
    await page.keyboard.press('Escape');
    log('Crop checks: re-cropping the q1 area warns "already saved as q1_fig1.png"');

    // ---- retake
    await drag(...around(D.q3));
    await page.waitForSelector('#cropPanel:not([hidden])');
    await page.click('#retakeBtn');
    assert.ok(await page.locator('#cropPanel').isHidden());
    assert.ok(await page.locator('.crop-box').isHidden());
    assert.equal((await files())['q3_fig1.png'], undefined);
    assert.equal(await active(), 'q3_fig1.png');
    log('Retake cleared the box and saved nothing');

    // ---- tiny drag ignored
    await drag({ page: 1, x: 150, y: 120 }, { page: 1, x: 152, y: 121 });
    assert.ok(await page.locator('.crop-box').isHidden(), 'tiny drag ignored');

    // ---- 2nd approve: q3 (keyboard Enter), after nudging the box with a handle
    await drag(...around(D.q3, 6));
    await page.waitForSelector('#cropPanel:not([hidden])');
    const se = await page.locator('.crop-box .h-se').boundingBox();
    await page.mouse.move(se.x + 7, se.y + 7);
    await page.mouse.down();
    await page.mouse.move(se.x - 7, se.y - 7, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await waitFor(async () => (await files())['q3_fig1.png'], 'q3 file');
    assert.equal(await active(), 'q4_fig_1.png');
    log('Resized box with a handle, approved q3_fig1.png with Enter -> next q4_fig_1.png');

    // ---- 3rd approve: q4 (after a wrong-page attempt)
    await drag(...around(D.q3));
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.match(await page.locator('#cpWarn').textContent(), /Q4 is on page 2, but the box is on page 1/);
    await page.keyboard.press('Escape');
    await drag(...around(D.q4));
    await page.waitForSelector('#cropPanel:not([hidden])');
    await page.click('#approveBtn');
    await waitFor(async () => (await files())['q4_fig_1.png'], 'q4 file');
    assert.equal(await active(), 'q5_fig1.png');
    log('Approved q4_fig_1.png -> next q5_fig1.png');

    // ---- use for another name
    await page.click('#savedCopyBtn');
    await page.waitForSelector('#pickerDialog[open]');
    await shot('05-picker');
    await page.click('#pickerList button:has-text("q5_fig1.png")');
    await waitFor(async () => (await files())['q5_fig1.png'], 'q5 copy');
    let f = await files();
    assert.equal(f['q5_fig1.png'].size, f['q4_fig_1.png'].size);
    assert.equal(await active(), 'q6_fig1.png');
    log('Used the q4 image for q5_fig1.png as well -> next q6_fig1.png');

    // ---- undo
    await page.keyboard.press('Control+z');
    await waitFor(async () => !(await files())['q5_fig1.png'], 'q5 removed by undo');
    assert.equal(await active(), 'q5_fig1.png');
    assert.equal(await status('q5_fig1.png'), 'pending');
    log('Undo removed q5_fig1.png, marked it Pending and made it active');

    // ---- skip with a note
    await page.keyboard.press('s');
    await page.waitForSelector('#skipDialog[open]');
    await page.fill('#skipNote', 'not in PDF');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await status('q5_fig1.png')) === 'skipped', 'skip');
    assert.equal(await active(), 'q6_fig1.png');
    log('Skipped q5_fig1.png with note "not in PDF" -> next q6_fig1.png');

    // ---- crop across a page break
    await drag({ page: 2, x: D.q6a.x - 2, y: D.q6a.y - 2 }, { page: 3, x: D.q6b.x + D.q6b.w + 2, y: D.q6b.y + D.q6b.h + 2 });
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.match(await page.locator('#cpInfo').textContent(), /pages 2 to 3/);
    await shot('06-page-break');
    await page.click('#approveBtn');
    await waitFor(async () => (await files())['q6_fig1.png'], 'q6 file');
    assert.equal(await active(), 'q7_fig1.png');
    log('Crop across pages 2-3 stitched into q6_fig1.png -> next q7_fig1.png');

    // ---- check the files: exact names and sensible sizes
    f = await files();
    assert.deepEqual(Object.keys(f).sort(), ['q1_fig1.png', 'q3_fig1.png', 'q4_fig_1.png', 'q6_fig1.png', 'q8_fig1.png']);
    for (const n of Object.keys(f)) assert.ok(f[n].png, `${n} is a PNG`);
    const ratio = (n) => (f[n].w - 20) / (f[n].h - 20); // minus 10 px padding each side
    assert.ok(Math.abs(ratio('q1_fig1.png') - 80 / 60) < 0.15, `q1 aspect ${ratio('q1_fig1.png')}`);
    assert.ok(Math.abs(ratio('q4_fig_1.png') - 90 / 60) < 0.2, `q4 aspect ${ratio('q4_fig_1.png')}`);
    assert.ok(f['q6_fig1.png'].h > f['q6_fig1.png'].w * 0.55, `q6 is tall (stitched): ${f['q6_fig1.png'].w}x${f['q6_fig1.png'].h}`);
    for (const n of ['q1_fig1.png', 'q3_fig1.png', 'q4_fig_1.png', 'q6_fig1.png']) assert.ok(f[n].w <= 1200, 'max width respected');
    console.log('      files:', Object.entries(f).map(([n, v]) => `${n} ${v.w}x${v.h}`).join(', '));
    log('Folder holds exactly the expected file names');
    await shot('07-progress');

    // ---- refresh: progress, folder and PDF come back
    const before = await page.evaluate(() => window.__dc.state.items.map((i) => `${i.name}:${i.status}:${i.page}:${i.note}`));
    await page.reload();
    await page.waitForSelector('.pdf-page[data-page="1"]');
    await waitFor(async () => (await page.locator('#folderName').textContent()) === 'images', 'folder reconnected');
    const after = await page.evaluate(() => window.__dc.state.items.map((i) => `${i.name}:${i.status}:${i.page}:${i.note}`));
    assert.deepEqual(after, before);
    assert.equal(await active(), 'q7_fig1.png');
    assert.match(await page.locator('#progressText').textContent(), /5 \/ 8 done/);
    assert.ok(await page.locator('#setupDialog').evaluate((d) => !d.open), 'setup not forced after refresh');
    log('After refresh: statuses, notes, pages, active name, folder and PDF restored');
    await shot('08-after-refresh');

    // ---- verification report
    await page.click('#finishBtn');
    await page.click('#verifyBtn');
    await waitFor(async () => /names have no file|All \d+ names/.test(await page.locator('#verifyResult').textContent()), 'verification text');
    const vr = await page.locator('#verifyResult').textContent();
    assert.match(vr, /3 of 8 names have no file/);
    for (const n of ['q5_fig1.png', 'q7_fig1.png', 'q7_fig2.png']) assert.ok(vr.includes(n), `missing list has ${n}`);
    for (const n of ['q1_fig1.png', 'q6_fig1.png']) assert.ok(!vr.includes(n), `missing list does not have ${n}`);
    const report = await page.locator('#reportCols').textContent();
    assert.match(report, /Done \(5\)/);
    assert.match(report, /Skipped \(1\)/);
    assert.match(report, /not in PDF/);
    assert.match(report, /Pending \(2\)/);
    await shot('09-finish');
    log('Verification lists exactly q5_fig1.png, q7_fig1.png, q7_fig2.png as missing');

    // ---- exports
    const dl = async (btn) => {
      const [d] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
      const p = path.join(shots, d.suggestedFilename());
      await d.saveAs(p);
      return p;
    };
    const csv = fs.readFileSync(await dl('#csvBtn'), 'utf8');
    assert.match(csv, /q5_fig1\.png,Skipped,5,,,not in PDF/);
    assert.match(csv, /q6_fig1\.png,Done,6,sample-questions\.pdf,2-3,/);
    const wb = XLSX.readFile(await dl('#excelOutBtn'));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Questions, { header: 1, defval: '' });
    assert.deepEqual(rows[0].slice(0, 6), ['qno', 'text', 'imagePath', 'subject', 'Image status', 'Image note']);
    assert.deepEqual([rows[4][2], rows[4][4]], ['q4_fig_1.png', 'Done']);
    assert.deepEqual([rows[5][2], rows[5][4], rows[5][5]], ['images/q5_fig1.png', 'Skipped', 'not in PDF']);
    assert.equal(rows[7][4], 'Pending');
    assert.equal(rows[2][4], '', 'row without image untouched');
    const zipPath = await dl('#zipBtn');
    assert.ok(fs.statSync(zipPath).size > 1000);
    const backup = JSON.parse(fs.readFileSync(await dl('#backupBtn'), 'utf8'));
    assert.equal(backup.state.items.length, 8);
    log('CSV, updated Excel (status + fixed image path), ZIP and backup downloads are correct');

    // ---- review gallery
    await page.click('#finishReviewBtn');
    await page.waitForSelector('#reviewDialog[open]');
    assert.equal(await page.locator('#gallery .card').count(), 5);
    await page.waitForTimeout(300);
    await shot('10-review');
    // a card opens the editor (original is stored); close it again
    await page.locator('#gallery .card:has-text("q3_fig1.png") .ci').click();
    await page.waitForSelector('#editorDialog[open]');
    assert.equal(await page.locator('#edName').textContent(), 'q3_fig1.png');
    await page.click('#edBack');
    await page.click('#reviewDialog [data-close]');
    await page.locator('.row:has-text("q3_fig1.png") .thumb').click();
    await page.waitForSelector('#viewDialog[open]');
    assert.match(await page.locator('#viewInfo').textContent(), /page 1/);

    // ---- replace from the saved box (opened from the review)
    await page.click('#viewReplaceBtn');
    await page.waitForSelector('#cropPanel:not([hidden])');
    assert.equal(await active(), 'q3_fig1.png');
    assert.ok(await page.locator('#cpMode').isVisible(), 'saved crop shown for adjusting');
    assert.ok(await page.locator('.crop-box').isVisible());
    await shot('11-replace');
    await page.click('#approveBtn');
    await waitFor(async () => (await active()) === 'q7_fig1.png', 'back to next pending after replace');
    assert.equal(await status('q3_fig1.png'), 'done');
    log('Review gallery shows 5 images; "Replace" puts the saved q3 box back, Approve replaces it');

    assert.deepEqual(errors, [], `no console errors: ${errors.join('\n')}`);
    await context.close();

    // ---- second pass: a browser without folder access (download fallback) + pasted names
    const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
    await ctx2.addInitScript(() => {
      delete window.showDirectoryPicker; delete Window.prototype.showDirectoryPicker;
      if (!localStorage.getItem('diagram-cropper-state-v1')) localStorage.setItem('diagram-cropper-state-v1', JSON.stringify({ settings: { autoName: false } }));
    });
    const p2 = await ctx2.newPage();
    await p2.goto(URL);
    await p2.waitForSelector('#setupDialog[open]');
    assert.ok(await p2.locator('#fallbackNote').isVisible(), 'fallback note shown at the start');
    await p2.fill('#pasteArea', '  a1.png\n\nimages/b2\na1.png\nC 3.png\n');
    await p2.click('#checkPasteBtn');
    const rv = await p2.locator('#review').textContent();
    assert.match(rv, /3 names found \(1 repeated removed\)/);
    assert.match(rv, /C 3\.png/);
    await p2.click('#review >> text=Use these 3 names');
    assert.deepEqual(await p2.evaluate(() => window.__dc.state.items.map((i) => i.name)), ['a1.png', 'b2.png', 'C 3.png'],
      'names kept as they are when not fixed');
    await p2.setInputFiles('#pdfInput', PDF);
    await p2.waitForSelector('.pdf-page[data-page="1"] canvas');
    await p2.click('#startBtn');
    const bb = await p2.locator('.pdf-page[data-page="1"]').boundingBox();
    const mm = bb.width / 210;
    await p2.mouse.move(bb.x + 18 * mm, bb.y + 33 * mm);
    await p2.mouse.down();
    await p2.mouse.move(bb.x + 102 * mm, bb.y + 97 * mm, { steps: 8 });
    await p2.mouse.up();
    const [d2] = await Promise.all([p2.waitForEvent('download'), p2.click('#approveBtn')]);
    assert.equal(d2.suggestedFilename(), 'a1.png');
    await waitFor(async () => (await p2.locator('#activeName').textContent()) === 'b2.png', 'next name in fallback');
    await ctx2.close();
    log('Without folder access: note shown, pasted names cleaned, crop downloads as a1.png, next name active');

    console.log(`\nAll e2e checks passed. Screenshots and downloads: ${shots}`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('\nE2E FAILED:', e); process.exit(1); });
