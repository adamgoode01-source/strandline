/* Verifies the app's importProjectBundle against the file the reader writes,
   extracted from index.html so the real code is what runs. */
import { readFileSync } from 'node:fs';
const script = readFileSync('../index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const grabFn = name => {
  const at = script.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('no such function: ' + name);
  let d = 0;
  for (let i = script.indexOf('{', at); i < script.length; i++) {
    if (script[i] === '{') d++;
    else if (script[i] === '}') { d--; if (!d) return script.slice(at, i + 1); }
  }
  throw new Error('unbalanced ' + name);
};
const grabRange = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));

const api = new Function(`
  const save = () => {};
  const num = v => { const n = parseFloat(String(v).replace(/,/g,'')); return isFinite(n) ? n : NaN; };
  ${grabRange('const SHARED_KEYS', 'function blankProject(name){')}
  ${grabFn('blankProject')}
  ${grabFn('blankRecord')}
  ${grabFn('blankTendon')}
  ${grabFn('newFormForBuilding')}
  let DB = { v:2, projects:[], activeProject:null, active:null, view:'home' };
  ${grabFn('importProjectBundle')}
  return { importProjectBundle, get DB(){ return DB; } };
`)();

let pass = 0, fail = 0;
const eq = (g, w, l) => { const ok = JSON.stringify(g) === JSON.stringify(w);
  if (ok) pass++; else { fail++; console.log('  FAIL ' + l + '\n    got  ' + JSON.stringify(g) + '\n    want ' + JSON.stringify(w)); } };

const bundle = JSON.parse(readFileSync('./out/project.json','utf8'));
const res = api.importProjectBundle(bundle);
const p = res.project;
const tendons = p.records.reduce((a,r)=>a.concat(r.tendons),[]);

eq(p.name, 'Prado Lofts at Meadowbrook', 'project name');
eq(p.jobNo, '2622560140', 'job number');
eq(p.records.length, 1, 'one form');
eq(tendons.length, 121, '121 tendons imported');
eq(tendons[0].mark, '300', 'first mark');
eq(tendons[0].len, '34', 'first length');
eq(tendons[0].calc, '2-1/2', 'first elongation as a fraction');
eq(tendons[0].anchor, 'A', 'anchorage carried through');
eq(tendons[120].mark, '420', 'last mark');
eq(tendons[120].calc, '13-5/8', 'last elongation');
eq(tendons[120].anchor, 'B', 'last anchorage');
eq(tendons.every(t=>t.strands === 1), true, 'strand count defaulted');
eq(tendons.filter(t=>t.calc === '').length, 0, 'every tendon has an elongation');
eq(new Set(tendons.map(t=>t.mark)).size, 121, 'no duplicate marks');
eq(res.warnings.length, 0, 'no warnings on a clean read');
eq(p.records[0].shopDwg, 'PT-02A', 'sheet number carried through');
eq(p.records[0].pour, 'Pour 1', 'pour carried through');
// the record must inherit the project defaults so it stands alone
eq(typeof p.records[0].tolInd, 'string', 'acceptance tolerance present on the form');

// a malformed file must be refused, not half-imported
let refused = false;
try { api.importProjectBundle({ nope: true }); } catch (e) { refused = true; }
eq(refused, true, 'a file that is not a plan file is refused');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
