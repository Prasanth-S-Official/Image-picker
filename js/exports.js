// CSV, Excel, ZIP and backup files.

export const STATUS_LABEL = { pending: 'Pending', done: 'Done', skipped: 'Skipped' };
export const WARN_LABEL = {
  edge: 'may be cut off at an edge',
  text: 'has a lot of text',
  small: 'small image',
  duplicate: 'same area as another image',
  page: 'far from its question in the PDF',
  nearlyBlank: 'nearly blank',
  dark: 'very dark',
  blurry: 'looks blurry',
};

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function progressCsv(items) {
  const lines = [['name', 'status', 'question_no', 'pdf', 'page', 'note', 'warnings'].join(',')];
  for (const it of items) {
    const warn = it.status === 'done' ? (it.warnings || []).map((c) => WARN_LABEL[c] || c).join('; ') : '';
    lines.push([it.name, STATUS_LABEL[it.status], it.qno, it.pdf, it.page, noteFor(it), warn].map(csvCell).join(','));
  }
  // BOM so Excel opens it as UTF-8
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

export function noteFor(it) {
  const parts = [];
  if (it.note) parts.push(it.note);
  if (it.copyOf) parts.push(`same image as ${it.copyOf}`);
  if (it.status === 'done' && it.source === 'folder') parts.push('file was already in the folder');
  return parts.join('; ');
}

/**
 * Updated copy of the original workbook: fills the image column with the final names and adds
 * "Image status" and "Image note" columns. Without an original workbook, builds a new one.
 */
export function updatedWorkbook(XLSX, items, excelMeta, excelBytes) {
  if (!excelMeta || !excelBytes) {
    const wb = XLSX.utils.book_new();
    const rows = [['Image name', 'Question no', 'Image status', 'PDF', 'Page', 'Image note']];
    for (const it of items) rows.push([it.name, it.qno, STATUS_LABEL[it.status], it.pdf, it.page, noteFor(it)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Images');
    return wb;
  }
  const wb = XLSX.read(excelBytes, { type: 'array' });
  const ws = wb.Sheets[excelMeta.sheet];
  if (!ws) throw new Error(`The sheet "${excelMeta.sheet}" is no longer in the Excel file.`);
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const r0 = excelMeta.origin.r;
  const c0 = excelMeta.origin.c;
  const headerR = r0 + excelMeta.headerRow;

  const headerAt = (c) => {
    const cell = ws[XLSX.utils.encode_cell({ r: headerR, c })];
    return cell ? String(cell.v ?? '').trim().toLowerCase() : '';
  };
  const findOrAdd = (title) => {
    for (let c = range.s.c; c <= range.e.c; c++) if (headerAt(c) === title.toLowerCase()) return c;
    range.e.c += 1;
    ws[XLSX.utils.encode_cell({ r: headerR, c: range.e.c })] = { t: 's', v: title };
    return range.e.c;
  };
  const statusC = findOrAdd('Image status');
  const noteC = findOrAdd('Image note');
  const imageC = c0 + excelMeta.cols.image;

  // row -> parts in that row
  const byRow = new Map();
  for (const it of items) {
    for (const ref of it.rows || []) {
      if (!byRow.has(ref.row)) byRow.set(ref.row, []);
      byRow.get(ref.row).push({ it, prefix: ref.prefix || '' });
    }
  }
  for (const [row, parts] of byRow) {
    const r = r0 + row;
    const set = (c, v) => { ws[XLSX.utils.encode_cell({ r, c })] = { t: 's', v }; };
    set(imageC, parts.map((p) => p.prefix + p.it.name).join(', '));
    const statuses = parts.map((p) => STATUS_LABEL[p.it.status]);
    const allSame = statuses.every((s) => s === statuses[0]);
    set(statusC, allSame ? statuses[0] : parts.map((p) => `${p.it.name}: ${STATUS_LABEL[p.it.status]}`).join(', '));
    const notes = parts.map((p) => noteFor(p.it)).filter(Boolean);
    set(noteC, notes.join('; '));
    if (r > range.e.r) range.e.r = r;
  }
  ws['!ref'] = XLSX.utils.encode_range(range);
  return wb;
}

export function backupJson(state) {
  const data = { app: 'diagram-cropper', version: 1, exportedAt: new Date().toISOString(), state };
  return new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
}

/** Validates a backup file. Returns the state or throws a plain-language error. */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not a valid backup (it is not JSON).'); }
  if (!data || data.app !== 'diagram-cropper' || !data.state || !Array.isArray(data.state.items)) {
    throw new Error('This file is not a Diagram Cropper backup.');
  }
  return data.state;
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
