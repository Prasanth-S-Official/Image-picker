// Browser test for automatic names (page_question_figure.png) with no names list loaded.
// Usage: node tests/e2e-autoname.mjs   (HEADED=1 to watch)

import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import assert from 'assert/strict';
import { DIAGRAMS as D } from './make-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5195;
const URL = `http://localhost:${PORT}/`;

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

async function main() {
  const server = spawn(process.execPath, ['server.js', String(PORT), '--no-open'], { cwd: root, stdio: 'ignore' });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: !process.env.HEADED });
  try {
    await waitFor(() => fetch(URL).then((r) => r.ok), 'server');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      const ready = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('images', { create: true }));
      window.showDirectoryPicker = () => ready;
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });

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
    assert.equal(await page.locator('#startBtn').isDisabled(), false, 'Start works without a names list');
    await page.setInputFiles('#pdfInput', path.join(root, 'samples', 'sample-questions.pdf'));
    await page.waitForSelector('.pdf-page[data-page="1"] canvas');
    await page.click('#startBtn');
    log('Setup needs only the folder and the PDF');

    async function crop(pg, d, fx = 0.5, fy = 0.5) {
      await page.keyboard.press('Escape');
      await page.evaluate(({ pg, y }) => { const v = window.__dc.viewer; v.scrollToY(v.pages[pg - 1].top + (y * 72) / 25.4 - 250); }, { pg, y: d.y });
      await page.waitForTimeout(250);
      const bb = await page.locator(`.pdf-page[data-page="${pg}"]`).boundingBox();
      const mm = bb.width / 210;
      await page.mouse.click(bb.x + (d.x + d.w * fx) * mm, bb.y + (d.y + d.h * fy) * mm);
      await page.waitForSelector('#cropPanel:not([hidden])');
      await waitFor(async () => /^\d+_\w+_\d+\.png$/.test(await page.locator('#cpName').textContent()), 'auto name');
      return page.locator('#cpName').textContent();
    }

    async function cropAndSave(pg, d, fx, fy) {
      const name = await crop(pg, d, fx, fy);
      const n = await page.evaluate(() => window.__dc.state.items.length);
      await page.keyboard.press('Enter');
      await waitFor(() => page.evaluate((n) => window.__dc.state.items.length === n + 1 && window.__dc.state.items[n].status === 'done', n), `saved ${name}`);
      return name;
    }

    const got = [];
    got.push(await cropAndSave(1, D.q1, 0.5, 0.83));
    got.push(await cropAndSave(1, D.q3));
    got.push(await cropAndSave(2, D.q4, 0.45));
    got.push(await cropAndSave(3, D.q7a, 0.35));
    got.push(await cropAndSave(3, D.q7b, 0.5, 0.3));
    got.push(await cropAndSave(3, D.q8, 0.5, 0.6));
    assert.deepEqual(got, ['1_1_1.png', '1_3_1.png', '2_4_1.png', '3_7_1.png', '3_7_2.png', '3_8_1.png']);
    const files = await page.evaluate(() => window.__dc.folder.fileNames().sort());
    assert.deepEqual(files, [...got].sort());
    log(`Crops saved as ${got.join(', ')} (two figures of Q7 numbered 1 and 2)`);

    // typing a question number overrides the one found in the PDF
    await crop(2, D.q5);
    await page.fill('#cpQno', '15');
    assert.equal(await page.locator('#cpName').textContent(), '2_15_1.png');
    await page.keyboard.press('Enter');
    await waitFor(() => page.evaluate(() => window.__dc.folder.hasFile('2_15_1.png')), 'typed name saved');
    log('A typed question number is used instead (2_15_1.png)');

    // undo removes the file and the list entry
    await page.keyboard.press('Control+z');
    await waitFor(() => page.evaluate(() => !window.__dc.folder.hasFile('2_15_1.png')
      && !window.__dc.state.items.some((it) => it.name === '2_15_1.png')), 'undo');
    log('Undo removes the auto-named file and its list entry');

    assert.deepEqual(errors, [], `no console errors: ${errors.join('\n')}`);
    console.log('\nAll automatic-name checks passed.');
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('\nAUTONAME E2E FAILED:', e); process.exit(1); });
