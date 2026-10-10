// Unit tests for name cleaning and checking. Usage: node tests/unit-names.mjs
import assert from 'assert/strict';
import * as N from '../js/names.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('cleanName trims, strips folders, adds .png', () => {
  assert.equal(N.cleanName('  q12_fig1.png '), 'q12_fig1.png');
  assert.equal(N.cleanName('images/q12.png'), 'q12.png');
  assert.equal(N.cleanName('C:\\imgs\\sub\\q9.jpg'), 'q9.jpg');
  assert.equal(N.cleanName('q6_fig1'), 'q6_fig1.png');
  assert.equal(N.cleanName('   '), '');
  assert.equal(N.cleanName(null), '');
  assert.equal(N.cleanName('images/'), '');
});

t('fixName lowercases and replaces spaces and specials', () => {
  assert.equal(N.fixName('Q4 Fig 1.PNG'), 'q4_fig_1.png');
  assert.equal(N.fixName('q(5) fig#2.png'), 'q_5_fig_2.png');
  assert.equal(N.fixName('A  B .png'), 'a_b.png');
});

t('nameProblems flags spaces, capitals, specials, long names', () => {
  assert.deepEqual(N.nameProblems('q1_fig1.png'), []);
  const p = N.nameProblems('Q4 Fig#1.png');
  assert.ok(p.some((x) => x.includes('spaces')));
  assert.ok(p.some((x) => x.includes('capital')));
  assert.ok(p.some((x) => x.includes('special')));
  assert.ok(N.nameProblems(`${'a'.repeat(90)}.png`).some((x) => x.includes('long')));
});

t('buildNameList removes blanks and duplicates, keeps rows', () => {
  const r = N.buildNameList([
    { raw: 'q1.png', row: 1 }, { raw: '' , row: 2 }, { raw: 'images/q1.png', row: 3 }, { raw: 'Q1.png', row: 4 },
  ]);
  assert.equal(r.names.length, 2);
  assert.equal(r.removedDuplicate, 1);
  assert.deepEqual(r.names[0].rows.map((x) => x.row), [1, 3]);
  assert.equal(r.names[0].rows[1].prefix, 'images/');
  assert.ok(r.problems.find((p) => p.name === 'Q1.png').problems.some((x) => x.includes('except for capital')));
  const fixed = N.buildNameList([{ raw: 'q1.png' }, { raw: 'Q1.png' }], { fix: true });
  assert.equal(fixed.names.length, 1);
});

t('entriesFromText splits lines and commas, drops blanks', () => {
  assert.deepEqual(N.entriesFromText('a.png\n\n b.png ,c.png\r\n').map((e) => e.raw), ['a.png', 'b.png', 'c.png']);
  assert.deepEqual(N.entriesFromText(''), []);
});

t('detectColumns finds image, qno and text columns', () => {
  assert.deepEqual(N.detectColumns(['qno', 'text', 'imagePath']), { image: 2, qno: 0, text: 1 });
  assert.deepEqual(N.detectColumns(['Question No', 'Question', 'Image Name']), { image: 2, qno: 0, text: 1 });
  assert.equal(N.detectColumns(['a', 'b']).image, -1);
});

t('entriesFromRows reads multi-name cells', () => {
  const rows = [['qno', 'img'], [1, 'a.png, b.png'], [2, ''], [3, 'c.png']];
  const e = N.entriesFromRows(rows, { image: 1, qno: 0, text: -1 }, 0);
  assert.deepEqual(e.map((x) => [x.raw, x.row, x.qno]), [['a.png', 1, 1], ['b.png', 1, 1], ['c.png', 3, 3]]);
});

t('mimeFor follows the extension', () => {
  assert.equal(N.mimeFor('a.png'), 'image/png');
  assert.equal(N.mimeFor('a.JPG'), 'image/jpeg');
});

console.log(`${n} unit tests passed`);
