/* End-to-end tests against a real server on a throwaway database.
   The important cases are the safety ones: a field token must not be able to
   change a calculated elongation, and a stale push must not overwrite work. */

import { rmSync } from 'node:fs';
import { addToken } from './db.mjs';

const DB = './test.sqlite';
for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch (e) {} }
process.env.STRANDLINE_DB = DB;
process.env.NODE_ENV = 'test';

const { app, db } = await import('./server.mjs');
const OFFICE = addToken(db, { org: 'JC', role: 'office', label: 'test' });
const FIELD  = addToken(db, { org: 'JC', role: 'field',  label: 'test' });
const OTHER  = addToken(db, { org: 'Someone Else', role: 'office', label: 'test' });

const server = app.listen(0);
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log('  FAIL ' + label + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want)); }
};
const api = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await res.json(); } catch (e) {}
  return { status: res.status, body: j };
};

console.log('auth');
eq((await api('GET', '/v1/projects', null)).status, 401, 'no token rejected');
eq((await api('GET', '/v1/projects', 'slp_nonsense')).status, 401, 'bad token rejected');
eq((await api('GET', '/health', null)).status, 200, 'health is open');
eq((await api('GET', '/v1/projects', FIELD)).status, 200, 'field token can read');

console.log('office pushes a project and a schedule');
const PROJ = { id: 'p_prado', name: 'Prado Lofts at Meadowbrook', jobNo: '2622560140',
               defaults: { company: 'JC Concrete, LLC', ramArea: '4.20', fciReq: '3000' } };
eq((await api('POST', '/v1/projects', FIELD, PROJ)).status, 403, 'field token cannot create a project');
let r = await api('POST', '/v1/projects', OFFICE, PROJ);
eq(r.status, 200, 'office creates the project');
eq(r.body.rev, 1, 'project starts at rev 1');

const REC = {
  id: 'r_pour1', recName: 'Pour 1', bldg: '4 Story Prado Lofts', pour: 'Pour 1',
  ramArea: '4.20', fciReq: '3000', tolInd: '7', lenMode: 'frac', den: '16',
  dateStressed: '', stressedBy: '',
  tendons: [
    { mark: '300', len: '34', calc: '2-1/2', anchor: 'A', strands: 1, apsi: '', mka: '', mkb: '', seat: '', notes: '' },
    { mark: '301', len: '34', calc: '2-1/2', anchor: 'A', strands: 1, apsi: '', mka: '', mkb: '', seat: '', notes: '' }
  ]
};
r = await api('POST', '/v1/projects/p_prado/records', OFFICE, { records: [{ id: 'r_pour1', record: REC }] });
eq(r.body.results[0].status, 'created', 'schedule pushed');
eq(r.body.results[0].rev, 1, 'record at rev 1');

console.log('field pulls, records measurements, pushes back');
r = await api('GET', '/v1/projects/p_prado', FIELD);
eq(r.body.records[0].record.tendons.length, 2, 'field sees the schedule');
eq(r.body.records[0].record.tendons[0].calc, '2-1/2', 'calculated elongation arrives');

const fieldCopy = JSON.parse(JSON.stringify(r.body.records[0].record));
fieldCopy.dateStressed = '09/10/26';
fieldCopy.stressedBy = 'M. Reyes';
fieldCopy.tendons[0].mka = '2';
fieldCopy.tendons[0].mkb = '4-9/16';
fieldCopy.tendons[0].seat = '1/4';
fieldCopy.tendons[0].apsi = '7987';
r = await api('POST', '/v1/projects/p_prado/records', FIELD,
  { records: [{ id: 'r_pour1', baseRev: 1, record: fieldCopy }] });
eq(r.body.results[0].status, 'updated', 'field push accepted');
eq(r.body.results[0].rev, 2, 'record advanced to rev 2');

r = await api('GET', '/v1/projects/p_prado', OFFICE);
let stored = r.body.records[0].record;
eq(stored.tendons[0].mka, '2', 'field measurement stored');
eq(stored.stressedBy, 'M. Reyes', 'field signature stored');

console.log('a field token cannot change the schedule');
const tampered = JSON.parse(JSON.stringify(stored));
tampered.tendons[0].calc = '9-9/16';        // would make a failing tendon pass
tampered.tendons[0].len = '999';
tampered.tolInd = '25';                      // and would widen the tolerance
tampered.ramArea = '1.00';
r = await api('POST', '/v1/projects/p_prado/records', FIELD,
  { records: [{ id: 'r_pour1', baseRev: 2, record: tampered }] });
eq(r.body.results[0].status, 'updated', 'push accepted (measurements do land)');
r = await api('GET', '/v1/projects/p_prado', OFFICE);
stored = r.body.records[0].record;
eq(stored.tendons[0].calc, '2-1/2', 'calculated elongation UNCHANGED by a field push');
eq(stored.tendons[0].len, '34', 'tendon length UNCHANGED by a field push');
eq(stored.tolInd, '7', 'tolerance UNCHANGED by a field push');
eq(stored.ramArea, '4.20', 'ram area UNCHANGED by a field push');

console.log('a field token cannot invent a tendon');
const extra = JSON.parse(JSON.stringify(stored));
extra.tendons.push({ mark: '999', len: '50', calc: '4', anchor: 'A', strands: 1, mka: '2', mkb: '6' });
r = await api('POST', '/v1/projects/p_prado/records', FIELD,
  { records: [{ id: 'r_pour1', record: extra }] });
eq(r.body.results[0].unknownMarks, ['999'], 'unknown mark reported back');
r = await api('GET', '/v1/projects/p_prado', OFFICE);
eq(r.body.records[0].record.tendons.length, 2, 'unknown tendon not added to the record');

console.log('the office can revise a schedule without losing measurements');
const revised = JSON.parse(JSON.stringify(REC));
revised.tendons[0].calc = '2-5/8';           // revision cloud changed it
revised.tendons.push({ mark: '302', len: '34', calc: '2-1/2', anchor: 'A', strands: 1 });
r = await api('POST', '/v1/projects/p_prado/records', OFFICE, { records: [{ id: 'r_pour1', record: revised }] });
eq(r.body.results[0].status, 'updated', 'office revision accepted');
r = await api('GET', '/v1/projects/p_prado', OFFICE);
stored = r.body.records[0].record;
eq(stored.tendons[0].calc, '2-5/8', 'revised elongation applied');
eq(stored.tendons[0].mka, '2', 'field measurement survived the revision');
eq(stored.tendons[0].mkb, '4-9/16', 'second mark survived the revision');
eq(stored.tendons.length, 3, 'added tendon present');
eq(stored.stressedBy, 'M. Reyes', 'field signature survived the revision');

console.log('stale pushes are refused');
r = await api('POST', '/v1/projects/p_prado/records', FIELD,
  { records: [{ id: 'r_pour1', baseRev: 1, record: fieldCopy }] });
eq(r.body.results[0].status, 'conflict', 'stale baseRev conflicts');
eq(typeof r.body.results[0].record, 'object', 'server copy returned so the client can merge');

console.log('organisations are isolated');
eq((await api('GET', '/v1/projects/p_prado', OTHER)).status, 404, 'another org cannot read the project');
eq((await api('GET', '/v1/projects', OTHER)).body.projects.length, 0, 'another org sees no projects');

console.log('delta pull');
r = await api('GET', '/v1/changes?since=1970-01-01T00:00:00.000Z', FIELD);
eq(r.body.projects.length, 1, 'changes include the project');
eq(r.body.records.length, 1, 'changes include the record');
const after = r.body.now;
r = await api('GET', '/v1/changes?since=' + encodeURIComponent(after), FIELD);
eq(r.body.records.length, 0, 'nothing new after the watermark');

console.log('deletion');
eq((await api('DELETE', '/v1/projects/p_prado', FIELD)).status, 403, 'field cannot delete a project');
eq((await api('DELETE', '/v1/projects/p_prado', OFFICE)).status, 200, 'office deletes');
eq((await api('GET', '/v1/projects/p_prado', OFFICE)).status, 404, 'deleted project is gone');

server.close();
for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch (e) {} }
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
