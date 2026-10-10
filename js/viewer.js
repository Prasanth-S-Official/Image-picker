// Continuous-scroll PDF viewer with an always-on crop box.
// All layout positions are kept in PDF points ("pts") so zooming never moves the crop box.

const GAP = 12; // pts between pages
const MIN_SCALE = 0.3;
const MAX_SCALE = 6;
const MIN_DRAG_PX = 30; // drags smaller than this (screen px) are ignored
const MAX_CANVAS_PIXELS = 24e6;
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Lowercase letters and digits only, single spaces. Used to match Excel text against PDF text. */
export const normText = (s) => String(s ?? '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export class Viewer {
  /** callbacks: canCrop, onBlocked, onBoxChange, onBoxDone, onScroll, onZoom */
  constructor(scroller, callbacks) {
    this.scroller = scroller;
    this.cb = callbacks;
    this.doc = null;
    this.pages = [];
    this.scale = 1;
    this.fitMode = true;
    this.box = null;
    this.drag = null;
    this.dpr = window.devicePixelRatio || 1;

    this.stage = document.createElement('div');
    this.stage.className = 'pdf-stage';
    this.column = document.createElement('div');
    this.column.className = 'pdf-column';
    this.stage.appendChild(this.column);
    scroller.appendChild(this.stage);

    this.boxEl = document.createElement('div');
    this.boxEl.className = 'crop-box';
    this.boxEl.hidden = true;
    for (const h of HANDLES) {
      const d = document.createElement('div');
      d.className = `handle h-${h}`;
      d.dataset.h = h;
      this.boxEl.appendChild(d);
    }

    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = this.pages[Number(e.target.dataset.i)];
        if (!p) continue;
        p.visible = e.isIntersecting;
        if (!p.visible) this.releasePage(p);
      }
      this.pump();
    }, { root: scroller, rootMargin: '900px 0px' });

    scroller.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    scroller.addEventListener('pointermove', (e) => this.onPointerMove(e));
    scroller.addEventListener('pointerup', (e) => this.onPointerUp(e));
    scroller.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !this.doc) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0022);
      this.setScale(this.scale * factor, { clientX: e.clientX, clientY: e.clientY });
    }, { passive: false });
    scroller.addEventListener('scroll', () => this.cb.onScroll && this.cb.onScroll());

    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (this.fitMode && this.doc) this.fitWidth(); }, 120);
    }).observe(scroller);
  }

  // ---------- loading and layout ----------

  async load(doc, view) {
    this.unload();
    this.doc = doc;
    this.text = null;
    this.textPromise = null;
    const pages = [];
    let top = 0;
    let maxW = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      pages.push({ i: i - 1, page, w: vp.width, h: vp.height, top, left: 0, visible: false, canvas: null, renderedScale: 0 });
      top += vp.height + GAP;
      maxW = Math.max(maxW, vp.width);
    }
    this.colW = maxW;
    this.colH = Math.max(0, top - GAP);
    for (const p of pages) {
      p.left = (maxW - p.w) / 2;
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.i = p.i;
      el.dataset.page = p.i + 1;
      p.el = el;
      this.column.appendChild(el);
    }
    this.pages = pages;
    this.column.appendChild(this.boxEl);
    if (view && view.zoom && view.zoom !== 'fit') {
      this.fitMode = false;
      this.applyScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(view.zoom) || 1)));
    } else {
      this.fitWidth(true);
    }
    for (const p of pages) this.observer.observe(p.el);
    if (view && typeof view.y === 'number') this.scrollToY(view.y, 'auto');
    else this.scroller.scrollTop = 0;
  }

  unload() {
    this.clearBox(true);
    for (const p of this.pages) { this.observer.unobserve(p.el); this.releasePage(p); }
    this.pages = [];
    this.column.innerHTML = '';
    this.doc = null;
    this.marker = null;
    this.markerEl = null;
  }

  applyScale(s) {
    this.scale = s;
    this.column.style.width = `${this.colW * s}px`;
    this.column.style.height = `${this.colH * s}px`;
    for (const p of this.pages) {
      Object.assign(p.el.style, {
        left: `${p.left * s}px`, top: `${p.top * s}px`, width: `${p.w * s}px`, height: `${p.h * s}px`,
      });
    }
    this.positionBox();
    this.positionMarker();
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = setTimeout(() => this.pump(), 180);
    this.cb.onZoom && this.cb.onZoom();
  }

  /** Change zoom, keeping the point under the mouse (or the view centre) still. */
  setScale(s, anchor) {
    if (!this.doc) return;
    s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    if (Math.abs(s - this.scale) < 1e-4) return;
    const sr = this.scroller.getBoundingClientRect();
    const a = anchor || { clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height / 2 };
    const before = this.column.getBoundingClientRect();
    const px = (a.clientX - before.left) / this.scale;
    const py = (a.clientY - before.top) / this.scale;
    this.fitMode = false;
    this.applyScale(s);
    const after = this.column.getBoundingClientRect();
    this.scroller.scrollLeft += after.left - (a.clientX - px * s);
    this.scroller.scrollTop += after.top - (a.clientY - py * s);
  }

  zoomBy(f) { this.setScale(this.scale * f); }

  fitWidth(initial) {
    if (!this.doc) return;
    const y = initial ? null : this.getScrollY();
    const avail = this.scroller.clientWidth - 48 - 4;
    this.fitMode = true;
    this.applyScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, avail / this.colW)));
    if (y !== null) this.scrollToY(y, 'auto');
  }

  /** Zoom as a percentage of real size (100% = 96 dpi). */
  zoomPercent() { return Math.round((this.scale * 72) / 96 * 100); }

  // ---------- page rendering ----------

  releasePage(p) {
    if (p.canvas) {
      p.canvas.width = 0;
      p.canvas.height = 0;
      p.canvas.remove();
      p.canvas = null;
    }
    p.renderedScale = 0;
  }

  targetRenderScale(p) {
    let rs = this.scale * Math.max(2, this.dpr);
    const px = p.w * rs * p.h * rs;
    if (px > MAX_CANVAS_PIXELS) rs *= Math.sqrt(MAX_CANVAS_PIXELS / px);
    return rs;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const doc = this.doc;
        if (!doc) break;
        const mid = (this.scroller.scrollTop + this.scroller.clientHeight / 2) / this.scale;
        const need = this.pages
          .filter((p) => p.visible && Math.abs(p.renderedScale - this.targetRenderScale(p)) > 1e-3)
          .sort((a, b) => Math.abs(a.top + a.h / 2 - mid) - Math.abs(b.top + b.h / 2 - mid));
        if (!need.length) break;
        const p = need[0];
        const rs = this.targetRenderScale(p);
        const c = document.createElement('canvas');
        c.width = Math.round(p.w * rs);
        c.height = Math.round(p.h * rs);
        try {
          await p.page.render({ canvasContext: c.getContext('2d'), viewport: p.page.getViewport({ scale: rs }) }).promise;
        } catch (e) {
          console.warn('Page render failed', p.i + 1, e);
          p.renderedScale = rs; // do not loop forever on a broken page
          continue;
        }
        if (this.doc !== doc) break;
        if (!p.visible) { c.width = 0; continue; }
        if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
        p.canvas = c;
        p.renderedScale = rs;
        p.el.appendChild(c);
        if (this.box) this.cb.onBoxChange && this.cb.onBoxChange(this.box, 'render');
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---------- scrolling ----------

  getScrollY() { return this.scroller.scrollTop / this.scale; }

  scrollToY(yPts, behavior = 'auto') {
    this.scroller.scrollTo({ top: Math.max(0, yPts * this.scale), behavior });
  }

  scrollToPage(n, behavior = 'auto') {
    const p = this.pages[n - 1];
    if (!p) return false;
    this.scrollToY(Math.max(0, p.top - 4 / this.scale), behavior);
    return true;
  }

  pageAtY(yPts) {
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.pages[m].top <= yPts) lo = m; else hi = m - 1;
    }
    return lo + 1;
  }

  currentPage() {
    if (!this.pages.length) return 0;
    return this.pageAtY((this.scroller.scrollTop + this.scroller.clientHeight * 0.35) / this.scale);
  }

  // ---------- crop box interaction ----------

  pointToPts(e) {
    const r = this.column.getBoundingClientRect();
    return {
      x: Math.min(this.colW, Math.max(0, (e.clientX - r.left) / this.scale)),
      y: Math.min(this.colH, Math.max(0, (e.clientY - r.top) / this.scale)),
    };
  }

  onPointerDown(e) {
    if (e.button !== 0 || !this.doc) return;
    // ignore clicks on the scrollbar
    const sr = this.scroller.getBoundingClientRect();
    if (e.clientX > sr.left + this.scroller.clientWidth || e.clientY > sr.top + this.scroller.clientHeight) return;
    const block = this.cb.canCrop ? this.cb.canCrop() : null;
    if (block) { this.cb.onBlocked && this.cb.onBlocked(block); return; }
    e.preventDefault();
    const pt = this.pointToPts(e);
    const handle = e.target.closest && e.target.closest('.handle');
    const onBox = e.target.closest && e.target.closest('.crop-box');
    if (this.box && handle) {
      this.drag = { kind: 'resize', h: handle.dataset.h, start: pt, orig: { ...this.box } };
    } else if (this.box && onBox) {
      this.drag = { kind: 'move', start: pt, orig: { ...this.box } };
    } else {
      this.drag = { kind: 'new', start: pt, orig: this.box ? { ...this.box } : null };
    }
    this.drag.last = { clientX: e.clientX, clientY: e.clientY };
    this.drag.down = { clientX: e.clientX, clientY: e.clientY };
    this.scroller.setPointerCapture(e.pointerId);
    this.scroller.classList.add('dragging');
    this.startAutoScroll();
  }

  onPointerMove(e) {
    if (!this.drag) return;
    this.drag.last = { clientX: e.clientX, clientY: e.clientY };
    this.updateDrag();
  }

  updateDrag() {
    const d = this.drag;
    if (!d) return;
    const pt = this.pointToPts(d.last);
    if (d.kind === 'new') {
      this.setBox({
        x0: Math.min(d.start.x, pt.x), x1: Math.max(d.start.x, pt.x),
        y0: Math.min(d.start.y, pt.y), y1: Math.max(d.start.y, pt.y),
      }, true);
    } else if (d.kind === 'move') {
      const o = d.orig;
      const w = o.x1 - o.x0;
      const h = o.y1 - o.y0;
      const x0 = Math.min(this.colW - w, Math.max(0, o.x0 + pt.x - d.start.x));
      const y0 = Math.min(this.colH - h, Math.max(0, o.y0 + pt.y - d.start.y));
      this.setBox({ x0, y0, x1: x0 + w, y1: y0 + h });
    } else {
      const b = { ...d.orig };
      const min = MIN_DRAG_PX / this.scale;
      if (d.h.includes('w')) b.x0 = Math.min(pt.x, b.x1 - min);
      if (d.h.includes('e')) b.x1 = Math.max(pt.x, b.x0 + min);
      if (d.h.includes('n')) b.y0 = Math.min(pt.y, b.y1 - min);
      if (d.h.includes('s')) b.y1 = Math.max(pt.y, b.y0 + min);
      this.setBox(b);
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.scroller.classList.remove('dragging');
    try { this.scroller.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    cancelAnimationFrame(this.autoRaf);
    if (d.kind === 'new') {
      const b = this.box;
      const tooSmall = !b || (b.x1 - b.x0) * this.scale < MIN_DRAG_PX || (b.y1 - b.y0) * this.scale < MIN_DRAG_PX;
      if (tooSmall) {
        // a click or tiny drag: keep whatever box was there before
        if (d.orig) this.setBox(d.orig); else this.clearBox();
        const moved = Math.hypot(d.last.clientX - d.down.clientX, d.last.clientY - d.down.clientY);
        if (moved < 5 && this.cb.onClick) this.cb.onClick(d.start);
        return;
      }
    }
    if (this.box) this.cb.onBoxDone && this.cb.onBoxDone(this.box);
  }

  startAutoScroll() {
    const step = () => {
      if (!this.drag) return;
      const r = this.scroller.getBoundingClientRect();
      const y = this.drag.last.clientY;
      const edge = 48;
      let dy = 0;
      if (y < r.top + edge) dy = -Math.ceil((r.top + edge - y) / 3);
      else if (y > r.bottom - edge) dy = Math.ceil((y - (r.bottom - edge)) / 3);
      if (dy) {
        this.scroller.scrollTop += Math.max(-40, Math.min(40, dy));
        this.updateDrag();
      }
      this.autoRaf = requestAnimationFrame(step);
    };
    this.autoRaf = requestAnimationFrame(step);
  }

  setBox(b, drawing) {
    this.box = b;
    this.positionBox();
    this.cb.onBoxChange && this.cb.onBoxChange(b, drawing ? 'drawing' : 'edit');
  }

  clearBox(silent) {
    this.box = null;
    this.drag = null;
    this.positionBox();
    if (!silent) this.cb.onBoxChange && this.cb.onBoxChange(null);
  }

  positionBox() {
    const b = this.box;
    if (!b) { this.boxEl.hidden = true; return; }
    const s = this.scale;
    this.boxEl.hidden = false;
    Object.assign(this.boxEl.style, {
      left: `${b.x0 * s}px`, top: `${b.y0 * s}px`, width: `${(b.x1 - b.x0) * s}px`, height: `${(b.y1 - b.y0) * s}px`,
    });
  }

  /** Screen rectangle of the box (for placing the floating panel). */
  boxClientRect() {
    return this.box ? this.boxEl.getBoundingClientRect() : null;
  }

  flash(b) {
    const s = this.scale;
    const f = document.createElement('div');
    f.className = 'crop-flash';
    Object.assign(f.style, {
      left: `${b.x0 * s}px`, top: `${b.y0 * s}px`, width: `${(b.x1 - b.x0) * s}px`, height: `${(b.y1 - b.y0) * s}px`,
    });
    this.column.appendChild(f);
    setTimeout(() => f.remove(), 900);
  }

  /** True when this point (pts) is comfortably inside the visible part of the scroll area. */
  isYVisible(yPts) {
    const top = this.scroller.scrollTop / this.scale;
    const bottom = (this.scroller.scrollTop + this.scroller.clientHeight) / this.scale;
    return yPts > top + 10 && yPts < bottom - 120 / this.scale;
  }

  // ---------- PDF text: finding questions and checking crops ----------

  /** Text of every page with positions (built once per PDF, in the background). */
  textIndex() {
    if (this.textPromise) return this.textPromise;
    const doc = this.doc;
    const pages = this.pages;
    this.textPromise = (async () => {
      const out = [];
      for (const p of pages) {
        let tc = { items: [] };
        try { tc = await p.page.getTextContent(); } catch { /* page without text */ }
        const vp = p.page.getViewport({ scale: 1 });
        const items = [];
        let norm = '';
        for (const it of tc.items) {
          const n = normText(it.str);
          if (!n) continue;
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          const h = Math.hypot(it.transform[2], it.transform[3]) || 10;
          if (norm) norm += ' ';
          items.push({ str: it.str.trim(), x, y: y - h, w: it.width || 0, h, start: norm.length });
          norm += n;
        }
        out.push({ norm, items });
      }
      if (this.doc === doc) this.text = out;
      return out;
    })();
    return this.textPromise;
  }

  hasText() { return !!this.text && this.text.some((p) => p.items.length > 0); }

  /**
   * Where a question starts: first by the opening words of its text, then by its number ("Q12." / "12.").
   * Returns { page, x, y, how } in page pts, or null.
   */
  async findQuestion({ qno, text }) {
    const idx = await this.textIndex();
    if (!idx) return null;
    const hitAt = (pi, k) => {
      const items = idx[pi].items;
      let best = items[0];
      for (const it of items) { if (it.start <= k) best = it; else break; }
      return best ? { page: pi + 1, x: best.x, y: best.y, how: 'text' } : null;
    };
    const words = normText(text).split(' ').filter(Boolean);
    for (const n of [10, 7, 5]) {
      if (words.length < Math.min(n, 4)) continue;
      const phrase = words.slice(0, Math.min(n, words.length)).join(' ');
      for (let pi = 0; pi < idx.length; pi++) {
        const k = idx[pi].norm.indexOf(phrase);
        if (k >= 0) return hitAt(pi, k);
      }
    }
    const num = String(qno ?? '').trim().replace(/^q(uestion)?\.?\s*/i, '');
    if (/^\d+[a-z]?$/i.test(num)) {
      const re = new RegExp(`^(q(uestion)?\\.?\\s*${num}\\b|${num}\\s*[.)])`, 'i');
      for (let pi = 0; pi < idx.length; pi++) {
        const it = idx[pi].items.find((t) => re.test(t.str));
        if (it) return { page: pi + 1, x: it.x, y: it.y, how: 'number' };
      }
    }
    return null;
  }

  /** Text found inside the box (only once the text index is ready; otherwise null). */
  textInBox(b) {
    if (!this.text) return null;
    const out = [];
    for (const pc of this.pieces(b)) {
      const { p } = pc;
      for (const it of this.text[p.i].items) {
        const cx = p.left + it.x + it.w / 2;
        const cy = it.y + it.h / 2;
        if (cx > b.x0 && cx < b.x1 && cy > pc.y0 && cy < pc.y1) out.push(it.str);
      }
    }
    return out;
  }

  /** Small label on the page showing where the active question starts. */
  setMarker(m) {
    this.marker = m;
    if (!this.markerEl) {
      this.markerEl = document.createElement('div');
      this.markerEl.className = 'q-marker';
    }
    if (m && this.pages[m.page - 1]) {
      this.markerEl.textContent = m.label;
      if (!this.markerEl.isConnected) this.column.appendChild(this.markerEl);
    } else {
      this.markerEl.remove();
    }
    this.positionMarker();
  }

  positionMarker() {
    const m = this.marker;
    if (!m || !this.markerEl || !this.markerEl.isConnected) return;
    const p = this.pages[m.page - 1];
    this.markerEl.style.top = `${(p.top + m.y) * this.scale - 4}px`;
    this.markerEl.style.left = `${p.left * this.scale}px`;
  }

  /** Page under a layout point, with the point in page pts. Null in the gaps between pages. */
  pageAtPoint(pt) {
    for (const p of this.pages) {
      if (pt.y >= p.top && pt.y <= p.top + p.h && pt.x >= p.left && pt.x <= p.left + p.w) {
        return { p, x: pt.x - p.left, y: pt.y - p.top };
      }
    }
    return null;
  }

  /** The whole page rendered at `scale` px per pt, as ImageData (for finding diagrams). */
  async pageImageData(i, scale) {
    const p = this.pages[i];
    const c = document.createElement('canvas');
    c.width = Math.round(p.w * scale);
    c.height = Math.round(p.h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await p.page.render({ canvasContext: ctx, viewport: p.page.getViewport({ scale }) }).promise;
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  /** Y position (pts, whole document) of a point on a page. */
  docY(page, y) { return this.pages[page - 1] ? this.pages[page - 1].top + y : 0; }

  // ---------- producing the cropped image ----------

  /** Parts of each page covered by the box: [{ p, x0, x1, y0, y1 }] in page pts. Page gaps are skipped. */
  pieces(b) {
    const out = [];
    for (const p of this.pages) {
      const y0 = Math.max(b.y0, p.top);
      const y1 = Math.min(b.y1, p.top + p.h);
      if (y1 - y0 < 0.5) continue;
      out.push({ p, y0: y0 - p.top, y1: y1 - p.top });
    }
    return out;
  }

  /** Page numbers covered by the box, e.g. [3] or [3, 4]. */
  boxPages(b) { return this.pieces(b).map((pc) => pc.p.i + 1); }

  /** Output scale (pixels per pt) for the saved image: at least `minScale` (3 = 216 dpi), sharper if zoomed in. */
  outputScale(b, minScale = 3) {
    let s = Math.max(minScale, Math.min(6, this.scale * this.dpr * 2));
    const pcs = this.pieces(b);
    const w = b.x1 - b.x0;
    const h = pcs.reduce((a, pc) => a + pc.y1 - pc.y0, 0);
    // small diagrams get extra pixels (up to 576 dpi) so the longest side is at least 1000 px
    const longest = Math.max(w, h);
    if (longest > 0 && longest * s < 1000) s = Math.min(8, 1000 / longest);
    if (w * h * s * s > MAX_CANVAS_PIXELS) s = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
    return s;
  }

  /** Fast preview from the on-screen page images. Returns { canvas, scale }. */
  previewCanvas(b, maxW = 620, maxH = 520) {
    const pcs = this.pieces(b);
    const bw = b.x1 - b.x0;
    const bh = pcs.reduce((a, pc) => a + pc.y1 - pc.y0, 0);
    if (!pcs.length || bw <= 0) return null;
    const s = Math.min(maxW / bw, maxH / bh, this.scale * Math.max(2, this.dpr));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bw * s));
    c.height = Math.max(1, Math.round(bh * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    let dy = 0;
    for (const pc of pcs) {
      const { p } = pc;
      const ph = (pc.y1 - pc.y0) * s;
      // horizontal overlap between the box and this page
      const ix0 = Math.max(b.x0, p.left);
      const ix1 = Math.min(b.x1, p.left + p.w);
      if (ix1 > ix0) {
        if (p.canvas && p.renderedScale) {
          const rs = p.canvas.width / p.w;
          ctx.drawImage(p.canvas,
            (ix0 - p.left) * rs, pc.y0 * rs, (ix1 - ix0) * rs, (pc.y1 - pc.y0) * rs,
            (ix0 - b.x0) * s, dy, (ix1 - ix0) * s, ph);
        } else {
          ctx.fillStyle = '#e8e8e8';
          ctx.fillRect((ix0 - b.x0) * s, dy, (ix1 - ix0) * s, ph);
        }
      }
      dy += ph;
    }
    return { canvas: c, scale: s };
  }

  /** Full-quality crop rendered straight from the PDF. Pieces on different pages are stacked. */
  async renderCrop(b, s) {
    const pcs = this.pieces(b);
    if (!pcs.length) throw new Error('The box is not on a page. Draw it over the diagram.');
    const W = Math.max(1, Math.round((b.x1 - b.x0) * s));
    const heights = pcs.map((pc) => Math.max(1, Math.round((pc.y1 - pc.y0) * s)));
    const out = document.createElement('canvas');
    out.width = W;
    out.height = heights.reduce((a, h) => a + h, 0);
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    let dy = 0;
    for (let k = 0; k < pcs.length; k++) {
      const pc = pcs[k];
      const tmp = document.createElement('canvas');
      tmp.width = W;
      tmp.height = heights[k];
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = '#fff';
      tctx.fillRect(0, 0, W, heights[k]);
      const viewport = pc.p.page.getViewport({
        scale: s, offsetX: -(b.x0 - pc.p.left) * s, offsetY: -pc.y0 * s,
      });
      await pc.p.page.render({ canvasContext: tctx, viewport }).promise;
      octx.drawImage(tmp, 0, dy);
      tmp.width = 0;
      dy += heights[k];
    }
    return out;
  }
}
