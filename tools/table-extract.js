/* Position-aware text extraction for PDF content streams.
 *
 * The original extractor collected text strings and threw the coordinates
 * away, which left an unordered bag of words that no amount of regex can turn
 * back into a table. This walks the content stream properly, tracking the
 * graphics and text matrices, so every string comes out with an (x, y).
 * Rows and columns can then be recovered by clustering.
 */

const BS = String.fromCharCode(92);   // backslash, kept out of string literals

// PDF affine matrices are [a b c d e f]; this is m1 x m2.
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}
const IDENT = [1, 0, 0, 1, 0, 0];

const ESC = Object.create(null);
ESC.n = String.fromCharCode(10);
ESC.r = String.fromCharCode(13);
ESC.t = String.fromCharCode(9);
ESC.b = String.fromCharCode(8);
ESC.f = String.fromCharCode(12);
ESC['('] = '(';
ESC[')'] = ')';
ESC[BS] = BS;

function scanContent(content) {
  const items = [];
  const n = content.length;
  let i = 0;
  let ops = [];
  let ctm = IDENT.slice();
  const gs = [];
  let tm = null, tlm = null;
  let leading = 0, size = 0, charSp = 0, hscale = 1;

  const nums = k => {
    const v = [];
    for (const o of ops) if (o.t === 'num') v.push(o.v);
    return v.slice(-k);
  };

  function emit(text) {
    if (!tm || !text) return;
    const m = mul(tm, ctm);
    const sc = Math.hypot(m[0], m[1]) || 1;
    items.push({ x: m[4], y: m[5], text: text, size: (size * sc) || size || 1 });
    // No font metrics here, so advance on an average glyph width. It only has
    // to be good enough to decide whether two fragments share a cell.
    const w = text.length * 0.5 * size * hscale + text.length * charSp;
    tm = mul([1, 0, 0, 1, w, 0], tm);
  }

  while (i < n) {
    const c = content[i];

    if (c === '%') { while (i < n && content[i] !== ESC.n) i++; continue; }
    if (c === ' ' || c === ESC.n || c === ESC.r || c === ESC.t || c === ESC.f) { i++; continue; }

    if (c === '(') {                                  // literal string, nesting-aware
      let depth = 1, j = i + 1, out = '';
      while (j < n && depth > 0) {
        const ch = content[j];
        if (ch === BS) {
          const nx = content[j + 1];
          if (nx !== undefined && ESC[nx] !== undefined) { out += ESC[nx]; j += 2; }
          else if (nx >= '0' && nx <= '7') {
            let o = '', k = j + 1;
            while (k < n && content[k] >= '0' && content[k] <= '7' && o.length < 3) { o += content[k]; k++; }
            out += String.fromCharCode(parseInt(o, 8)); j = k;
          } else { out += (nx === undefined ? '' : nx); j += 2; }
          continue;
        }
        if (ch === '(') { depth++; out += ch; j++; continue; }
        if (ch === ')') { depth--; if (!depth) { j++; break; } out += ch; j++; continue; }
        out += ch; j++;
      }
      ops.push({ t: 'str', v: out }); i = j; continue;
    }

    if (c === '<' && content[i + 1] === '<') {        // dictionary - skip it whole
      let d = 0, j = i;
      while (j < n) {
        if (content.startsWith('<<', j)) { d++; j += 2; }
        else if (content.startsWith('>>', j)) { d--; j += 2; if (!d) break; }
        else j++;
      }
      i = j; continue;
    }

    if (c === '<') {                                  // hex string
      let j = content.indexOf('>', i); if (j < 0) j = n;
      const hex = content.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, '');
      // 2-byte CIDs are common in CAD output, 1-byte elsewhere. Take whichever
      // decoding yields more printable ASCII.
      let two = '', one = '';
      for (let k = 0; k + 4 <= hex.length; k += 4) {
        const v = parseInt(hex.substr(k, 4), 16);
        if (!isNaN(v)) two += String.fromCharCode(v);
      }
      for (let k = 0; k + 2 <= hex.length; k += 2) {
        const v = parseInt(hex.substr(k, 2), 16);
        if (!isNaN(v)) one += String.fromCharCode(v);
      }
      const score = s => {
        if (!s.length) return 0;
        let g = 0;
        for (const ch of s) if (ch >= ' ' && ch <= '~') g++;
        return g / s.length;
      };
      ops.push({ t: 'str', v: score(two) > score(one) ? two : one });
      i = j + 1; continue;
    }

    if (c === '[') { ops.push({ t: 'arrStart' }); i++; continue; }
    if (c === ']') {
      const arr = [];
      while (ops.length && ops[ops.length - 1].t !== 'arrStart') arr.unshift(ops.pop());
      ops.pop();
      ops.push({ t: 'arr', v: arr }); i++; continue;
    }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !/[\s/[\]<>(){}%]/.test(content[j])) j++;
      ops.push({ t: 'name', v: content.slice(i + 1, j) }); i = j; continue;
    }
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      let j = i;
      while (j < n && /[-+.\dEe]/.test(content[j])) j++;
      ops.push({ t: 'num', v: parseFloat(content.slice(i, j)) || 0 }); i = j; continue;
    }

    let j = i;
    while (j < n && /[A-Za-z0-9*'"]/.test(content[j])) j++;
    if (j === i) { i++; continue; }
    const op = content.slice(i, j); i = j;

    switch (op) {
      case 'q': gs.push(ctm.slice()); break;
      case 'Q': ctm = gs.pop() || IDENT.slice(); break;
      case 'cm': { const v = nums(6); if (v.length === 6) ctm = mul(v, ctm); break; }
      case 'BT': tm = IDENT.slice(); tlm = IDENT.slice(); break;
      case 'ET': tm = null; tlm = null; break;
      case 'Tf': { const v = nums(1); if (v.length) size = v[0]; break; }
      case 'TL': { const v = nums(1); if (v.length) leading = v[0]; break; }
      case 'Tc': { const v = nums(1); if (v.length) charSp = v[0]; break; }
      case 'Tz': { const v = nums(1); if (v.length) hscale = v[0] / 100; break; }
      case 'Td': { const v = nums(2); if (v.length === 2 && tlm) { tlm = mul([1,0,0,1,v[0],v[1]], tlm); tm = tlm.slice(); } break; }
      case 'TD': { const v = nums(2); if (v.length === 2 && tlm) { leading = -v[1]; tlm = mul([1,0,0,1,v[0],v[1]], tlm); tm = tlm.slice(); } break; }
      case 'Tm': { const v = nums(6); if (v.length === 6) { tlm = v.slice(); tm = v.slice(); } break; }
      case 'T*': if (tlm) { tlm = mul([1,0,0,1,0,-leading], tlm); tm = tlm.slice(); } break;
      case 'Tj':
      case "'":
      case '"': {
        if (op !== 'Tj' && tlm) { tlm = mul([1,0,0,1,0,-leading], tlm); tm = tlm.slice(); }
        let last = null;
        for (const o of ops) if (o.t === 'str') last = o;
        if (last) emit(last.v);
        break;
      }
      case 'TJ': {
        let arr = null;
        for (const o of ops) if (o.t === 'arr') arr = o;
        if (arr) for (const el of arr.v) {
          if (el.t === 'str') emit(el.v);
          else if (el.t === 'num' && tm) tm = mul([1, 0, 0, 1, -el.v / 1000 * size * hscale, 0], tm);
        }
        break;
      }
      default: break;
    }
    ops = [];
  }
  return items;
}

/* ---------- turning positioned text into a table ---------- */

// Group items into visual rows. CAD output rarely aligns baselines exactly, so
// the tolerance scales with the text size.
function toRows(items) {
  const live = items.filter(it => it.text && it.text.trim());
  if (!live.length) return [];
  const sorted = live.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];
    const tol = Math.max(2, (it.size || 8) * 0.55);
    if (Math.abs(it.y - cur[0].y) <= tol) cur.push(it);
    else { rows.push(cur); cur = [it]; }
  }
  rows.push(cur);
  // merge fragments that sit side by side inside one cell
  return rows.map(r => {
    const cells = [];
    r.sort((a, b) => a.x - b.x);
    for (const it of r) {
      const prev = cells[cells.length - 1];
      const gap = prev ? it.x - (prev.x + prev.w) : Infinity;
      if (prev && gap < (it.size || 8) * 0.6) {
        prev.text += (gap > (it.size || 8) * 0.18 ? ' ' : '') + it.text;
        prev.w = it.x + it.text.length * 0.5 * (it.size || 8) - prev.x;
      } else {
        cells.push({ x: it.x, y: it.y, size: it.size, text: it.text,
                     w: it.text.length * 0.5 * (it.size || 8) });
      }
    }
    return cells.map(c => ({ x: c.x, y: c.y, size: c.size, text: c.text.trim() }))
                .filter(c => c.text);
  }).filter(r => r.length);
}

// Column synonyms seen on real PT shop drawings.
const COLS = {
  mark:    [/^(tendon|mark|tdn|no\.?|id|strand\s*(no|id))\s*(no\.?|#)?$/i,
            /tendon\s*(mark|no|id)/i, /^mk$/i, /^tdn\b/i],
  loc:     [/^(location|grid|gridline|grid\s*line|position|from\s*[-/]?\s*to|bay)$/i, /grid/i],
  strands: [/^(strands?|no\.?\s*of\s*strands?|#\s*strands?|qty|str)$/i, /strand.*(qty|count|no)/i],
  // "L (FT)" and "LGTH" are both common on shop drawings, so the bare-letter
  // and abbreviated forms have to be matched as well as the spelled-out word.
  len:     [/^(length|len|lgth|lgt|lng)\b/i,
            /^l\s*[({[]?\s*(ft|feet|f)\.?\s*[)}\]]?$/i,
            /tendon\s*length/i, /length/i],
  calc:    [/^(calc(ulated)?\.?\s*elong(ation)?|elong(ation)?|theoretical\s*elong|design\s*elong|calc\.?\s*e)$/i,
            /elong/i]
};
function classifyHeader(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const key of ['mark', 'loc', 'strands', 'len', 'calc']) {
    for (const re of COLS[key]) if (re.test(t)) return key;
  }
  return null;
}

// Find the row that looks most like a header, then read the rows under it.
function findTable(items) {
  const rows = toRows(items);
  let best = null;
  rows.forEach((row, ri) => {
    const hits = new Map();
    row.forEach(cell => {
      const k = classifyHeader(cell.text);
      if (k && !hits.has(k)) hits.set(k, cell);
    });
    // a mark column plus at least one measurable column
    if (hits.has('mark') && (hits.has('len') || hits.has('calc'))) {
      const score = hits.size;
      if (!best || score > best.score) best = { score, ri, hits, row };
    }
  });
  if (!best) return { rows: rows, table: null };

  const cols = Array.from(best.hits.entries())
    .map(([key, cell]) => ({ key: key, x: cell.x, size: cell.size }))
    .sort((a, b) => a.x - b.x);

  // Column boundaries sit halfway between adjacent header anchors.
  const bounds = cols.map((c, i) => {
    const lo = i === 0 ? -Infinity : (cols[i - 1].x + c.x) / 2;
    const hi = i === cols.length - 1 ? Infinity : (c.x + cols[i + 1].x) / 2;
    return { key: c.key, lo: lo, hi: hi };
  });

  const out = [];
  for (let ri = best.ri + 1; ri < rows.length; ri++) {
    const row = rows[ri];
    const rec = {};
    for (const cell of row) {
      const b = bounds.find(b => cell.x >= b.lo && cell.x < b.hi);
      if (!b) continue;
      rec[b.key] = rec[b.key] ? (rec[b.key] + ' ' + cell.text) : cell.text;
    }
    if (!rec.mark) continue;
    // a mark is short and contains a digit; this is what stops totals rows,
    // notes and legend text from being read in as tendons
    if (!/\d/.test(rec.mark) || rec.mark.length > 12) continue;
    if (!(rec.len || rec.calc)) continue;
    out.push(rec);
  }
  return { rows: rows, table: { columns: bounds.map(b => b.key), rows: out, headerRow: best.ri } };
}

module.exports = { scanContent, mul, toRows, findTable, classifyHeader };
