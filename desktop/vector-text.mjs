/* Reads schedule cells that were exported as CAD line-work rather than text.
 *
 * Why this exists. PT shop drawings routinely explode their lettering: on the
 * Prado Lofts set, sheet PT-02A carries one font and 187 text runs - the cable
 * numbers and titles - against 13,585 vector paths, which is everything else,
 * including the entire QTY X FT and elongation columns. The text layer cannot
 * recover those because there are no characters there.
 *
 * Why it can work anyway. Line-work is not a scan. The strokes are exact
 * geometry, so two instances of the same character are bit-identical rather
 * than merely similar - the "X" in the quantity column occurs 18 times on that
 * sheet, once per row, and all 18 normalise to the same bitmap. That is the
 * property pixel OCR never had: there is no 3-against-5 ambiguity to lose, and
 * cell-read.mjs records what happened when we tried it (5 of 18 elongations
 * exact, 8 confidently wrong).
 *
 * So nothing here guesses what a shape means. It groups identical shapes and
 * hands them to the operator to name once. Naming ~15 shapes settles every
 * occurrence on the sheet exactly, and the same alphabet reads later sheets
 * from the same detailer without being asked again.
 *
 * The table's own ruling is line-work too, which is convenient: the grid comes
 * from the drawing rather than from image processing, so cell boundaries are
 * exact instead of inferred.
 */

let pdfjs;
async function getPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

const mul = (a, b) => [
  a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1],
  a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
  a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5]
];
const ap = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];

/* Every stroke on the page, in fractions of the page from the top-left.
 *
 * The transform stack has to be tracked by hand. pdfjs hands back a flat
 * operator list, and a path's coordinates mean nothing without the matrix in
 * force when it was constructed - ignoring it puts every stroke in the same
 * place, which is exactly what the first attempt did. */
export async function extractStrokes(doc, pageNo) {
  const lib = await getPdfjs();
  const OPS = lib.OPS;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();

  let ctm = vp.transform.slice();
  const stack = [];
  const out = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (a[0]) ctm = mul(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.constructPath) {
      const flat = a[1] && a[1][0];
      if (!flat) continue;
      /* The coordinate array interleaves op codes with points: 0 moveTo,
         1 lineTo, 2 curveTo (6 operands), 3 rect (4). Curves and rects are
         skipped rather than flattened - stick lettering is polylines, and a
         curve here is part of the drawing, not a character. */
      const pts = [];
      for (let k = 0; k < flat.length; ) {
        const op = flat[k++];
        if (op === 0 || op === 1) {
          const [X, Y] = ap(ctm, flat[k++], flat[k++]);
          pts.push([X / vp.width, Y / vp.height]);
        } else if (op === 2) k += 6;
        else if (op === 3) k += 4;
        else break;
      }
      if (pts.length < 2) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      out.push({ pts, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 });
    }
  }
  return out;
}

const inBox = (s, box) =>
  s.x0 >= box.x - 1e-6 && s.x1 <= box.x + box.w + 1e-6 &&
  s.y0 >= box.y - 1e-6 && s.y1 <= box.y + box.h + 1e-6;

/* Positions where a long straight rule runs, collapsed so that a rule drawn
   as several segments counts once.
 *
 * The two axes have to be kept straight. A horizontal rule is long in x and
 * sits at a y, so its length is judged against the box width but two of them
 * are told apart by the box height. Using one span for both collapsed every
 * row rule in the table into two lines. */
function ruleLines(strokes, box, horizontal) {
  const lenSpan = horizontal ? box.w : box.h;    // along the rule
  const posSpan = horizontal ? box.h : box.w;    // across it
  const hits = [];
  for (const s of strokes) {
    const len = horizontal ? s.w : s.h;
    const thick = horizontal ? s.h : s.w;
    if (thick > posSpan * 0.004) continue;       // not straight enough to be a rule
    if (len < lenSpan * 0.25) continue;          // too short to be a rule
    hits.push(horizontal ? (s.y0 + s.y1) / 2 : (s.x0 + s.x1) / 2);
  }
  hits.sort((a, b) => a - b);
  const merged = [];
  for (const v of hits) {
    if (!merged.length || v - merged[merged.length - 1] > posSpan * 0.008) merged.push(v);
  }
  return merged;
}

/* The table's grid, taken from its own ruling. */
export function tableGrid(strokes, box) {
  const within = strokes.filter(s => inBox(s, box));
  return {
    xs: ruleLines(within, box, false),
    ys: ruleLines(within, box, true)
  };
}

/* Character-sized strokes only: short enough not to be a rule, tall enough
   not to be a stray tick. */
function glyphStrokes(strokes, box) {
  const within = strokes.filter(s => inBox(s, box));
  const heights = within.map(s => s.h).filter(h => h > 0).sort((a, b) => a - b);
  if (!heights.length) return { strokes: [], ch: 0 };
  /* The median, not a high percentile. Most strokes in a schedule cell are
     full-height character strokes, so the median lands on the character
     height; a p90 is pulled up by the tallest outliers, and overstating the
     height by half widens every downstream tolerance until neighbouring
     characters merge into one shape. */
  const shortish = heights.filter(h => h < box.h * 0.06);
  const ch = shortish.length ? shortish[Math.floor(shortish.length * 0.5)] : heights[0];
  /* Up to two and a half character heights, because a fraction's solidus is
     drawn full height across a raised numerator and a dropped denominator.
     Capping at 1.6 threw it away, and without it "7/8" has nothing to divide
     it and reads as one run of digits. */
  const keep = within.filter(s => s.h <= ch * 2.5 && s.w <= ch * 1.6);
  return { strokes: keep, ch };
}

/* Assemble strokes into characters.
 *
 * Rows come from the ruling, so a fraction's stacked halves stay in the row
 * they belong to instead of inventing baselines of their own. Inside a row,
 * characters are split at horizontal gaps. */
function buildGlyphs(strokes, ch) {
  /* The solidus comes out first. It is drawn as one tall diagonal across both
     halves of the fraction, so it overlaps its own digits in x - left in the
     grouping below it welds numerator, slash and denominator into a single
     shape, which is how "7/8" came back as one unnameable blob. */
  const solidi = strokes.filter(s =>
    s.h > ch * 1.35 && s.w < ch * 0.9 && s.pts.length <= 3);
  const rest = strokes.filter(s => !solidi.includes(s));

  const glyphs = solidi.map(s => ({
    ss: [s], x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, w: s.w, h: s.h, solidus: true
  }));
  const byX = rest.slice().sort((a, b) => a.x0 - b.x0);
  let group = null;
  /* Measured on this lettering: strokes belonging to one character overlap or
     touch (the bar of an "A" sits inside it, the two diagonals of an "X" share
     an x range), while the gap to the next character is about a sixth of the
     character height. A tenth sits clearly between the two. */
  const SPLIT = ch * 0.10;
  for (const s of byX) {
    if (!group || s.x0 - group.x1 > SPLIT) {
      group = { x0: s.x0, x1: s.x1, ss: [s] };
      glyphs.push(group);
    } else {
      group.x1 = Math.max(group.x1, s.x1);
      group.ss.push(s);
    }
  }
  return glyphs.map(g => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of g.ss) {
      x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x1);
      y0 = Math.min(y0, s.y0); y1 = Math.max(y1, s.y1);
    }
    return { ss: g.ss, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, solidus: !!g.solidus };
  }).sort((a, b) => a.x0 - b.x0);
}

export const GW = 10, GH = 14;

/* A character normalised to a small bitmap. Scale and stroke decomposition
   drop out; what remains is the shape. */
export function glyphBitmap(gl) {
  const w = Math.max(gl.w, 1e-9), h = Math.max(gl.h, 1e-9);
  const b = new Uint8Array(GW * GH);
  const put = (px, py) => { if (px >= 0 && px < GW && py >= 0 && py < GH) b[py * GW + px] = 1; };
  for (const s of gl.ss) {
    for (let k = 0; k + 1 < s.pts.length; k++) {
      const A = s.pts[k], B = s.pts[k + 1];
      const ax = (A[0] - gl.x0) / w * (GW - 1), ay = (A[1] - gl.y0) / h * (GH - 1);
      const bx = (B[0] - gl.x0) / w * (GW - 1), by = (B[1] - gl.y0) / h * (GH - 1);
      const n = Math.max(2, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 3));
      for (let t = 0; t <= n; t++) put(Math.round(ax + (bx - ax) * t / n), Math.round(ay + (by - ay) * t / n));
    }
  }
  return b;
}

const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

/* Group characters by shape.
 *
 * Aspect ratio is compared as well as ink, because normalising to a fixed box
 * makes a narrow character fill it: without this a "1" and an "8" both become
 * a full box and can land in the same cluster. Purity matters far more than
 * tidiness here - two shapes wrongly merged means a wrong digit on a record,
 * whereas one shape split in two only costs a second naming. */
export function clusterGlyphs(glyphs, tol = 6) {
  const clusters = [];
  for (const gl of glyphs) {
    const bm = glyphBitmap(gl);
    const ar = gl.w / Math.max(gl.h, 1e-9);
    let hit = null;
    for (const c of clusters) {
      if (Math.abs(c.ar - ar) > 0.22) continue;
      if (hamming(c.bitmap, bm) <= tol) { hit = c; break; }
    }
    if (hit) { hit.members.push(gl); gl.cluster = hit.id; }
    else {
      const c = { id: clusters.length, bitmap: bm, ar, members: [gl] };
      clusters.push(c);
      gl.cluster = c.id;
    }
  }
  return clusters;
}

/* Read one cell as a sequence of cluster ids, with stacked fractions folded
   into the order they are spoken: whole number, numerator, solidus,
   denominator. A horizontal bar with characters above and below it is a
   fraction bar; the caller never has to know the layout. */
export function cellSequence(glyphs, ch) {
  if (!glyphs.length) return [];
  const seq = [];
  const slash = glyphs.find(g => g.solidus);

  /* No fraction: everything is on one line, in reading order. */
  if (!slash) {
    glyphs.slice().sort((a, b) => a.x0 - b.x0)
      .forEach(g => seq.push({ cluster: g.cluster, part: 'main', glyph: g }));
    return seq;
  }

  /* A fraction here is written on the diagonal - a raised numerator, a full
     height solidus, a dropped denominator - so which half a digit belongs to
     is decided by height, not by which side of a bar it sits on. The baseline
     is taken from the full-size characters, which are the ones outside the
     fraction.
   *
   * The part tags matter downstream. "2", "1", "2" flattened to a string is
   * "212" or "21/2" depending on how it is joined, and neither says whether
   * the sheet meant 2-1/2 or 21/2. */
  const full = glyphs.filter(g => !g.solidus && g.h > ch * 0.7);
  const mids = (full.length ? full : glyphs).map(g => (g.y0 + g.y1) / 2).sort((a, b) => a - b);
  const base = mids[Math.floor(mids.length / 2)];

  /* Height alone is not enough to say which half a character belongs to. The
     inch mark after the fraction sits high too, and was being read as a second
     numerator digit. A numerator also has to end before the solidus does, and
     a denominator to start after it begins. */
  const slack = ch * 0.1;
  const num = [], den = [], main = [];
  for (const g of glyphs) {
    if (g.solidus) continue;
    const mid = (g.y0 + g.y1) / 2;
    const raised = mid < base - ch * 0.18;
    const dropped = mid > base + ch * 0.18;
    if (raised && g.x1 <= slash.x1 + slack && g.x1 > slash.x0 - ch * 1.2) num.push(g);
    else if (dropped && g.x0 >= slash.x0 - slack && g.x0 < slash.x1 + ch * 1.2) den.push(g);
    else main.push(g);
  }

  main.sort((a, b) => a.x0 - b.x0).forEach(g => seq.push({ cluster: g.cluster, part: 'main', glyph: g }));
  num.sort((a, b) => a.x0 - b.x0).forEach(g => seq.push({ cluster: g.cluster, part: 'num', glyph: g }));
  seq.push({ solidus: true, part: 'solidus' });
  den.sort((a, b) => a.x0 - b.x0).forEach(g => seq.push({ cluster: g.cluster, part: 'den', glyph: g }));
  return seq;
}

/* Everything the caller needs: the grid, the characters grouped by shape, and
   each cell as a sequence referring to those groups. Naming the groups turns
   every cell into text at once. */
export async function readVectorTable(doc, pageNo, box, opts = {}) {
  const strokes = await extractStrokes(doc, pageNo);
  const grid = tableGrid(strokes, box);
  const { strokes: gs, ch } = glyphStrokes(strokes, box);
  if (!gs.length) return { rows: [], clusters: [], ch: 0, grid, glyphCount: 0 };

  /* Rows come from the caller, because a schedule's data rows are usually not
     ruled - this one has vertical separators the whole height of the table and
     exactly two horizontals, both in the heading. The caller already knows
     where the rows are: the strips the operator is stepping through were cut
     from the same table and carry their bands. Falling back to the vertical
     spacing of the characters themselves would split every stacked fraction
     into rows of its own. */
  let bands = opts.rowBands && opts.rowBands.length
    ? opts.rowBands.map(b => ({ y0: b.y0, y1: b.y1 }))
    : null;
  if (!bands) {
    const ys = grid.ys.length >= 2 ? grid.ys : [box.y, box.y + box.h];
    bands = [];
    for (let r = 0; r + 1 < ys.length; r++) bands.push({ y0: ys[r], y1: ys[r + 1] });
  }

  /* Columns come from the ruling, which schedules do carry: separators run the
     full height even where rows are unruled. */
  const xs = grid.xs.length >= 1
    ? [box.x, ...grid.xs, box.x + box.w].filter((v, i, a) => i === 0 || v - a[i - 1] > ch * 0.5)
    : [box.x, box.x + box.w];

  const rows = [];
  for (const b of bands) {
    const top = b.y0, bot = b.y1;
    if (bot - top < ch * 0.5) continue;
    const band = gs.filter(s => (s.y0 + s.y1) / 2 > top && (s.y0 + s.y1) / 2 < bot);
    if (!band.length) { rows.push({ y0: top, y1: bot, cells: [] }); continue; }
    const cells = [];
    for (let c = 0; c + 1 < xs.length; c++) {
      const left = xs[c], right = xs[c + 1];
      const cellStrokes = band.filter(s => (s.x0 + s.x1) / 2 > left && (s.x0 + s.x1) / 2 < right);
      cells.push({ col: c, x0: left, x1: right, glyphs: buildGlyphs(cellStrokes, ch) });
    }
    rows.push({ y0: top, y1: bot, cells });
  }

  const all = [];
  rows.forEach(r => r.cells.forEach(c => c.glyphs.forEach(g => all.push(g))));
  const clusters = clusterGlyphs(all, opts.tol == null ? 6 : opts.tol);
  rows.forEach(r => r.cells.forEach(c => { c.seq = cellSequence(c.glyphs, ch); }));

  return { rows, clusters, ch, grid, glyphCount: all.length };
}

/* Name shapes without asking anybody, using what the sheet already proves.
 *
 * The bundle column is live text, so "300 THRU 308" is known to be nine
 * cables - and the quantity cell on that row begins with the digits of that
 * same nine. That labels a shape with certainty rather than by guessing, and
 * the label then holds everywhere the shape occurs, including in the
 * elongation column where nothing else could have settled it.
 *
 * Each label is voted on by every row that produces it. A shape that two rows
 * disagree about is left unnamed and reported: a disagreement means the
 * segmentation is wrong somewhere, and the whole point of this approach is
 * that it fails visibly instead of quietly writing a wrong digit.
 *
 * countFor: a row's bundle text -> how many cables it covers, or null.
 */
export function learnFromCounts(table, bundleTexts, countFor, qtyCol = 1) {
  const seqOf = r => {
    const c = r.cells.find(c => c.col === qtyCol);
    return c && c.seq ? c.seq.filter(i => i.cluster != null).map(i => i.cluster) : null;
  };
  const seqs = table.rows.map(seqOf);
  const rowCount = seqs.filter(Boolean).length;

  /* The separator between quantity and length appears once in every row, so
     it is the shape present in the most rows. Two rows are allowed to miss it
     - a revision cloud crossing a row breaks its segmentation. */
  const spread = new Map();
  seqs.forEach(ids => { if (ids) new Set(ids).forEach(id => spread.set(id, (spread.get(id) || 0) + 1)); });
  const ranked = [...spread.entries()].sort((a, b) => b[1] - a[1]);
  const sep = ranked.filter(([, n]) => n >= rowCount - 2).map(([id]) => id);

  const votes = new Map();
  const skipped = [];
  seqs.forEach((ids, i) => {
    if (!ids) return;
    const n = countFor(bundleTexts[i]);
    if (!n) return;
    const at = ids.findIndex(id => sep.includes(id));
    if (at < 1) return;
    const digits = String(n);
    const lead = ids.slice(0, at);
    if (lead.length !== digits.length) { skipped.push(i + 1); return; }
    lead.forEach((id, k) => {
      if (!votes.has(id)) votes.set(id, new Map());
      const m = votes.get(id);
      m.set(digits[k], (m.get(digits[k]) || 0) + 1);
    });
  });

  const names = {}, conflicts = [], evidence = {};
  for (const [id, m] of votes) {
    const opts = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (opts.length > 1) { conflicts.push({ cluster: id, saw: opts.map(o => o[0] + '×' + o[1]) }); continue; }
    names[id] = opts[0][0];
    evidence[id] = opts[0][1];
  }
  return { names, conflicts, evidence, separator: sep, skippedRows: skipped };
}

/* Turn a cell's sequence into text once the shapes have names. Any shape not
   yet named leaves a marker, so a partly-named alphabet produces an obviously
   incomplete cell rather than a plausible wrong one. */
export function renderCell(seq, names) {
  let out = '';
  for (const item of seq) {
    if (item.solidus) { out += '/'; continue; }
    const n = names[item.cluster];
    out += (n == null || n === '') ? '·' : n;
  }
  return out;
}

const UNNAMED = '·';

/* A quantity cell as the rest of the app expects it: "9 X 34A".
   Returns null unless every character in the cell has a name - a partly read
   quantity is worse than none, because the count is cross-checked against the
   bundle range and a missing digit would fail that check for the wrong
   reason. */
export function cellAsQty(seq, names) {
  const s = renderCell(seq, names);
  if (!s || s.includes(UNNAMED)) return null;
  const m = /^(\d{1,3})[Xx](\d{1,4})([A-Za-z]{0,2})$/.exec(s.replace(/\s+/g, ''));
  return m ? m[1] + ' X ' + m[2] + m[3].toUpperCase() : null;
}

/* An elongation cell as inches: "2 1/2".
 *
 * The delta, the equals sign and the inch mark are printed but carry no
 * value, so they are dropped once named. What is left has to be digits in the
 * three places the layout already told us about. */
export function cellAsElongation(seq, names) {
  const part = p => seq.filter(i => i.part === p && !i.solidus)
    .map(i => names[i.cluster]).join('');
  const anyUnnamed = seq.some(i => !i.solidus && (names[i.cluster] == null || names[i.cluster] === ''));
  if (anyUnnamed) return null;

  const main = part('main').replace(/[^0-9]/g, '');
  const num = part('num').replace(/[^0-9]/g, '');
  const den = part('den').replace(/[^0-9]/g, '');

  if (num && den) return (main ? main + ' ' : '') + num + '/' + den;
  if (main) return main;
  return null;
}

/* A shape, as lines that can be drawn at any size. The operator is naming
   these by eye, so they have to be legible - a 10x14 bitmap is enough to
   match shapes but not enough to read one. */
export function clusterOutline(cluster) {
  const gl = cluster.members[0];
  const w = Math.max(gl.w, 1e-9), h = Math.max(gl.h, 1e-9);
  const lines = gl.ss.map(s => s.pts.map(([x, y]) => [
    +(((x - gl.x0) / w) * 100).toFixed(1),
    +(((y - gl.y0) / h) * 100).toFixed(1)
  ]));
  return { lines, aspect: +(w / h).toFixed(3) };
}
