// Name parsing, cleaning and checking. Pure functions, no DOM.

export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const HAS_EXT_RE = /\.[a-z0-9]{2,5}$/i;
export const LONG_NAME = 80;

/** Split a name like "images/sub/q12.png" into { prefix: "images/sub/", base: "q12.png" }. */
export function splitPath(raw) {
  const s = String(raw ?? '').trim();
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut >= 0 ? { prefix: s.slice(0, cut + 1), base: s.slice(cut + 1).trim() } : { prefix: '', base: s };
}

/** Trim, drop any folder path, add .png when there is no extension. Returns '' for blanks. */
export function cleanName(raw) {
  let { base } = splitPath(raw);
  base = base.trim();
  if (!base) return '';
  if (!HAS_EXT_RE.test(base)) base += '.png';
  return base;
}

/** Split one cell / line that may hold several names ("a.png, b.png"). */
export function splitCell(value) {
  if (value === null || value === undefined) return [];
  return String(value).split(/[\n\r;,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Lowercase, spaces to underscores, other unsafe characters to underscores. Keeps the extension. */
export function fixName(name) {
  let s = String(name).trim().toLowerCase();
  s = s.replace(/\s+/g, '_');
  s = s.replace(/[^a-z0-9._-]/g, '_');
  s = s.replace(/_+/g, '_');
  // no underscores right before the extension or at the start
  s = s.replace(/_+(\.[a-z0-9]+)$/, '$1').replace(/^_+/, '');
  if (!HAS_EXT_RE.test(s)) s += '.png';
  if (s.length > LONG_NAME) {
    const m = s.match(/(\.[a-z0-9]+)$/);
    const ext = m ? m[1] : '';
    s = s.slice(0, LONG_NAME - ext.length) + ext;
  }
  return s;
}

/** Problems with a single name, as plain-language strings. */
export function nameProblems(name) {
  const out = [];
  if (/\s/.test(name)) out.push('has spaces');
  if (/[A-Z]/.test(name)) out.push('has capital letters');
  const specials = name.replace(/[A-Za-z0-9._\s-]/g, '');
  if (specials) out.push(`has special characters (${[...new Set(specials)].join(' ')})`);
  if (name.length > LONG_NAME) out.push(`is very long (${name.length} characters)`);
  if (!IMAGE_EXT_RE.test(name)) out.push('does not end in an image extension like .png');
  if (/^\.|\.$/.test(name)) out.push('starts or ends with a dot');
  return out;
}

/**
 * Turn raw entries into a checked list.
 * entries: [{ raw, qno?, text?, row? }]
 * Returns { names: [{ name, qno, text, rows:[{row,prefix}] }], removedBlank, removedDuplicate, problems: [{ name, problems, fixed }] }
 */
export function buildNameList(entries, { fix = false } = {}) {
  const byName = new Map();
  let removedBlank = 0;
  let removedDuplicate = 0;
  for (const e of entries) {
    const { prefix } = splitPath(e.raw);
    let name = cleanName(e.raw);
    if (!name) { removedBlank++; continue; }
    if (fix) name = fixName(name);
    const existing = byName.get(name);
    if (existing) {
      removedDuplicate++;
      if (e.row !== undefined) existing.rows.push({ row: e.row, prefix });
      if (!existing.qno && e.qno) existing.qno = e.qno;
      if (!existing.text && e.text) existing.text = e.text;
      continue;
    }
    byName.set(name, {
      name,
      qno: e.qno ? String(e.qno).trim() : '',
      text: e.text ? String(e.text).trim() : '',
      rows: e.row !== undefined ? [{ row: e.row, prefix }] : [],
    });
  }
  const names = [...byName.values()];

  // names that differ only by capital letters clash on Windows
  const lowerCount = new Map();
  for (const n of names) {
    const k = n.name.toLowerCase();
    lowerCount.set(k, (lowerCount.get(k) || 0) + 1);
  }
  const problems = [];
  for (const n of names) {
    const p = nameProblems(n.name);
    if (lowerCount.get(n.name.toLowerCase()) > 1) p.push('same as another name except for capital letters');
    if (p.length) problems.push({ name: n.name, problems: p, fixed: fixName(n.name) });
  }
  return { names, removedBlank, removedDuplicate, problems };
}

/** Parse pasted text: one name per line (commas and semicolons also split). */
export function entriesFromText(text) {
  return splitCell(text).map((raw) => ({ raw }));
}

const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Guess which header columns hold the image name, question number and question text. */
export function detectColumns(headers) {
  const H = headers.map(norm);
  const pick = (exact, contains = [], avoid = []) => {
    for (const want of exact) {
      const i = H.indexOf(want);
      if (i >= 0) return i;
    }
    for (const want of contains) {
      const i = H.findIndex((h) => h.includes(want) && !avoid.some((a) => h.includes(a)));
      if (i >= 0) return i;
    }
    return -1;
  };
  const image = pick(['imagepath', 'imagename', 'image', 'imagefile', 'img', 'imgpath', 'diagram', 'figure', 'imageurl'],
    ['image', 'img', 'diagram', 'figure']);
  const qno = pick(['qno', 'questionno', 'questionnumber', 'qnum', 'qnumber', 'questionid', 'qid', 'no', 'sno', 'slno', 'number', 'id'],
    ['qno', 'questionno', 'questionnum']);
  const text = pick(['text', 'question', 'questiontext', 'questionstem', 'stem', 'questiontitle'],
    ['questiontext', 'question'], ['no', 'num', 'id', 'type', 'image', 'img']);
  return { image, qno, text: text === qno ? -1 : text };
}

/** Read entries from a 2D array (first non-empty row is the header). */
export function entriesFromRows(rows, cols, headerRow) {
  const entries = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = cols.image >= 0 ? row[cols.image] : undefined;
    const parts = splitCell(cell);
    for (const raw of parts) {
      entries.push({
        raw,
        row: r,
        qno: cols.qno >= 0 ? row[cols.qno] ?? '' : '',
        text: cols.text >= 0 ? row[cols.text] ?? '' : '',
      });
    }
  }
  return entries;
}

export function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    if ((rows[r] || []).some((c) => String(c ?? '').trim() !== '')) return r;
  }
  return -1;
}

/** Image type from the file name; PNG unless the name says otherwise. */
export function mimeFor(name) {
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.webp$/i.test(name)) return 'image/webp';
  return 'image/png';
}
