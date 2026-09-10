/* Cuts a cropped schedule into cells.
 *
 * Two things about these tables drive the design:
 *
 *  - The bundle column chains its hexagon bubbles with a continuous vertical
 *    line, so projecting rows across the whole table puts ink in every gap and
 *    merges all eighteen rows into one band. Rows are therefore projected from
 *    the numeric columns only.
 *  - A gap between text rows is not empty: anti-aliasing leaves a few pixels.
 *    The threshold is a fraction of the projected width, not a small constant.
 */

import sharp from 'sharp';

const DEFAULTS = {
  ink: 150,             // grey below this counts as ink
  ruleHeight: 0.5,      // a column rule spans at least this much of the height
  ruleMerge: 25,        // px; a double-stroked border is one rule
  rowThreshold: 0.04,   // fraction of projected width
  minBandPx: 18
};

export async function loadGrey(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

export function findColumns(grey, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt);
  const { data, W, H } = grey;
  const colInk = new Array(W).fill(0);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) if (data[row + x] < o.ink) colInk[x]++;
  }
  const tall = [];
  for (let x = 0; x < W; x++) if (colInk[x] > H * o.ruleHeight) tall.push(x);
  const groups = [];
  for (const x of tall) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= o.ruleMerge) last.push(x);
    else groups.push([x]);
  }
  const rules = groups.map(g => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
  const cols = [];
  for (let i = 0; i < rules.length - 1; i++) {
    cols.push({ x0: rules[i], x1: rules[i + 1], w: rules[i + 1] - rules[i] });
  }
  return { rules, cols };
}

/* Rows are found from the columns given in `zones` (indices into cols). */
export function findRows(grey, cols, zoneIdx, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt);
  const { data, W, H } = grey;
  const zones = zoneIdx.map(i => cols[i]).filter(Boolean)
    .map(c => [c.x0 + 10, c.x1 - 10]).filter(([a, b]) => b > a);
  if (!zones.length) return [];
  const projected = zones.reduce((a, [x0, x1]) => a + (x1 - x0), 0);
  const threshold = Math.max(6, Math.round(projected * o.rowThreshold));

  const rowInk = new Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    let n = 0;
    const row = y * W;
    for (const [x0, x1] of zones) for (let x = x0; x < x1; x++) if (data[row + x] < o.ink) n++;
    rowInk[y] = n;
  }
  const bands = [];
  let s = -1;
  for (let y = 0; y <= H; y++) {
    const has = y < H && rowInk[y] > threshold;
    if (has && s < 0) s = y;
    else if (!has && s >= 0) { if (y - s >= o.minBandPx) bands.push({ y0: s, y1: y }); s = -1; }
  }
  return bands.map(b => Object.assign(b, {
    // a full-width run of ink is a rule, not a row of text
    isRule: (b.y1 - b.y0) < 24 && rowInk[Math.floor((b.y0 + b.y1) / 2)] > projected * 0.8
  }));
}

/* Which columns hold the numbers. The bundle column is the widest one on the
   left and is split into two hexagon sub-columns, so the numeric columns are
   whatever follows them. Identified by ink pattern rather than by index, so a
   differently laid out schedule still works: a hexagon column has ink spread
   down its whole height, a numeric column has it in bands. */
export function classifyColumns(grey, cols, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt);
  const { data, W, H } = grey;
  return cols.map((c, i) => {
    let inkRows = 0;
    for (let y = 0; y < H; y++) {
      let n = 0;
      const row = y * W;
      for (let x = c.x0 + 8; x < c.x1 - 8; x++) if (data[row + x] < o.ink) n++;
      if (n > 2) inkRows++;
    }
    const coverage = inkRows / H;
    return { index: i, x0: c.x0, x1: c.x1, w: c.w, coverage,
             // chained hexagons leave ink almost everywhere down the column
             chained: coverage > 0.8 };
  });
}

export function clampExtract(box, W, H) {
  const left = Math.max(0, Math.min(W - 2, Math.round(box.left)));
  const top = Math.max(0, Math.min(H - 2, Math.round(box.top)));
  return {
    left, top,
    width: Math.max(2, Math.min(W - left, Math.round(box.width))),
    height: Math.max(2, Math.min(H - top, Math.round(box.height)))
  };
}

/* Every cell as a padded crop, ready to be read. */
export async function cutCells(pngBuffer, grey, cols, rows, pad = 8) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const band = rows[r];
    if (band.isRule) continue;
    const cells = [];
    for (let c = 0; c < cols.length; c++) {
      const box = clampExtract({
        left: cols[c].x0 + 6, top: band.y0 - pad,
        width: cols[c].w - 12, height: (band.y1 - band.y0) + pad * 2
      }, grey.W, grey.H);
      cells.push({ col: c, box });
    }
    out.push({ row: r, y0: band.y0, y1: band.y1, cells });
  }
  return out;
}
