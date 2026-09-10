/* Local per-digit OCR of schedule cells. MEASURED AND NOT GOOD ENOUGH TO USE.
 *
 * Kept because the measurement is worth more than the code, and because
 * anyone who tries this again should start from what actually went wrong.
 *
 * Result on the real Prado Lofts POUR 1 elongation column, 18 cells whose
 * correct values are known:
 *
 *     5  exact
 *     8  confidently wrong   ("6-5/8" for "6-3/8", "5/4" for "4-3/4")
 *     5  blank
 *
 * The blanks are harmless. The eight wrong ones are the reason this is not
 * wired into the app: a plausible-looking elongation that is wrong by a
 * sixteenth silently changes whether a tendon passes, and nobody would catch
 * it by glancing at a filled-in grid.
 *
 * Three structural problems, in the order they were hit:
 *
 *  1. Glyphs touch. Connected-component analysis assumes they do not, so a "4"
 *     meeting the solidus becomes one blob and both vanish. This is why whole
 *     numbers kept coming back empty on rows 13 to 15.
 *  2. "1" and "4" are as sparse as a diagonal stroke, so any fill-based test
 *     for the solidus discards them too. Height works better - the solidus is
 *     the only thing spanning the cell - but not once glyphs have merged.
 *  3. Tesseract confuses 3 with 5 on this font at this size even as a single
 *     character with a digit whitelist. That alone caps accuracy well short of
 *     what a stressing record needs.
 *
 * What did work, and is used: the segmentation in cell-segment.mjs finds the
 * 18 data rows and 5 columns exactly. That is enough to show an operator one
 * magnified row at a time, which is the approach that replaced this.
 */

import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TESSDATA = path.join(HERE, 'tessdata');

let worker = null;
export async function getWorker() {
  if (worker) return worker;
  // langPath points at the bundled traineddata, so no download is attempted.
  worker = await createWorker('eng', 1, { langPath: TESSDATA, gzip: false, cacheMethod: 'none' });
  return worker;
}
export async function endWorker() {
  if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; }
}

/* ---------- connected components ---------- */

/* Four-connected labelling over the ink in a region. Small enough regions that
   a simple stack flood fill is fine. */
export function components(data, W, H, box, inkThreshold = 150, minPixels = 12) {
  const { left, top, width, height } = box;
  const seen = new Uint8Array(width * height);
  const out = [];
  const at = (x, y) => data[(top + y) * W + (left + x)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (seen[i] || at(x, y) >= inkThreshold) continue;
      let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        const py = (p / width) | 0, pxx = p % width;
        n++;
        if (pxx < x0) x0 = pxx; if (pxx > x1) x1 = pxx;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        const push = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
          const q = ny * width + nx;
          if (seen[q] || at(nx, ny) >= inkThreshold) return;
          seen[q] = 1; stack.push(q);
        };
        push(pxx - 1, py); push(pxx + 1, py); push(pxx, py - 1); push(pxx, py + 1);
      }
      if (n >= minPixels) {
        out.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: n,
                   cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
      }
    }
  }
  return out.sort((a, b) => a.x0 - b.x0);
}

/* A diagonal solidus: tall, narrow, and its ink runs corner to corner rather
   than filling the box. Distinguishes it from a digit of similar height. */
function looksLikeSlash(c, data, W, H, box) {
  if (c.h < c.w * 1.2) return false;
  // A digit fills a third or more of its box; a diagonal stroke fills far less.
  if (c.pixels / (c.w * c.h) > 0.3) return false;
  let onDiagonal = 0, total = 0;
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      if (data[(box.top + y) * W + (box.left + x)] >= 150) continue;
      total++;
      // expected x for this y along the leading diagonal, bottom-left to top-right
      const t = (c.y1 - y) / Math.max(1, c.h - 1);
      const ex = c.x0 + t * (c.w - 1);
      if (Math.abs(x - ex) <= Math.max(3, c.w * 0.35)) onDiagonal++;
    }
  }
  return total > 0 && onDiagonal / total > 0.75;
}

async function ocrOne(png, box, worker, whitelist, psm) {
  const buf = await sharp(png)
    .extract(box)
    .resize({ height: 96, fit: 'inside', kernel: 'lanczos3', withoutEnlargement: false })
    .extend({ top: 14, bottom: 14, left: 14, right: 14, background: '#ffffff' })
    .greyscale().normalise()
    .png().toBuffer();
  await worker.setParameters({
    tessedit_char_whitelist: whitelist,
    tessedit_pageseg_mode: String(psm)
  });
  const { data } = await worker.recognize(buf);
  return { text: (data.text || '').replace(/\s+/g, ''), confidence: data.confidence };
}

/* ---------- an elongation cell ---------- */

/* Returns { value, confidence, parts, note }. value is a fraction string the
   app already understands, e.g. "2-1/2". */
export async function readElongationCell(png, grey, box, opts = {}) {
  const { data, W, H } = grey;
  const w = await getWorker();
  const comps = components(data, W, H, box);
  if (!comps.length) return { value: '', confidence: 0, note: 'nothing in the cell' };

  const cellH = box.height;
  const fill = c => c.pixels / (c.w * c.h);

  /* The equals sign is the landmark. Trying to identify the delta triangle by
     its shape does not work: a triangle outline and a digit have similar
     dimensions and similar fill, so a loose test throws the digits away with
     it. The two thin stacked bars of an equals sign, though, are unmistakable,
     and everything to their left is furniture. */
  const bars = comps.filter(c => c.w > c.h * 3 && fill(c) > 0.75 && c.h < cellH * 0.16);
  let kept;
  if (bars.length >= 2) {
    const equalsRight = Math.max(...bars.map(b => b.x1));
    kept = comps.filter(c => c.x0 > equalsRight + 4);
  } else {
    // No equals sign: drop the leftmost component if it looks like a hollow
    // triangle sitting on the baseline, and keep the rest.
    kept = comps.slice();
    if (kept.length > 2 && fill(kept[0]) < 0.30 && kept[0].h > cellH * 0.4) kept = kept.slice(1);
  }

  // The inch marks: small, high, and at the right-hand end.
  const isTick = c => c.h < cellH * 0.32 && c.cy < cellH * 0.45 && c.w < cellH * 0.25;
  while (kept.length > 1 && isTick(kept[kept.length - 1])) kept = kept.slice(0, -1);

  if (!kept.length) return { value: '', confidence: 0, note: 'only symbols found' };

  /* Roles come from vertical position, not from finding the slash.
   *
   * Detecting the solidus was the weak link: when it touched a neighbouring
   * digit its shape changed enough to be missed, and every digit in the cell
   * then concatenated into one number - "13-5/8" arriving as "1358", which is
   * exactly the kind of plausible-looking wrong answer that must not happen.
   *
   * A diagonal fraction is unambiguous without it. The numerator is raised,
   * the denominator is dropped, and the whole number sits between them on the
   * baseline. The slash itself is discarded for being sparse: a stroke fills a
   * fraction of its bounding box where a digit fills a third or more. */
  const whole = [], numer = [], denom = [];
  for (const c of kept) {
    /* The solidus is the only thing that spans the cell top to bottom: it has
       to reach from the raised numerator down past the dropped denominator,
       where a digit occupies barely half the height. Filtering it by sparseness
       instead was discarding "1" and "4", which are sparse too - that is why
       whole numbers kept coming back empty. */
    if (c.h > cellH * 0.70) continue;
    const rel = c.cy / cellH;
    if (rel < 0.36) numer.push(c);
    else if (rel > 0.62) denom.push(c);
    else whole.push(c);
  }
  if (!whole.length && !numer.length && !denom.length) {
    return { value: '', confidence: 0, note: 'no digits found in the cell' };
  }

  const readGroup = async (list) => {
    let s = '', conf = 100;
    for (const c of list) {
      const r = await ocrOne(png, { left: box.left + c.x0 - 2, top: box.top + c.y0 - 2,
        width: c.w + 4, height: c.h + 4 }, w, '0123456789', 10);
      s += r.text;
      if (r.text) conf = Math.min(conf, Math.max(r.confidence, 1));
      else conf = 0;
    }
    return { s, conf };
  };

  const W1 = await readGroup(whole);
  const N = await readGroup(numer);
  const D = await readGroup(denom);

  const notes = [];
  if (!N.s || !D.s) notes.push('the fraction did not read cleanly');
  if (D.s && !['2','4','8','16','32','3','64'].includes(D.s)) notes.push('denominator ' + D.s + ' is unusual');

  const value = (W1.s ? W1.s + (N.s && D.s ? '-' : '') : '') + (N.s && D.s ? N.s + '/' + D.s : '');
  return {
    value,
    confidence: Math.min(W1.s ? W1.conf : 100, N.conf, D.conf),
    parts: { whole: W1.s, numerator: N.s, denominator: D.s },
    note: notes.join('; ')
  };
}

/* ---------- a plain text cell ---------- */

/* The quantity cell reads "9 X 34A": digits, an x, digits, and an anchorage
   letter. Read as a line, since everything sits on one baseline. */
export async function readPlainCell(png, box, whitelist = '0123456789XxABC. ') {
  const w = await getWorker();
  const r = await ocrOne(png, box, w, whitelist, 7);
  return { value: r.text.toUpperCase().replace(/\s+/g, ''), confidence: r.confidence };
}

/* ---------- a bundle cell ---------- */

/* Bundle numbers sit inside hexagon outlines. The hexagon is a large hollow
   component; the digits are inside it. Reading the digits individually avoids
   the outline being taken for a character. */
export async function readBundleCell(png, grey, box) {
  const { data, W, H } = grey;
  const w = await getWorker();
  const comps = components(data, W, H, box);
  const cellH = box.height;
  // the hexagon: tall, wide, and mostly hollow
  const inner = comps.filter(c => !(c.h > cellH * 0.5 && c.w > cellH * 0.6 && c.pixels < c.w * c.h * 0.5));
  let s = '', conf = 100;
  for (const c of inner) {
    if (c.h < cellH * 0.15) continue;                 // dashes, chain links
    const r = await ocrOne(png, { left: box.left + c.x0 - 2, top: box.top + c.y0 - 2,
      width: c.w + 4, height: c.h + 4 }, w, '0123456789', 10);
    if (r.text) { s += r.text; conf = Math.min(conf, r.confidence); }
  }
  return { value: s, confidence: s ? conf : 0 };
}
