/* Runs the app's extractor over a real PDF and reports what it actually saw.
 *
 *   node tools/diagnose-plan.js "path/to/plans.pdf"
 *
 * The app does this in the browser with DecompressionStream; here it is zlib,
 * but the parsing and table detection are the same code from table-extract.js.
 */

const fs = require('fs');
const zlib = require('zlib');
const { scanContent, toRows, findTable, classifyHeader } = require('./table-extract.js');

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/diagnose-plan.js <plans.pdf>'); process.exit(1); }

const bytes = fs.readFileSync(file);
const raw = bytes.toString('latin1');

console.log('file:   ' + file.split(/[\\/]/).pop());
console.log('size:   ' + (bytes.length / 1024 / 1024).toFixed(1) + ' MB');
console.log('pages:  ' + (raw.match(/\/Type\s*\/Page[^s]/g) || []).length);
console.log('encrypted: ' + /\/Encrypt\b/.test(raw));
console.log('');

// pull content streams the same way the app does
const chunks = [];
const re = /stream\r?\n?/g;
let m, guard = 0, flate = 0, plain = 0, imageOnly = 0, failed = 0;
while ((m = re.exec(raw)) && guard++ < 8000) {
  const start = m.index + m[0].length;
  const end = raw.indexOf('endstream', start);
  if (end < 0) continue;
  const head = raw.slice(Math.max(0, m.index - 600), m.index);
  const seg = bytes.subarray(start, end);
  if (seg.length < 6 || seg.length > 24 * 1024 * 1024) { re.lastIndex = end; continue; }
  let content = null;
  if (/\/FlateDecode/.test(head)) {
    try { content = zlib.inflateSync(seg).toString('latin1'); flate++; }
    catch (e) {
      try { content = zlib.inflateRawSync(seg).toString('latin1'); flate++; }
      catch (e2) { failed++; }
    }
  } else if (/\/DCTDecode|\/JPXDecode|\/CCITTFax|\/JBIG2|\/RunLength|\/LZW/.test(head)) {
    imageOnly++;
  } else { content = seg.toString('latin1'); plain++; }
  if (content && /(Tj|TJ)/.test(content)) chunks.push(content);
  re.lastIndex = end;
}

console.log('streams: ' + flate + ' flate, ' + plain + ' plain, ' + imageOnly +
            ' image-coded, ' + failed + ' failed to inflate');
console.log('streams containing text operators: ' + chunks.length);
if (!chunks.length) {
  console.log('');
  console.log('>> No text-drawing operators anywhere. This is a scanned or fully');
  console.log('>> rasterised drawing. No parser can read it without OCR.');
  process.exit(0);
}

let allItems = [];
const perStream = [];
chunks.forEach((c, i) => {
  let items = [];
  try { items = scanContent(c); } catch (e) { /* keep going */ }
  perStream.push(items.length);
  allItems = allItems.concat(items);
});
console.log('positioned text items: ' + allItems.length);
console.log('items per stream (top 8): ' + perStream.slice().sort((a,b)=>b-a).slice(0,8).join(', '));
console.log('');

// What header-looking words exist anywhere in the document?
const HINT = /(tendon|mark|strand|elong|length|grid|drape|stress|schedule|qty|bldg|building)/i;
const hits = new Map();
for (const it of allItems) {
  const t = it.text.trim();
  if (t.length < 2 || t.length > 40) continue;
  if (!HINT.test(t)) continue;
  hits.set(t.toUpperCase(), (hits.get(t.toUpperCase()) || 0) + 1);
}
const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1]);
console.log('schedule-ish words found (top 30):');
sorted.slice(0, 30).forEach(([t, n]) => {
  const cls = classifyHeader(t);
  console.log('  ' + String(n).padStart(4) + 'x  ' + (cls ? '[' + cls + ']' : '[     ]') + '  ' + t);
});
if (!sorted.length) console.log('  (none - the text layer has no schedule vocabulary at all)');
console.log('');

// Row clustering + detection
chunks.forEach((c, i) => {
  let items = [];
  try { items = scanContent(c); } catch (e) { return; }
  if (items.length < 20) return;
  const res = findTable(items);
  if (res.table) {
    console.log('STREAM ' + i + ': table found, ' + res.table.rows.length + ' rows, cols ' +
                res.table.columns.join(','));
    res.table.rows.slice(0, 5).forEach(r => console.log('    ' + JSON.stringify(r)));
  }
});

// If nothing was found, show the widest rows so the real layout is visible.
const anyTable = chunks.some(c => { try { return !!findTable(scanContent(c)).table; } catch (e) { return false; } });
if (!anyTable) {
  console.log('>> No table detected. Widest text rows in the document, which is');
  console.log('>> what a schedule row should look like if one is present:');
  console.log('');
  let rows = [];
  chunks.forEach(c => { try { rows = rows.concat(toRows(scanContent(c))); } catch (e) {} });
  rows.sort((a, b) => b.length - a.length);
  rows.slice(0, 18).forEach(r => {
    console.log('  [' + String(r.length).padStart(2) + ' cells] ' +
                r.slice(0, 12).map(c => c.text).join(' | ').slice(0, 150));
  });
}
