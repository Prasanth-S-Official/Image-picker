// Full image editor: clean-up tools, background and clarity settings, geometry, compare.
// Non-destructive: works on the original crop plus an edit document { presetId, overrides, geom, ops }.

import * as Pz from './presets.js';
import { geoTransform, applyH, inv } from './pipeline.js';
import { previewWorker, fullWorker, downscale, toImageData } from './processor.js';

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const PREVIEW_MAX = 1100;

const TOOLS = [
  { id: 'none', label: 'Look', icon: '👁', tip: 'Just look. No tool is active.' },
  { id: 'erase', label: 'Erase brush', icon: '🖌', tip: 'Paint over unwanted marks to make them white.' },
  { id: 'eraseBox', label: 'Erase box', icon: '▭', tip: 'Drag a rectangle to remove that area.' },
  { id: 'lasso', label: 'Lasso erase', icon: '➰', tip: 'Draw a free shape around the part to remove.' },
  { id: 'keep', label: 'Keep only this area', icon: '◎', tip: 'Draw a shape. Everything outside it is removed.' },
  { id: 'clone', label: 'Clone / patch', icon: '⧉', tip: 'Click a clean area to copy from, then paint over the blemish.' },
  { id: 'protect', label: 'Protect area', icon: '🛡', tip: 'Draw a shape the automatic clean-up must never change (thin lines, labels).' },
  { id: 'crop', label: 'Fine crop', icon: '⌗', tip: 'Adjust the edges with the handles. Arrow keys move the selected edge.' },
  { id: 'persp', label: 'Perspective', icon: '⬚', tip: 'Drag the four corners onto the corners of the diagram, then click Apply.' },
];

// ============================================================ shared settings controls

/**
 * Builds the settings controls (used by the editor and the settings page).
 * cfg: { get(): settings, base(): settings (for reset and "changed" marks), set(key, value, done), autoEnhance?() }
 */
export function buildSettingsControls(root, cfg) {
  root.innerHTML = '';
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const section = (title) => {
    const s = el('section', 'set-sec');
    s.appendChild(el('h4', '', title));
    root.appendChild(s);
    return s;
  };
  const refreshers = [];

  const secMode = section('Mode');
  const modes = el('div', 'seg');
  modes.setAttribute('role', 'radiogroup');
  for (const m of Pz.MODES) {
    const b = el('button', 'seg-btn', m.label);
    b.type = 'button';
    b.title = m.tip;
    b.dataset.mode = m.value;
    b.onclick = () => { cfg.set('mode', m.value, true); refresh(); };
    modes.appendChild(b);
  }
  secMode.appendChild(modes);
  refreshers.push(() => {
    for (const b of modes.children) {
      const on = b.dataset.mode === cfg.get().mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  });

  const secBg = section('Background and clarity');
  if (cfg.autoEnhance) {
    const ae = el('button', 'btn small primary-outline', 'Auto enhance');
    ae.type = 'button';
    ae.title = 'White background, shadow removal, contrast and sharpening with safe values.';
    ae.onclick = () => { cfg.autoEnhance(); refresh(); };
    secBg.appendChild(ae);
  }
  for (const t of Pz.TOGGLES) {
    const lab = el('label', 'check');
    lab.title = t.tip;
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.key = t.key;
    cb.onchange = () => cfg.set(t.key, cb.checked, true);
    lab.append(cb, document.createTextNode(` ${t.label}`));
    secBg.appendChild(lab);
    refreshers.push(() => { cb.checked = !!cfg.get()[t.key]; lab.classList.toggle('changed', cfg.base()[t.key] !== cfg.get()[t.key]); });
  }

  const secAdj = section('Adjustments');
  const slider = (parent, def) => {
    const row = el('div', 'slider');
    row.title = def.tip || '';
    const head = el('div', 'sl-head');
    const lab = el('label', '', def.label);
    const id = `sl-${Math.random().toString(36).slice(2, 8)}`;
    lab.htmlFor = id;
    const num = el('input', 'sl-num');
    num.type = 'number';
    num.min = def.min; num.max = def.max; num.step = def.step;
    num.setAttribute('aria-label', `${def.label} value`);
    const reset = el('button', 'sl-reset');
    reset.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-reset"/></svg>';
    reset.type = 'button';
    reset.title = `Reset ${def.label.toLowerCase()}`;
    reset.setAttribute('aria-label', `Reset ${def.label}`);
    head.append(lab, num, reset);
    const rng = el('input');
    rng.type = 'range';
    rng.id = id;
    rng.min = def.min; rng.max = def.max; rng.step = def.step;
    row.append(head, rng);
    parent.appendChild(row);
    const val = (v) => (def.step < 1 ? Number(Number(v).toFixed(2)) : Math.round(Number(v)));
    rng.oninput = () => { num.value = val(rng.value); cfg.set(def.key, val(rng.value), false); markChanged(); };
    rng.onchange = () => cfg.set(def.key, val(rng.value), true);
    num.onchange = () => {
      const v = Math.min(def.max, Math.max(def.min, val(num.value)));
      cfg.set(def.key, v, true);
      refresh();
    };
    reset.onclick = () => { cfg.set(def.key, cfg.base()[def.key], true); refresh(); };
    const markChanged = () => row.classList.toggle('changed', cfg.base()[def.key] !== cfg.get()[def.key]);
    refreshers.push(() => { const v = cfg.get()[def.key]; rng.value = v; num.value = v; markChanged(); });
  };
  for (const def of Pz.SLIDERS) slider(secAdj, def);

  const secOut = section('Output');
  slider(secOut, { key: 'padding', ...Pz.OUTPUT.padding });
  const sel = (label, key, options, tip) => {
    const lab = el('label', 'sel');
    lab.title = tip || '';
    lab.appendChild(el('span', '', label));
    const s = el('select');
    for (const o of options) { const op = el('option', '', o.label); op.value = String(o.value); s.appendChild(op); }
    s.onchange = () => { const v = typeof Pz.NEUTRAL[key] === 'number' ? Number(s.value) : s.value; cfg.set(key, v, true); refresh(); };
    lab.appendChild(s);
    secOut.appendChild(lab);
    refreshers.push(() => { s.value = String(cfg.get()[key]); lab.classList.toggle('changed', cfg.base()[key] !== cfg.get()[key]); });
  };
  sel('Largest width', 'maxWidth', Pz.OUTPUT.widths.map((v) => ({ value: v, label: v ? `${v} px` : 'No limit' })), 'Wider images are scaled down, keeping proportions.');
  sel('Largest height', 'maxHeight', Pz.OUTPUT.heights.map((v) => ({ value: v, label: v ? `${v} px` : 'No limit' })), 'Taller images are scaled down, keeping proportions.');
  sel('File format', 'format', Pz.OUTPUT.formats, 'PNG keeps every detail. PNG-8 is much smaller for simple diagrams. JPG suits photos.');
  const jpgWrap = el('div');
  secOut.appendChild(jpgWrap);
  slider(jpgWrap, { key: 'jpgQuality', label: 'JPG quality', min: 50, max: 100, step: 1 });
  refreshers.push(() => { jpgWrap.hidden = cfg.get().format !== 'jpg'; });

  function refresh() { for (const r of refreshers) r(); }
  refresh();
  return { refresh };
}

// ============================================================ editor

export class Editor {
  /**
   * api: { presets(), presetById(id), activePresetId(), savePreset(name, settings) -> id, updatePreset(id, settings),
   *        applyToOthers(edit, includeDone), copySettings(edit), pasteSettings() -> {presetId, overrides}|null, toast(msg, kind) }
   */
  constructor(api) {
    this.api = api;
    this.dlg = $('editorDialog');
    this.canvas = $('edCanvas');
    this.overlay = $('edOverlay');
    this.stage = $('edStage');
    this.tool = 'none';
    this.brush = 30;
    this.soft = true;
    this.compare = 'none'; // none | split | side
    this.split = 0.5;
    this.holding = false;
    this.buildTools();
    this.wire();
  }

  // ---------- open / close

  /** Opens the editor. Resolves { action: 'approve'|'back'|'retake', edit, result?, preview? }. */
  async open({ original, edit, name, mode }) {
    this.orig = original;
    this.fullW = original.width;
    this.fullH = original.height;
    const ds = downscale(original, PREVIEW_MAX);
    this.prev = ds.data;
    this.s = ds.s;
    this.prevCanvas = null;
    this.doc = clone(edit);
    this.doc.geom = { ...Pz.emptyGeom(), ...(this.doc.geom || {}) };
    this.doc.ops = this.doc.ops || [];
    this.doc.overrides = this.doc.overrides || {};
    if (!this.api.presetById(this.doc.presetId)) this.doc.presetId = this.api.activePresetId();
    this.history = [JSON.stringify(this.doc)];
    this.hIndex = 0;
    this.mode = mode;
    this.last = null;
    this.estimate = null;
    this.cloneSrc = null;
    this.cloneOff = null;
    this.tool = 'none';
    this.compare = 'none';
    $('edName').textContent = name;
    $('edRetake').hidden = mode !== 'new';
    $('edBack').textContent = mode === 'new' ? 'Back to crop' : 'Close';
    $('edApprove').firstChild.textContent = mode === 'new' ? 'Approve ' : 'Save changes ';
    this.renderPresetSelect();
    this.controls = buildSettingsControls($('edSettings'), {
      get: () => this.settings(),
      base: () => this.presetSettings(),
      set: (k, v, done) => this.setSetting(k, v, done),
      autoEnhance: () => this.autoEnhance(),
    });
    this.updateToolUi();
    this.dlg.showModal();
    await Promise.all([
      previewWorker().setImage('ed-prev', this.prev, this.fullW, this.fullH),
      fullWorker().setImage('ed-full', this.orig),
    ]);
    this.fit();
    this.requestRender();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  finish(action, extra = {}) {
    const resolve = this.resolve;
    this.resolve = null;
    this.dlg.close();
    const preview = this.last && this.last.working ? toImageData(this.last.final || this.last.working) : null;
    previewWorker().drop('ed-prev');
    fullWorker().drop('ed-full');
    if (resolve) resolve({ action, edit: clone(this.doc), preview, ...extra });
  }

  // ---------- settings

  presetSettings() {
    const p = this.api.presetById(this.doc.presetId) || this.api.presetById(this.api.activePresetId());
    return Pz.sanitizeSettings(p ? p.settings : Pz.NEUTRAL);
  }

  settings() { return Pz.sanitizeSettings({ ...this.presetSettings(), ...this.doc.overrides }); }

  setSetting(key, value, done) {
    const base = this.presetSettings();
    if (base[key] === value) delete this.doc.overrides[key];
    else this.doc.overrides[key] = value;
    if (key === 'autoDeskew' && this.doc.geom.deskewAuto) { this.doc.geom.deskew = null; this.doc.geom.deskewAuto = false; }
    if (done) this.commit(); else this.requestRender();
    this.updateCustom();
  }

  autoEnhance() {
    const want = { whiteBg: true, shadow: true, enhance: 60, sharpen: 35, denoise: 20, despeckle: 2 };
    const base = this.presetSettings();
    for (const [k, v] of Object.entries(want)) {
      if (base[k] === v) delete this.doc.overrides[k]; else this.doc.overrides[k] = v;
    }
    if (this.settings().mode === 'original') this.doc.overrides.mode = 'color';
    this.commit();
    this.api.toast('Auto enhance applied.', 'ok');
  }

  renderPresetSelect() {
    const sel = $('edPreset');
    sel.innerHTML = '';
    for (const p of this.api.presets()) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.value = this.doc.presetId;
    $('edUpdatePreset').hidden = !!(this.api.presetById(this.doc.presetId) || {}).builtIn;
    this.updateCustom();
  }

  updateCustom() {
    const custom = Pz.isCustom(this.doc);
    $('edCustom').hidden = !custom;
    $('edCustom').title = Pz.customSummary(this.doc);
    const n = Object.keys(this.doc.overrides).length;
    $('edCustomNote').textContent = n ? `${n} setting${n === 1 ? '' : 's'} changed for this image only.` : 'Using the preset as it is.';
    $('edClearCustom').disabled = !n;
  }

  // ---------- history

  commit() {
    const snap = JSON.stringify(this.doc);
    if (snap !== this.history[this.hIndex]) {
      this.history = this.history.slice(0, this.hIndex + 1);
      this.history.push(snap);
      if (this.history.length > 200) this.history.shift();
      this.hIndex = this.history.length - 1;
    }
    this.afterDocChange();
  }

  undo() { if (this.hIndex > 0) { this.hIndex--; this.doc = JSON.parse(this.history[this.hIndex]); this.afterDocChange(true); } }
  redo() { if (this.hIndex < this.history.length - 1) { this.hIndex++; this.doc = JSON.parse(this.history[this.hIndex]); this.afterDocChange(true); } }

  afterDocChange(refreshControls) {
    $('edUndo').disabled = this.hIndex <= 0;
    $('edRedo').disabled = this.hIndex >= this.history.length - 1;
    if (refreshControls) { $('edPreset').value = this.doc.presetId; this.controls.refresh(); }
    this.updateCustom();
    this.updateGeomUi();
    this.requestRender();
  }

  // ---------- geometry buttons

  rotate90(dir) {
    const g = this.doc.geom;
    g.rot90 = (((g.rot90 || 0) + dir * 90) % 360 + 360) % 360;
    const c = g.crop;
    if (c) g.crop = dir > 0 ? { x0: 1 - c.y1, x1: 1 - c.y0, y0: c.x0, y1: c.x1 } : { x0: c.y0, x1: c.y1, y0: 1 - c.x1, y1: 1 - c.x0 };
    this.commit();
  }

  flip(axis) {
    const g = this.doc.geom;
    const c = g.crop;
    if (axis === 'h') { g.flipH = !g.flipH; if (c) g.crop = { ...c, x0: 1 - c.x1, x1: 1 - c.x0 }; }
    else { g.flipV = !g.flipV; if (c) g.crop = { ...c, y0: 1 - c.y1, y1: 1 - c.y0 }; }
    this.commit();
  }

  async autoDeskew() {
    $('edDeskewInfo').textContent = 'Looking for tilt…';
    try {
      const angle = await previewWorker().deskew('ed-prev', this.doc);
      this.doc.geom.deskew = angle;
      this.doc.geom.deskewAuto = false;
      this.commit();
      this.api.toast(Math.abs(angle) < 0.1 ? 'No tilt found.' : `Tilt fixed: ${angle > 0 ? '+' : ''}${angle.toFixed(1)}°.`, 'ok');
    } catch (e) {
      this.api.toast(`Could not detect the tilt. ${e.message}`, 'error');
    }
  }

  updateGeomUi() {
    const g = this.doc.geom;
    $('edAngle').value = g.angle || 0;
    $('edAngleVal').textContent = `${(g.angle || 0).toFixed(1)}°`;
    $('edDeskewInfo').textContent = g.deskew ? `Tilt fixed by ${g.deskew > 0 ? '+' : ''}${Number(g.deskew).toFixed(1)}°${g.deskewAuto ? ' (automatic)' : ''}` : '';
    $('edDeskewReset').hidden = !g.deskew;
    $('edPerspClear').hidden = !g.persp;
    $('edCropClear').hidden = !g.crop;
    $('edProtectClear').hidden = !this.doc.ops.some((o) => o.t === 'protect');
  }

  // ---------- tools

  buildTools() {
    const box = $('edTools');
    box.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool';
      b.dataset.tool = t.id;
      b.title = t.tip;
      b.innerHTML = `<svg class="ico ti" aria-hidden="true"><use href="#i-${t.id}"/></svg><span class="tl"></span>`;
      b.querySelector('.tl').textContent = t.label;
      b.onclick = () => this.setTool(t.id);
      box.appendChild(b);
    }
  }

  setTool(id) {
    if (this.tool === 'persp' && id !== 'persp') this.perspPts = null;
    this.tool = id;
    if (id !== 'none' && this.compare !== 'none') this.compare = 'none';
    if (id === 'persp') {
      const g = this.doc.geom;
      const w = this.fullW, h = this.fullH, m = 0.04;
      this.perspPts = g.persp ? clone(g.persp) : [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]];
    }
    if (id === 'crop') { this.cropSel = null; this.cropDraft = this.doc.geom.crop ? { ...this.doc.geom.crop } : { x0: 0, y0: 0, x1: 1, y1: 1 }; }
    this.updateToolUi();
    this.requestRender();
  }

  updateToolUi() {
    for (const b of $('edTools').children) b.classList.toggle('on', b.dataset.tool === this.tool);
    const t = TOOLS.find((x) => x.id === this.tool);
    $('edHelp').textContent = t ? t.tip : '';
    $('edBrushBox').hidden = !['erase', 'clone'].includes(this.tool);
    $('edCloneReset').hidden = this.tool !== 'clone';
    $('edPerspBox').hidden = this.tool !== 'persp';
    $('edCropBox').hidden = this.tool !== 'crop';
    this.overlay.style.cursor = this.tool === 'none' ? 'default' : this.tool === 'crop' || this.tool === 'persp' ? 'default' : 'crosshair';
    for (const b of document.querySelectorAll('[data-compare]')) b.classList.toggle('on', b.dataset.compare === this.compare);
    this.updateGeomUi();
  }

  // ---------- coordinates

  geo() { return geoTransform(this.doc.geom, this.fullW, this.fullH); }

  cropApplied() { return this.tool !== 'crop' && !!this.doc.geom.crop; }

  /** Canvas CSS point -> original crop pixel. */
  toOrig(x, y) {
    if (this.tool === 'persp') return [x / this.disp / this.s, y / this.disp / this.s];
    let gx = x / this.disp;
    let gy = y / this.disp;
    const c = this.doc.geom.crop;
    if (this.cropApplied() && c && this.last) { gx += c.x0 * this.last.geoW; gy += c.y0 * this.last.geoH; }
    return applyH(inv(this.geo().H), gx / this.s, gy / this.s);
  }

  /** Original crop pixel -> canvas CSS point. */
  toDisp(p) {
    if (this.tool === 'persp') return [p[0] * this.s * this.disp, p[1] * this.s * this.disp];
    const q = applyH(this.geo().H, p[0], p[1]);
    let gx = q[0] * this.s;
    let gy = q[1] * this.s;
    const c = this.doc.geom.crop;
    if (this.cropApplied() && c && this.last) { gx -= c.x0 * this.last.geoW; gy -= c.y0 * this.last.geoH; }
    return [gx * this.disp, gy * this.disp];
  }

  // ---------- rendering

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.doRender(); });
  }

  async doRender() {
    if (!this.dlg.open) return;
    if (this.tool === 'persp') { this.draw(); return; }
    const t0 = performance.now();
    const busy = setTimeout(() => { $('edBusy').hidden = false; }, 150);
    const needBefore = this.compare !== 'none' || this.holding;
    let r;
    try {
      r = await previewWorker().renderLatest('editor', 'ed-prev', this.settings(), this.doc,
        { crop: this.tool !== 'crop', before: needBefore, final: true });
    } catch (e) {
      clearTimeout(busy);
      $('edBusy').hidden = true;
      this.api.toast(`Preview failed: ${e.message}`, 'error');
      return;
    }
    clearTimeout(busy);
    if (!r) return;
    $('edBusy').hidden = true;
    this.renderMs = Math.round(performance.now() - t0);
    if (r.deskewUsed !== null && r.deskewUsed !== undefined && (this.doc.geom.deskew === null || this.doc.geom.deskew === undefined)) {
      // automatic tilt fix from the preset: remember the angle so tools line up
      this.doc.geom.deskew = r.deskewUsed;
      this.doc.geom.deskewAuto = true;
      this.history[this.hIndex] = JSON.stringify(this.doc);
      this.updateGeomUi();
    }
    this.last = r;
    this.draw();
    this.scheduleEstimate();
  }

  fit() {
    const r = this.stage.getBoundingClientRect();
    this.stageW = Math.max(100, r.width - 24);
    this.stageH = Math.max(100, r.height - 24);
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    let a;
    let b = null;
    if (this.tool === 'persp') {
      a = this.prev;
    } else {
      if (!this.last) return;
      a = toImageData(this.last.working);
      if (this.last.before) b = toImageData(this.last.before);
    }
    const side = this.compare === 'side' && b && this.tool !== 'persp';
    const gap = side ? 16 : 0;
    const cw = side ? a.width * 2 + gap : a.width;
    const ch = a.height;
    this.canvas.width = cw;
    this.canvas.height = ch;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    if (side) {
      ctx.putImageData(b, 0, 0);
      ctx.putImageData(a, a.width + gap, 0);
      ctx.clearRect(a.width, 0, gap, ch);
    } else if (this.holding && b) {
      ctx.putImageData(b, 0, 0);
    } else if (this.compare === 'split' && b) {
      ctx.putImageData(a, 0, 0);
      const sx = Math.round(a.width * this.split);
      ctx.putImageData(b, 0, 0, 0, 0, sx, a.height);
    } else {
      ctx.putImageData(a, 0, 0);
    }
    this.disp = Math.min(this.stageW / cw, this.stageH / ch, 4);
    const W = Math.round(cw * this.disp);
    const H = Math.round(ch * this.disp);
    for (const c of [this.canvas, this.overlay]) { c.style.width = `${W}px`; c.style.height = `${H}px`; }
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(W * dpr);
    this.overlay.height = Math.round(H * dpr);
    this.cssW = W;
    this.cssH = H;
    this.drawOverlay();
    this.updateInfo();
  }

  drawOverlay() {
    const o = this.overlay.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, this.cssW, this.cssH);
    if (this.compare === 'side') {
      o.fillStyle = 'rgba(0,0,0,.65)';
      o.font = '600 12px Segoe UI, sans-serif';
      o.fillText('Original', 6, 16);
      o.fillText('Edited', this.cssW / 2 + 8, 16);
      return;
    }
    if (this.compare === 'split' && this.tool !== 'persp') {
      const x = this.cssW * this.split;
      o.strokeStyle = '#0b5cad';
      o.lineWidth = 2;
      o.beginPath(); o.moveTo(x, 0); o.lineTo(x, this.cssH); o.stroke();
      o.fillStyle = '#0b5cad';
      o.fillRect(x - 9, this.cssH / 2 - 14, 18, 28);
      o.fillStyle = 'rgba(0,0,0,.65)';
      o.font = '600 12px Segoe UI, sans-serif';
      o.fillText('Original', 6, 16);
      o.fillText('Edited', x + 8, 16);
    }
    if (this.holding) {
      o.fillStyle = 'rgba(11,92,173,.9)';
      o.fillRect(0, 0, 90, 22);
      o.fillStyle = '#fff';
      o.font = '700 12px Segoe UI, sans-serif';
      o.fillText('ORIGINAL', 8, 15);
    }
    // protected areas
    for (const op of this.doc.ops) {
      if (op.t !== 'protect' || this.tool === 'persp') continue;
      o.beginPath();
      op.pts.forEach((p, i) => { const q = this.toDisp(p); if (i) o.lineTo(q[0], q[1]); else o.moveTo(q[0], q[1]); });
      o.closePath();
      o.fillStyle = 'rgba(11,92,173,.12)';
      o.fill();
      o.setLineDash([5, 4]);
      o.strokeStyle = '#0b5cad';
      o.lineWidth = 1.5;
      o.stroke();
      o.setLineDash([]);
    }
    // trim frame
    const st = this.settings();
    if (st.trim && this.last && this.last.trimBox && this.tool !== 'crop' && this.tool !== 'persp' && !this.holding) {
      const b = this.last.trimBox;
      o.setLineDash([4, 4]);
      o.strokeStyle = 'rgba(23,117,58,.8)';
      o.lineWidth = 1;
      o.strokeRect(b.x * this.disp + 0.5, b.y * this.disp + 0.5, b.w * this.disp, b.h * this.disp);
      o.setLineDash([]);
    }
    if (this.showGrid && this.tool !== 'persp') {
      o.strokeStyle = 'rgba(11,92,173,.35)';
      o.lineWidth = 1;
      const step = Math.max(20, Math.min(this.cssW, this.cssH) / 10);
      for (let x = step; x < this.cssW; x += step) { o.beginPath(); o.moveTo(x, 0); o.lineTo(x, this.cssH); o.stroke(); }
      for (let y = step; y < this.cssH; y += step) { o.beginPath(); o.moveTo(0, y); o.lineTo(this.cssW, y); o.stroke(); }
    }
    if (this.tool === 'crop' && this.cropDraft && this.last) {
      const c = this.cropDraft;
      const x0 = c.x0 * this.cssW, x1 = c.x1 * this.cssW, y0 = c.y0 * this.cssH, y1 = c.y1 * this.cssH;
      o.fillStyle = 'rgba(10,18,30,.45)';
      o.fillRect(0, 0, this.cssW, y0);
      o.fillRect(0, y1, this.cssW, this.cssH - y1);
      o.fillRect(0, y0, x0, y1 - y0);
      o.fillRect(x1, y0, this.cssW - x1, y1 - y0);
      o.strokeStyle = '#0b5cad';
      o.lineWidth = 2;
      o.strokeRect(x0, y0, x1 - x0, y1 - y0);
      for (const [hx, hy, key] of this.cropHandles()) {
        o.fillStyle = key === this.cropSel ? '#f0a400' : '#fff';
        o.strokeStyle = '#0b5cad';
        o.fillRect(hx - 6, hy - 6, 12, 12);
        o.strokeRect(hx - 6, hy - 6, 12, 12);
      }
    }
    if (this.tool === 'persp' && this.perspPts) {
      const P = this.perspPts.map((p) => this.toDisp(p));
      o.beginPath();
      P.forEach((q, i) => (i ? o.lineTo(q[0], q[1]) : o.moveTo(q[0], q[1])));
      o.closePath();
      o.strokeStyle = '#0b5cad';
      o.lineWidth = 2;
      o.stroke();
      o.fillStyle = 'rgba(11,92,173,.08)';
      o.fill();
      P.forEach((q, i) => {
        o.beginPath();
        o.arc(q[0], q[1], 9, 0, Math.PI * 2);
        o.fillStyle = i === this.perspSel ? '#f0a400' : '#fff';
        o.fill();
        o.stroke();
      });
    }
    if (this.cloneSrc && this.tool === 'clone') {
      const q = this.toDisp(this.cloneSrc);
      o.strokeStyle = '#b42318';
      o.lineWidth = 2;
      o.beginPath(); o.arc(q[0], q[1], 10, 0, Math.PI * 2); o.moveTo(q[0] - 14, q[1]); o.lineTo(q[0] + 14, q[1]); o.moveTo(q[0], q[1] - 14); o.lineTo(q[0], q[1] + 14); o.stroke();
    }
    // stroke / shape in progress
    const d = this.drag;
    if (d && d.pts && d.pts.length) {
      o.strokeStyle = d.kind === 'protect' ? '#0b5cad' : '#b42318';
      o.fillStyle = d.kind === 'keep' ? 'rgba(23,117,58,.15)' : d.kind === 'protect' ? 'rgba(11,92,173,.15)' : 'rgba(180,35,24,.15)';
      if (d.kind === 'erase' || d.kind === 'clone') {
        o.lineCap = 'round';
        o.lineJoin = 'round';
        o.lineWidth = this.brush * this.s * this.disp;
        o.strokeStyle = d.kind === 'clone' ? 'rgba(11,92,173,.35)' : 'rgba(255,255,255,.85)';
        o.beginPath();
        d.pts.forEach((p, i) => (i ? o.lineTo(p[0], p[1]) : o.moveTo(p[0], p[1])));
        o.stroke();
      } else if (d.kind === 'eraseBox') {
        const [a, b] = [d.pts[0], d.pts[d.pts.length - 1]];
        o.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        o.lineWidth = 2;
        o.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      } else {
        o.beginPath();
        d.pts.forEach((p, i) => (i ? o.lineTo(p[0], p[1]) : o.moveTo(p[0], p[1])));
        o.closePath();
        o.fill();
        o.lineWidth = 2;
        o.stroke();
      }
    }
    // brush outline under the mouse
    if (this.hover && ['erase', 'clone'].includes(this.tool)) {
      o.strokeStyle = 'rgba(0,0,0,.6)';
      o.lineWidth = 1;
      o.beginPath();
      o.arc(this.hover[0], this.hover[1], Math.max(2, (this.brush * this.s * this.disp) / 2), 0, Math.PI * 2);
      o.stroke();
    }
  }

  cropHandles() {
    const c = this.cropDraft;
    const W = this.cssW, H = this.cssH;
    const mx = ((c.x0 + c.x1) / 2) * W, my = ((c.y0 + c.y1) / 2) * H;
    return [[c.x0 * W, c.y0 * H, 'tl'], [c.x1 * W, c.y0 * H, 'tr'], [c.x1 * W, c.y1 * H, 'br'], [c.x0 * W, c.y1 * H, 'bl'],
      [mx, c.y0 * H, 't'], [mx, c.y1 * H, 'b'], [c.x0 * W, my, 'l'], [c.x1 * W, my, 'r']];
  }

  updateInfo() {
    const e = this.estimate;
    const st = this.settings();
    const fmt = (Pz.OUTPUT.formats.find((f) => f.value === st.format) || {}).label || 'PNG';
    if (e && e.sig === this.sig()) {
      const kb = e.blob.size / 1024;
      $('edInfo').textContent = `Final image: ${e.w} × ${e.h} px · ${kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`} · ${fmt.split(' ')[0]}`;
      const flags = e.flags || [];
      $('edInfo').title = flags.length ? `Check: ${flags.join(', ')}` : '';
    } else {
      $('edInfo').textContent = 'Final image: measuring…';
    }
    $('edSpeed').textContent = this.renderMs ? `preview ${this.renderMs} ms` : '';
  }

  sig() { return JSON.stringify([this.settings(), this.doc]); }

  scheduleEstimate() {
    clearTimeout(this.estTimer);
    const sig = this.sig();
    if (this.estimate && this.estimate.sig === sig) { this.updateInfo(); return; }
    this.estTimer = setTimeout(() => this.measure(sig).catch(() => {}), 500);
  }

  async measure(sig) {
    const st = this.settings();
    const r = await fullWorker().render('ed-full', st, this.doc, { encode: { format: st.format, quality: st.jpgQuality }, stats: true, noPixels: true });
    if (!this.dlg.open) return null;
    this.estimate = { sig, blob: r.blob, w: r.finalW, h: r.finalH, stats: r.stats, deskewUsed: r.deskewUsed };
    this.updateInfo();
    return this.estimate;
  }

  // ---------- pointer handling on the image

  wire() {
    const ov = this.overlay;
    const pos = (e) => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = pos(e);
      if (this.compare === 'split' && this.tool === 'none') {
        this.drag = { kind: 'split' };
      } else if (this.compare === 'side') {
        return;
      } else if (this.tool === 'crop') {
        const hit = this.cropHandles().find(([hx, hy]) => Math.abs(hx - p[0]) < 10 && Math.abs(hy - p[1]) < 10);
        const c = this.cropDraft;
        const inside = p[0] > c.x0 * this.cssW && p[0] < c.x1 * this.cssW && p[1] > c.y0 * this.cssH && p[1] < c.y1 * this.cssH;
        this.cropSel = hit ? hit[2] : inside ? 'move' : 'new';
        this.drag = { kind: 'crop', start: p, orig: { ...c } };
      } else if (this.tool === 'persp') {
        const P = this.perspPts.map((q) => this.toDisp(q));
        let best = -1, bd = 24;
        P.forEach((q, i) => { const dd = Math.hypot(q[0] - p[0], q[1] - p[1]); if (dd < bd) { bd = dd; best = i; } });
        if (best < 0) return;
        this.perspSel = best;
        this.drag = { kind: 'persp' };
      } else if (this.tool === 'clone' && !this.cloneSrc) {
        this.cloneSrc = this.toOrig(p[0], p[1]);
        this.api.toast('Copy-from point set. Now paint over the spot to cover.', 'info');
        this.drawOverlay();
        return;
      } else if (['erase', 'eraseBox', 'lasso', 'keep', 'protect', 'clone'].includes(this.tool)) {
        this.drag = { kind: this.tool === 'lasso' ? 'erasePoly' : this.tool, pts: [p] };
      } else {
        return;
      }
      ov.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.onMove(p);
    });
    ov.addEventListener('pointermove', (e) => {
      const p = pos(e);
      this.hover = p;
      if (this.drag) this.onMove(p);
      else if (['erase', 'clone'].includes(this.tool)) this.drawOverlay();
    });
    ov.addEventListener('pointerleave', () => { this.hover = null; if (!this.drag) this.drawOverlay(); });
    const up = (e) => {
      if (!this.drag) return;
      try { ov.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.onUp();
    };
    ov.addEventListener('pointerup', up);
    ov.addEventListener('pointercancel', up);
    new ResizeObserver(() => { if (this.dlg.open) { this.fit(); this.draw(); } }).observe(this.stage);

    // buttons
    $('edUndo').onclick = () => this.undo();
    $('edRedo').onclick = () => this.redo();
    $('edReset').onclick = () => {
      this.doc = Pz.newEdit(this.doc.presetId, {});
      this.cloneSrc = null;
      this.cloneOff = null;
      this.commit();
      this.controls.refresh();
      this.api.toast('Back to the original crop with the preset settings.', 'info');
    };
    const holdBtn = $('edHold');
    const hold = (on) => { this.holding = on; if (on && !(this.last && this.last.before)) this.requestRender(); else this.draw(); };
    holdBtn.addEventListener('pointerdown', () => hold(true));
    for (const ev of ['pointerup', 'pointerleave', 'blur']) holdBtn.addEventListener(ev, () => { if (this.holding) hold(false); });
    holdBtn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!this.holding) hold(true); } });
    holdBtn.addEventListener('keyup', () => hold(false));
    for (const b of document.querySelectorAll('[data-compare]')) {
      b.onclick = () => {
        this.compare = this.compare === b.dataset.compare ? 'none' : b.dataset.compare;
        if (this.compare !== 'none' && this.tool !== 'none') this.tool = 'none';
        this.updateToolUi();
        this.requestRender();
      };
    }
    $('edRotL').onclick = () => this.rotate90(-1);
    $('edRotR').onclick = () => this.rotate90(1);
    $('edFlipH').onclick = () => this.flip('h');
    $('edFlipV').onclick = () => this.flip('v');
    const ang = $('edAngle');
    ang.oninput = () => { this.doc.geom.angle = Number(ang.value); this.showGrid = true; $('edAngleVal').textContent = `${Number(ang.value).toFixed(1)}°`; this.requestRender(); };
    ang.onchange = () => { this.commit(); clearTimeout(this.gridTimer); this.gridTimer = setTimeout(() => { this.showGrid = false; this.drawOverlay(); }, 900); };
    ang.onpointerdown = () => { this.showGrid = true; this.drawOverlay(); };
    $('edAngleReset').onclick = () => { this.doc.geom.angle = 0; this.commit(); };
    $('edDeskew').onclick = () => this.autoDeskew();
    $('edDeskewReset').onclick = () => { this.doc.geom.deskew = 0; this.doc.geom.deskewAuto = false; this.commit(); };
    $('edBrush').oninput = () => { this.brush = Number($('edBrush').value); $('edBrushVal').textContent = this.brush; this.drawOverlay(); };
    $('edSoft').onchange = () => { this.soft = $('edSoft').checked; };
    $('edCloneReset').onclick = () => { this.cloneSrc = null; this.cloneOff = null; this.api.toast('Click the clean area to copy from.', 'info'); this.drawOverlay(); };
    $('edPerspApply').onclick = () => {
      this.doc.geom.persp = clone(this.perspPts);
      this.doc.geom.crop = null;
      this.tool = 'none';
      this.commit();
      this.updateToolUi();
    };
    $('edPerspClear').onclick = () => { this.doc.geom.persp = null; this.perspPts = null; if (this.tool === 'persp') this.tool = 'none'; this.commit(); this.updateToolUi(); };
    $('edCropDone').onclick = () => this.setTool('none');
    $('edCropClear').onclick = () => { this.doc.geom.crop = null; this.cropDraft = { x0: 0, y0: 0, x1: 1, y1: 1 }; this.commit(); };
    $('edProtectClear').onclick = () => { this.doc.ops = this.doc.ops.filter((o) => o.t !== 'protect'); this.commit(); };

    $('edPreset').onchange = () => { this.doc.presetId = $('edPreset').value; this.doc.overrides = {}; this.commit(); this.controls.refresh(); this.renderPresetSelect(); };
    $('edClearCustom').onclick = () => { this.doc.overrides = {}; this.commit(); this.controls.refresh(); };
    $('edSavePreset').onclick = () => {
      const name = $('edPresetName').value.trim();
      if (!name) { this.api.toast('Type a name for the new preset.', 'warn'); $('edPresetName').focus(); return; }
      const id = this.api.savePreset(name, this.settings());
      this.doc.presetId = id;
      this.doc.overrides = {};
      $('edPresetName').value = '';
      this.commit();
      this.renderPresetSelect();
      this.controls.refresh();
      this.api.toast(`Preset "${name}" saved.`, 'ok');
    };
    $('edUpdatePreset').onclick = () => {
      this.api.updatePreset(this.doc.presetId, this.settings());
      this.doc.overrides = {};
      this.commit();
      this.controls.refresh();
    };
    $('edApplyRemaining').onclick = () => this.api.applyToOthers({ presetId: this.doc.presetId, overrides: clone(this.doc.overrides) }, false);
    $('edApplyAll').onclick = () => this.api.applyToOthers({ presetId: this.doc.presetId, overrides: clone(this.doc.overrides) }, true);
    $('edCopy').onclick = () => this.api.copySettings({ presetId: this.doc.presetId, overrides: clone(this.doc.overrides) });
    $('edPaste').onclick = () => {
      const s = this.api.pasteSettings();
      if (!s) return;
      this.doc.presetId = this.api.presetById(s.presetId) ? s.presetId : this.doc.presetId;
      this.doc.overrides = clone(s.overrides || {});
      this.commit();
      this.renderPresetSelect();
      this.controls.refresh();
    };

    $('edApprove').onclick = () => this.approve();
    $('edRetake').onclick = () => this.finish('retake');
    $('edBack').onclick = () => this.finish('back');
    this.dlg.addEventListener('cancel', (e) => { e.preventDefault(); this.finish('back'); });

    this.dlg.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'z' || e.key === 'Z') && !typing) { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (ctrl && (e.key === 'y' || e.key === 'Y') && !typing) { e.preventDefault(); this.redo(); return; }
      if (typing || ctrl || e.altKey) return;
      if (e.key === '[') { this.brush = Math.max(4, this.brush - 4); $('edBrush').value = this.brush; $('edBrushVal').textContent = this.brush; this.drawOverlay(); }
      if (e.key === ']') { this.brush = Math.min(300, this.brush + 4); $('edBrush').value = this.brush; $('edBrushVal').textContent = this.brush; this.drawOverlay(); }
      if (this.tool === 'crop' && e.key.startsWith('Arrow')) {
        e.preventDefault();
        this.nudgeCrop(e.key, e.shiftKey ? 10 : 1);
      }
      if (e.key === 'Enter' && !(e.target.closest && e.target.closest('button'))) { e.preventDefault(); this.approve(); }
    });
  }

  onMove(p) {
    const d = this.drag;
    if (d.kind === 'split') {
      this.split = Math.min(0.98, Math.max(0.02, p[0] / this.cssW));
      this.draw();
      return;
    }
    if (d.kind === 'crop') {
      const nx = Math.min(1, Math.max(0, p[0] / this.cssW));
      const ny = Math.min(1, Math.max(0, p[1] / this.cssH));
      const o = d.orig;
      const c = { ...o };
      const min = 0.02;
      const sel = this.cropSel;
      if (sel === 'move') {
        const dx = (p[0] - d.start[0]) / this.cssW, dy = (p[1] - d.start[1]) / this.cssH;
        const w = o.x1 - o.x0, h = o.y1 - o.y0;
        c.x0 = Math.min(1 - w, Math.max(0, o.x0 + dx)); c.x1 = c.x0 + w;
        c.y0 = Math.min(1 - h, Math.max(0, o.y0 + dy)); c.y1 = c.y0 + h;
      } else if (sel === 'new') {
        const sx = d.start[0] / this.cssW, sy = d.start[1] / this.cssH;
        c.x0 = Math.min(sx, nx); c.x1 = Math.max(sx, nx); c.y0 = Math.min(sy, ny); c.y1 = Math.max(sy, ny);
      } else {
        if (sel.includes('l')) c.x0 = Math.min(nx, o.x1 - min);
        if (sel.includes('r')) c.x1 = Math.max(nx, o.x0 + min);
        if (sel.includes('t')) c.y0 = Math.min(ny, o.y1 - min);
        if (sel.includes('b')) c.y1 = Math.max(ny, o.y0 + min);
      }
      this.cropDraft = c;
      this.drawOverlay();
      return;
    }
    if (d.kind === 'persp') {
      this.perspPts[this.perspSel] = this.toOrig(Math.min(this.cssW, Math.max(0, p[0])), Math.min(this.cssH, Math.max(0, p[1])));
      this.drawOverlay();
      return;
    }
    const last = d.pts[d.pts.length - 1];
    if (d.kind === 'eraseBox') { if (d.pts.length > 1) d.pts[1] = p; else d.pts.push(p); }
    else if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) d.pts.push(p);
    this.drawOverlay();
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    if (d.kind === 'split') return;
    if (d.kind === 'crop') {
      const c = this.cropDraft;
      if ((c.x1 - c.x0) < 0.02 || (c.y1 - c.y0) < 0.02) { this.cropDraft = d.orig; this.drawOverlay(); return; }
      const full = c.x0 <= 0.001 && c.y0 <= 0.001 && c.x1 >= 0.999 && c.y1 >= 0.999;
      this.doc.geom.crop = full ? null : { ...c };
      this.commit();
      return;
    }
    if (d.kind === 'persp') return;
    const toO = (p) => this.toOrig(p[0], p[1]).map((v) => Math.round(v * 10) / 10);
    if (d.kind === 'erase' || d.kind === 'clone') {
      const pts = d.pts.map(toO);
      const size = this.brush;
      if (d.kind === 'erase') this.doc.ops.push({ t: 'erase', pts, size, soft: this.soft });
      else {
        if (!this.cloneOff) this.cloneOff = [this.cloneSrc[0] - pts[0][0], this.cloneSrc[1] - pts[0][1]];
        this.doc.ops.push({ t: 'clone', pts, off: this.cloneOff.slice(), size, soft: this.soft });
      }
    } else if (d.kind === 'eraseBox') {
      if (d.pts.length < 2) return;
      const [a, b] = d.pts;
      if (Math.abs(b[0] - a[0]) < 3 || Math.abs(b[1] - a[1]) < 3) { this.drawOverlay(); return; }
      const pts = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map(toO);
      this.doc.ops.push({ t: 'erasePoly', pts });
    } else {
      if (d.pts.length < 3) { this.drawOverlay(); return; }
      const t = d.kind === 'keep' ? 'keep' : d.kind === 'protect' ? 'protect' : 'erasePoly';
      this.doc.ops.push({ t, pts: d.pts.map(toO) });
    }
    this.commit();
  }

  nudgeCrop(key, px) {
    const c = { ...this.cropDraft };
    const dx = px / (this.last ? this.last.geoW : 1000);
    const dy = px / (this.last ? this.last.geoH : 1000);
    const sel = this.cropSel && this.cropSel !== 'new' ? this.cropSel : 'move';
    const mv = { ArrowLeft: [-dx, 0], ArrowRight: [dx, 0], ArrowUp: [0, -dy], ArrowDown: [0, dy] }[key];
    if (sel === 'move') {
      const w = c.x1 - c.x0, h = c.y1 - c.y0;
      c.x0 = Math.min(1 - w, Math.max(0, c.x0 + mv[0])); c.x1 = c.x0 + w;
      c.y0 = Math.min(1 - h, Math.max(0, c.y0 + mv[1])); c.y1 = c.y0 + h;
    } else {
      if (sel.includes('l')) c.x0 = Math.min(c.x1 - 0.02, Math.max(0, c.x0 + mv[0]));
      if (sel.includes('r')) c.x1 = Math.max(c.x0 + 0.02, Math.min(1, c.x1 + mv[0]));
      if (sel.includes('t')) c.y0 = Math.min(c.y1 - 0.02, Math.max(0, c.y0 + mv[1]));
      if (sel.includes('b')) c.y1 = Math.max(c.y0 + 0.02, Math.min(1, c.y1 + mv[1]));
    }
    this.cropDraft = c;
    this.doc.geom.crop = c;
    this.commit();
  }

  async approve() {
    if (this.approving) return;
    this.approving = true;
    $('edApprove').disabled = true;
    $('edBusy').hidden = false;
    try {
      if (this.tool === 'persp') { this.doc.geom.persp = clone(this.perspPts); this.tool = 'none'; }
      const sig = this.sig();
      const est = this.estimate && this.estimate.sig === sig ? this.estimate : await this.measure(sig);
      if (!est) return;
      this.finish('approve', { result: { blob: est.blob, w: est.w, h: est.h, stats: est.stats, deskewUsed: est.deskewUsed } });
    } catch (e) {
      this.api.toast(`Could not make the final image. ${e.message}`, 'error');
    } finally {
      this.approving = false;
      $('edApprove').disabled = false;
      $('edBusy').hidden = true;
    }
  }
}
