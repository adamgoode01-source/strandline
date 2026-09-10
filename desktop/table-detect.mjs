/* Finds ruled tables on a drawing sheet.
 *
 * Works on the rendered image rather than the PDF's path operators. That is a
 * deliberate choice: it costs a render, but it is font-independent, it does not
 * care whether the sheet was exported as vectors or scanned, and there is no
 * CTM bookkeeping to get subtly wrong. A schedule is a grid of long straight
 * rules, and long straight rules are trivial to see in pixels.
 *
 * No API, no model, no network.
 */

import sharp from 'sharp';

const DEFAULTS = {
  analyseWidth: 1800,     // downscale for analysis; rules survive this easily
  darkThreshold: 160,     // 0-255; below this counts as ink
  minRuleFraction: 0.045, // a rule must span this much of the sheet
  minRows: 3,             // a schedule has a title, a header and data
  minCols: 2,
  mergeTolerance: 3       // pixels; rules drawn as two passes count once
};

/* Collapse near-duplicate rules: CAD often strokes a rule twice, and an
   anti-aliased edge shows up as two adjacent rows.
 *
 * Two runs at the same height are only the same rule if they also overlap
 * along their length. Merging on height alone joined a schedule rule to an
 * unrelated titleblock rule at the same height, producing one sheet-wide rule
 * that then swallowed every real table. */
function mergeRuns(values, tol) {
  if (!values.length) return [];
  const sorted = values.slice().sort((a, b) => (a.at - b.at) || (a.from - b.from));
  const out = [];
  for (const v of sorted) {
    let merged = false;
    for (let i = out.length - 1; i >= 0 && v.at - out[i].at <= tol; i--) {
      const o = out[i];
      const overlap = Math.min(o.to, v.to) - Math.max(o.from, v.from);
      if (overlap > -tol) {                 // overlapping, or touching end to end
        o.from = Math.min(o.from, v.from);
        o.to = Math.max(o.to, v.to);
        o.n++;
        merged = true;
        break;
      }
    }
    if (!merged) out.push({ at: v.at, from: v.from, to: v.to, n: 1 });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* Scan one axis for unbroken dark runs. A table rule is a single long run, not
   a scattering of ink, so runs are measured rather than pixels counted -
   otherwise a dense band of tendon lines reads as a rule. */
function findRules(gray, w, h, axis, opt) {
  const minLen = Math.round((axis === 'h' ? w : h) * opt.minRuleFraction);
  const outer = axis === 'h' ? h : w;
  const inner = axis === 'h' ? w : h;
  const found = [];
  for (let o = 0; o < outer; o++) {
    let runStart = -1;
    for (let i = 0; i <= inner; i++) {
      const dark = i < inner &&
        gray[axis === 'h' ? o * w + i : i * w + o] < opt.darkThreshold;
      if (dark && runStart < 0) runStart = i;
      else if (!dark && runStart >= 0) {
        if (i - runStart >= minLen) found.push({ at: o, from: runStart, to: i });
        runStart = -1;
      }
    }
  }
  return mergeRuns(found, opt.mergeTolerance);
}

/* Assemble rules into tables.
 *
 * The vertical rules define a table's extent, not the horizontals. That is the
 * opposite of the obvious approach and it matters: on this schedule the data
 * rows carry no horizontal rules at all - only the outer border, the title
 * separator and the header separator - so grouping horizontals by vertical
 * proximity found the header and stopped, missing every row of data. The
 * column separators, by contrast, run the full height of the table and say
 * exactly where it begins and ends.
 *
 * So: find columns that share a vertical extent, then confirm the region with
 * horizontal rules that span the same width. */
function assemble(hRules, vRules, opt) {
  const tables = [];
  const tol = opt.mergeTolerance * 3;

  // Group verticals that start and end at about the same height - those are
  // the column separators of one table.
  const clusters = [];
  for (const v of vRules) {
    const len = v.to - v.from;
    if (len < 12) continue;
    let hit = null;
    for (const c of clusters) {
      if (Math.abs(c.from - v.from) <= tol && Math.abs(c.to - v.to) <= tol) { hit = c; break; }
    }
    if (hit) {
      hit.xs.push(v.at);
      hit.from = Math.min(hit.from, v.from);
      hit.to = Math.max(hit.to, v.to);
    } else {
      clusters.push({ from: v.from, to: v.to, xs: [v.at] });
    }
  }

  for (const c of clusters) {
    if (c.xs.length < opt.minCols) continue;
    const left = Math.min(...c.xs), right = Math.max(...c.xs);
    const width = right - left;
    if (width < 12) continue;

    // Horizontal rules that sit inside this region and span most of its width
    const hs = hRules.filter(r =>
      r.at >= c.from - tol && r.at <= c.to + tol &&
      Math.min(r.to, right) - Math.max(r.from, left) > width * 0.6);
    if (hs.length < opt.minRows) continue;

    tables.push({
      rows: hs.length,
      cols: c.xs.length,
      px: {
        left: Math.min(left, ...hs.map(r => r.from)),
        right: Math.max(right, ...hs.map(r => r.to)),
        top: Math.min(c.from, ...hs.map(r => r.at)),
        bottom: Math.max(c.to, ...hs.map(r => r.at))
      },
      columnsPx: c.xs.slice().sort((a, b) => a - b),
      rowsPx: hs.map(r => r.at)
    });
  }
  return tables;
}

/* pngBuffer: a rendered page. Returns candidate tables with boxes expressed as
   fractions of the page, largest first. */
export async function detectTables(pngBuffer, options = {}) {
  const opt = Object.assign({}, DEFAULTS, options);
  const meta = await sharp(pngBuffer).metadata();
  const scale = Math.min(1, opt.analyseWidth / meta.width);
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));

  const { data } = await sharp(pngBuffer)
    .resize(w, h, { kernel: 'lanczos3' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });

  const hRules = findRules(data, w, h, 'h', opt);
  const vRules = findRules(data, w, h, 'v', opt);
  const tables = assemble(hRules, vRules, opt);

  /* Ink density inside the region, which is what separates a schedule from a
     false positive. The drawing area throws up plenty of rectangles because
     tendon runs are long straight lines and read as rules; those regions are
     mostly white space. A schedule is small, has few columns, and is packed
     with numbers. */
  const inkFraction = (px) => {
    const x0 = Math.max(0, px.left), x1 = Math.min(w, px.right);
    const y0 = Math.max(0, px.top), y1 = Math.min(h, px.bottom);
    if (x1 <= x0 || y1 <= y0) return 0;
    let dark = 0, total = 0;
    const stepX = Math.max(1, Math.floor((x1 - x0) / 240));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 240));
    for (let y = y0; y < y1; y += stepY) {
      for (let x = x0; x < x1; x += stepX) {
        total++;
        if (data[y * w + x] < opt.darkThreshold) dark++;
      }
    }
    return total ? dark / total : 0;
  };

  const scored = tables.map(t => {
    const area = ((t.px.right - t.px.left) * (t.px.bottom - t.px.top)) / (w * h);
    const ink = inkFraction(t.px);
    return {
      rows: t.rows,
      cols: t.cols,
      area,
      ink,
      box: {
        x: t.px.left / w, y: t.px.top / h,
        w: (t.px.right - t.px.left) / w, h: (t.px.bottom - t.px.top) / h
      }
    };
  });

  return {
    analysedAt: { width: w, height: h },
    horizontalRules: hRules.length,
    verticalRules: vRules.length,
    debug: opt.debug ? { hRules, vRules, rawTables: tables, scored } : undefined,
    /* Ranked, not chosen. Detection narrows a sheet down to a handful of
       regions; which one is the schedule is a judgement the operator makes in
       two seconds from a thumbnail. Auto-picking would be right most of the
       time, and silently wrong the rest, on a value that decides whether a
       tendon passes. */
    tables: dedupe(
      scored
        // A schedule has a few columns and occupies a corner. A dozen columns
        // spanning half the sheet is the drawing itself, where tendon runs read
        // as rules.
        .filter(t => t.cols <= 8 && t.area <= 0.20 && t.box.w > 0.03 && t.box.h > 0.02)
        // Ink favours dense text; the width penalty favours a discrete block
        // over a band stretched across the drawing.
        .map(t => Object.assign(t, { score: t.ink * (1 - Math.min(0.6, t.box.w)) }))
        .sort((a, b) => b.score - a.score)
    ).slice(0, 8)
  };
}

/* Overlapping detections are the same table found twice - once by its outer
   border and once by an inner rule. Keep the better-scoring one. */
function dedupe(list) {
  const out = [];
  for (const t of list) {
    const clash = out.find(o => {
      const ox = Math.min(o.box.x + o.box.w, t.box.x + t.box.w) - Math.max(o.box.x, t.box.x);
      const oy = Math.min(o.box.y + o.box.h, t.box.y + t.box.h) - Math.max(o.box.y, t.box.y);
      if (ox <= 0 || oy <= 0) return false;
      const inter = ox * oy;
      const smaller = Math.min(o.box.w * o.box.h, t.box.w * t.box.h);
      return inter > smaller * 0.6;
    });
    if (!clash) out.push(t);
  }
  return out;
}
