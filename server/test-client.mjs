/* Integration test for the app's sync client, pulled out of index.html and
   run against a live server with the DOM stubbed. This covers the half that
   test-server.mjs cannot: whether the client merges what comes back into its
   own store correctly, and whether a field device's recorded work survives an
   office revision arriving on top of it.

     node test-client.mjs <serverUrl> <officeToken> <fieldToken>
*/

import { readFileSync } from 'node:fs';

const [, , URL_, OFFICE, FIELD] = process.argv;
if (!URL_ || !OFFICE || !FIELD) {
  console.error('usage: node test-client.mjs <serverUrl> <officeToken> <fieldToken>');
  process.exit(1);
}

const html = readFileSync('../index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* Pull out just what the sync client needs. Functions are extracted by
   balanced braces rather than by an end marker, because marker slicing broke
   as soon as the file was reordered. */
function grabFn(name) {
  const at = script.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('no such function: ' + name);
  let depth = 0;
  for (let i = script.indexOf('{', at); i < script.length; i++) {
    const c = script[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return script.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
function grabRange(startMarker, endMarker) {
  const a = script.indexOf(startMarker);
  const b = script.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('could not extract: ' + startMarker);
  return script.slice(a, b);
}
const syncSrc = grabRange('const SYNC_KEY', '/* ---------- top-level views');
const helpers = grabFn('trimTrailingSlash') + '\n' + grabFn('stripScheme');
const blanks  = grabRange('const SHARED_KEYS', 'function blankProject(name){') + grabFn('blankProject');
const recSrc  = grabFn('blankRecord');
const tendSrc = grabFn('blankTendon');

// Minimal environment.
const store = new Map();
const env = {
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  },
  fetch,
  toasts: [],
  toast(m) { this.toasts.push(m); },
  $: () => null,
  save: () => {},
  esc: s => String(s == null ? '' : s),
  num: v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : NaN; },
  renderHome: () => {}, renderProject: () => {}, renderSyncBar: () => {},
  Math, Date, JSON, Object, Array, String, Number, isFinite, encodeURIComponent, console
};

const factory = new Function('env', `
  // renderSyncBar is NOT stubbed: the extracted source defines the real one,
  // and it already tolerates a missing element.
  const { localStorage, fetch, $, save, esc, num, renderHome, renderProject } = env;
  const toast = m => env.toast(m);
  ${blanks}
  ${recSrc}
  ${tendSrc}
  let DB = { v:2, projects:[], activeProject:null, active:null, view:'home' };
  function proj(){ return DB.projects.find(p=>p.id===DB.activeProject) || null; }
  function projRecords(){ const p = proj(); return p ? p.records : []; }
  ${helpers}
  ${syncSrc}
  return {
    get DB(){ return DB; }, set DB(v){ DB = v; },
    syncPush, syncPull, syncCfg, saveSyncCfg, blankProject, blankRecord, blankTendon
  };
`);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log('  FAIL ' + label + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want)); }
};

// ---- the office device ----
store.clear();
const office = factory(env);
office.saveSyncCfg({ url: URL_, token: OFFICE });

const proj = office.blankProject('Prado Lofts at Meadowbrook');
proj.id = 'p_test_' + Date.now();
proj.jobNo = '2622560140';
proj.defaults.company = 'JC Concrete, LLC';
proj.defaults.ramArea = '4.20';

const form = office.blankRecord('Pour 1');
form.bldg = '4 Story Prado Lofts';
form.pour = 'Pour 1';
form.ramArea = '4.20';
form.tolInd = '7';
form.tendons = [
  Object.assign(office.blankTendon('300'), { len: '34', calc: '2-1/2', anchor: 'A', strands: 1 }),
  Object.assign(office.blankTendon('301'), { len: '34', calc: '2-1/2', anchor: 'A', strands: 1 })
];
proj.records.push(form);
office.DB.projects.push(proj);

console.log('office pushes');
let r = await office.syncPush();
eq(r.pushed, 1, 'one form pushed');
eq(r.conflicts, 0, 'no conflicts');
eq(typeof proj.srev, 'number', 'project got a server revision');
eq(form.srev, 1, 'form at server rev 1');

// ---- the field device, a separate store ----
const fieldStore = new Map();
const fieldEnv = Object.assign({}, env, {
  localStorage: {
    getItem: k => (fieldStore.has(k) ? fieldStore.get(k) : null),
    setItem: (k, v) => fieldStore.set(k, String(v)),
    removeItem: k => fieldStore.delete(k)
  },
  toasts: [], toast(m) { this.toasts.push(m); }
});
const field = factory(fieldEnv);
field.saveSyncCfg({ url: URL_, token: FIELD });

console.log('field pulls');
let d = await field.syncPull();
eq(d.projects >= 1, true, 'project received');
const fp = field.DB.projects.find(p => p.id === proj.id);
eq(!!fp, true, 'project present locally');
eq(fp.records.length, 1, 'form received');
eq(fp.records[0].tendons.length, 2, 'both tendons received');
eq(fp.records[0].tendons[0].calc, '2-1/2', 'calculated elongation received');
eq(fp.records[0].tendons[0].anchor, 'A', 'anchorage type received');
eq(fp.jobNo, '2622560140', 'job number received');

console.log('field records measurements and pushes');
const fr = fp.records[0];
fr.dateStressed = '09/10/26';
fr.stressedBy = 'M. Reyes';
fr.tendons[0].mka = '2';
fr.tendons[0].mkb = '4-9/16';
fr.tendons[0].seat = '1/4';
fr.tendons[0].apsi = '7987';
r = await field.syncPush();
eq(r.pushed, 1, 'field push accepted');
eq(fr.srev, 2, 'form advanced to rev 2');

console.log('office revises the schedule while the field work stands');
form.tendons[0].calc = '2-5/8';
form.tendons.push(Object.assign(office.blankTendon('302'), { len: '34', calc: '2-1/2', anchor: 'A', strands: 1 }));
r = await office.syncPush();
eq(r.pushed, 1, 'revision pushed');

console.log('field pulls the revision');
d = await field.syncPull();
const fr2 = field.DB.projects.find(p => p.id === proj.id).records[0];
eq(fr2.tendons.length, 3, 'added tendon arrives');
eq(fr2.tendons[0].calc, '2-5/8', 'revised elongation arrives');
eq(fr2.tendons[0].mka, '2', 'the crew measurement survived the revision');
eq(fr2.tendons[0].mkb, '4-9/16', 'second mark survived');
eq(fr2.stressedBy, 'M. Reyes', 'field signature survived');

console.log('a field device cannot push a changed elongation');
fr2.tendons[0].calc = '9-1/2';
fr2.tolInd = '25';
await field.syncPush();
const check = await fetch(URL_ + '/v1/projects/' + proj.id, { headers: { authorization: 'Bearer ' + OFFICE } });
const server = (await check.json()).records[0].record;
eq(server.tendons[0].calc, '2-5/8', 'server kept the office elongation');
eq(server.tolInd, '7', 'server kept the office tolerance');

/* A device that has been offline pushes against a revision that has moved on.
   The push must still land - the crew's work is not discarded for being late -
   and it must not drag the stale office fields back with it. */
console.log('a stale field push still lands, without reverting the schedule');
const stale = JSON.parse(JSON.stringify(fr2));
stale.srev = 1;                                     // pretend this device is behind
stale.tendons[0].calc = '2-1/2';                    // and is carrying the old elongation
stale.tendons[1].mka = '2';
stale.tendons[1].mkb = '4-1/2';
const fp2 = field.DB.projects.find(p => p.id === proj.id);
fp2.records[0] = stale;
r = await field.syncPush();
eq(r.conflicts, 0, 'resolved by retry rather than reported as a conflict');
eq(r.pushed, 1, 'the late measurement was accepted');

const after = await fetch(URL_ + '/v1/projects/' + proj.id, { headers: { authorization: 'Bearer ' + OFFICE } });
const srv = (await after.json()).records[0].record;
eq(srv.tendons[1].mka, '2', 'the late measurement reached the server');
eq(srv.tendons[1].mkb, '4-1/2', 'both marks reached the server');
eq(srv.tendons[0].calc, '2-5/8', 'the stale copy did NOT revert the revised elongation');
eq(srv.tendons[0].mka, '2', 'the earlier measurement is still there');

// clean up
await fetch(URL_ + '/v1/projects/' + proj.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + OFFICE } });

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
