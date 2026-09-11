/* Sanity checks on index.html before it is built into the shipped targets.
 *
 * These all exist because something got past review and only showed up when a
 * real interaction ran. They are cheap, so they run on every build. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let bad = 0;
const fail = (msg) => { bad++; console.error('  ' + msg); };

/* $$ collapsed to $.
 *
 * Patches to this file are applied with String.replace, and "$$" in a
 * replacement string means an escaped literal "$" - so $$('sel') silently
 * becomes $('sel'), which returns one element instead of an array. It throws
 * only when the line runs, which in a UI can be a long way from the build.
 * This has shipped four times: assistTable, assistCands, stripDots, and the
 * shape grid. */
const collapsed = [...src.matchAll(/(?<!\$)\$\('[^']*'\)\s*\.\s*(forEach|find|map|filter|indexOf|reduce|some|every|slice)\b/g)];
if (collapsed.length) {
  console.error('$$ collapsed to $ (array method on a single element):');
  collapsed.forEach(m => {
    const line = src.slice(0, m.index).split('\n').length;
    fail('index.html:' + line + '  ' + m[0]);
  });
}

/* The page is one file: an unbalanced div means the build silently ships a
   broken layout. */
const opens = (src.match(/<div\b/g) || []).length;
const closes = (src.match(/<\/div>/g) || []).length;
if (opens !== closes) fail('div tags unbalanced: ' + opens + ' open, ' + closes + ' close');

/* It has to parse. */
const m = /<script>([\s\S]*)<\/script>/.exec(src);
if (!m) fail('no <script> block found');
else {
  try { new (await import('node:vm')).Script(m[1]); }
  catch (e) { fail('script does not parse: ' + e.message); }
}

if (bad) {
  console.error('\ncheck-page: ' + bad + ' problem(s) - not building');
  process.exit(1);
}
console.log('check-page: ok');
