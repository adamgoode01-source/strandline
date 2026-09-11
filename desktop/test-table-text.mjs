/* Scores the text-layer reader against a sheet whose correct answer is known,
   and reports what it finds on other sets so the limits are visible rather
   than assumed. Run: node test-table-text.mjs */

import { existsSync } from 'node:fs';
import { openPdf } from './render.mjs';
import { readTableText, splitRow } from './table-text.mjs';

const PRADO = 'C:/Users/adamg/Downloads/03 00 00 - 01 Concrete PT Shop Drawings - REVISED-GS.pdf';
const BOX = { x: 0.045, y: 0.12, w: 0.15, h: 0.35 };

const TRUTH = [
  ['300 THRU 308', '9 X 34A', '2 1/2'], ['309 THRU 311', '3 X 51A', '3 7/8'],
  ['312', '1 X 54A', '4 1/4'], ['313 THRU 329', '17 X 57A', '4 1/2'],
  ['330', '1 X 60A', '4 3/4'], ['331 THRU 340', '10 X 80A', '6 3/8'],
  ['341 THRU 343', '3 X 125A', '10 1/8'], ['344 THRU 363', '20 X 135B', '10 7/8'],
  ['364 THRU 371', '8 X 34A', '2 1/2'], ['372 AND 373', '2 X 49A', '3 3/4'],
  ['374 THRU 379', '6 X 55A', '4 1/4'], ['380 AND 381', '2 X 56A', '4 3/8'],
  ['382 AND 383', '2 X 58A', '4 5/8'], ['384 AND 385', '2 X 59A', '4 5/8'],
  ['386', '1 X 59B', '4 5/8'], ['387 THRU 396', '10 X 80A', '6 3/8'],
  ['397 AND 398', '2 X 96A', '7 3/4'], ['399 THRU 420', '22 X 169B', '13 5/8']
];

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.log('  FAIL  ' + msg); } };

/* --- the splitter, on strings whose answer is obvious --- */
console.log('splitRow');
const cases = [
  ['300 THRU 308 9 X 34A 2 1/2',      { bundle: '300 THRU 308', qtyFt: '9 X 34A', elongation: '2 1/2' }],
  ['399 THRU 420 22 X 169B 13 5/8',   { bundle: '399 THRU 420', qtyFt: '22 X 169B', elongation: '13 5/8' }],
  ['372 AND 373 2 X 49A 3 3/4',       { bundle: '372 AND 373', qtyFt: '2 X 49A', elongation: '3 3/4' }],
  ['312 1 X 54A 4 1/4',               { bundle: '312', qtyFt: '1 X 54A', elongation: '4 1/4' }],
  ['386 1 X 59B D = 4 5/8"',          { bundle: '386', qtyFt: '1 X 59B', elongation: '4 5/8' }],
  ['300 THRU 308',                    { bundle: '300 THRU 308', qtyFt: null, elongation: null }],
  ['BUNDLE QTY ELONG',                { bundle: null, qtyFt: null, elongation: null }],
  // a loose digit from the drawing must not become an elongation
  ['341 THRU 343 2',                 { bundle: '341 THRU 343', qtyFt: null, elongation: null }],
  ['330 1 X 60A 5"',                 { bundle: '330', qtyFt: '1 X 60A', elongation: '5' }],
  ['330 1 X 60A D = 5',              { bundle: '330', qtyFt: '1 X 60A', elongation: '5' }]
];
for (const [input, want] of cases) {
  const got = splitRow(input);
  for (const k of ['bundle', 'qtyFt', 'elongation']) {
    ok(got[k] === want[k], `${JSON.stringify(input)} -> ${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`);
  }
}
console.log(failed ? `  ${failed} failed` : '  all ' + cases.length * 3 + ' checks pass');

/* --- the real sheet --- */
/* The splitter above is the part that must hold everywhere; this second half
   needs the actual drawing set, so it is skipped rather than failed on a
   machine that does not have it. */
if (!existsSync(PRADO)) {
  console.log('\nPrado Lofts set not on this machine - skipping the sheet checks');
  console.log(failed ? `\n${failed} FAILED` : '\nall checks pass');
  process.exit(failed ? 1 : 0);
}

console.log('\nPrado Lofts PT-02A, POUR 1 schedule');
const doc = await openPdf(PRADO);
const res = await readTableText(doc, 5, BOX);
console.log(`  text items inside the schedule box: ${res.itemsInBox}`);
console.log(`  lines recovered: ${res.rows.length}`);
console.log(`  columns present: bundle ${res.recovered.bundle}, quantity ${res.recovered.qtyFt}, elongation ${res.recovered.elongation}`);

const data = res.rows.filter(r => r.bundle);
let exact = 0, wrong = 0;
data.forEach((r, i) => {
  const t = TRUTH[i];
  if (!t) return;
  if (r.bundle === t[0]) exact++;
  else { wrong++; console.log(`  DIFF row ${i + 1}: got ${JSON.stringify(r.bundle)}, want ${JSON.stringify(t[0])}`); }
});
console.log(`  bundle column: ${exact} of ${TRUTH.length} exact, ${wrong} wrong`);
ok(exact === TRUTH.length, 'the bundle column should come back exact');
ok(wrong === 0, 'nothing should come back wrong');

/* The point of the exercise: absent is absent. A column that is line art must
   produce nulls, never a value borrowed from a neighbouring column. */
ok(res.recovered.qtyFt === 0, 'the quantity column is line art here and must come back empty');
ok(res.recovered.elongation === 0, 'the elongation column is line art here and must come back empty');
console.log('  quantity and elongation correctly reported as absent, not guessed');

console.log(failed ? `\n${failed} FAILED` : '\nall checks pass');
process.exit(failed ? 1 : 0);
