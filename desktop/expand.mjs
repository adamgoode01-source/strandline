/* Turns a PT supplier's bundle schedule into one row per tendon.
 *
 * Real schedules are written in ranges, not per tendon:
 *
 *   BUNDLE NO.      QTY.  FT.   ELONGATIONS
 *   300 THRU 308    9  X  34A   D = 2 1/2"
 *   372 AND  373    2  X  49A   D = 3 3/4"
 *   312             1  X  54A   D = 4 1/4"
 *
 * "300 THRU 308, 9 X 34A" means tendons 300 to 308, nine of them, each 34 ft,
 * anchorage type A. The trailing letter is the anchorage configuration, not
 * part of the length: per the legend, A stresses full force at one end and B
 * at each end, so it tells the crew which end to pull and must be carried
 * through to the field sheet.
 *
 * Nothing here reconciles a disagreement quietly. If the stated quantity does
 * not match the range it describes, the row is flagged and left for a person.
 */

// "2 1/2", "2-1/2", "10 1/8", "4.5", "13 5/8" -> inches
export function parseInches(s) {
  if (s == null) return NaN;
  let t = String(s)
    // The delta symbol is often transcribed as a plain letter D, so strip a
    // leading delta-or-D only when it is followed by "=", never a bare D.
    .replace(/^\s*[DdΔ∆]\s*(?==)/, '')
    .replace(/[Δ∆]/g, '')
    .replace(/^\s*[=:]\s*/, '')
    .replace(/[""“”″]/g, '')
    .replace(/\bIN\b\.?/ig, '')
    .trim();
  // unicode vulgar fractions
  const VF = { '½':'1/2','¼':'1/4','¾':'3/4','⅛':'1/8','⅜':'3/8',
               '⅝':'5/8','⅞':'7/8','⅓':'1/3','⅔':'2/3' };
  t = t.replace(/[½¼¾⅛⅜⅝⅞⅓⅔]/g, m => ' ' + VF[m]);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return NaN;
  let m = /^(\d+(?:\.\d+)?)[\s-]+(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m) { const d = +m[3]; return d ? +m[1] + (+m[2]) / d : NaN; }
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m) { const d = +m[2]; return d ? (+m[1]) / d : NaN; }
  if (/^\d*\.?\d+$/.test(t)) return parseFloat(t);
  return NaN;
}

export function toFraction(v, den = 16) {
  if (!isFinite(v)) return '';
  const neg = v < 0, x = Math.abs(v);
  let w = Math.floor(x + 1e-9);
  let n = Math.round((x - w) * den);
  if (n >= den) { w++; n = 0; }
  const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a || 1; };
  let out;
  if (n > 0) { const g = gcd(n, den); out = (w ? w + '-' : '') + (n / g) + '/' + (den / g); }
  else out = String(w);
  return (neg ? '-' : '') + out;
}

// "300 THRU 308" | "372 AND 373" | "312" | "300-308"
export function parseBundle(s) {
  const t = String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let m = /^([A-Z]*)(\d+)\s*(?:THRU|THROUGH|TO|-|–)\s*([A-Z]*)(\d+)$/.exec(t);
  if (m) {
    const lo = +m[2], hi = +m[4];
    if (hi < lo) return null;
    const prefix = m[1] || m[3] || '';
    return { kind: 'range', prefix, from: lo, to: hi, count: hi - lo + 1 };
  }
  m = /^([A-Z]*)(\d+)\s*(?:AND|&|\+)\s*([A-Z]*)(\d+)$/.exec(t);
  if (m) {
    const a = +m[2], b = +m[4];
    const prefix = m[1] || m[3] || '';
    // "AND" is a pair, which is only a range when they are adjacent
    if (b === a + 1) return { kind: 'range', prefix, from: a, to: b, count: 2 };
    return { kind: 'list', prefix, marks: [a, b], count: 2 };
  }
  m = /^([A-Z]*)(\d+)$/.exec(t);
  if (m) return { kind: 'range', prefix: m[1] || '', from: +m[2], to: +m[2], count: 1 };
  return null;
}

// "9 X 34A" | "17 X 57A" | "22 X 169B" | "9x34" | "1 X 59B"
export function parseQtyFt(s) {
  const t = String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
  let m = /^(\d+)\s*[X×]\s*(\d+(?:\.\d+)?)\s*([A-Z])?$/.exec(t);
  if (m) return { qty: +m[1], feet: parseFloat(m[2]), anchor: m[3] || '' };
  m = /^(\d+(?:\.\d+)?)\s*([A-Z])?$/.exec(t);      // length only
  if (m) return { qty: null, feet: parseFloat(m[1]), anchor: m[2] || '' };
  return null;
}

/* rows: [{ bundle, qtyFt, elongation, pf?, note? }] as read off the sheet.
   Returns { tendons, warnings, stats }. */
export function expandSchedule(rows, opts = {}) {
  const den = opts.den || 16;
  const tendons = [];
  const warnings = [];
  const seen = new Set();

  rows.forEach((row, i) => {
    const where = 'row ' + (i + 1) + ' (' + (row.bundle || '?') + ')';
    const b = parseBundle(row.bundle);
    const q = parseQtyFt(row.qtyFt);
    const eIn = parseInches(row.elongation);

    if (!b) { warnings.push({ level: 'error', where, msg: 'bundle numbers unreadable, row skipped' }); return; }
    if (!q) { warnings.push({ level: 'error', where, msg: 'quantity/length unreadable, row skipped' }); return; }
    if (!isFinite(eIn)) warnings.push({ level: 'warn', where, msg: 'elongation unreadable, left blank' });

    const marks = b.kind === 'list'
      ? b.marks.slice()
      : Array.from({ length: b.count }, (_, k) => b.from + k);

    // A stated quantity that disagrees with the range is a reading error or a
    // drawing error. Either way it is not for this code to decide.
    if (q.qty != null && q.qty !== marks.length) {
      warnings.push({ level: 'error', where,
        msg: 'stated quantity ' + q.qty + ' does not match ' + marks.length +
             ' bundle numbers - verify against the drawing before use' });
    }

    for (const n of marks) {
      const mark = (b.prefix || '') + n;
      if (seen.has(mark)) {
        warnings.push({ level: 'error', where, msg: 'tendon ' + mark + ' appears more than once' });
        continue;
      }
      seen.add(mark);
      tendons.push({
        mark,
        loc: '',
        strands: 1,
        len: isFinite(q.feet) ? String(q.feet) : '',
        calc: isFinite(eIn) ? toFraction(eIn, den) : '',
        anchor: q.anchor,
        grp: row.pour || '',
        notes: row.note || (row.pf ? 'PF ' + row.pf : '')
      });
    }
  });

  const total = tendons.length;
  const stated = rows.reduce((a, r) => { const q = parseQtyFt(r.qtyFt); return a + (q && q.qty ? q.qty : 0); }, 0);
  if (stated && stated !== total) {
    warnings.push({ level: 'error', where: 'schedule total',
      msg: 'quantities sum to ' + stated + ' but ' + total + ' tendons were produced' });
  }
  return { tendons, warnings, stats: { rows: rows.length, tendons: total, statedTotal: stated } };
}
