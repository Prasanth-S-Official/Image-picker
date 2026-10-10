import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { Viewer, normText } from './viewer.js';
import * as folder from './folder.js';
import * as db from './db.js';
import * as N from './names.js';
import * as img from './image.js';
import * as X from './exports.js';
import * as Pz from './presets.js';
import * as proc from './processor.js';
import { qualityFlags } from './pipeline.js';
import { Editor, buildSettingsControls } from './editor.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const LS_KEY = 'diagram-cropper-state-v1';
const TEXT_LEN = 150;
const MAX_RECENT_PDFS = 3;
const DEFAULT_SETTINGS = { dpi: 300, autoFind: true, clickCrop: true };
const DETECT_SCALE = 1.5; // page picture for finding diagrams: 108 dpi
const MM = 72 / 25.4; // pts per mm
const QUALITY_CODES = ['nearlyBlank', 'dark', 'blurry', 'small'];
const STATUSES = ['pending', 'done', 'skipped'];

// ============================================================ state

function freshState() {
  return {
    v: 1,
    items: [],
    active: -1,
    settings: { ...DEFAULT_SETTINGS },
    views: {},
    currentPdf: '',
    recentPdfs: [],
    lastSaved: null,
    folderName: '',
    excel: null,
    pendingOnly: false,
    customPresets: [],
    activePresetId: Pz.DEFAULT_PRESET_ID,
    defaultPresetId: Pz.DEFAULT_PRESET_ID,
    origSizes: {},
  };
}

function newItem(n) {
  return {
    name: n.name, qno: n.qno || '', text: (n.text || '').slice(0, 1000), rows: n.rows || [],
    status: 'pending', note: '', pdf: '', page: '', w: 0, h: 0, savedAt: 0, source: '', copyOf: '',
    box: null, warnings: [], edit: null,
  };
}

function sanitize(raw) {
  const s = { ...freshState(), ...(raw || {}) };
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  s.items = (Array.isArray(s.items) ? s.items : [])
    .filter((it) => it && typeof it.name === 'string' && it.name)
    .map((it) => ({ ...newItem(it), ...it, status: STATUSES.includes(it.status) ? it.status : 'pending' }));
  if (!Number.isInteger(s.active) || !s.items[s.active]) s.active = -1;
  if (!s.views || typeof s.views !== 'object') s.views = {};
  if (!Array.isArray(s.recentPdfs)) s.recentPdfs = [];
  s.customPresets = Pz.sanitizePresets(s.customPresets).filter((x) => !x.builtIn);
  const ids = Pz.sanitizePresets(s.customPresets).map((x) => x.id);
  if (!ids.includes(s.defaultPresetId)) s.defaultPresetId = Pz.DEFAULT_PRESET_ID;
  if (!ids.includes(s.activePresetId)) s.activePresetId = s.defaultPresetId;
  if (!s.origSizes || typeof s.origSizes !== 'object') s.origSizes = {};
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : freshState();
  } catch (e) {
    console.warn('Could not read saved progress', e);
    return freshState();
  }
}

let S = loadState();

/** Things that live only while the page is open. */
const R = {
  docs: new Map(), // pdf name -> pdf.js document
  blobs: new Map(), // image name -> Blob saved this session
  thumbs: new Map(), // image name -> object URL
  undo: [],
  busy: false,
  rows: new Map(), // item index -> <li>
  textOpen: false,
  draft: null, // names being checked in setup
  excelDraft: null,
  savedHandle: null,
  folderError: '',
  savedTimer: 0,
  pick: null,
  viewIndex: -1,
};

let persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveNow, 250);
}
function saveNow() {
  clearTimeout(persistTimer);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(S));
  } catch (e) {
    toast('Could not save progress in the browser (storage is full). Use "Save backup" to keep a copy.', 'error');
  }
}
window.addEventListener('beforeunload', () => { saveView(); saveNow(); });

// ============================================================ small helpers

function toast(msg, kind = 'info', ms) {
  const box = $('toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), ms || (kind === 'error' ? 8000 : 3500));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clone = (o) => JSON.parse(JSON.stringify(o));
const qnoLabel = (q) => (q === '' || q === undefined || q === null ? '' : /^\d+$/.test(String(q)) ? `Q${q}` : String(q));
const pageLabel = (pages) => (pages.length > 1 ? `${pages[0]}-${pages[pages.length - 1]}` : String(pages[0] || ''));
const counts = () => {
  const c = { pending: 0, done: 0, skipped: 0 };
  for (const it of S.items) c[it.status]++;
  return c;
};
const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const anyDialogOpen = () => !!document.querySelector('dialog[open]');

function openDialog(d) { if (!d.open) d.showModal(); }

function confirmBox(title, text, okLabel = 'OK', danger = false) {
  const d = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  const ok = $('confirmOk');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  d.returnValue = '';
  openDialog(d);
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
  });
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${what}.`, 'ok');
}

// ============================================================ presets

const allPresets = () => Pz.sanitizePresets(S.customPresets);
const presetById = (id) => allPresets().find((x) => x.id === id) || null;
const activePreset = () => presetById(S.activePresetId) || presetById(S.defaultPresetId) || allPresets()[0];

/** Settings for an image: its preset plus anything changed just for it. */
function effectiveSettings(edit) {
  const pr = (edit && presetById(edit.presetId)) || activePreset();
  return Pz.sanitizeSettings({ ...pr.settings, ...((edit && edit.overrides) || {}) });
}

/** Edit document for a new crop of this item. */
function baseEditFor(item) {
  const e = item && item.edit;
  if (e && (e.assigned || Object.keys(e.overrides || {}).length)) {
    return Pz.newEdit(presetById(e.presetId) ? e.presetId : activePreset().id, e.overrides);
  }
  return Pz.newEdit(activePreset().id, {});
}

const sameBox = (a, b) => !!a && !!b && ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);

function qualityCodes(res) { return res && res.stats ? qualityFlags(res.stats) : []; }
function mergeQuality(old, res) { return [...new Set([...(old || []).filter((c) => !QUALITY_CODES.includes(c)), ...qualityCodes(res)])]; }

function renderPresetUi() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  for (const pr of allPresets()) {
    const o = document.createElement('option');
    o.value = pr.id;
    o.textContent = `${pr.name}${pr.id === S.defaultPresetId ? ' (default)' : ''}`;
    sel.appendChild(o);
  }
  sel.value = activePreset().id;
  sel.title = `New crops use "${activePreset().name}"`;
}

// ---------- original crops (kept so images can be re-edited without losing quality)

let origQueue = Promise.resolve();

function imageDataToPng(id) {
  return new Promise((resolve, reject) => {
    proc.imageDataToCanvas(id).toBlob((b) => (b ? resolve(b) : reject(new Error('Could not store the original crop.'))), 'image/png');
  });
}

async function setOriginal(name, blob) {
  if (!(await db.set(`orig:${name}`, blob))) return;
  S.origSizes[name] = blob.size;
  persist();
}

async function delOriginal(name) {
  await db.del(`orig:${name}`);
  delete S.origSizes[name];
  persist();
}

async function loadOriginal(name) {
  await origQueue;
  const blob = await db.get(`orig:${name}`);
  if (!blob) return null;
  try { return await proc.blobToImageData(blob); } catch { return null; }
}

/** Writes an image to the folder and records it (with undo). */
async function storeSaved(idx, blob, info) {
  const item = S.items[idx];
  const name = item.name;
  let prevBlob = null;
  try { prevBlob = await folder.readFile(name); } catch { /* no previous file */ }
  await origQueue;
  const prevOrig = (await db.get(`orig:${name}`)) || null;
  await folder.writeFile(name, blob);
  if (info.original) {
    const original = info.original;
    origQueue = origQueue.then(async () => {
      const b = original instanceof Blob ? original : await imageDataToPng(original);
      await setOriginal(name, b);
    }).catch((e) => console.warn('Original not stored', e));
  }
  R.undo.push({ kind: 'save', targets: [{ index: idx, name, prevItem: clone(item), prevBlob, prevOrig }] });
  const patch = { status: 'done', w: info.w, h: info.h, savedAt: Date.now(), note: '', edit: info.edit, warnings: info.warnings || [] };
  for (const k of ['pdf', 'page', 'box', 'source', 'copyOf']) if (info[k] !== undefined) patch[k] = info[k];
  Object.assign(item, patch);
  setBlob(name, blob);
}

// ============================================================ viewer

const viewer = new Viewer($('scroller'), {
  canCrop,
  onBlocked: (msg) => toast(msg, 'warn'),
  onClick: (pt) => clickToCrop(pt),
  onBoxChange,
  onBoxDone: () => showPanel(),
  onScroll: () => { positionPanel(); updatePageIndicator(); saveViewSoon(); },
  onZoom: () => { $('zoomVal').textContent = `${viewer.zoomPercent()}%`; positionPanel(); saveViewSoon(); },
});

function canCrop() {
  if (folder.supported && !folder.isReady()) return 'Choose the images folder first.';
  if (!S.items.length) return 'Load the image names first. Click "Setup".';
  if (!S.items[S.active]) return 'All names are done or skipped. Click a name in the list to replace its image.';
  if (R.busy) return 'Saving… one moment.';
  return null;
}

let viewTimer = 0;
function saveViewSoon() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { saveView(); persist(); }, 400);
}
function saveView() {
  if (S.currentPdf && viewer.doc) {
    S.views[S.currentPdf] = { zoom: viewer.fitMode ? 'fit' : viewer.scale, y: viewer.getScrollY() };
  }
}

function updatePageIndicator() {
  const inp = $('pageInput');
  if (document.activeElement !== inp) inp.value = viewer.currentPage() || 1;
}

// ============================================================ click to crop

/** Click inside a diagram: find its edges and put the box around it. */
async function clickToCrop(pt) {
  if (S.settings.clickCrop === false || R.busy || R.detecting || !viewer.doc) return;
  const hit = viewer.pageAtPoint(pt);
  if (!hit) return;
  if (viewer.box) {
    // clicking inside the current box does nothing (drag it to move)
    const b = viewer.box;
    if (pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1) return;
  }
  R.detecting = true;
  $('scroller').classList.add('finding');
  try {
    const key = `${S.currentPdf}#${hit.p.i}`;
    const w = proc.previewWorker();
    if (!R.detectPages) R.detectPages = [];
    if (!R.detectPages.includes(key)) {
      const id = await viewer.pageImageData(hit.p.i, DETECT_SCALE);
      await w.setImage(key, id);
      R.detectPages.push(key);
      while (R.detectPages.length > 4) w.drop(R.detectPages.shift());
    }
    const found = await w.detect(key, hit.x * DETECT_SCALE, hit.y * DETECT_SCALE, {
      r: 1.2 * MM * DETECT_SCALE, gap: 2.5 * MM * DETECT_SCALE, minSize: 6 * MM * DETECT_SCALE,
      lineMax: 7 * MM * DETECT_SCALE, captionGap: 12 * MM * DETECT_SCALE,
    });
    if (!found || found.error) {
      toast(`${found && found.error ? found.error : 'No diagram found here.'} You can always drag a box instead.`, 'warn');
      return;
    }
    const pad = 1.5 * MM;
    const p = hit.p;
    const box = {
      x0: Math.max(p.left, p.left + found.x0 / DETECT_SCALE - pad),
      y0: Math.max(p.top, p.top + found.y0 / DETECT_SCALE - pad),
      x1: Math.min(p.left + p.w, p.left + (found.x1 + 1) / DETECT_SCALE + pad),
      y1: Math.min(p.top + p.h, p.top + (found.y1 + 1) / DETECT_SCALE + pad),
    };
    if (canCrop()) return; // something changed while finding (for example the folder was disconnected)
    viewer.setBox(box);
    showPanel();
  } catch (e) {
    console.warn('Finding the diagram failed', e);
    toast('Could not find the diagram automatically. Drag a box around it instead.', 'warn');
  } finally {
    R.detecting = false;
    $('scroller').classList.remove('finding');
  }
}

// ============================================================ crop panel

let previewRaf = 0;
function onBoxChange(b, reason) {
  if (!b || reason === 'drawing') R.prevShown = false;
  if (R.editDraft && !R.editorOpen && (!b || !sameBox(R.editDraft.box, b))) {
    if (b && Pz.isCustom(R.editDraft.edit)) toast('The box changed, so the edits for this crop were cleared.', 'warn');
    R.editDraft = null;
  }
  if (!b) { hidePanel(); return; }
  if (reason === 'drawing') { hidePanel(); return; }
  if (!$('cropPanel').hidden) schedulePreview();
}

function showPanel() {
  if ($('cropPanel').hidden) R.panelFresh = true;
  $('cropPanel').hidden = false;
  $('cpMode').hidden = !R.prevShown;
  updatePanelName();
  drawPreview();
}

function hidePanel() {
  $('cropPanel').hidden = true;
}

function updatePanelName() {
  const it = S.items[S.active];
  $('cpName').textContent = it ? it.name : '—';
}

function schedulePreview() {
  cancelAnimationFrame(previewRaf);
  previewRaf = requestAnimationFrame(drawPreview);
}

const minScale = () => (Number(S.settings.dpi) || 300) / 72;

function drawPreview() {
  const b = viewer.box;
  if (!b || $('cropPanel').hidden) return;
  const pv = viewer.previewCanvas(b);
  if (pv) {
    const outScale = viewer.outputScale(b, minScale());
    const ratio = pv.scale / outScale;
    const c = $('cpCanvas');
    if (R.panelFresh) {
      // show the plain crop at once; the cleaned-up version replaces it a moment later
      R.panelFresh = false;
      c.width = pv.canvas.width;
      c.height = pv.canvas.height;
      c.getContext('2d').drawImage(pv.canvas, 0, 0);
    }
    const pages = viewer.boxPages(b);
    R.panelWhere = pages.length > 1
      ? `pages ${pages[0]} to ${pages[pages.length - 1]} (joined into one image)`
      : `page ${pages[0]}`;
    const estW = Math.round(pv.canvas.width / ratio);
    const estH = Math.round(pv.canvas.height / ratio);
    $('cpInfo').textContent = `About ${estW} × ${estH} px · ${R.panelWhere}`;
    R.warnings = checkCrop(b, pv.canvas, estW, estH);
    renderPanelWarnings();
    panelProcess(pv, ratio);
  }
  renderPanelPreset();
  positionPanel();
}

function renderPanelWarnings() {
  const warn = $('cpWarn');
  warn.innerHTML = '';
  for (const x of R.warnings || []) {
    const d = document.createElement('div');
    d.textContent = x.msg;
    warn.appendChild(d);
  }
  warn.hidden = !(R.warnings || []).length;
  const blank = (R.warnings || []).some((x) => x.code === 'blank');
  warn.classList.toggle('block', blank);
  if (!R.busy) $('approveBtn').disabled = blank;
}

function renderPanelPreset() {
  const it = S.items[S.active];
  const edit = R.editDraft ? R.editDraft.edit : baseEditFor(it);
  const pr = presetById(edit.presetId) || activePreset();
  const el = $('cpPreset');
  el.textContent = `Preset: ${pr.name}`;
  if (Pz.isCustom(edit)) {
    const b = document.createElement('span');
    b.className = 'badge custom';
    b.textContent = R.editDraft ? 'edited' : 'custom';
    b.title = Pz.customSummary(edit) || 'Settings changed for this image';
    el.appendChild(b);
  }
}

let panelToken = 0;
/** Applies the image settings to the panel preview in the background worker. */
async function panelProcess(pv, ratio) {
  const token = ++panelToken;
  const it = S.items[S.active];
  const edit = R.editDraft ? R.editDraft.edit : baseEditFor(it);
  const settings = effectiveSettings(edit);
  try {
    const w = proc.previewWorker();
    await w.setImage('panel', proc.canvasToImageData(pv.canvas), pv.canvas.width / ratio, pv.canvas.height / ratio);
    if (token !== panelToken) return;
    const r = await w.renderLatest('panel', 'panel', settings, edit, { final: true });
    if (!r || token !== panelToken || !viewer.box) return;
    const c = $('cpCanvas');
    const id = proc.toImageData(r.final);
    c.width = id.width;
    c.height = id.height;
    c.getContext('2d').putImageData(id, 0, 0);
    const fw = Math.round(r.final.w / r.s);
    const fh = Math.round(r.final.h / r.s);
    $('cpInfo').textContent = `About ${fw} × ${fh} px · ${R.panelWhere}`;
    // re-check on the cleaned-up image: paper grain and shadows no longer count as ink
    const cleaned = proc.imageDataToCanvas(proc.toImageData(r.working));
    const rest = (R.warnings || []).filter((x) => !['small', 'edge', 'blank'].includes(x.code));
    const fresh = [];
    if (!img.hasInk(cleaned)) fresh.push(BLANK_WARNING);
    else {
      const edges = img.inkOnEdges(cleaned);
      if (edges.length) fresh.push(edgeWarning(edges));
      if (img.isSmall(fw, fh)) fresh.push({ code: 'small', msg: `Small image (${fw} × ${fh} px). Check that it shows the whole diagram.` });
    }
    R.warnings = [...fresh, ...rest];
    renderPanelWarnings();
    positionPanel();
  } catch (e) {
    console.warn('Preview processing failed', e);
  }
}

const listWords = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);

function overlap(a, b) {
  const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}

const BLANK_WARNING = { code: 'blank', msg: 'The box is empty (only white). Draw it over the diagram.' };
const edgeWarning = (edges) => ({ code: 'edge', msg: `Something touches the ${listWords(edges)} edge of the box. Make the box a little bigger if the diagram continues.` });

/** Checks that catch common mistakes before saving. Returns [{ code, msg }]. */
function checkCrop(b, canvas, w, h) {
  const out = [];
  if (!img.hasInk(canvas)) {
    out.push(BLANK_WARNING);
    return out;
  }
  const edges = img.inkOnEdges(canvas);
  if (edges.length) out.push(edgeWarning(edges));
  if (img.isSmall(w, h)) out.push({ code: 'small', msg: `Small image (${w} × ${h} px). Check that it shows the whole diagram.` });
  const txt = viewer.textInBox(b);
  if (txt) {
    const joined = txt.join(' ');
    const words = normText(joined).split(' ').filter((x) => x.length >= 3).length;
    if (words >= 12) {
      out.push({ code: 'text', msg: `The box has a lot of text ("${joined.slice(0, 50).trim()}…"). Keep only the diagram, unless the text is part of it.` });
    }
  }
  const dup = S.items.find((it, i) => i !== S.active && it.status === 'done' && it.source === 'crop'
    && it.box && it.pdf === S.currentPdf && overlap(it.box, b) > 0.6);
  if (dup) out.push({ code: 'duplicate', msg: `This area was already saved as ${dup.name}.` });
  const it = S.items[S.active];
  const f = R.found && R.found.index === S.active ? R.found.result : null;
  if (it && f) {
    const pages = viewer.boxPages(b);
    if (!pages.some((p) => p === f.page || p === f.page + 1)) {
      out.push({ code: 'page', msg: `${qnoLabel(it.qno) || 'This question'} is on page ${f.page}, but the box is on page ${pages[0]}. Check it is the right diagram.` });
    }
  }
  return out;
}

function positionPanel() {
  const p = $('cropPanel');
  if (p.hidden) return;
  const r = viewer.boxClientRect();
  if (!r) return;
  const area = $('scroller').getBoundingClientRect();
  const pw = p.offsetWidth;
  const ph = p.offsetHeight;
  const gap = 14;
  let left = r.right + gap;
  if (left + pw > area.right - 20) {
    left = r.left - gap - pw;
    if (left < area.left + 8) left = area.right - pw - 24;
  }
  left = clamp(left, 8, window.innerWidth - pw - 8);
  let top = clamp(r.top, area.top + 8, area.bottom - ph - 8);
  top = clamp(top, 8, window.innerHeight - ph - 8);
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
}

function setPanelBusy(on) {
  $('approveBtn').disabled = on || (R.warnings || []).some((x) => x.code === 'blank');
  $('retakeBtn').disabled = on;
  $('approveBtn').firstChild.textContent = on ? 'Saving… ' : 'Approve ';
}

// ============================================================ save, skip, undo

async function approve() {
  if (R.busy) return;
  const b = viewer.box;
  if (!b) return;
  const block = canCrop();
  if (block) { toast(block, 'warn'); return; }
  drawPreview();
  if ((R.warnings || []).some((x) => x.code === 'blank')) { toast('The box is empty. Draw it over the diagram.', 'warn'); return; }
  const warnings = (R.warnings || []).map((x) => x.code).filter((c) => !QUALITY_CODES.includes(c));

  // Everything is fixed at this moment: the name, the box, the PDF, the edits.
  const idx = S.active;
  const item = S.items[idx];
  const name = item.name;
  const pdfName = S.currentPdf;
  const box = { ...b };
  const pages = viewer.boxPages(box);
  const scale = viewer.outputScale(box, minScale());
  const draft = R.editDraft && sameBox(R.editDraft.box, box) ? R.editDraft : null;

  R.busy = true;
  setPanelBusy(true);
  // clear the box straight away so it can never be saved again under the next name
  viewer.flash(box);
  viewer.clearBox();
  try {
    const original = draft ? draft.original : proc.canvasToImageData(await viewer.renderCrop(box, scale));
    const edit = draft ? clone(draft.edit) : baseEditFor(item);
    const settings = effectiveSettings(edit);
    const reuse = draft && draft.result && draft.resultSig === JSON.stringify([settings, edit]);
    const res = reuse ? draft.result : await proc.renderFinal(original, settings, edit);
    if (res.deskewUsed !== null && res.deskewUsed !== undefined && (edit.geom.deskew === null || edit.geom.deskew === undefined)) {
      edit.geom.deskew = res.deskewUsed;
      edit.geom.deskewAuto = true;
    }
    const flags = qualityCodes(res);
    await storeSaved(idx, res.blob, {
      original, edit, w: res.w, h: res.h, pdf: pdfName, page: pageLabel(pages), box, source: 'crop', copyOf: '',
      warnings: [...new Set([...warnings, ...flags])],
    });
    R.editDraft = null;
    S.lastSaved = { pdf: pdfName, y: Math.max(0, box.y0 - 30), page: pages[0], name };
    if (S.active === idx) moveToNext(idx);
    else refreshRow(idx);
    showSavedCard(idx, res.blob);
    if (flags.length) {
      toast(`${name}: ${flags.map((c) => X.WARN_LABEL[c] || c).join(', ')}. Check it in "Review saved images".`, 'warn', 6000);
    }
    renderTop();
    renderToolbar();
    persist();
  } catch (e) {
    console.error(e);
    // put the box back so the user can try again
    viewer.setBox(box);
    if (draft) R.editDraft = draft;
    showPanel();
    toast(`${name} was not saved. ${e.name === 'NoFolder' ? e.message : folder.explain(e)}`, 'error');
  } finally {
    R.busy = false;
    setPanelBusy(false);
    renderBanner();
  }
}

// ---------- the editor

const editor = new Editor({
  presets: allPresets,
  presetById,
  activePresetId: () => activePreset().id,
  savePreset: (name, settings) => {
    const id = `p${Date.now().toString(36)}`;
    S.customPresets.push({ id, name, builtIn: false, settings: Pz.sanitizeSettings(settings) });
    persist();
    renderPresetUi();
    return id;
  },
  updatePreset: (id, settings) => {
    const pr = S.customPresets.find((x) => x.id === id);
    if (!pr) { toast('Built-in presets cannot be changed. Save a new preset instead.', 'warn'); return; }
    pr.settings = Pz.sanitizeSettings(settings);
    persist();
    toast(`Preset "${pr.name}" updated.`, 'ok');
  },
  applyToOthers: (e, includeDone) => applyToOthers(e, includeDone),
  copySettings: (e) => { R.clip = clone(e); toast('Settings copied. Use "Paste settings" on another image.', 'ok'); },
  pasteSettings: () => { if (!R.clip) { toast('Copy settings from an image first.', 'warn'); return null; } return clone(R.clip); },
  toast,
});

async function openEditorForBox() {
  const b = viewer.box;
  if (!b || R.busy || R.editorOpen) return;
  const block = canCrop();
  if (block) { toast(block, 'warn'); return; }
  const it = S.items[S.active];
  let draft = R.editDraft && sameBox(R.editDraft.box, b) ? R.editDraft : null;
  R.editorOpen = true;
  try {
    if (!draft) {
      $('editBtn').disabled = true;
      const raw = await viewer.renderCrop(b, viewer.outputScale(b, minScale()));
      draft = { box: { ...b }, original: proc.canvasToImageData(raw), edit: baseEditFor(it) };
    }
    hidePanel();
    const res = await editor.open({ original: draft.original, edit: draft.edit, name: it.name, mode: 'new' });
    R.editorOpen = false;
    if (res.action === 'retake') { R.editDraft = null; viewer.clearBox(); return; }
    draft.edit = res.edit;
    R.editDraft = draft;
    if (res.action === 'approve') {
      draft.result = res.result;
      draft.resultSig = JSON.stringify([effectiveSettings(res.edit), res.edit]);
      await approve();
    } else {
      showPanel();
    }
  } catch (e) {
    toast(`Could not open the editor. ${e.message}`, 'error');
    if (viewer.box) showPanel();
  } finally {
    R.editorOpen = false;
    $('editBtn').disabled = false;
  }
}

/** Opens a saved image in the editor from its stored original. */
async function editSaved(i) {
  const it = S.items[i];
  if (!it || R.busy || R.editorOpen) return;
  const orig = await loadOriginal(it.name);
  if (!orig) {
    toast(`No original crop is stored for ${it.name}, so it cannot be re-edited. Crop it again from the PDF instead.`, 'warn', 6000);
    return;
  }
  R.editorOpen = true;
  let res;
  try {
    res = await editor.open({ original: orig, edit: it.edit || Pz.newEdit(activePreset().id), name: it.name, mode: 'done' });
  } finally {
    R.editorOpen = false;
  }
  if (res.action !== 'approve') return;
  R.busy = true;
  try {
    const edit = res.edit;
    if (res.result.deskewUsed !== null && res.result.deskewUsed !== undefined && (edit.geom.deskew === null || edit.geom.deskew === undefined)) {
      edit.geom.deskew = res.result.deskewUsed;
      edit.geom.deskewAuto = true;
    }
    await storeSaved(i, res.result.blob, { edit, w: res.result.w, h: res.result.h, warnings: mergeQuality(it.warnings, res.result) });
    refreshRow(i);
    renderTop();
    persist();
    if ($('reviewDialog').open) renderGallery();
    toast(`Saved changes to ${it.name}.`, 'ok');
  } catch (e) {
    toast(`${it.name} was not saved. ${folder.explain(e)}`, 'error');
  } finally {
    R.busy = false;
  }
}

/** "Apply these settings to all remaining images" (and optionally Done images too). */
async function applyToOthers(e, includeDone) {
  let pending = 0;
  S.items.forEach((it, i) => {
    if (it.status !== 'pending') return;
    it.edit = { ...Pz.newEdit(e.presetId, e.overrides), assigned: true };
    pending++;
    refreshRow(i);
  });
  let msg = `Settings applied to ${plural(pending, 'remaining image')}.`;
  persist();
  if (includeDone) {
    const done = [];
    S.items.forEach((it, i) => { if (it.status === 'done') done.push(i); });
    if (done.length && await confirmBox('Re-process the Done images?',
      `This re-makes ${plural(done.length, 'saved image')} from the stored original crops with these settings and replaces the files in the folder (same names).`, 'Re-process')) {
      const r = await reprocess(done, (ed) => ({ ...ed, presetId: e.presetId, overrides: clone(e.overrides) }));
      msg += ` ${plural(r.count, 'Done image')} re-processed.${r.skipped.length ? ` ${r.skipped.length} had no stored original.` : ''}`;
    }
  }
  toast(msg, 'ok', 6000);
}

/** Re-makes saved images from their stored originals. `mutate(edit)` changes the settings. */
async function reprocess(indices, mutate, onProgress) {
  const out = { count: 0, skipped: [], failed: [] };
  if (folder.supported && !folder.isReady()) { toast('Choose or reconnect the images folder first.', 'warn'); return out; }
  R.busy = true;
  let n = 0;
  try {
    for (const i of indices) {
      const it = S.items[i];
      n++;
      if (!it || it.status !== 'done') continue;
      const orig = await loadOriginal(it.name);
      if (!orig) { out.skipped.push(it.name); onProgress && onProgress(n, indices.length, it.name); continue; }
      const edit = mutate(clone(it.edit || Pz.newEdit(activePreset().id, {})));
      edit.geom = { ...Pz.emptyGeom(), ...(edit.geom || {}) };
      edit.ops = edit.ops || [];
      if (edit.geom.deskewAuto) { edit.geom.deskew = null; edit.geom.deskewAuto = false; }
      delete edit.assigned;
      try {
        const res = await proc.renderFinal(orig, effectiveSettings(edit), edit);
        if (res.deskewUsed !== null && res.deskewUsed !== undefined && edit.geom.deskew === null) {
          edit.geom.deskew = res.deskewUsed;
          edit.geom.deskewAuto = true;
        }
        await folder.writeFile(it.name, res.blob);
        Object.assign(it, { edit, w: res.w, h: res.h, savedAt: Date.now(), warnings: mergeQuality(it.warnings, res) });
        setBlob(it.name, res.blob);
        refreshRow(i);
        out.count++;
      } catch (e) {
        console.error(e);
        out.failed.push(it.name);
      }
      onProgress && onProgress(n, indices.length, it.name);
    }
  } finally {
    R.busy = false;
    persist();
    renderTop();
  }
  if (out.failed.length) toast(`Could not re-process: ${out.failed.slice(0, 5).join(', ')}`, 'error');
  return out;
}

function retake() {
  viewer.clearBox();
}

/** After a save or skip: make the next pending name active. */
function moveToNext(fromIdx) {
  const next = nextPending(fromIdx);
  setActive(next);
  refreshRow(fromIdx);
  if (next < 0 && S.items.length) {
    toast('All names are done or skipped. Click "Finish and check" to check the folder.', 'ok', 6000);
  }
}

function nextPending(from) {
  const n = S.items.length;
  for (let k = 1; k <= n; k++) {
    const j = (((from + k) % n) + n) % n;
    if (S.items[j].status === 'pending') return j;
  }
  return -1;
}

function pendingAfter(from, count) {
  const out = [];
  const n = S.items.length;
  for (let k = 1; k < n && out.length < count; k++) {
    const j = (((from + k) % n) + n) % n;
    if (S.items[j].status === 'pending' && j !== from) out.push(S.items[j]);
  }
  return out;
}

function openSkip() {
  const it = S.items[S.active];
  if (!it) { toast('There is no active name to skip.', 'warn'); return; }
  $('skipName').textContent = it.name;
  $('skipNote').value = it.status === 'skipped' ? it.note || '' : '';
  const d = $('skipDialog');
  d.returnValue = '';
  openDialog(d);
  $('skipNote').focus();
}

function doSkip(note) {
  const idx = S.active;
  const it = S.items[idx];
  if (!it) return;
  viewer.clearBox();
  R.undo.push({ kind: 'skip', targets: [{ index: idx, name: it.name, prevItem: clone(it) }] });
  it.status = 'skipped';
  it.note = note.trim();
  moveToNext(idx);
  renderTop();
  persist();
  toast(`Skipped ${it.name}${it.note ? ` (${it.note})` : ''}.`);
}

async function undo() {
  if (R.busy) return;
  const e = R.undo.pop();
  if (!e) { toast('Nothing to undo.'); return; }
  R.busy = true;
  try {
    await origQueue;
    for (const t of [...e.targets].reverse()) {
      if (e.kind === 'save' && t.prevOrig !== undefined) {
        if (t.prevOrig) await setOriginal(t.name, t.prevOrig); else await delOriginal(t.name);
      }
      if (e.kind === 'save') {
        if (t.prevBlob) {
          await folder.writeFile(t.name, t.prevBlob, { quiet: true });
          setBlob(t.name, t.prevBlob);
        } else {
          await folder.removeFile(t.name);
          dropBlob(t.name);
        }
      }
      if (S.items[t.index] && S.items[t.index].name === t.name) S.items[t.index] = t.prevItem;
    }
    viewer.clearBox();
    const first = e.targets[0];
    setActive(first.index);
    refreshRow(first.index);
    renderTop();
    persist();
    let msg = e.kind === 'skip' ? `Undid skip of ${first.name}.`
      : e.targets[0].prevBlob ? `Undid save. The previous ${first.name} was put back.` : `Undid save. ${first.name} was removed from the folder.`;
    if (e.kind === 'save' && !folder.supported) msg = `Undid save of ${first.name}. Delete the downloaded copy from your Downloads folder.`;
    toast(msg);
  } catch (err) {
    R.undo.push(e);
    toast(`Could not undo. ${folder.explain(err)}`, 'error');
  } finally {
    R.busy = false;
    $('savedCard').hidden = true;
  }
}

// ---------- same image under another name

async function convertBlob(blob, mime) {
  if (blob.type === mime) return blob;
  const bmp = await createImageBitmap(blob);
  const c = img.makeCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  return img.toBlob(c, mime);
}

async function useForAnother(srcIdx) {
  const src = S.items[srcIdx];
  if (!src || src.status !== 'done') { toast('Save an image for this name first.', 'warn'); return; }
  const dstIdx = await pickName(srcIdx);
  if (dstIdx === null || dstIdx === undefined) return;
  await copyImage(srcIdx, dstIdx);
}

async function copyImage(srcIdx, dstIdx) {
  if (R.busy) return;
  const src = S.items[srcIdx];
  const dst = S.items[dstIdx];
  if (!src || !dst || srcIdx === dstIdx) return;
  if (folder.supported && !folder.isReady()) { toast('Choose the images folder first.', 'warn'); return; }
  R.busy = true;
  try {
    let blob = R.blobs.get(src.name) || await folder.readFile(src.name);
    if (!blob) throw Object.assign(new Error(`The file ${src.name} was not found in the folder.`), { name: 'Plain' });
    blob = await convertBlob(blob, N.mimeFor(dst.name));
    let prevBlob = null;
    try { prevBlob = await folder.readFile(dst.name); } catch { /* none */ }
    await origQueue;
    const prevOrig = (await db.get(`orig:${dst.name}`)) || null;
    await folder.writeFile(dst.name, blob);
    const srcOrig = await db.get(`orig:${src.name}`);
    if (srcOrig) await setOriginal(dst.name, srcOrig);
    R.undo.push({ kind: 'save', targets: [{ index: dstIdx, name: dst.name, prevItem: clone(dst), prevBlob, prevOrig }] });
    Object.assign(dst, {
      status: 'done', pdf: src.pdf, page: src.page, w: src.w, h: src.h,
      savedAt: Date.now(), source: 'copy', copyOf: src.name, note: '', box: null, warnings: src.warnings || [],
      edit: src.edit ? clone(src.edit) : null,
    });
    setBlob(dst.name, blob);
    if (S.active === dstIdx) moveToNext(dstIdx);
    refreshRow(dstIdx);
    renderTop();
    persist();
    toast(`Saved the same image as ${dst.name}.`, 'ok');
  } catch (e) {
    toast(`Could not save ${dst.name}. ${e.name === 'Plain' ? e.message : folder.explain(e)}`, 'error');
  } finally {
    R.busy = false;
  }
}

function pickName(excludeIdx) {
  const d = $('pickerDialog');
  $('pickerSearch').value = '';
  $('pickerAll').checked = false;
  R.pickExclude = excludeIdx;
  renderPicker();
  openDialog(d);
  $('pickerSearch').focus();
  return new Promise((resolve) => { R.pick = resolve; });
}

function renderPicker() {
  const q = $('pickerSearch').value.trim().toLowerCase();
  const all = $('pickerAll').checked;
  const ul = $('pickerList');
  ul.innerHTML = '';
  let shown = 0;
  S.items.forEach((it, i) => {
    if (i === R.pickExclude) return;
    if (!all && it.status !== 'pending') return;
    if (!matches(it, q)) return;
    if (shown++ > 400) return;
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = i;
    const fn = document.createElement('span');
    fn.className = 'fn';
    fn.textContent = it.name;
    const sm = document.createElement('small');
    sm.textContent = [qnoLabel(it.qno), it.status !== 'pending' ? `${X.STATUS_LABEL[it.status]}${it.status === 'done' ? ' — will be replaced' : ''}` : ''].filter(Boolean).join(' · ');
    b.append(fn, sm);
    li.appendChild(b);
    ul.appendChild(li);
  });
  if (!shown) ul.innerHTML = `<li class="muted" style="padding:10px">${all ? 'No names match.' : 'No pending names match. Tick "Show all names" to choose a done one.'}</li>`;
}

// ============================================================ thumbnails

function setBlob(name, blob) {
  R.blobs.set(name, blob);
  const old = R.thumbs.get(name);
  if (old) URL.revokeObjectURL(old);
  R.thumbs.set(name, URL.createObjectURL(blob));
}

function dropBlob(name) {
  R.blobs.delete(name);
  const old = R.thumbs.get(name);
  if (old) URL.revokeObjectURL(old);
  R.thumbs.delete(name);
}

async function thumbUrl(name) {
  if (R.thumbs.has(name)) return R.thumbs.get(name);
  const url = await folder.fileUrl(name);
  if (url) R.thumbs.set(name, url);
  return url;
}

const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    const name = e.target.dataset.name;
    thumbUrl(name).then((url) => { if (url && e.target.dataset.name === name) e.target.src = url; });
  }
}, { root: $('nameList'), rootMargin: '200px 0px' });

// ============================================================ saved card

function showSavedCard(idx, blob) {
  const it = S.items[idx];
  const card = $('savedCard');
  $('savedImg').src = R.thumbs.get(it.name) || '';
  $('savedName').textContent = it.name;
  $('savedSub').textContent = `${it.w} × ${it.h} px · page ${it.page}`;
  card.dataset.i = idx;
  card.hidden = false;
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  clearTimeout(R.savedTimer);
  const hide = () => { R.savedTimer = setTimeout(() => { if (!card.matches(':hover')) card.hidden = true; else hide(); }, 5000); };
  hide();
}

// ============================================================ active name, list, top bar

/** opts.showPrev: when the name is Done, put its saved crop box back on the page to adjust. */
function setActive(i, opts = {}) {
  const prev = S.active;
  S.active = S.items[i] ? i : -1;
  // never leave another name's saved box on screen
  if (R.prevShown && prev !== S.active) viewer.clearBox();
  if (prev !== S.active) refreshRow(prev);
  if (S.active >= 0) {
    if (!R.rows.has(S.active) && (S.pendingOnly || $('searchInput').value)) renderList();
    refreshRow(S.active);
    const row = R.rows.get(S.active);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  R.textOpen = false;
  renderTop();
  updatePanelName();
  const shown = opts.showPrev && showPrevBox();
  locateActive({ scroll: !shown });
  persist();
}

function showPrevBox() {
  const it = S.items[S.active];
  if (!it || it.status !== 'done' || !it.box || it.pdf !== S.currentPdf || !viewer.doc) return false;
  viewer.setBox({ ...it.box });
  R.prevShown = true;
  if (!viewer.isYVisible(it.box.y0)) viewer.scrollToY(Math.max(0, it.box.y0 - 40));
  showPanel();
  return true;
}

// ---------- finding the active question in the PDF

let locateToken = 0;
async function locateActive({ scroll = true } = {}) {
  const token = ++locateToken;
  const it = S.items[S.active];
  R.found = null;
  viewer.setMarker(null);
  if (!it || !viewer.doc) { R.finding = false; renderFind(); return; }
  R.finding = true;
  renderFind();
  let res = null;
  try { res = await viewer.findQuestion(it); } catch (e) { console.warn('Search failed', e); }
  if (token !== locateToken) return;
  R.finding = false;
  R.found = res ? { index: S.active, result: res } : null;
  renderFind();
  if (!res) return;
  viewer.setMarker({ page: res.page, y: res.y, label: `▶ ${qnoLabel(it.qno) || 'Question'}` });
  const y = viewer.docY(res.page, res.y);
  if (scroll && S.settings.autoFind && !viewer.box && !viewer.drag && !viewer.isYVisible(y)) {
    viewer.scrollToY(Math.max(0, y - 24), 'smooth');
  }
  if (viewer.box) schedulePreview();
}

function renderFind() {
  const el = $('findInfo');
  el.innerHTML = '';
  const it = S.items[S.active];
  if (!it || !viewer.doc) { el.hidden = true; return; }
  el.hidden = false;
  const label = qnoLabel(it.qno) || 'This question';
  const span = document.createElement('span');
  if (R.finding) {
    span.className = 'notfound';
    span.textContent = `Looking for ${label}…`;
  } else if (R.found) {
    span.className = 'found';
    span.textContent = `${label} is on page ${R.found.result.page}`;
  } else if (viewer.text && !viewer.hasText()) {
    span.className = 'notfound';
    span.textContent = 'Question search off (no text in PDF)';
    span.title = 'This PDF has no text layer (for example a scan or phone photo), so questions cannot be found automatically.';
  } else {
    span.className = 'notfound';
    span.textContent = it.qno || it.text ? `${label} not found in this PDF` : '';
  }
  el.appendChild(span);
  if (R.found && !R.finding) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = 'Show';
    b.onclick = () => {
      const r = R.found && R.found.result;
      if (r) viewer.scrollToY(Math.max(0, viewer.docY(r.page, r.y) - 24), 'smooth');
    };
    el.appendChild(b);
  }
}

function matches(it, q) {
  if (!q) return true;
  const qno = String(it.qno || '').toLowerCase();
  return it.name.toLowerCase().includes(q) || qno === q || qno.startsWith(q) || `q${qno}` === q;
}

function renderList() {
  const ul = $('nameList');
  ul.innerHTML = '';
  R.rows.clear();
  const q = $('searchInput').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;
  S.items.forEach((it, i) => {
    if (!matches(it, q)) return;
    if (S.pendingOnly && it.status !== 'pending' && i !== S.active) return;
    const li = document.createElement('li');
    li.dataset.i = i;
    li.setAttribute('role', 'option');
    fillRow(li, it, i);
    frag.appendChild(li);
    R.rows.set(i, li);
    shown++;
  });
  ul.appendChild(frag);
  $('sideEmpty').hidden = S.items.length > 0;
  $('nameList').hidden = !S.items.length;
  const c = counts();
  $('sideCounts').textContent = !S.items.length ? ''
    : (q || S.pendingOnly) ? `Showing ${shown} of ${S.items.length} names`
      : `${S.items.length} names · ${c.done} done · ${c.skipped} skipped · ${c.pending} pending`;
  if (q && !shown) {
    ul.innerHTML = '<li class="muted" style="padding:12px">No names match your search.</li>';
  }
}

function fillRow(li, it, i) {
  const active = i === S.active;
  li.className = `row ${it.status}${active ? ' active' : ''}`;
  li.setAttribute('aria-selected', String(active));
  li.tabIndex = active ? 0 : -1;
  li.title = `${it.name} — ${X.STATUS_LABEL[it.status]}. Click to make it the active name.`;
  li.innerHTML = '';
  const st = document.createElement('span');
  st.className = 'st';
  st.textContent = it.status === 'done' ? '✓' : it.status === 'skipped' ? '–' : '';
  st.setAttribute('aria-label', X.STATUS_LABEL[it.status]);
  const nm = document.createElement('div');
  nm.className = 'nm';
  const fn = document.createElement('div');
  fn.className = 'fn';
  fn.textContent = it.name;
  const sm = document.createElement('small');
  const bits = [qnoLabel(it.qno)];
  if (it.status === 'done') bits.push(it.page ? `page ${it.page}` : it.source === 'folder' ? 'already in folder' : '');
  if (it.copyOf) bits.push(`same as ${it.copyOf}`);
  if (it.status === 'skipped') bits.push(it.note ? `Skipped: ${it.note}` : 'Skipped');
  sm.textContent = bits.filter(Boolean).join(' · ');
  if (Pz.isCustom(it.edit) || (it.edit && it.edit.assigned && it.status === 'pending')) {
    const c = document.createElement('span');
    c.className = 'custom-tag';
    c.textContent = ' · custom';
    c.title = Pz.customSummary(it.edit) || `Uses "${(presetById(it.edit.presetId) || activePreset()).name}"`;
    sm.appendChild(c);
  }
  if (it.status === 'done' && it.warnings && it.warnings.length) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = ' · ⚠ check';
    w.title = it.warnings.map((c) => X.WARN_LABEL[c] || c).join(', ');
    sm.appendChild(w);
  }
  nm.append(fn, sm);
  li.append(st, nm);
  if (it.status === 'done') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb';
    b.title = 'Enlarge';
    b.setAttribute('aria-label', `Enlarge ${it.name}`);
    const im = document.createElement('img');
    im.alt = '';
    im.dataset.name = it.name;
    const url = R.thumbs.get(it.name);
    if (url) im.src = url; else thumbObserver.observe(im);
    b.appendChild(im);
    li.appendChild(b);
  } else {
    li.appendChild(document.createElement('span'));
  }
}

function refreshRow(i) {
  if (i < 0 || !S.items[i]) return;
  const li = R.rows.get(i);
  if (li) fillRow(li, S.items[i], i);
  const c = counts();
  if (!$('searchInput').value && !S.pendingOnly && S.items.length) {
    $('sideCounts').textContent = `${S.items.length} names · ${c.done} done · ${c.skipped} skipped · ${c.pending} pending`;
  }
}

function renderTop() {
  const it = S.items[S.active];
  const nameEl = $('activeName');
  const c = counts();
  if (!S.items.length) {
    nameEl.textContent = 'No names loaded';
    nameEl.className = 'active-name none';
    $('activeLabel').textContent = 'Now cropping';
  } else if (!it) {
    nameEl.textContent = 'All names are done or skipped';
    nameEl.className = 'active-name none';
    $('activeLabel').textContent = 'Nothing left to crop';
  } else {
    nameEl.textContent = it.name;
    nameEl.className = 'active-name';
    $('activeLabel').textContent = 'Now cropping — the next approved crop is saved as';
  }
  const badge = $('activeBadge');
  badge.hidden = !it || it.status === 'pending';
  if (it && it.status === 'done') { badge.textContent = 'Done — approving replaces the file'; badge.className = 'badge'; }
  if (it && it.status === 'skipped') { badge.textContent = 'Skipped'; badge.className = 'badge skipped'; }

  const meta = $('activeMeta');
  meta.hidden = !it || (!it.qno && !it.text);
  if (it) {
    $('activeQno').textContent = qnoLabel(it.qno);
    const long = it.text.length > TEXT_LEN;
    $('activeText').textContent = R.textOpen || !long ? it.text : `${it.text.slice(0, TEXT_LEN).trimEnd()}…`;
    $('toggleTextBtn').hidden = !long;
    $('toggleTextBtn').textContent = R.textOpen ? 'Show less' : 'Show more';
    meta.classList.toggle('expanded', R.textOpen);
    document.querySelector('.topbar').classList.toggle('text-open', R.textOpen && long);
  }
  const note = $('activeNote');
  note.hidden = !(it && it.status === 'skipped' && it.note);
  if (it && it.note) note.textContent = `Note: ${it.note}`;

  const next = $('nextNames');
  next.innerHTML = '';
  const upcoming = pendingAfter(S.active, 3);
  if (upcoming.length) {
    next.append('Next: ');
    for (const u of upcoming) {
      const code = document.createElement('code');
      code.textContent = u.name;
      next.appendChild(code);
    }
  }

  const total = S.items.length;
  $('progressText').textContent = `${c.done} / ${total} done`;
  const pct = total ? Math.round((c.done / total) * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressBarWrap').setAttribute('aria-valuenow', pct);
  $('progressSub').textContent = total ? `${c.skipped} skipped · ${c.pending} pending` : ' ';

  $('undoBtn').disabled = !R.undo.length;
  $('skipBtn').disabled = !it;
  $('copyActiveBtn').hidden = !(it && it.status === 'done');
  renderFolder();
  renderBanner();
}

function renderFolder() {
  const nameEl = $('folderName');
  const btn = $('folderBtn');
  if (!folder.supported) {
    nameEl.textContent = 'Downloads (browser saves)';
    nameEl.className = 'folder-name';
    btn.hidden = true;
  } else if (folder.isReady()) {
    nameEl.textContent = folder.name();
    nameEl.className = 'folder-name';
    btn.textContent = 'Change folder';
    btn.hidden = false;
  } else {
    nameEl.textContent = R.savedHandle ? `${R.savedHandle.name} (not connected)` : 'Not chosen';
    nameEl.className = 'folder-name missing';
    btn.textContent = R.savedHandle ? 'Reconnect folder' : 'Choose images folder';
    btn.hidden = false;
  }
  nameEl.title = nameEl.textContent;
}

function renderBanner() {
  const b = $('banner');
  b.innerHTML = '';
  b.className = 'banner';
  const add = (el) => b.appendChild(el);
  const text = (t) => { const s = document.createElement('span'); s.textContent = t; add(s); };
  const button = (label, action, primary) => {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = `btn small${primary ? ' primary' : ''}`;
    x.textContent = label;
    x.dataset.action = action;
    add(x);
  };
  if (R.folderError) {
    b.classList.add('error');
    text(R.folderError);
    button('Change folder', 'choose-folder', true);
  } else if (folder.supported && !folder.isReady()) {
    text('Choose the images folder first.');
    if (R.savedHandle) {
      button(`Reconnect folder "${R.savedHandle.name}"`, 'reconnect-folder', true);
      button('Choose a different folder', 'choose-folder');
    } else {
      button('Choose images folder', 'choose-folder', true);
    }
  } else if (!S.items.length) {
    text('Load the image names first.');
    button('Load names', 'open-setup', true);
  } else if (!folder.supported) {
    text('This browser cannot save into a folder. Each image downloads with the correct name to your Downloads folder.');
  }
  b.hidden = !b.childNodes.length;
  $('scroller').classList.toggle('blocked', !!canCrop() && !R.busy);
}

// ============================================================ PDF

function explainPdf(e) {
  if (e && e.name === 'PasswordException') return 'This PDF is password protected. Remove the password and try again.';
  if (e && e.name === 'InvalidPDFException') return 'This file is not a valid PDF, or it is damaged.';
  return `Could not open the PDF. ${e && e.message ? e.message : ''}`;
}

async function openDoc(buf) {
  return pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
}

async function openPdfFile(file) {
  $('pdfError').hidden = true;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showPdfError(`"${file.name}" is not a PDF file.`);
    return false;
  }
  try {
    const buf = await file.arrayBuffer();
    const doc = await openDoc(buf.slice(0));
    R.docs.set(file.name, doc);
    await rememberPdf(file.name, buf);
    await showPdf(file.name);
    return true;
  } catch (e) {
    showPdfError(`${file.name}: ${explainPdf(e)}`);
    return false;
  }
}

function showPdfError(msg) {
  const el = $('pdfError');
  el.textContent = msg;
  el.hidden = false;
  toast(msg, 'error');
}

async function rememberPdf(name, buf) {
  const before = S.recentPdfs;
  S.recentPdfs = [name, ...before.filter((n) => n !== name)].slice(0, MAX_RECENT_PDFS);
  for (const n of before) if (!S.recentPdfs.includes(n)) db.del(`pdf:${n}`);
  const ok = await db.set(`pdf:${name}`, buf);
  if (!ok) S.recentPdfs = S.recentPdfs.filter((n) => n !== name);
  persist();
}

async function reopenPdf(name, quiet) {
  if (R.docs.has(name)) { await showPdf(name); return true; }
  const buf = await db.get(`pdf:${name}`);
  if (!buf) {
    S.recentPdfs = S.recentPdfs.filter((n) => n !== name);
    if (!quiet) toast(`${name} is no longer stored in the browser. Click "Choose PDF" and pick it again.`, 'warn');
    renderToolbar();
    return false;
  }
  try {
    const doc = await openDoc(buf.slice(0));
    R.docs.set(name, doc);
    await showPdf(name);
    return true;
  } catch (e) {
    if (!quiet) showPdfError(explainPdf(e));
    return false;
  }
}

async function showPdf(name) {
  const doc = R.docs.get(name);
  if (!doc) return;
  saveView();
  S.currentPdf = name;
  hidePanel();
  if (R.detectPages) { for (const k of R.detectPages) proc.previewWorker().drop(k); R.detectPages = []; }
  $('pdfEmpty').hidden = true;
  await viewer.load(doc, S.views[name]);
  renderToolbar();
  updatePageIndicator();
  persist();
  viewer.textIndex();
  locateActive({ scroll: false });
}

function renderToolbar() {
  const sel = $('pdfSelect');
  sel.innerHTML = '';
  for (const n of R.docs.keys()) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    o.selected = n === S.currentPdf;
    sel.appendChild(o);
  }
  sel.hidden = R.docs.size === 0;
  $('openPdfLabel').textContent = R.docs.size ? 'Open another PDF' : 'Choose PDF';
  const has = !!viewer.doc;
  $('pageCount').textContent = `of ${has ? viewer.pages.length : 0}`;
  $('pageInput').max = has ? viewer.pages.length : 1;
  $('zoomVal').textContent = has ? `${viewer.zoomPercent()}%` : '—';
  for (const id of ['zoomInBtn', 'zoomOutBtn', 'fitBtn', 'goPageBtn', 'pageInput']) $(id).disabled = !has;
  $('lastSavedBtn').disabled = !S.lastSaved;
  $('toolHint').textContent = S.settings.clickCrop !== false
    ? 'Click a diagram to select it, or drag a box. Ctrl + wheel to zoom.'
    : 'Drag over a diagram to crop. Ctrl + wheel to zoom.';
  $('pdfEmpty').hidden = has;
  const recent = $('recentPdfs');
  recent.innerHTML = '';
  for (const n of S.recentPdfs) {
    if (R.docs.has(n)) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = `Reopen ${n}`;
    b.dataset.reopen = n;
    recent.appendChild(b);
  }
  $('setupPdfStatus').textContent = has ? `✓ ${S.currentPdf} (${viewer.pages.length} pages)` : 'No PDF open';
  $('setupPdfStatus').className = `status-line${has ? ' ok' : ''}`;
}

async function ensurePdf(name) {
  if (S.currentPdf === name && viewer.doc) return true;
  if (R.docs.has(name)) { await showPdf(name); return true; }
  if (S.recentPdfs.includes(name)) return reopenPdf(name);
  toast(`Open ${name} first to see this page.`, 'warn');
  return false;
}

async function goToLastSaved() {
  const ls = S.lastSaved;
  if (!ls) return;
  if (!(await ensurePdf(ls.pdf))) return;
  viewer.scrollToY(ls.y, 'smooth');
}

function goToPage() {
  const n = parseInt($('pageInput').value, 10);
  if (!viewer.doc) return;
  if (!(n >= 1 && n <= viewer.pages.length)) { toast(`Enter a page number from 1 to ${viewer.pages.length}.`, 'warn'); return; }
  viewer.scrollToPage(n);
}

// ============================================================ folder

async function chooseFolder() {
  if (!folder.supported) {
    toast('This browser cannot save into a folder. Images will be downloaded instead.', 'warn');
    return;
  }
  let h;
  try {
    h = await folder.pick();
  } catch (e) {
    setFolderError(folder.explain(e));
    return;
  }
  if (!h) return;
  const check = await folder.checkWritable(h);
  if (!check.ok) {
    setFolderError(`Cannot save in "${h.name}". ${check.message}`);
    toast(check.message, 'error');
    return;
  }
  const changed = folder.isReady() && folder.name() !== h.name;
  try {
    await folder.connect(h);
  } catch (e) {
    setFolderError(folder.explain(e));
    return;
  }
  R.savedHandle = h;
  S.folderName = h.name;
  setFolderError('');
  const found = markFromFolder();
  toast(found ? `Folder "${h.name}" is ready. ${plural(found, 'image')} already in it ${found === 1 ? 'is' : 'are'} marked Done.`
    : `Folder "${h.name}" is ready.${changed ? ' Images saved earlier stay in the old folder.' : ''}`, 'ok', 5000);
  renderAll();
  persist();
}

async function reconnectFolder() {
  const r = await folder.reconnect(true);
  if (!r.ok) {
    if (r.message) setFolderError(`Could not reconnect to "${r.name || S.folderName}". ${r.message}`);
    else toast('Permission was not given. Click "Reconnect folder" again and choose "Allow".', 'warn');
    return;
  }
  setFolderError('');
  S.folderName = folder.name();
  const found = markFromFolder();
  toast(`Reconnected to "${folder.name()}".${found ? ` ${plural(found, 'more image')} found and marked Done.` : ''}`, 'ok');
  renderAll();
  persist();
}

function setFolderError(msg) {
  R.folderError = msg;
  $('folderError').textContent = msg;
  $('folderError').hidden = !msg;
  renderBanner();
  renderSetup();
}

/** Marks pending names that already have a file in the folder as Done. Returns how many. */
function markFromFolder() {
  if (!folder.supported || !folder.isReady()) return 0;
  let n = 0;
  const activeWasPending = S.items[S.active] && S.items[S.active].status === 'pending';
  for (const it of S.items) {
    if (it.status === 'pending' && folder.hasFile(it.name)) {
      it.status = 'done';
      it.source = 'folder';
      it.savedAt = it.savedAt || Date.now();
      n++;
    }
  }
  if (n && activeWasPending && S.items[S.active].status !== 'pending') S.active = nextPending(S.active);
  return n;
}

// ============================================================ setup

function openSetup() {
  renderSetup();
  openDialog($('setupDialog'));
}

function renderSetup() {
  const folderOk = !folder.supported || folder.isReady();
  $('stepFolder').classList.toggle('complete', folderOk && folder.supported);
  $('fallbackNote').hidden = folder.supported;
  $('setupFolderBtn').hidden = !folder.supported;
  $('setupFolderBtn').textContent = folder.isReady() ? 'Change folder' : R.savedHandle ? `Reconnect folder "${R.savedHandle.name}"` : 'Choose images folder';
  const fs = $('setupFolderStatus');
  fs.textContent = !folder.supported ? '' : folder.isReady() ? `✓ ${folder.name()}` : 'Not chosen yet';
  fs.className = `status-line${folder.isReady() ? ' ok' : ''}`;
  $('stepNames').classList.toggle('complete', S.items.length > 0 && !R.draft);
  $('stepPdf').classList.toggle('complete', !!viewer.doc);
  const c = counts();
  $('setupSummary').textContent = S.items.length ? `${S.items.length} names in the list · ${c.done} done` : '';
  $('startBtn').disabled = !S.items.length;
}

function setTab(which) {
  const excel = which === 'excel';
  $('tabPaste').setAttribute('aria-selected', String(!excel));
  $('tabExcel').setAttribute('aria-selected', String(excel));
  $('panePaste').hidden = excel;
  $('paneExcel').hidden = !excel;
}

function checkPasted() {
  const entries = N.entriesFromText($('pasteArea').value);
  if (!entries.length) {
    R.draft = null;
    renderReview();
    toast('Paste at least one name, one per line.', 'warn');
    return;
  }
  R.draft = { source: 'paste', entries, fix: false };
  renderReview();
}

async function onExcelFile(file) {
  const errEl = $('excelError');
  errEl.hidden = true;
  $('excelFileName').textContent = file.name;
  let bytes;
  let wb;
  try {
    bytes = await file.arrayBuffer();
    wb = XLSX.read(bytes, { type: 'array' });
  } catch (e) {
    showExcelError('Could not read this file. Open it in Excel, save it as .xlsx, and try again.');
    return;
  }
  if (!wb.SheetNames.length) { showExcelError('This Excel file has no sheets.'); return; }
  R.excelDraft = { fileName: file.name, bytes, wb };
  const sel = $('sheetSelect');
  sel.innerHTML = '';
  for (const n of wb.SheetNames) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  // first sheet that has an image-like column, else the first sheet
  const best = wb.SheetNames.find((n) => {
    const rows = sheetRows(wb.Sheets[n]);
    const hr = N.findHeaderRow(rows);
    return hr >= 0 && N.detectColumns(rows[hr]).image >= 0;
  }) || wb.SheetNames[0];
  sel.value = best;
  loadSheet(best);
}

function sheetRows(ws) {
  if (!ws || !ws['!ref']) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: false });
}

function showExcelError(msg) {
  const el = $('excelError');
  el.textContent = msg;
  el.hidden = false;
  R.draft = null;
  renderReview();
}

function colLetter(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function loadSheet(sheetName) {
  const d = R.excelDraft;
  const ws = d.wb.Sheets[sheetName];
  $('excelError').hidden = true;
  const rows = sheetRows(ws);
  const headerRow = N.findHeaderRow(rows);
  if (headerRow < 0) {
    $('excelCols').hidden = false;
    showExcelError(`The sheet "${sheetName}" is empty.`);
    return;
  }
  const origin = XLSX.utils.decode_range(ws['!ref']).s;
  const headers = rows[headerRow].map((h) => String(h ?? '').trim());
  const cols = N.detectColumns(headers);
  Object.assign(d, { sheet: sheetName, rows, headerRow, origin, headers, cols });
  const fill = (id, value, noneLabel) => {
    const sel = $(id);
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '-1';
    none.textContent = noneLabel;
    sel.appendChild(none);
    headers.forEach((h, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${colLetter(origin.c + i)}: ${h || '(no heading)'}`;
      sel.appendChild(o);
    });
    sel.value = String(value);
  };
  fill('colImage', cols.image, '— choose a column —');
  fill('colQno', cols.qno, '— not used —');
  fill('colText', cols.text, '— not used —');
  $('excelCols').hidden = false;
  buildExcelDraft();
}

function buildExcelDraft() {
  const d = R.excelDraft;
  if (!d || !d.rows) return;
  d.cols = {
    image: Number($('colImage').value),
    qno: Number($('colQno').value),
    text: Number($('colText').value),
  };
  $('excelError').hidden = true;
  if (d.cols.image < 0) {
    showExcelError('Could not find the image name column (like imagePath or imageName). Choose it from "Image name column".');
    return;
  }
  const entries = N.entriesFromRows(d.rows, d.cols, d.headerRow);
  if (!entries.length) {
    showExcelError(`No image names found in column "${d.headers[d.cols.image] || colLetter(d.origin.c + d.cols.image)}". Check that you picked the right column and sheet.`);
    return;
  }
  R.draft = {
    source: 'excel', entries, fix: false, bytes: d.bytes,
    excel: { fileName: d.fileName, sheet: d.sheet, headerRow: d.headerRow, origin: d.origin, cols: d.cols },
  };
  renderReview();
}

function renderReview() {
  const box = $('review');
  const d = R.draft;
  box.innerHTML = '';
  if (!d) { box.hidden = true; renderSetup(); return; }
  box.hidden = false;
  const res = N.buildNameList(d.entries, { fix: d.fix });
  d.result = res;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const extra = [];
  if (res.removedBlank) extra.push(`${res.removedBlank} blank removed`);
  if (res.removedDuplicate) extra.push(`${res.removedDuplicate} repeated removed`);
  box.appendChild(el('div', 'summary', `${plural(res.names.length, 'name')} found${extra.length ? ` (${extra.join(', ')})` : ''}.`));

  if (folder.isReady()) {
    const have = res.names.filter((n) => folder.hasFile(n.name)).length;
    if (have) box.appendChild(el('div', 'muted', `${have} of these already ${have === 1 ? 'has' : 'have'} a file in the folder and will be marked Done.`));
  }

  if (d.fix) {
    const changes = [];
    const seen = new Set();
    for (const e of d.entries) {
      const before = N.cleanName(e.raw);
      const after = before && N.fixName(before);
      if (before && before !== after && !seen.has(before)) { seen.add(before); changes.push([before, after]); }
    }
    box.appendChild(el('div', 'status-line ok', `Names were fixed automatically (${plural(changes.length, 'name')} changed).`));
    if (changes.length) {
      const wrap = el('div', 'problems');
      const t = el('table');
      t.innerHTML = '<thead><tr><th>Was</th><th>Now</th></tr></thead>';
      const tb = el('tbody');
      for (const [a, b] of changes.slice(0, 300)) {
        const tr = el('tr');
        const td1 = el('td'); td1.appendChild(el('code', '', a));
        const td2 = el('td'); td2.appendChild(el('code', '', b));
        tr.append(td1, td2);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      wrap.appendChild(t);
      box.appendChild(wrap);
    }
    if (res.problems.length) box.appendChild(el('div', 'err', `${plural(res.problems.length, 'name')} still need${res.problems.length === 1 ? 's' : ''} attention.`));
    const undoFix = el('button', 'btn small', 'Undo the fix (keep original names)');
    undoFix.type = 'button';
    undoFix.onclick = () => { d.fix = false; renderReview(); };
    box.appendChild(undoFix);
  } else if (res.problems.length) {
    box.appendChild(el('div', 'err', `${plural(res.problems.length, 'name')} may cause problems:`));
    const wrap = el('div', 'problems');
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Name</th><th>Problem</th><th>Fixed version</th></tr></thead>';
    const tb = el('tbody');
    for (const p of res.problems.slice(0, 300)) {
      const tr = el('tr');
      const td1 = el('td'); td1.appendChild(el('code', '', p.name));
      const td2 = el('td', '', p.problems.join(', '));
      const td3 = el('td'); td3.appendChild(el('code', '', p.fixed));
      tr.append(td1, td2, td3);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);
    const row = el('div', 'row-gap');
    const fix = el('button', 'btn primary small', 'Fix automatically');
    fix.type = 'button';
    fix.onclick = () => { d.fix = true; renderReview(); };
    row.append(fix, el('span', 'muted', 'Lowercase, spaces become underscores, special characters removed. Or keep them as they are.'));
    box.appendChild(row);
  } else {
    box.appendChild(el('div', 'status-line ok', '✓ All names look fine.'));
  }

  const actions = el('div', 'row-gap');
  if (S.items.length) {
    const add = el('button', 'btn primary', 'Add to current list');
    add.type = 'button';
    add.onclick = () => applyNames('add');
    const rep = el('button', 'btn', 'Replace current list');
    rep.type = 'button';
    rep.onclick = () => applyNames('replace');
    actions.append(add, rep);
  } else {
    const use = el('button', 'btn primary', `Use ${res.names.length === 1 ? 'this name' : `these ${res.names.length} names`}`);
    use.type = 'button';
    use.onclick = () => applyNames('replace');
    actions.appendChild(use);
  }
  if (!res.names.length) for (const b of actions.querySelectorAll('button')) b.disabled = true;
  box.appendChild(actions);
  renderSetup();
}

async function applyNames(mode) {
  const d = R.draft;
  if (!d || !d.result || !d.result.names.length) return;
  const res = d.result;
  if (mode === 'replace' && S.items.length) {
    const ok = await confirmBox('Replace the current list?',
      `This removes the ${S.items.length} names in the current list and their progress. Files already saved in the folder are not deleted.`,
      'Replace list', true);
    if (!ok) return;
  }
  if (mode === 'replace') {
    S.items = [];
    S.active = -1;
    S.excel = null;
    R.undo = [];
  }
  if (d.source === 'excel') {
    for (const it of S.items) it.rows = [];
    S.excel = d.excel;
    await db.set('excel', d.bytes);
  }
  const index = new Map(S.items.map((it, i) => [it.name, i]));
  let added = 0;
  let kept = 0;
  for (const n of res.names) {
    const j = index.get(n.name);
    if (j !== undefined) {
      const it = S.items[j];
      kept++;
      if (!it.qno) it.qno = n.qno;
      if (!it.text) it.text = n.text.slice(0, 1000);
      if (d.source === 'excel') it.rows = n.rows;
    } else {
      index.set(n.name, S.items.length);
      S.items.push(newItem(n));
      added++;
    }
  }
  if (folder.isReady()) { try { await folder.scan(); } catch { /* keep old listing */ } }
  const found = markFromFolder();
  if (!S.items[S.active] || (mode === 'replace')) S.active = nextPending(-1);
  R.draft = null;
  if (d.source === 'paste') $('pasteArea').value = '';
  renderReview();
  renderAll();
  persist();
  toast(`${plural(added, 'name')} added${kept ? `, ${kept} ${kept === 1 ? 'was' : 'were'} already in the list` : ''}${found ? `. ${found} already ${found === 1 ? 'has a file and is' : 'have a file and are'} marked Done` : ''}.`, 'ok', 5000);
}

async function resetAll() {
  const ok = await confirmBox('Reset everything?',
    'This clears the name list and all progress (statuses, notes, page info). Files already saved in the folder are not deleted.',
    'Reset', true);
  if (!ok) return;
  const keep = { settings: S.settings, customPresets: S.customPresets, activePresetId: S.activePresetId, defaultPresetId: S.defaultPresetId };
  S = freshState();
  Object.assign(S, keep);
  S.folderName = folder.name();
  S.currentPdf = viewer.doc ? [...R.docs.entries()].find(([, doc]) => doc === viewer.doc)?.[0] || '' : '';
  S.recentPdfs = [...R.docs.keys()].slice(0, MAX_RECENT_PDFS);
  R.undo = [];
  for (const n of [...R.thumbs.keys()]) dropBlob(n);
  await db.del('excel');
  for (const k of await db.keys()) if (String(k).startsWith('blob:') || String(k).startsWith('orig:')) await db.del(k);
  viewer.clearBox();
  $('savedCard').hidden = true;
  saveNow();
  renderAll();
  toast('Everything was reset.', 'ok');
}

// ============================================================ finish and check

function renderReport() {
  const wrap = $('reportCols');
  wrap.innerHTML = '';
  const groups = [
    ['done', 'Done', (it) => it.name],
    ['skipped', 'Skipped', (it) => (it.note ? `${it.name}\t${it.note}` : it.name)],
    ['pending', 'Pending', (it) => it.name],
  ];
  for (const [status, label, line] of groups) {
    const list = S.items.filter((it) => it.status === status);
    const col = document.createElement('div');
    col.className = `report-col ${status}`;
    const head = document.createElement('header');
    const h = document.createElement('strong');
    h.textContent = `${label} (${list.length})`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn small';
    copy.textContent = 'Copy';
    copy.disabled = !list.length;
    copy.onclick = () => copyText(list.map(line).join('\n'), `${list.length} ${label.toLowerCase()} names`);
    head.append(h, copy);
    const ul = document.createElement('ul');
    for (const it of list) {
      const li = document.createElement('li');
      li.textContent = it.name;
      if (status === 'skipped' && it.note) {
        const sm = document.createElement('small');
        sm.textContent = ` — ${it.note}`;
        li.appendChild(sm);
      }
      ul.appendChild(li);
    }
    if (!list.length) ul.innerHTML = '<li><small>None</small></li>';
    col.append(head, ul);
    wrap.appendChild(col);
  }
}

async function verify() {
  const out = $('verifyResult');
  out.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'verify-box';
  out.appendChild(box);
  const p = (t, cls) => { const e = document.createElement('p'); if (cls) e.className = cls; e.textContent = t; box.appendChild(e); return e; };
  const list = (names) => {
    const ul = document.createElement('ul');
    for (const n of names.slice(0, 500)) { const li = document.createElement('li'); li.textContent = n; ul.appendChild(li); }
    box.appendChild(ul);
  };
  if (!S.items.length) { p('There are no names in the list.'); return; }
  if (!folder.supported) {
    const done = S.items.filter((it) => it.status === 'done').length;
    p(`This browser downloads images instead of saving into a folder, so the folder cannot be checked. ${done} images were downloaded. Check your Downloads folder, or use "All images (ZIP)".`);
    return;
  }
  if (!folder.isReady()) { p('Choose or reconnect the images folder first, then check again.', 'err'); return; }
  try {
    await folder.scan();
  } catch (e) {
    p(folder.explain(e), 'err');
    return;
  }
  const missing = S.items.filter((it) => !folder.hasFile(it.name));
  const doneMissing = missing.filter((it) => it.status === 'done');
  const notDoneButFound = S.items.filter((it) => it.status !== 'done' && folder.hasFile(it.name));
  const inList = new Set(S.items.map((it) => it.name.toLowerCase()));
  const extras = folder.fileNames().filter((f) => !inList.has(f.toLowerCase()));

  if (!missing.length) {
    box.classList.add('ok');
    p(`✓ All ${S.items.length} names have a file in the folder "${folder.name()}".`);
  } else {
    box.classList.add('bad');
    p(`${missing.length} of ${plural(S.items.length, 'name')} ${missing.length === 1 ? 'has' : 'have'} no file in the folder "${folder.name()}":`, 'err');
    list(missing.map((it) => {
      const cm = folder.caseMismatch(it.name);
      return `${it.name}  (${X.STATUS_LABEL[it.status]}${cm ? `; the folder has "${cm}" with different capital letters` : ''})`;
    }));
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn small';
    copyBtn.textContent = 'Copy missing names';
    copyBtn.onclick = () => copyText(missing.map((it) => it.name).join('\n'), `${missing.length} missing names`);
    box.appendChild(copyBtn);
  }
  if (doneMissing.length) {
    p(`${plural(doneMissing.length, 'name')} ${doneMissing.length === 1 ? 'is' : 'are'} marked Done but the file is missing (deleted, renamed, or saved in another folder).`, 'err');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small primary';
    b.textContent = 'Mark these as Pending';
    b.onclick = () => {
      for (const it of doneMissing) { it.status = 'pending'; it.source = ''; }
      if (!S.items[S.active]) S.active = nextPending(-1);
      renderAll(); persist(); renderReport(); verify();
    };
    box.appendChild(b);
  }
  if (notDoneButFound.length) {
    p(`${plural(notDoneButFound.length, 'name')} ${notDoneButFound.length === 1 ? 'has a file but is' : 'have a file but are'} not marked Done.`);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = 'Mark these as Done';
    b.onclick = () => {
      for (const it of notDoneButFound) { it.status = 'done'; it.source = it.source || 'folder'; }
      if (S.items[S.active] && S.items[S.active].status !== 'pending') S.active = nextPending(S.active);
      renderAll(); persist(); renderReport(); verify();
    };
    box.appendChild(b);
  }
  if (extras.length) p(`${plural(extras.length, 'other image')} in the folder ${extras.length === 1 ? 'is' : 'are'} not in your list: ${extras.slice(0, 20).join(', ')}${extras.length > 20 ? ', …' : ''}`, 'muted');
}

async function exportZip() {
  const done = S.items.filter((it) => it.status === 'done');
  if (!done.length) { toast('No images are saved yet.', 'warn'); return; }
  if (folder.supported && !folder.isReady()) { toast('Reconnect the images folder first.', 'warn'); return; }
  toast(`Making the ZIP of ${done.length} images…`);
  const zip = new JSZip();
  const missing = [];
  for (const it of done) {
    let blob = R.blobs.get(it.name);
    if (!blob) { try { blob = await folder.readFile(it.name); } catch { blob = null; } }
    if (blob) zip.file(it.name, blob); else missing.push(it.name);
  }
  const out = await zip.generateAsync({ type: 'blob' });
  folder.download(out, `images_${X.stamp()}.zip`);
  toast(missing.length ? `ZIP saved. ${missing.length} files were missing from the folder: ${missing.slice(0, 5).join(', ')}` : `ZIP saved with ${done.length} images.`, missing.length ? 'warn' : 'ok', 6000);
}

async function exportExcel() {
  if (!S.items.length) { toast('There are no names in the list.', 'warn'); return; }
  try {
    const bytes = S.excel ? await db.get('excel') : null;
    const wb = X.updatedWorkbook(XLSX, S.items, S.excel, bytes);
    const base = S.excel ? S.excel.fileName.replace(/\.[^.]+$/, '') : 'image-names';
    XLSX.writeFile(wb, `${base}_with_image_status.xlsx`);
    if (S.excel && !bytes) toast('The original Excel was not found in the browser, so a new sheet was made.', 'warn');
  } catch (e) {
    toast(`Could not make the Excel file. ${e.message}`, 'error');
  }
}

async function restoreBackup(file) {
  let state;
  try {
    state = X.parseBackup(await file.text());
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const ok = await confirmBox('Restore this backup?',
    `The backup has ${state.items.length} names. It replaces the current list and progress (${S.items.length} names).`, 'Restore');
  if (!ok) return;
  S = sanitize(state);
  R.undo = [];
  markFromFolder();
  saveNow();
  renderAll();
  renderReport();
  toast(`Backup restored: ${S.items.length} names.`, 'ok');
}

// ============================================================ review gallery

function openReview() {
  if (!S.items.some((it) => it.status === 'done')) { toast('No images are saved yet.', 'warn'); return; }
  renderGallery();
  openDialog($('reviewDialog'));
}

function renderGallery() {
  const g = $('gallery');
  g.innerHTML = '';
  const warnOnly = $('reviewWarnOnly').checked;
  if (!R.gSel) R.gSel = new Set();
  let shown = 0;
  S.items.forEach((it, i) => {
    if (it.status !== 'done') { R.gSel.delete(i); return; }
    if (warnOnly && !(it.warnings && it.warnings.length)) return;
    shown++;
    const hasOrig = !!S.origSizes[it.name];
    const card = document.createElement('div');
    card.className = `card${it.warnings && it.warnings.length ? ' has-warn' : ''}${R.gSel.has(i) ? ' selected' : ''}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = hasOrig ? 'Click to edit this image' : 'Click to view (no original crop stored, so it cannot be re-edited)';
    card.dataset.i = i;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'csel';
    cb.checked = R.gSel.has(i);
    cb.setAttribute('aria-label', `Select ${it.name}`);
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) R.gSel.add(i); else R.gSel.delete(i);
      card.classList.toggle('selected', cb.checked);
      updateGallerySel();
    };
    const ci = document.createElement('div');
    ci.className = 'ci';
    const im = document.createElement('img');
    im.alt = it.name;
    thumbUrl(it.name).then((u) => { if (u) im.src = u; });
    ci.appendChild(im);
    const cn = document.createElement('div');
    cn.className = 'cn';
    cn.textContent = it.name;
    const cm = document.createElement('div');
    cm.className = 'cm';
    const pr = it.edit ? presetById(it.edit.presetId) : null;
    cm.textContent = [qnoLabel(it.qno), it.page ? `page ${it.page}` : it.source === 'folder' ? 'already in folder' : '',
      it.w ? `${it.w} × ${it.h} px` : '', pr ? pr.name : '', it.copyOf ? `same as ${it.copyOf}` : ''].filter(Boolean).join(' · ');
    const badges = document.createElement('div');
    badges.className = 'cbadges';
    if (Pz.isCustom(it.edit)) {
      const b = document.createElement('span');
      b.className = 'badge custom';
      b.textContent = 'custom';
      b.title = Pz.customSummary(it.edit);
      badges.appendChild(b);
    }
    if (!hasOrig) {
      const b = document.createElement('span');
      b.className = 'badge skipped';
      b.textContent = 'no original';
      b.title = 'Cannot be re-edited or re-processed. Crop it again from the PDF to fix it.';
      badges.appendChild(b);
    }
    card.append(cb, ci, cn, cm, badges);
    if (it.text) {
      const ct = document.createElement('div');
      ct.className = 'ct';
      ct.textContent = it.text;
      card.appendChild(ct);
    }
    if (it.warnings && it.warnings.length) {
      const cw = document.createElement('div');
      cw.className = 'cw';
      cw.textContent = `⚠ ${it.warnings.map((c) => X.WARN_LABEL[c] || c).join(', ')}`;
      card.appendChild(cw);
    }
    const open = () => (hasOrig ? editSaved(i) : openView(i));
    card.onclick = open;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    g.appendChild(card);
  });
  if (!shown) g.innerHTML = `<p class="muted">${warnOnly ? 'No saved images need a look.' : 'No images are saved yet.'}</p>`;
  const sel = $('gPreset');
  sel.innerHTML = '<option value="">Keep each image\'s preset</option>';
  for (const pr of allPresets()) {
    const o = document.createElement('option');
    o.value = pr.id;
    o.textContent = pr.name;
    sel.appendChild(o);
  }
  updateGallerySel();
}

function updateGallerySel() {
  const n = R.gSel ? R.gSel.size : 0;
  $('gSelCount').textContent = `${n} selected`;
  $('gReprocess').disabled = !n || R.busy;
  $('gPaste').disabled = !n || R.busy;
}

async function galleryReprocess(mutate, what) {
  const list = [...R.gSel].sort((a, b) => a - b);
  if (!list.length) return;
  const ok = await confirmBox('Re-process the selected images?',
    `${plural(list.length, 'image')} will be re-made from the stored original crops ${what} and saved over the files in the folder (same names).`, 'Re-process');
  if (!ok) return;
  const bar = $('gProgress');
  bar.hidden = false;
  const onProgress = (n, total, name) => {
    $('gProgressBar').style.width = `${Math.round((n / total) * 100)}%`;
    $('gProgressText').textContent = `${n} / ${total} · ${name}`;
  };
  onProgress(0, list.length, '');
  const r = await reprocess(list, mutate, onProgress);
  bar.hidden = true;
  renderGallery();
  toast(`${plural(r.count, 'image')} re-processed.${r.skipped.length ? ` ${r.skipped.length} skipped (no stored original): ${r.skipped.slice(0, 3).join(', ')}` : ''}`,
    r.skipped.length ? 'warn' : 'ok', 6000);
}

// ============================================================ settings

function openSettingsPage() {
  R.pSel = activePreset().id;
  R.pDraft = null;
  renderSettingsPage();
  openDialog($('settingsDialog'));
}

function renderSettingsPage() {
  const list = $('presetList');
  list.innerHTML = '';
  const presets = allPresets();
  if (!presetById(R.pSel)) R.pSel = activePreset().id;
  const selP = presetById(R.pSel);
  if (!R.pDraft || R.pDraft.id !== R.pSel) R.pDraft = { id: R.pSel, settings: clone(selP.settings) };
  for (const pr of presets) {
    const li = document.createElement('li');
    li.className = pr.id === R.pSel ? 'sel' : '';
    li.setAttribute('role', 'option');
    li.tabIndex = 0;
    li.dataset.id = pr.id;
    li.appendChild(document.createTextNode(pr.name));
    const tags = [pr.builtIn ? 'built-in' : '', pr.id === S.defaultPresetId ? 'default' : '', pr.id === activePreset().id ? 'in use' : ''].filter(Boolean);
    for (const t of tags) { const sm = document.createElement('small'); sm.textContent = t; li.appendChild(sm); }
    const pick = () => { R.pSel = pr.id; renderSettingsPage(); };
    li.onclick = pick;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    list.appendChild(li);
  }
  $('pEditTitle').textContent = selP.name;
  $('pEditBadge').hidden = !selP.builtIn;
  $('pEditBadge').textContent = 'built-in';
  $('pSave').disabled = selP.builtIn;
  $('pDelete').disabled = selP.builtIn;
  $('pRename').disabled = selP.builtIn;
  $('pUse').disabled = selP.id === activePreset().id;
  $('pDefault').disabled = selP.id === S.defaultPresetId;
  $('pEditNote').textContent = selP.builtIn
    ? 'Built-in presets cannot be changed. Adjust the settings and click "Save as new preset" to keep your own version.'
    : 'Change the settings, then click "Save changes". Images already saved keep their look until you re-process them.';
  R.pControls = buildSettingsControls($('pControls'), {
    get: () => R.pDraft.settings,
    base: () => selP.settings,
    set: (k, v) => { R.pDraft.settings[k] = v; R.pControls && R.pControls.refresh(); },
  });
  $('setDpi').value = String(S.settings.dpi || 300);
  $('setAutoFind').checked = !!S.settings.autoFind;
  $('setClickCrop').checked = S.settings.clickCrop !== false;
  renderOrigUsage();
}

async function renderOrigUsage() {
  const names = Object.keys(S.origSizes);
  const bytes = names.reduce((a, n) => a + (S.origSizes[n] || 0), 0);
  const mb = (bytes / 1048576).toFixed(1);
  let text = `${plural(names.length, 'original crop')} stored · ${mb} MB`;
  $('origUsage').textContent = text;
  $('origClear').disabled = !names.length;
  try {
    const est = await navigator.storage.estimate();
    if (est && est.quota) text += ` (browser storage used: ${(est.usage / 1048576).toFixed(0)} MB of about ${(est.quota / 1073741824).toFixed(1)} GB)`;
  } catch { /* not available */ }
  $('origUsage').textContent = text;
  $('origClear').disabled = !names.length;
}

function presetName(suggest) {
  const name = (window.prompt('Name for the preset:', suggest) || '').trim();
  return name.slice(0, 60);
}

function exportSettings() {
  const data = {
    app: 'diagram-cropper-settings', version: 1, exportedAt: new Date().toISOString(),
    presets: S.customPresets, activePresetId: S.activePresetId, defaultPresetId: S.defaultPresetId, capture: S.settings,
  };
  folder.download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `diagram-cropper-settings_${X.stamp()}.json`);
}

async function importSettings(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('This file is not valid JSON.', 'error'); return; }
  if (!data || data.app !== 'diagram-cropper-settings' || !Array.isArray(data.presets)) {
    toast('This file is not a Diagram Cropper settings file.', 'error');
    return;
  }
  const incoming = Pz.sanitizePresets(data.presets).filter((x) => !x.builtIn);
  for (const pr of incoming) {
    const k = S.customPresets.findIndex((x) => x.id === pr.id);
    if (k >= 0) S.customPresets[k] = pr; else S.customPresets.push(pr);
  }
  if (presetById(data.defaultPresetId)) S.defaultPresetId = data.defaultPresetId;
  if (presetById(data.activePresetId)) S.activePresetId = data.activePresetId;
  if (data.capture) S.settings = { ...S.settings, ...data.capture };
  persist();
  renderPresetUi();
  if ($('settingsDialog').open) renderSettingsPage();
  toast(`Settings imported: ${plural(incoming.length, 'preset')}.`, 'ok');
}

function wireSettingsPage() {
  $('pUse').onclick = () => { S.activePresetId = R.pSel; persist(); renderPresetUi(); renderSettingsPage(); schedulePreview(); toast(`New crops use "${activePreset().name}".`, 'ok'); };
  $('pDefault').onclick = () => { S.defaultPresetId = R.pSel; persist(); renderPresetUi(); renderSettingsPage(); toast(`"${presetById(R.pSel).name}" is now the default preset.`, 'ok'); };
  $('pDuplicate').onclick = () => {
    const src = presetById(R.pSel);
    const name = presetName(`${src.name} (copy)`);
    if (!name) return;
    const id = `p${Date.now().toString(36)}`;
    S.customPresets.push({ id, name, builtIn: false, settings: clone(R.pDraft.settings) });
    R.pSel = id;
    persist();
    renderPresetUi();
    renderSettingsPage();
  };
  $('pSaveAs').onclick = $('pDuplicate').onclick;
  $('pRename').onclick = () => {
    const pr = S.customPresets.find((x) => x.id === R.pSel);
    if (!pr) return;
    const name = presetName(pr.name);
    if (!name) return;
    pr.name = name;
    persist();
    renderPresetUi();
    renderSettingsPage();
  };
  $('pDelete').onclick = async () => {
    const pr = S.customPresets.find((x) => x.id === R.pSel);
    if (!pr || !(await confirmBox('Delete this preset?', `"${pr.name}" will be removed. Images that used it keep their files; if re-processed they use the preset in use.`, 'Delete', true))) return;
    S.customPresets = S.customPresets.filter((x) => x.id !== pr.id);
    if (S.defaultPresetId === pr.id) S.defaultPresetId = Pz.DEFAULT_PRESET_ID;
    if (S.activePresetId === pr.id) S.activePresetId = S.defaultPresetId;
    persist();
    renderPresetUi();
    renderSettingsPage();
  };
  $('pSave').onclick = () => {
    const pr = S.customPresets.find((x) => x.id === R.pSel);
    if (!pr) return;
    pr.settings = Pz.sanitizeSettings(R.pDraft.settings);
    persist();
    schedulePreview();
    toast(`Preset "${pr.name}" saved.`, 'ok');
    renderSettingsPage();
  };
  $('setDpi').onchange = () => { S.settings.dpi = Number($('setDpi').value) || 300; persist(); schedulePreview(); };
  $('setAutoFind').onchange = () => { S.settings.autoFind = $('setAutoFind').checked; persist(); };
  $('setClickCrop').onchange = () => { S.settings.clickCrop = $('setClickCrop').checked; persist(); renderToolbar(); };
  $('setExport').onclick = exportSettings;
  $('setImport').onclick = () => $('settingsInput').click();
  $('settingsInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSettings(f); };
  $('origClear').onclick = async () => {
    const n = Object.keys(S.origSizes).length;
    if (!(await confirmBox('Clear the stored originals?', `${plural(n, 'original crop')} will be removed from the browser. Saved images in the folder stay, but they can no longer be re-edited or re-processed.`, 'Clear originals', true))) return;
    for (const k of await db.keys()) if (String(k).startsWith('orig:')) await db.del(k);
    S.origSizes = {};
    persist();
    renderOrigUsage();
    toast('Stored originals cleared.', 'ok');
  };
}

// ============================================================ view dialog

async function openView(i) {
  const it = S.items[i];
  if (!it) return;
  R.viewIndex = i;
  $('viewTitle').textContent = it.name;
  $('viewImg').removeAttribute('src');
  const url = await thumbUrl(it.name);
  if (url) $('viewImg').src = url;
  const info = [];
  if (it.w) info.push(`${it.w} × ${it.h} px`);
  if (it.pdf) info.push(`From ${it.pdf}, page ${it.page}`);
  else if (it.source === 'folder') info.push('This file was already in the folder, so the PDF page is not known.');
  if (it.copyOf) info.push(`Same image as ${it.copyOf}`);
  if (!url) info.push('The file was not found in the folder.');
  if (it.warnings && it.warnings.length) info.push(`⚠ ${it.warnings.map((c) => X.WARN_LABEL[c] || c).join(', ')}`);
  $('viewInfo').textContent = info.join(' · ');
  $('viewGoBtn').disabled = !it.pdf || !it.page;
  $('viewCopyBtn').disabled = !url;
  $('viewEditBtn').disabled = !S.origSizes[it.name];
  $('viewEditBtn').title = S.origSizes[it.name] ? 'Open in the editor' : 'No original crop is stored for this image';
  openDialog($('viewDialog'));
}

// ============================================================ wiring

function renderAll() {
  renderTop();
  renderList();
  renderToolbar();
  renderBanner();
  renderSetup();
}

function wire() {
  // close buttons in dialogs
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) c.closest('dialog').close();
    const a = e.target.closest('[data-action]');
    if (a) {
      const act = a.dataset.action;
      if (act === 'choose-folder') chooseFolder();
      if (act === 'reconnect-folder') reconnectFolder();
      if (act === 'open-setup') openSetup();
    }
    const r = e.target.closest('[data-reopen]');
    if (r) reopenPdf(r.dataset.reopen);
  });

  $('folderBtn').onclick = () => (folder.isReady() || !R.savedHandle ? chooseFolder() : reconnectFolder());
  $('setupFolderBtn').onclick = () => (folder.isReady() || !R.savedHandle ? chooseFolder() : reconnectFolder());
  $('setupBtn').onclick = openSetup;
  $('sideLoadBtn').onclick = openSetup;
  $('settingsBtn').onclick = openSettingsPage;
  wireSettingsPage();
  $('presetSelect').onchange = (e) => {
    S.activePresetId = e.target.value;
    persist();
    renderPresetUi();
    schedulePreview();
    toast(`New crops use "${activePreset().name}".`, 'ok');
  };
  $('editBtn').onclick = openEditorForBox;
  $('cpCanvas').ondblclick = openEditorForBox;
  $('viewEditBtn').onclick = () => { $('viewDialog').close(); editSaved(R.viewIndex); };
  $('gSelAll').onclick = () => { R.gSel = new Set(S.items.map((it, i) => (it.status === 'done' ? i : -1)).filter((i) => i >= 0)); renderGallery(); };
  $('gSelNone').onclick = () => { R.gSel = new Set(); renderGallery(); };
  $('gReprocess').onclick = () => {
    const id = $('gPreset').value;
    const pr = id ? presetById(id) : null;
    galleryReprocess((ed) => (pr ? { ...ed, presetId: pr.id, overrides: {} } : ed), pr ? `with the preset "${pr.name}"` : 'with their current settings');
  };
  $('gPaste').onclick = () => {
    if (!R.clip) { toast('Open an image in the editor and click "Copy settings" first.', 'warn'); return; }
    const c = clone(R.clip);
    galleryReprocess((ed) => ({ ...ed, presetId: c.presetId, overrides: clone(c.overrides) }), 'with the copied settings');
  };
  $('finishBtn').onclick = () => { renderReport(); $('verifyResult').innerHTML = ''; openDialog($('finishDialog')); };
  $('skipBtn').onclick = openSkip;
  $('undoBtn').onclick = undo;
  $('copyActiveBtn').onclick = () => useForAnother(S.active);
  $('toggleTextBtn').onclick = () => { R.textOpen = !R.textOpen; renderTop(); };

  // crop panel
  $('approveBtn').onclick = approve;
  $('retakeBtn').onclick = retake;
  $('savedCopyBtn').onclick = () => { const i = Number($('savedCard').dataset.i); $('savedCard').hidden = true; useForAnother(i); };

  // list
  $('nameList').addEventListener('click', (e) => {
    const li = e.target.closest('li.row');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (e.target.closest('.thumb')) { openView(i); return; }
    setActive(i, { showPrev: true });
  });
  $('nameList').addEventListener('keydown', (e) => {
    const li = e.target.closest('li.row');
    if (!li) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (next && next.matches('li.row')) { li.tabIndex = -1; next.tabIndex = 0; next.focus(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setActive(Number(li.dataset.i), { showPrev: true });
      R.rows.get(Number(li.dataset.i))?.focus();
    }
  });
  $('searchInput').addEventListener('input', renderList);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    let i = S.items.findIndex((it) => String(it.qno).toLowerCase() === q || `q${String(it.qno).toLowerCase()}` === q || it.name.toLowerCase() === q);
    if (i < 0) i = S.items.findIndex((it) => matches(it, q) && (!S.pendingOnly || it.status === 'pending'));
    if (i < 0) { toast('No name matches.', 'warn'); return; }
    setActive(i, { showPrev: true });
  });
  $('pendingOnly').checked = S.pendingOnly;
  $('pendingOnly').onchange = (e) => { S.pendingOnly = e.target.checked; renderList(); persist(); };

  // PDF toolbar
  const pickPdf = () => $('pdfInput').click();
  $('openPdfBtn').onclick = pickPdf;
  $('emptyOpenBtn').onclick = pickPdf;
  $('setupPdfBtn').onclick = pickPdf;
  $('pdfInput').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) await openPdfFile(f);
    renderSetup();
  };
  $('pdfSelect').onchange = (e) => showPdf(e.target.value);
  $('zoomInBtn').onclick = () => viewer.zoomBy(1.2);
  $('zoomOutBtn').onclick = () => viewer.zoomBy(1 / 1.2);
  $('fitBtn').onclick = () => viewer.fitWidth();
  $('goPageBtn').onclick = goToPage;
  $('pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goToPage(); } });
  $('lastSavedBtn').onclick = goToLastSaved;

  // setup
  $('tabPaste').onclick = () => setTab('paste');
  $('tabExcel').onclick = () => setTab('excel');
  $('checkPasteBtn').onclick = checkPasted;
  $('excelBtn').onclick = () => $('excelInput').click();
  $('excelInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onExcelFile(f); };
  $('sheetSelect').onchange = (e) => loadSheet(e.target.value);
  for (const id of ['colImage', 'colQno', 'colText']) $(id).onchange = buildExcelDraft;
  $('startBtn').onclick = () => {
    $('setupDialog').close();
    if (folder.supported && !folder.isReady()) toast('Choose the images folder first.', 'warn');
    else if (!viewer.doc) toast('Now open the PDF with the questions.', 'info');
  };
  $('resetBtn').onclick = resetAll;

  // settings

  // finish
  $('verifyBtn').onclick = verify;
  $('reviewBtn').onclick = openReview;
  $('finishReviewBtn').onclick = () => { $('finishDialog').close(); openReview(); };
  $('reviewWarnOnly').onchange = renderGallery;
  $('csvBtn').onclick = () => folder.download(X.progressCsv(S.items), `progress_${X.stamp()}.csv`);
  $('zipBtn').onclick = exportZip;
  $('excelOutBtn').onclick = exportExcel;
  $('backupBtn').onclick = () => folder.download(X.backupJson(S), `diagram-cropper-backup_${X.stamp()}.json`);
  $('restoreBtn').onclick = () => $('restoreInput').click();
  $('restoreInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); };

  // skip dialog
  $('skipDialog').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-note]');
    if (chip) { $('skipNote').value = chip.dataset.note; $('skipNote').focus(); }
  });
  $('skipDialog').addEventListener('close', () => {
    if ($('skipDialog').returnValue === 'skip') doSkip($('skipNote').value);
  });

  // picker
  $('pickerSearch').addEventListener('input', renderPicker);
  $('pickerSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('pickerList').querySelector('button')?.click(); }
  });
  $('pickerAll').onchange = renderPicker;
  $('pickerList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const resolve = R.pick;
    R.pick = null;
    $('pickerDialog').close();
    resolve && resolve(Number(b.dataset.i));
  });
  $('pickerDialog').addEventListener('close', () => { if (R.pick) { R.pick(null); R.pick = null; } });

  // view dialog
  $('viewGoBtn').onclick = async () => {
    const it = S.items[R.viewIndex];
    $('viewDialog').close();
    if (it && it.pdf && (await ensurePdf(it.pdf))) viewer.scrollToPage(parseInt(it.page, 10), 'smooth');
  };
  $('viewCopyBtn').onclick = () => { $('viewDialog').close(); useForAnother(R.viewIndex); };
  $('viewReplaceBtn').onclick = () => {
    $('viewDialog').close();
    $('reviewDialog').close();
    setActive(R.viewIndex, { showPrev: true });
    toast(R.prevShown ? `Adjust the saved box, or draw a new one, to replace ${S.items[R.viewIndex].name}.`
      : `Draw a new box to replace ${S.items[R.viewIndex].name}.`);
  };

  // keyboard shortcuts (everything also works with the mouse)
  document.addEventListener('keydown', (e) => {
    if (anyDialogOpen()) return;
    const t = e.target;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (isTyping(t)) return;
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(t)) return;
    const onButton = t.closest && t.closest('button, a, li.row');
    if (e.key === 'Enter' && !onButton && viewer.box && !$('cropPanel').hidden) { e.preventDefault(); approve(); }
    else if (e.key === 'Escape' && viewer.box) { e.preventDefault(); retake(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); openSkip(); }
  });

  window.addEventListener('resize', positionPanel);
  // Ctrl + wheel zooms the PDF only, never the whole page
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
}

async function init() {
  wire();
  renderPresetUi();
  renderAll();
  if (folder.supported) {
    R.savedHandle = await folder.savedHandle();
    if (R.savedHandle) {
      const r = await folder.reconnect(false);
      if (r.ok) {
        S.folderName = folder.name();
        const found = markFromFolder();
        if (found) toast(`${plural(found, 'more image')} found in the folder and marked Done.`, 'ok');
      }
    }
  }
  renderAll();
  if (S.currentPdf && S.recentPdfs.includes(S.currentPdf)) await reopenPdf(S.currentPdf, true);
  renderToolbar();
  if (!S.items.length) openSetup();
  else if (S.active >= 0) R.rows.get(S.active)?.scrollIntoView({ block: 'center' });
  window.__dc = { get state() { return S; }, viewer, folder, editor };
}

init().catch((e) => {
  console.error(e);
  toast(`Something went wrong while starting: ${e.message}. Try refreshing the page.`, 'error', 15000);
});
