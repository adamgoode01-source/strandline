/* Renders PDF pages to images sized for the Claude vision API.
 *
 * Claude downscales anything wider than about 1568px, so sending a whole
 * E-size drawing sheet at higher resolution buys nothing - the schedule text
 * ends up a few pixels tall either way. The reader therefore works in two
 * passes: a whole-sheet image to locate the schedule, then a crop of just
 * that region blown up to 1568px to read it. That keeps the text legible
 * without tiling the sheet into nine separate calls.
 */

import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

export const API_MAX_EDGE = 1568;

let pdfjs;
async function getPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

export async function openPdf(path) {
  const lib = await getPdfjs();
  const data = new Uint8Array(readFileSync(path));
  const doc = await lib.getDocument({ data, disableWorker: true }).promise;
  return doc;
}

// Render one page to a PNG buffer at the given scale (1.0 = 72dpi).
export async function renderPage(doc, pageNo, scale = 4.0) {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const cv = createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { png: cv.toBuffer('image/png'), width: cv.width, height: cv.height };
}

// Whole sheet, sized so the API does not downscale it further.
export async function sheetImage(png) {
  const buf = await sharp(png)
    .resize(API_MAX_EDGE, API_MAX_EDGE, { fit: 'inside', kernel: 'lanczos3' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return buf;
}

/* Crop a region given as fractions of the page, then scale it up so the text
   fills the API's pixel budget. A generous margin is added because a model
   asked for a bounding box will clip the edges of a table more often than it
   overshoots them. */
export async function cropRegion(png, box, margin = 0.04) {
  const meta = await sharp(png).metadata();
  const x0 = Math.max(0, box.x - margin);
  const y0 = Math.max(0, box.y - margin);
  const x1 = Math.min(1, box.x + box.w + margin);
  const y1 = Math.min(1, box.y + box.h + margin);
  const left = Math.round(meta.width * x0);
  const top = Math.round(meta.height * y0);
  const width = Math.max(8, Math.round(meta.width * (x1 - x0)));
  const height = Math.max(8, Math.round(meta.height * (y1 - y0)));
  return sharp(png)
    .extract({ left, top, width, height })
    .resize(API_MAX_EDGE, API_MAX_EDGE, { fit: 'inside', kernel: 'lanczos3', withoutEnlargement: false })
    .jpeg({ quality: 92 })
    .toBuffer();
}

export function toDataPart(jpegBuffer) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: jpegBuffer.toString('base64') }
  };
}
