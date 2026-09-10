#!/usr/bin/env node
/* Command-line front end for the plan reader. The desktop window and this
   share one implementation in reader-core.mjs, so there is no second copy to
   drift.
 *
 * PowerShell does not accept && as a separator, so run these on separate
 * lines rather than chained:
 *
 *   $env:ANTHROPIC_API_KEY = "sk-ant-..."
 *   node read-plans.mjs "C:\path\to\plans.pdf" --out project.json
 *
 *   --dry-run          render the page images only, no API calls
 *   --from-json f.json expand a schedule you already have
 *   --pages 4-7        limit which sheets are examined
 *   --job, --name      job number and project name
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runReader, renderOnly, buildProject } from './reader-core.mjs';

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

function report(bundle, out) {
  console.log('');
  let total = 0;
  bundle.forms.forEach(f => {
    total += f.tendons.length;
    console.log('  ' + String(f.name || 'form').padEnd(24) + f.tendons.length + ' tendons' +
      (f.stats && f.stats.statedTotal ? '  (schedule states ' + f.stats.statedTotal + ')' : ''));
    (f.unreadable || []).forEach(u => console.log('      unreadable: ' + u));
  });
  console.log('  ' + 'total'.padEnd(24) + total + ' tendons across ' + bundle.forms.length + ' form(s)');
  const errs = bundle.warnings.filter(w => w.level === 'error');
  const warns = bundle.warnings.filter(w => w.level !== 'error');
  if (errs.length) {
    console.log('\n  MUST BE CHECKED BEFORE USE:');
    errs.forEach(w => console.log('    ' + (w.where || '') + ' - ' + w.msg));
  }
  if (warns.length) {
    console.log('\n  warnings:');
    warns.forEach(w => console.log('    ' + (w.where || '') + ' - ' + w.msg));
  }
  if (bundle.source && bundle.source.tokens) {
    console.log('\n  tokens: ' + bundle.source.tokens.input.toLocaleString() + ' in, ' +
                bundle.source.tokens.output.toLocaleString() + ' out');
  }
  console.log('\nwrote ' + out);
  console.log('Every elongation on that sheet governs whether a tendon passes. Check the');
  console.log('transcription against the drawing before the crew stresses anything.');
}

async function main() {
  const o = args(process.argv);

  if (o.fromJson) {
    const raw = JSON.parse(readFileSync(o.fromJson, 'utf8'));
    const tables = Array.isArray(raw) ? raw : (raw.tables || [raw]);
    const bundle = buildProject({ job: o.job, name: o.name, sourceFile: o.fromJson, model: null }, tables);
    writeFileSync(o.out, JSON.stringify(bundle, null, 2));
    report(bundle, o.out);
    return;
  }

  if (!o.pdf) {
    console.error('Usage: node read-plans.mjs <plans.pdf> [--out project.json] [--dry-run] [--pages 4-7]');
    process.exit(1);
  }
  if (!existsSync(o.pdf)) { console.error('No such file: ' + o.pdf); process.exit(1); }

  if (o.dryRun) {
    const dir = path.join(path.dirname(o.out) || '.', 'render');
    mkdirSync(dir, { recursive: true });
    const imgs = await renderOnly(o.pdf, o.pages, m =>
      process.stdout.write('  page ' + m.page + ' (' + m.index + ' of ' + m.of + ')\n'));
    imgs.forEach(i => writeFileSync(path.join(dir, 'page-' + i.page + '.jpg'), i.jpeg));
    console.log('\nDry run: ' + imgs.length + ' image(s) in ' + dir + ', no API calls made.');
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set. In PowerShell:');
    console.error('  $env:ANTHROPIC_API_KEY = "sk-ant-..."');
    process.exit(1);
  }

  let bundle;
  try {
    bundle = await runReader({
      pdfPath: o.pdf, pages: o.pages, job: o.job, name: o.name, apiKey: key,
      onProgress: m => {
        if (m.phase === 'start') console.log(path.basename(o.pdf) + ': ' + m.totalPages + ' pages, examining ' + m.examining);
        else if (m.phase === 'locate') process.stdout.write('  page ' + m.page + ': locating... ');
        else if (m.phase === 'noSchedule') console.log('no schedule');
        else if (m.phase === 'read') process.stdout.write('\n    reading "' + m.title + '"... ');
        else if (m.phase === 'readDone') console.log(m.rows + ' rows');
        else if (m.phase === 'pageError') console.log('FAILED (' + m.message + ')');
      }
    });
  } catch (e) {
    console.error('\n' + e.message);
    process.exit(e.code === 'NO_SCHEDULE' ? 2 : 1);
  }
  writeFileSync(o.out, JSON.stringify(bundle, null, 2));
  report(bundle, o.out);
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
