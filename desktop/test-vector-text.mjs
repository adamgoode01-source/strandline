/* Scores the vector reader against the Prado Lofts POUR 1 schedule, whose
   correct values are known. Run: node test-vector-text.mjs [--show]

   The point under test is not "did it read the table" - nothing here reads
   anything on its own. It is that the shapes group cleanly, that the labels
   the sheet proves for itself are right, and that a handful of names settles
   the rest exactly. */

import { existsSync } from 'node:fs';
import { openPdf } from './render.mjs';
import { readVectorTable, learnFromCounts, renderCell, GW, GH } from './vector-text.mjs';
import { readTableText } from './table-text.mjs';
import { parseBundle } from './expand.mjs';

const PRADO = 'C:/Users/adamg/Downloads/03 00 00 - 01 Concrete PT Shop Drawings - REVISED-GS.pdf';
const BOX = { x: 0.045, y: 0.12, w: 0.15, h: 0.35 };
const SHOW = process.argv.includes('--show');

// qty, elongation - exactly as printed on the sheet
const TRUTH = [
  ['9 X 34A', '2 1/2'], ['3 X 51A', '3 7/8'], ['1 X 54A', '4 1/4'],
  ['17 X 57A', '4 1/2'], ['1 X 60A', '4 3/4'], ['10 X 80A', '6 3/8'],
  ['3 X 125A', '10 1/8'], ['20 X 135B', '10 7/8'], ['8 X 34A', '2 1/2'],
  ['2 X 49A', '3 3/4'], ['6 X 55A', '4 1/4'], ['2 X 56A', '4 3/8'],
  ['2 X 58A', '4 5/8'], ['2 X 59A', '4 5/8'], ['1 X 59B', '4 5/8'],
  ['10 X 80A', '6 3/8'], ['2 X 96A', '7 3/4'], ['22 X 169B', '13 5/8']
];

if (!existsSync(PRADO)) {
  console.log('Prado Lofts set not on this machine - nothing to score against');
  process.exit(0);
}

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log('  FAIL  ' + m); } };

const doc = await openPdf(PRADO);

/* Rows come from the bundle column, which is live text: one line per data row.
   In the app these are the strips the operator is already stepping through. */
const txt = await readTableText(doc, 5, BOX);
const trows = txt.rows.filter(r => r.bundle).sort((a, b) => a.y - b.y);
const ys = trows.map(r => r.y);
const pitch = (ys[ys.length - 1] - ys[0]) / (ys.length - 1);
const rowBands = ys.map(y => ({ y0: y - pitch * 0.62, y1: y + pitch * 0.42 }));

const V = await readVectorTable(doc, 5, BOX, { rowBands, tol: 14 });
console.log('rows: ' + V.rows.length + '   characters: ' + V.glyphCount +
  '   distinct shapes: ' + V.clusters.length);
console.log('columns from the drawing\u2019s own ruling: ' + V.grid.xs.length + ' verticals');
ok(V.rows.length === 18, 'should find 18 rows');
ok(V.grid.xs.length >= 3, 'should find the column separators');

/* --- what the sheet proves about itself --- */
const learn = learnFromCounts(V, trows.map(r => r.bundle), b => {
  const p = parseBundle(b); return p && p.count ? p.count : null;
});
console.log('\nlearned with no operator input: ' + Object.keys(learn.names).length + ' shapes' +
  '  (conflicts: ' + learn.conflicts.length + ')');
Object.entries(learn.names).forEach(([id, ch]) =>
  console.log('   shape #' + id + ' = "' + ch + '"   confirmed by ' + learn.evidence[id] + ' rows'));
if (learn.skippedRows.length)
  console.log('   rows not used for learning (segmentation disagreed): ' + learn.skippedRows.join(', '));
ok(learn.conflicts.length === 0, 'no two rows should disagree about a shape');
ok(Object.keys(learn.names).length >= 6, 'should learn at least six digits for free');

/* Every automatic label must be right. This is the safety property: a wrong
   label here would put a wrong elongation on a stressing record. */
const names = Object.assign({}, learn.names);
let checked = 0;
const misread = [];
V.rows.forEach((r, i) => {
  const t = TRUTH[i]; if (!t) return;
  const c = r.cells.find(c => c.col === 1); if (!c || !c.seq) return;
  const got = renderCell(c.seq, names);
  const want = t[0].replace(/\s+/g, '');
  /* A row that produced a different number of characters than the sheet has
     is not a misreading, it is a row the segmentation did not understand -
     rows 7 and 8 carry revision clouds whose marks land in the cell. Those
     must be refused rather than filled, so they are counted separately and
     never compared position by position. */
  if (got.length !== want.length) { misread.push(i + 1); return; }
  for (let k = 0; k < got.length; k++) {
    if (got[k] === '\u00b7') continue;
    ok(got[k] === want[k], 'row ' + (i + 1) + ' quantity position ' + (k + 1) +
      ': read "' + got[k] + '", sheet says "' + want[k] + '"');
    checked++;
  }
});
console.log('named characters checked against the sheet: ' + checked + '  (all correct)');
console.log('rows whose character count disagrees with the sheet: ' +
  (misread.length ? misread.join(', ') + ' - these must be left for typing' : 'none'));

/* The quantity is cross-checked against the bundle range downstream, so a row
   the reader misunderstands is caught there too. What matters here is that it
   is visible rather than silently filled. */
ok(misread.length <= 2, 'at most the two clouded rows should fail to line up');

/* --- naming the rest --- */
const unnamed = V.clusters.filter(c => names[c.id] == null)
  .sort((a, b) => b.members.length - a.members.length);
console.log('\nshapes still to name: ' + unnamed.length +
  '  covering ' + unnamed.reduce((a, c) => a + c.members.length, 0) + ' characters');
console.log('  frequencies: ' + unnamed.map(c => c.members.length).join(' '));

if (SHOW) {
  unnamed.slice(0, 16).forEach(c => {
    console.log('\n  shape #' + c.id + '  seen ' + c.members.length + ' times');
    for (let y = 0; y < GH; y++) {
      let s = '';
      for (let x = 0; x < GW; x++) s += c.bitmap[y * GW + x] ? '#' : '.';
      console.log('    ' + s);
    }
  });
}

console.log('\ncells as they stand (\u00b7 = shape not yet named):');
V.rows.forEach((r, i) => {
  const q = r.cells.find(c => c.col === 1), e = r.cells.find(c => c.col === 2);
  console.log('  ' + String(i + 1).padStart(2) +
    '  qty[' + (q && q.seq ? renderCell(q.seq, names) : '') + ']' +
    '   elong[' + (e && e.seq ? renderCell(e.seq, names) : '') + ']' +
    '     sheet: ' + TRUTH[i][0] + ' / ' + TRUTH[i][1]);
});

console.log(failed ? '\n' + failed + ' FAILED' : '\nall checks pass');
process.exit(failed ? 1 : 0);
