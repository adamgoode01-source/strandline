/* PDF text extraction: object walking, stream decoding and font decoding.
 *
 * Replaces two faults in the original approach:
 *
 *  1. Streams were found by scanning for the word "stream" and reading the
 *     filter out of the preceding 600 characters. That misattributes filters
 *     and cannot resolve an indirect /Length, so most content was skipped.
 *     On a real 9-page shop drawing it recovered 3 text items instead of 609.
 *  2. Font encodings were ignored. Subset fonts routinely remap character
 *     codes, so "REVISIONS" arrives as "5(9,6,216" and no header ever matches.
 *
 * inflate is injected: DecompressionStream in the browser, zlib in node.
 */

// ---------- object index ----------
function indexObjects(raw) {
  const objs = new Map();
  const re = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    let end = raw.indexOf('endobj', start);
    if (end < 0) end = raw.length;
    objs.set(+m[1], { start, end });
  }
  return objs;
}

// ---------- glyph names to characters ----------
const AGL = {
  space:' ', exclam:'!', quotedbl:'"', numbersign:'#', dollar:'$', percent:'%',
  ampersand:'&', quotesingle:"'", parenleft:'(', parenright:')', asterisk:'*',
  plus:'+', comma:',', hyphen:'-', period:'.', slash:'/', zero:'0', one:'1',
  two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8',
  nine:'9', colon:':', semicolon:';', less:'<', equal:'=', greater:'>',
  question:'?', at:'@', bracketleft:'[', backslash:'\\', bracketright:']',
  asciicircum:'^', underscore:'_', grave:'`', braceleft:'{', bar:'|',
  braceright:'}', asciitilde:'~', degree:'°', plusminus:'±',
  quoteright:'’', quoteleft:'‘', endash:'–', emdash:'—',
  bullet:'•', fraction:'⁄', onehalf:'½', onequarter:'¼',
  threequarters:'¾'
};
function glyphToChar(name) {
  if (!name) return null;
  if (AGL[name]) return AGL[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  return null;
}

// ---------- /ToUnicode CMap ----------
function parseCMap(cmap) {
  const map = new Map();
  const hex = h => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    if (h.length === 2) s = String.fromCharCode(parseInt(h, 16));
    return s;
  };
  let m;
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(cmap))) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pair.exec(m[1]))) map.set(parseInt(p[1], 16), hex(p[2]));
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(cmap))) {
    const body = m[1];
    const simple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let r;
    while ((r = simple.exec(body))) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16), dst = parseInt(r[3], 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
    const arr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((r = arr.exec(body))) {
      const lo = parseInt(r[1], 16);
      const items = r[3].match(/<([0-9A-Fa-f]+)>/g) || [];
      items.forEach((it, i) => map.set(lo + i, hex(it.slice(1, -1))));
    }
  }
  return map;
}

// ---------- font decoding tables ----------
async function buildFontMap(fontObjNum, ctx) {
  if (ctx.fontCache.has(fontObjNum)) return ctx.fontCache.get(fontObjNum);
  const t = ctx.objText(fontObjNum);
  const out = { map: null, twoByte: /\/Type0\b/.test(t) || /\/Identity-H/.test(t) };

  const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(t);
  if (tu) {
    const cm = await ctx.decodeStream(+tu[1]);
    if (cm) { const m = parseCMap(cm); if (m.size) out.map = m; }
  }
  if (!out.map) {
    // /Encoding may be inline or an indirect object
    let enc = t;
    const encRef = /\/Encoding\s+(\d+)\s+0\s+R/.exec(t);
    if (encRef) enc = ctx.objText(+encRef[1]);
    const diff = /\/Differences\s*\[([\s\S]*?)\]/.exec(enc);
    if (diff) {
      const map = new Map();
      let code = 0;
      const tok = /(\d+)|\/([^\s/\]]+)/g;
      let d;
      while ((d = tok.exec(diff[1]))) {
        if (d[1] !== undefined) code = +d[1];
        else { const ch = glyphToChar(d[2]); if (ch) map.set(code, ch); code++; }
      }
      if (map.size) out.map = map;
    }
  }
  ctx.fontCache.set(fontObjNum, out);
  return out;
}

// Last resort. Subset fonts often renumber codes by a constant, so printable
// text arrives shifted - "REVISIONS" as "5(9,6,216" at +0x1D. Only applied
// when the raw text is mostly unreadable and a single shift makes most of it
// readable, and the caller is told it was guessed.
// Vocabulary that appears on essentially every structural drawing sheet.
const WORDS = ['DATE','REVISION','NOTES','PLAN','DETAIL','GENERAL','SHEET','SCALE',
  'TENDON','SLAB','CONCRETE','TYPICAL','THRU','DRAWN','CHECKED','PROJECT','FOUNDATION',
  'ELEVATION','SECTION','SCHEDULE','STRAND','LENGTH','ELONGATION','BUILDING','FLOOR',
  'LEVEL','POUR','GRID','MARK','TOTAL','STRESS','ANCHOR','REBAR','SLAB','JOINT'];

function guessShift(strings) {
  // Scored on real words, not character classes. A letter ratio cannot choose
  // between +29 and +65 - one yields "DATE", the other "hexi", and both are
  // all letters. Only a shift that produces actual drawing vocabulary is
  // accepted, which also means ordinary text is never mangled.
  const joined = strings.join(' ').slice(0, 8000);
  const hits = s => {
    let n = 0;
    for (const w of WORDS) {
      let i = -1;
      while ((i = s.indexOf(w, i + 1)) >= 0) n++;
    }
    return n;
  };
  const upper = joined.toUpperCase();
  const base = hits(upper);
  let best = 0, bestScore = base;
  for (let k = 1; k <= 96; k++) {
    const shifted = joined.replace(/[\x01-\x7e]/g, c => String.fromCharCode(c.charCodeAt(0) + k)).toUpperCase();
    const sc = hits(shifted);
    if (sc > bestScore) { bestScore = sc; best = k; }
  }
  return (bestScore >= 4 && bestScore >= base * 3) ? best : 0;
}

// ---------- main ----------
async function extractPdfText(bytes, inflate, scanContent) {
  const raw = latin1(bytes);
  const objs = indexObjects(raw);
  const objText = n => { const o = objs.get(n); return o ? raw.slice(o.start, o.end) : ''; };

  const ctx = { objText, fontCache: new Map(), decodeStream: null };

  async function decodeStream(objNum) {
    const o = objs.get(objNum);
    if (!o) return null;
    const body = raw.slice(o.start, o.end);
    const si = body.indexOf('stream');
    if (si < 0) return null;
    const dict = body.slice(0, si);
    if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(dict)) return null;
    let ds = si + 6;
    if (body[ds] === '\r') ds++;
    if (body[ds] === '\n') ds++;
    const de = body.indexOf('endstream', ds);
    if (de < 0) return null;
    // /Length is frequently an indirect reference
    let len = null;
    let lm = /\/Length\s+(\d+)\s+0\s+R/.exec(dict);
    if (lm) { const v = /(\d+)/.exec(objText(+lm[1])); if (v) len = +v[1]; }
    else { lm = /\/Length\s+(\d+)/.exec(dict); if (lm) len = +lm[1]; }
    const abs = o.start + ds;
    const avail = de - ds;
    const seg = bytes.subarray(abs, abs + Math.min(len == null ? avail : len, avail));
    if (/\/FlateDecode/.test(dict)) {
      const inf = await inflate(seg);
      return inf ? latin1(inf) : null;
    }
    if (/\/Filter/.test(dict)) return null;      // some other filter we do not handle
    return latin1(seg);
  }
  ctx.decodeStream = decodeStream;

  // page objects, with their content streams and font resources
  const pageRe = /\/Type\s*\/Page[^s]/g;
  const pageObjs = [];
  for (const [num, o] of objs) {
    const t = raw.slice(o.start, o.end);
    pageRe.lastIndex = 0;
    if (pageRe.test(t)) pageObjs.push({ num, text: t });
  }

  const tokens = [];
  const items = [];
  let pagesRead = 0;

  for (const pg of pageObjs) {
    // resources may be inline or indirect
    let resText = pg.text;
    const rref = /\/Resources\s+(\d+)\s+0\s+R/.exec(pg.text);
    if (rref) resText = objText(+rref[1]);
    const fonts = new Map();                       // /F1 -> font object number
    let fontDict = null;
    const fref = /\/Font\s+(\d+)\s+0\s+R/.exec(resText);
    if (fref) fontDict = objText(+fref[1]);
    else {
      const fi = resText.indexOf('/Font');
      if (fi >= 0) fontDict = resText.slice(fi, fi + 4000);
    }
    if (fontDict) {
      const fr = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g;
      let f;
      while ((f = fr.exec(fontDict))) fonts.set(f[1], +f[2]);
    }

    // contents: one ref or an array of them
    const contentNums = [];
    let cm = /\/Contents\s+(\d+)\s+0\s+R/.exec(pg.text);
    if (cm) contentNums.push(+cm[1]);
    else {
      const arr = /\/Contents\s*\[([^\]]*)\]/.exec(pg.text);
      if (arr) { let a; const ar = /(\d+)\s+0\s+R/g; while ((a = ar.exec(arr[1]))) contentNums.push(+a[1]); }
    }
    if (!contentNums.length) continue;

    let content = '';
    for (const cn of contentNums) {
      const c = await decodeStream(cn);
      if (c) content += c + '\n';
    }
    if (!content || !/(Tj|TJ)/.test(content)) continue;
    pagesRead++;

    // decode each shown string through whichever font was selected
    const maps = new Map();
    for (const [name, objNum] of fonts) maps.set(name, await buildFontMap(objNum, ctx));

    const pageItems = scanContent(content, (text, fontName) => {
      const fm = maps.get(fontName);
      if (!fm || !fm.map) return text;
      let out = '';
      if (fm.twoByte) {
        for (let i = 0; i + 1 < text.length; i += 2) {
          const code = (text.charCodeAt(i) << 8) | text.charCodeAt(i + 1);
          out += fm.map.has(code) ? fm.map.get(code) : '';
        }
      } else {
        for (const ch of text) {
          const code = ch.charCodeAt(0);
          out += fm.map.has(code) ? fm.map.get(code) : ch;
        }
      }
      return out || text;
    });
    for (const it of pageItems) items.push(it);
  }

  // Shift detection has to be per font, not per document. A submittal often
  // carries readable cover pages in one font and re-encoded drawing text in
  // another; averaging across both hides the re-encoded one entirely.
  const byFont = new Map();
  for (const it of items) {
    const k = it.font || '?';
    if (!byFont.has(k)) byFont.set(k, []);
    byFont.get(k).push(it);
  }
  let guessed = 0;
  for (const group of byFont.values()) {
    const shift = guessShift(group.map(i => i.text));
    if (!shift) continue;
    guessed++;
    for (const it of group) {
      it.text = it.text.replace(/[\x01-\x7e]/g, c => String.fromCharCode(c.charCodeAt(0) + shift));
    }
  }
  for (const it of items) if (it.text.trim()) tokens.push(it.text.trim());

  return { pageCount: pageObjs.length, pagesRead, tokens, items, encodingGuessed: guessed > 0, fontsGuessed: guessed };
}

function latin1(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}

module.exports = { extractPdfText, indexObjects, parseCMap, glyphToChar, guessShift, latin1 };
