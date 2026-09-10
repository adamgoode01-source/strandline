#!/usr/bin/env node
/* Reads the tendon elongation schedule off a set of PT plans.
 *
 *   set ANTHROPIC_API_KEY=...            (Windows: setx, or a .env you source)
 *   node read-plans.mjs "plans.pdf" --out project.json
 *
 *   --dry-run          render the page images only, no API calls, so you can
 *                      see exactly what would be sent
 *   --from-json f.json skip the API entirely and expand a schedule you already
 *                      have (e.g. produced by the Claude skill)
 *   --pages 4-7        limit which sheets are examined
 *   --job "24207"      job number for the project record
 *
 * Why vision rather than parsing: these drawings are exported with the text
 * converted to outlines, so the schedule is line art and no PDF parser can
 * read it. Rendering the sheet and looking at it sidesteps that completely.
 *
 * Division of labour is deliberate. The model only transcribes what is
 * printed; every piece of arithmetic - expanding "300 THRU 308" into nine
 * tendons, converting "2 1/2" to inches - happens in code that is tested
 * against a known sheet. A model is good at reading a smudged table and bad
 * at being audited, so it is never asked to compute.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openPdf, renderPage, sheetImage, cropRegion, toDataPart } from './render.mjs';
import { expandSchedule } from './expand.mjs';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// Locating a table on a sheet is easy; transcribing it accurately is not.
const LOCATE_MODEL = process.env.STRANDLINE_LOCATE_MODEL || 'claude-sonnet-5';
const READ_MODEL   = process.env.STRANDLINE_READ_MODEL   || 'claude-opus-5';

function args(argv) {
  const o = { pdf: null, out: 'project.json', dryRun: false, fromJson: null, pages: null, job: '', name: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--from-json') o.fromJson = argv[++i];
    else if (a === '--pages') o.pages = argv[++i];
    else if (a === '--job') o.job = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (!a.startsWith('--')) o.pdf = a;
  }
  return o;
}

function pageList(spec, total) {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set();
  for (const part of spec.split(',')) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (m) { for (let p = +m[1]; p <= +m[2]; p++) if (p >= 1 && p <= total) out.add(p); }
    else { const p = +part.trim(); if (p >= 1 && p <= total) out.add(p); }
  }
  return [...out].sort((a, b) => a - b);
}

async function callClaude(model, content, maxTokens = 4096) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set in the environment.');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('API ' + res.status + ': ' + body.slice(0, 300));
  }
  const j = await res.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return { text, usage: j.usage || {} };
}

// Models sometimes wrap JSON in prose or a fence despite instructions.
function extractJson(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1] : text;
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch (err) { return null; }
}

const LOCATE_PROMPT = `This is one sheet from a post-tensioning shop drawing set.

Find any table that lists tendon or bundle numbers together with their elongations. It is usually titled something like "SLAB TENDONS", "TENDON SCHEDULE" or "ELONGATIONS" and has columns for bundle numbers, quantity and length, and elongations.

Reply with JSON only:
{"found": true|false,
 "tables": [{"title": "<exact title text>", "pour": "<pour or phase if shown, else null>",
             "box": {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}}],
 "sheetNumber": "<e.g. PT-02A, else null>",
 "sheetTitle": "<e.g. TENDON FOUNDATION PLAN, else null>",
 "buildings": ["<any building names printed on the sheet>"]}

box is the table's bounding box as fractions of the sheet, x/y from the top-left. Include the title row and all data rows. Do not include tables that carry no elongations, such as reinforcing or support chair schedules.`;

const READ_PROMPT = `This is a tendon elongation schedule cropped from a post-tensioning shop drawing.

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

async function main() {
  const o = args(process.argv);

  // ---- schedule supplied directly, no API needed ----
  if (o.fromJson) {
    const raw = JSON.parse(readFileSync(o.fromJson, 'utf8'));
    const tables = Array.isArray(raw) ? raw : (raw.tables || [raw]);
    const bundle = buildProject(o, tables, { source: o.fromJson, model: null });
    writeFileSync(o.out, JSON.stringify(bundle, null, 2));
    report(bundle, o.out);
    return;
  }

  if (!o.pdf) {
    console.error('Usage: node read-plans.mjs <plans.pdf> [--out project.json] [--dry-run] [--pages 4-7]');
    process.exit(1);
  }
  if (!existsSync(o.pdf)) { console.error('No such file: ' + o.pdf); process.exit(1); }

  const doc = await openPdf(o.pdf);
  const pages = pageList(o.pages, doc.numPages);
  console.log(path.basename(o.pdf) + ': ' + doc.numPages + ' pages, examining ' + pages.length);

  const dumpDir = path.join(path.dirname(o.out) || '.', 'render');
  if (o.dryRun) mkdirSync(dumpDir, { recursive: true });

  const tables = [];
  let sheetInfo = {};
  let costIn = 0, costOut = 0;

  for (const p of pages) {
    process.stdout.write('  page ' + p + ': rendering... ');
    const { png } = await renderPage(doc, p, 4.0);
    const sheet = await sheetImage(png);

    if (o.dryRun) {
      writeFileSync(path.join(dumpDir, 'page-' + p + '.jpg'), sheet);
      console.log('written to render/page-' + p + '.jpg (' + (sheet.length / 1024).toFixed(0) + ' KB)');
      continue;
    }

    process.stdout.write('locating... ');
    let loc;
    try {
      const r = await callClaude(LOCATE_MODEL, [toDataPart(sheet), { type: 'text', text: LOCATE_PROMPT }], 1024);
      costIn += r.usage.input_tokens || 0; costOut += r.usage.output_tokens || 0;
      loc = extractJson(r.text);
    } catch (e) { console.log('FAILED (' + e.message.slice(0, 80) + ')'); continue; }

    if (!loc) { console.log('no usable reply'); continue; }
    if (loc.sheetNumber && !sheetInfo.sheetNumber) sheetInfo = loc;
    if (!loc.found || !Array.isArray(loc.tables) || !loc.tables.length) { console.log('no schedule'); continue; }

    console.log(loc.tables.length + ' schedule table(s)');
    for (const t of loc.tables) {
      if (!t.box) continue;
      process.stdout.write('    reading "' + (t.title || 'untitled') + '"... ');
      const crop = await cropRegion(png, t.box);
      try {
        const r = await callClaude(READ_MODEL, [toDataPart(crop), { type: 'text', text: READ_PROMPT }], 8192);
        costIn += r.usage.input_tokens || 0; costOut += r.usage.output_tokens || 0;
        const parsed = extractJson(r.text);
        if (!parsed || !Array.isArray(parsed.rows)) { console.log('unreadable reply'); continue; }
        parsed.page = p;
        parsed.sheetNumber = loc.sheetNumber || null;
        tables.push(parsed);
        console.log(parsed.rows.length + ' rows');
        if (parsed.unreadable && parsed.unreadable.length)
          parsed.unreadable.forEach(u => console.log('      unreadable: ' + u));
      } catch (e) { console.log('FAILED (' + e.message.slice(0, 80) + ')'); }
    }
  }

  if (o.dryRun) { console.log('\nDry run: images in ' + dumpDir + ', no API calls made.'); return; }
  if (!tables.length) { console.log('\nNo elongation schedule was found on the pages examined.'); process.exit(2); }

  const bundle = buildProject(o, tables, {
    source: path.basename(o.pdf), model: READ_MODEL,
    sheetNumber: sheetInfo.sheetNumber || null, buildings: sheetInfo.buildings || []
  });
  writeFileSync(o.out, JSON.stringify(bundle, null, 2));
  report(bundle, o.out);
  console.log('tokens: ' + costIn.toLocaleString() + ' in, ' + costOut.toLocaleString() + ' out');
}

function buildProject(o, tables, meta) {
  const forms = [];
  const allWarnings = [];
  for (const t of tables) {
    const rows = (t.rows || []).map(r => ({
      bundle: r.bundle, qtyFt: r.qtyFt, elongation: r.elongation,
      pf: r.pf, pour: t.pour || null,
      note: r.revised ? 'On a revision cloud - verify against the current sheet' : ''
    }));
    const { tendons, warnings, stats } = expandSchedule(rows);
    warnings.forEach(w => allWarnings.push({ ...w, table: t.title || null, page: t.page || null }));
    forms.push({
      name: t.pour ? String(t.pour) : (t.title || 'Schedule'),
      bldg: '', pour: t.pour ? String(t.pour) : '',
      shopDwg: t.sheetNumber || meta.sheetNumber || '',
      headers: t.headers || [],
      tendons, stats,
      unreadable: t.unreadable || []
    });
  }
  return {
    strandline: 1,
    kind: 'project',
    project: {
      name: o.name || (meta.source || 'Imported project').replace(/\.pdf$/i, ''),
      jobNo: o.job || ''
    },
    forms,
    source: { file: meta.source, model: meta.model, readAt: new Date().toISOString(),
              buildings: meta.buildings || [] },
    warnings: allWarnings
  };
}

function report(bundle, out) {
  console.log('');
  let total = 0;
  bundle.forms.forEach(f => {
    total += f.tendons.length;
    console.log('  ' + (f.name || 'form').padEnd(24) + f.tendons.length + ' tendons' +
                (f.stats && f.stats.statedTotal ? '  (schedule states ' + f.stats.statedTotal + ')' : ''));
  });
  const errs = bundle.warnings.filter(w => w.level === 'error');
  const warns = bundle.warnings.filter(w => w.level !== 'error');
  console.log('  ' + 'total'.padEnd(24) + total + ' tendons across ' + bundle.forms.length + ' form(s)');
  if (errs.length) {
    console.log('\n  MUST BE CHECKED BEFORE USE:');
    errs.forEach(w => console.log('    ' + (w.where || '') + ' - ' + w.msg));
  }
  if (warns.length) {
    console.log('\n  warnings:');
    warns.forEach(w => console.log('    ' + (w.where || '') + ' - ' + w.msg));
  }
  console.log('\nwrote ' + out);
  console.log('Every elongation on that sheet governs whether a tendon passes. Check the');
  console.log('transcription against the drawing before the crew stresses anything.');
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
