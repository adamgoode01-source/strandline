/* Reads a schedule out of the PDF's own text layer, with no API and no OCR.
 *
 * Worth having because it is the only reading of a drawing that is not a
 * guess: these are the characters the detailer typed, recovered exactly, or
 * they are absent and nothing is claimed. There is no middle state where a
 * plausible wrong number appears - which is precisely what sank local OCR
 * (see cell-read.mjs: 5 of 18 elongations exact, 8 confidently wrong).
 *
 * How much it recovers depends entirely on how the sheet was produced. On the
 * Prado Lofts set the bundle column is live text and comes back 18 of 18
 * exact, while the quantity and elongation columns were exploded to line art
 * and are simply not there. Other detailers' sets carry all three. The caller
 * fills what comes back and leaves the rest to the operator, so a sheet that
 * yields one column is a third less typing rather than a failure.
 *
 * Nothing here infers a value it did not read. A cell that is absent from the
 * text layer comes back null.
 */

let pdfjs;
async function getPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/* Text items carry a matrix in PDF space; the viewport transform is what puts
   them where they are drawn. Skipping it silently mislocates any rotated text
   - on this sheet the "THRU" tokens landed at y = -0.395, outside the page. */
export async function pageTextItems(doc, pageNo) {
  const lib = await getPdfjs();
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const out = [];
  for (const it of tc.items) {
    const s = (it.str || '').trim();
    if (!s) continue;
    const m = lib.Util.transform(vp.transform, it.transform);
    out.push({
      text: s,
      x: m[4] / vp.width,
      y: m[5] / vp.height,
      h: Math.abs(it.height || 0) / vp.height
    });
  }
  return out;
}

/* Group items into lines. The gap test is in page fractions and deliberately
   generous: a row's tokens sit on one baseline, and the next row of a
   schedule is a whole line height away. */
export function groupRows(items, tol = 0.006) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || it.y - cur.y > tol) { cur = { y: it.y, y0: it.y, y1: it.y, items: [it] }; rows.push(cur); }
    else { cur.items.push(it); cur.y1 = Math.max(cur.y1, it.y); cur.y0 = Math.min(cur.y0, it.y); }
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim();
    r.x0 = Math.min(...r.items.map(i => i.x));
  }
  return rows;
}

/* Pull the three fields out of one row's text.
 *
 * Matched by shape rather than by column position, because the columns are
 * only reliably separated when every one of them is live text. A field that
 * does not match is left null rather than filled from whatever remains. */
const RE_QTY    = /\b(\d{1,3})\s*[Xx]\s*(\d{1,4})\s*([A-Z]{1,2})?\b/;
const RE_BUNDLE = /^\s*(\d{2,4}(?:\s*(?:THRU|THRO|TO|AND|&|-)\s*\d{2,4})?)\b/i;

/* An elongation is only accepted in a form that could not be anything else:
   a fraction, or a whole number that the sheet itself marked as a length with
   an inch symbol or a delta.
 *
 * A bare trailing integer is rejected on purpose. Drawings carry loose digits
 * - tags, callouts, leader labels - and one of them sits on row 7 of this very
 * schedule. Accepting it read 2" where the sheet says 10 1/8", which is the
 * one thing this reader must never do: a wrong elongation passes the quantity
 * cross-check silently and decides whether a tendon is accepted. Rejecting it
 * costs the operator one field of typing on the rare sheet that prints whole
 * inches unmarked. Blank is recoverable; wrong is not. */
const RE_FRACTION = /(?:^|\s)(\d{1,2}\s+\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})\s*$/;
const RE_MARKED   = /(?:^|\s)(\d{1,2}(?:\.\d+)?)\s*$/;

export function splitRow(text) {
  const out = { bundle: null, qtyFt: null, elongation: null };
  let rest = text;

  const b = RE_BUNDLE.exec(rest);
  if (b) {
    out.bundle = b[1].replace(/\s+/g, ' ').replace(/\s*&\s*/, ' AND ')
                     .replace(/\bTHRO\b/i, 'THRU').toUpperCase();
    rest = rest.slice(b[0].length);
  }

  const q = RE_QTY.exec(rest);
  if (q) {
    out.qtyFt = q[1] + ' X ' + q[2] + (q[3] || '');
    rest = rest.slice(0, q.index) + ' ' + rest.slice(q.index + q[0].length);
  }

  /* Was this value labelled as a length by the sheet, rather than by us? */
  const marked = /[Δ∆]\s*=|\bD\s*=|["”]|\bIN\b/i.test(rest);
  rest = rest.replace(/[Δ∆D]\s*=\s*/g, ' ').replace(/["”]/g, ' ').trim();

  const frac = RE_FRACTION.exec(rest);
  if (frac) out.elongation = frac[1].replace(/\s+/g, ' ');
  else if (marked) {
    const whole = RE_MARKED.exec(rest);
    if (whole) out.elongation = whole[1];
  }

  return out;
}

/* opts: { box } in page fractions, x/y from the top-left.
 * Returns one entry per text line inside the box, each carrying its own
 * vertical position so the caller can match it to a segmented strip by
 * overlap rather than by counting. */
export async function readTableText(doc, pageNo, box) {
  const items = await pageTextItems(doc, pageNo);
  const inBox = items.filter(i =>
    i.x >= box.x && i.x <= box.x + box.w &&
    i.y >= box.y && i.y <= box.y + box.h);

  const rows = groupRows(inBox).map(r => {
    const f = splitRow(r.text);
    return { y: r.y, text: r.text, bundle: f.bundle, qtyFt: f.qtyFt, elongation: f.elongation };
  });

  const got = { bundle: 0, qtyFt: 0, elongation: 0 };
  for (const r of rows) for (const k of Object.keys(got)) if (r[k]) got[k]++;

  return {
    rows,
    itemsInBox: inBox.length,
    /* Named so the caller can say which columns the sheet actually carries,
       rather than reporting a bare count that hides a missing column. */
    recovered: got
  };
}
