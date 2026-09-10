import { openPdf, renderPage } from './render.mjs';
import { detectTables } from './table-detect.mjs';
import sharp from 'sharp';
const f = "C:/Users/adamg/Downloads/03 00 00 - 01 Concrete PT Shop Drawings - REVISED-GS.pdf";
const doc = await openPdf(f);
// page 5 is PT-02A, the sheet with the PRADO LOFTS SLAB TENDONS schedule
const { png } = await renderPage(doc, 5, 2.0);
const t0 = Date.now();
const res = await detectTables(png);
console.log('analysed ' + res.analysedAt.width + 'x' + res.analysedAt.height +
            ' in ' + (Date.now() - t0) + 'ms');
console.log('rules found: ' + res.horizontalRules + ' horizontal, ' + res.verticalRules + ' vertical');
console.log('candidate tables: ' + res.tables.length);
res.tables.forEach((t, i) => {
  console.log('  ' + i + ': ' + t.rows + ' rows x ' + t.cols + ' cols   ' +
    'x=' + t.box.x.toFixed(3) + ' y=' + t.box.y.toFixed(3) +
    ' w=' + t.box.w.toFixed(3) + ' h=' + t.box.h.toFixed(3) +
    '   area=' + (t.area * 100).toFixed(1) + '%');
});
// crop the top candidates so I can look at what it picked
for (let i = 0; i < Math.min(3, res.tables.length); i++) {
  const b = res.tables[i].box;
  const m = await sharp(png).metadata();
  await sharp(png).extract({
    left: Math.round(m.width * b.x), top: Math.round(m.height * b.y),
    width: Math.max(8, Math.round(m.width * b.w)), height: Math.max(8, Math.round(m.height * b.h))
  }).resize(700, null, { fit: 'inside' }).jpeg({ quality: 88 }).toFile('/tmp/cand-' + i + '.jpg');
}
console.log('cropped the top candidates to /tmp/cand-N.jpg');
