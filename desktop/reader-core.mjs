/* The reader itself, with no command line and no console output, so the CLI
   and the desktop window share exactly one implementation. Progress is
   reported through a callback rather than printed.
 *
 * The model only transcribes. Expanding "300 THRU 308" into nine tendons and
 * reading "2 1/2" as inches happen in expand.mjs, which is tested against a
 * sheet whose correct answer is known.
 */

import path from 'node:path';
import { openPdf, renderPage, sheetImage, cropRegion, toDataPart } from './render.mjs';
import { expandSchedule } from './expand.mjs';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
export const DEFAULT_LOCATE_MODEL = 'claude-sonnet-5';
export const DEFAULT_READ_MODEL = 'claude-opus-5';

export const LOCATE_PROMPT = `This is one sheet from a post-tensioning shop drawing set.

Find any table that lists tendon or bundle numbers together with their elongations. It is usually titled something like "SLAB TENDONS", "TENDON SCHEDULE" or "ELONGATIONS" and has columns for bundle numbers, quantity and length, and elongations.

Reply with JSON only:
{"found": true|false,
 "tables": [{"title": "<exact title text>", "pour": "<pour or phase if shown, else null>",
             "box": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}}],
 "sheetNumber": "<e.g. PT-02A, else null>",
 "sheetTitle": "<e.g. TENDON FOUNDATION PLAN, else null>",
 "buildings": ["<any building names printed on the sheet>"]}

box is the table's bounding box as fractions of the sheet, x/y from the top-left. Include the title row and all data rows. Do not include tables that carry no elongations, such as reinforcing or support chair schedules.`;

export const READ_PROMPT = `This is a tendon elongation schedule cropped from a post-tensioning shop drawing.

Transcribe it exactly as printed. Do not calculate, expand ranges, convert units, or correct anything that looks wrong.

Reply with JSON only:
{"title": "<table title>",
 "pour": "<pour or phase, else null>",
 "headers": ["<column headers exactly as printed>"],
 "rows": [{"bundle": "<bundle number cell, e.g. '300 THRU 308' or '312'>",
           "qtyFt": "<quantity and length cell, e.g. '9 X 34A'>",
           "elongation": "<elongation cell, e.g. 'D = 2 1/2\\"'>",
           "pf": "<PF column if present, else null>",
           "revised": true|false}],
 "unreadable": ["<describe any cell you could not read with confidence>"]}

Rules:
- Keep every row, in printed order.
- Reproduce fractions as written: "2 1/2", "10 1/8", "13 5/8".
- Keep the trailing letter on the length (34A, 169B) - it is the anchorage type.
- Use null for a cell that is genuinely blank.
- If a value is unclear, put null and describe it in "unreadable". Never guess a number.
- Set "revised" true only where a revision cloud or delta marker covers the row.`;

async function callClaude(apiKey, model, content, maxTokens) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens || 4096, messages: [{ role: 'user', content }] })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = 'API ' + res.status;
    if (res.status === 401) msg = 'the API key was rejected';
    else if (res.status === 429) msg = 'rate limited by the API - try again shortly';
    else if (res.status >= 500) msg = 'the API is having trouble (' + res.status + ')';
    throw new Error(msg + (body ? ': ' + body.slice(0, 200) : ''));
  }
  const j = await res.json();
  return {
    text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''),
    usage: j.usage || {}
  };
}

// Models sometimes wrap JSON in prose or a fence despite instructions.
export function extractJson(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1] : text;
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch (err) { return null; }
}

export function pageList(spec, total) {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (m) { for (let p = +m[1]; p <= +m[2]; p++) if (p >= 1 && p <= total) out.add(p); }
    else { const p = +part.trim(); if (p >= 1 && p <= total) out.add(p); }
  }
  return [...out].sort((a, b) => a - b);
}

export function buildProject({ job, name, sourceFile, model, sheetNumber, buildings }, tables) {
  const forms = [];
  const allWarnings = [];
  for (const t of tables) {
    const rows = (t.rows || []).map(r => ({
      bundle: r.bundle, qtyFt: r.qtyFt, elongation: r.elongation,
      pf: r.pf, pour: t.pour || null,
      note: r.revised ? 'On a revision cloud - verify against the current sheet' : ''
    }));
    const { tendons, warnings, stats } = expandSchedule(rows);
    warnings.forEach(w => allWarnings.push(Object.assign({}, w, { table: t.title || null, page: t.page || null })));
    forms.push({
      name: t.pour ? String(t.pour) : (t.title || 'Schedule'),
      bldg: '', pour: t.pour ? String(t.pour) : '',
      shopDwg: t.sheetNumber || sheetNumber || '',
      headers: t.headers || [], tendons, stats,
      unreadable: t.unreadable || []
    });
  }
  return {
    strandline: 1, kind: 'project',
    project: { name: name || String(sourceFile || 'Imported project').replace(/\.pdf$/i, ''), jobNo: job || '' },
    forms,
    source: { file: sourceFile, model, readAt: new Date().toISOString(), buildings: buildings || [] },
    warnings: allWarnings
  };
}

/* opts: { pdfPath, pages, job, name, apiKey, locateModel, readModel, onProgress } */
export async function runReader(opts) {
  const onProgress = opts.onProgress || (() => {});
  const locateModel = opts.locateModel || DEFAULT_LOCATE_MODEL;
  const readModel = opts.readModel || DEFAULT_READ_MODEL;
  if (!opts.apiKey) throw new Error('no API key supplied');

  const doc = await openPdf(opts.pdfPath);
  const pages = pageList(opts.pages, doc.numPages);
  onProgress({ phase: 'start', totalPages: doc.numPages, examining: pages.length });

  const tables = [];
  let sheetInfo = {};
  let tokensIn = 0, tokensOut = 0;

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    onProgress({ phase: 'render', page: p, index: i + 1, of: pages.length });
    const { png } = await renderPage(doc, p, 4.0);
    const sheet = await sheetImage(png);

    onProgress({ phase: 'locate', page: p, index: i + 1, of: pages.length });
    let loc = null;
    try {
      const r = await callClaude(opts.apiKey, locateModel,
        [toDataPart(sheet), { type: 'text', text: LOCATE_PROMPT }], 1024);
      tokensIn += r.usage.input_tokens || 0;
      tokensOut += r.usage.output_tokens || 0;
      loc = extractJson(r.text);
    } catch (err) {
      onProgress({ phase: 'pageError', page: p, message: err.message });
      continue;
    }
    if (!loc) { onProgress({ phase: 'noSchedule', page: p }); continue; }
    if (loc.sheetNumber && !sheetInfo.sheetNumber) sheetInfo = loc;
    if (!loc.found || !Array.isArray(loc.tables) || !loc.tables.length) {
      onProgress({ phase: 'noSchedule', page: p, sheet: loc.sheetNumber || null });
      continue;
    }

    for (const t of loc.tables) {
      if (!t.box) continue;
      onProgress({ phase: 'read', page: p, title: t.title || 'schedule' });
      try {
        const crop = await cropRegion(png, t.box);
        const r = await callClaude(opts.apiKey, readModel,
          [toDataPart(crop), { type: 'text', text: READ_PROMPT }], 8192);
        tokensIn += r.usage.input_tokens || 0;
        tokensOut += r.usage.output_tokens || 0;
        const parsed = extractJson(r.text);
        if (!parsed || !Array.isArray(parsed.rows)) {
          onProgress({ phase: 'pageError', page: p, message: 'the reply could not be parsed' });
          continue;
        }
        parsed.page = p;
        parsed.sheetNumber = loc.sheetNumber || null;
        tables.push(parsed);
        onProgress({ phase: 'readDone', page: p, title: parsed.title || null,
                     rows: parsed.rows.length, unreadable: parsed.unreadable || [] });
      } catch (err) {
        onProgress({ phase: 'pageError', page: p, message: err.message });
      }
    }
  }

  if (!tables.length) {
    const e = new Error('No elongation schedule was found on the pages examined.');
    e.code = 'NO_SCHEDULE';
    throw e;
  }

  const bundle = buildProject({
    job: opts.job, name: opts.name,
    sourceFile: path.basename(opts.pdfPath), model: readModel,
    sheetNumber: sheetInfo.sheetNumber || null, buildings: sheetInfo.buildings || []
  }, tables);
  bundle.source.tokens = { input: tokensIn, output: tokensOut };
  onProgress({ phase: 'done', tendons: bundle.forms.reduce((a, f) => a + f.tendons.length, 0),
               forms: bundle.forms.length, warnings: bundle.warnings.length });
  return bundle;
}

/* Render only, for the dry run and for showing the operator what would be sent. */
export async function renderOnly(pdfPath, pages, onProgress) {
  const doc = await openPdf(pdfPath);
  const list = pageList(pages, doc.numPages);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    (onProgress || (() => {}))({ phase: 'render', page: list[i], index: i + 1, of: list.length });
    const { png } = await renderPage(doc, list[i], 4.0);
    out.push({ page: list[i], jpeg: await sheetImage(png) });
  }
  return out;
}

/* Reads one already-cropped table image. Used by the desktop app's pull
   button, where the operator has already chosen the region, so there is no
   locate pass to pay for - one call, one table. */
export async function readTableImage(jpegBuffer, opts) {
  if (!opts || !opts.apiKey) throw new Error('no API key supplied');
  const model = opts.model || DEFAULT_READ_MODEL;
  const r = await callClaude(opts.apiKey, model,
    [toDataPart(jpegBuffer), { type: 'text', text: READ_PROMPT }], 8192);
  const parsed = extractJson(r.text);
  if (!parsed || !Array.isArray(parsed.rows)) {
    return { error: 'the reply could not be read as a table' };
  }
  return {
    title: parsed.title || null,
    pour: parsed.pour || null,
    headers: parsed.headers || [],
    rows: parsed.rows,
    unreadable: parsed.unreadable || [],
    usage: r.usage || {}
  };
}
