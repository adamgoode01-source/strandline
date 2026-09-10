/* Downloads the app's webfonts from Google Fonts and emits a self-contained
 * @font-face block with the files inlined as data URIs.
 *
 * Why inline rather than ship files alongside: the whole app is one HTML file,
 * which is what lets it be an Artifact, a double-clickable local file and the
 * Capacitor web asset all at once. Separate font files would work in the
 * native build and break the other two.
 *
 * Only latin and latin-ext subsets are kept. Cyrillic, Greek and Vietnamese
 * would roughly double the payload for characters this app will never render.
 *
 *   node tools/bundle-fonts.js          # writes tools/fonts.css
 */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Variable ranges where the family has one; explicit weights where it does not.
const FAMILIES = [
  'Archivo:wght@400..800',
  'Archivo+Narrow:wght@400..700',
  'Public+Sans:wght@400..700',
  'IBM+Plex+Mono:wght@400;500;600'
];
const KEEP_SUBSETS = ['latin', 'latin-ext'];

async function getCss(spec) {
  const url = 'https://fonts.googleapis.com/css2?family=' + spec + '&display=swap';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('css ' + res.status + ' for ' + spec);
  return res.text();
}

// Google's CSS puts a /* subset */ comment before each @font-face.
function parseFaces(css) {
  const out = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  let m;
  while ((m = re.exec(css))) out.push({ subset: m[1], block: m[2] });
  if (!out.length) {
    const re2 = /@font-face\s*\{[^}]*\}/g;
    let m2;
    while ((m2 = re2.exec(css))) out.push({ subset: 'latin', block: m2[0] });
  }
  return out;
}

async function main() {
  const chunks = [];
  let raw = 0;
  for (const spec of FAMILIES) {
    const css = await getCss(spec);
    const faces = parseFaces(css).filter(f => KEEP_SUBSETS.includes(f.subset));
    if (!faces.length) throw new Error('no latin faces for ' + spec);
    for (const f of faces) {
      const urlM = /url\(([^)]+)\)\s*format\(['"]woff2['"]\)/.exec(f.block);
      if (!urlM) { console.warn('  skipped a face with no woff2 in ' + spec); continue; }
      const fontUrl = urlM[1].replace(/['"]/g, '');
      const res = await fetch(fontUrl, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('font ' + res.status + ' ' + fontUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      raw += buf.length;
      const fam = (/font-family:\s*'([^']+)'/.exec(f.block) || [])[1] || '?';
      // unicode-range is what lets the browser skip the file entirely for text
      // it cannot cover, so it is worth keeping.
      const ur = (/unicode-range:\s*([^;]+);/.exec(f.block) || [])[1];
      const block = f.block
        .replace(/src:[^;]+;/, "src: url(data:font/woff2;base64," + buf.toString('base64') + ") format('woff2');")
        .replace(/\s+/g, ' ')
        .trim();
      chunks.push(block);
      console.log('  ' + fam.padEnd(16) + f.subset.padEnd(10) +
                  (buf.length / 1024).toFixed(1).padStart(7) + ' KB' +
                  (ur ? '' : '   (no unicode-range)'));
    }
  }
  const css = '/* Fonts inlined by tools/bundle-fonts.js - do not hand edit. */\n' +
              chunks.join('\n') + '\n';
  fs.writeFileSync(path.join(__dirname, 'fonts.css'), css);
  console.log('');
  console.log('faces:      ' + chunks.length);
  console.log('woff2 raw:  ' + (raw / 1024).toFixed(0) + ' KB');
  console.log('as base64:  ' + (css.length / 1024).toFixed(0) + ' KB');
  console.log('wrote tools/fonts.css');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
