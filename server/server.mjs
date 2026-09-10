/* Strandline PT sync service.
 *
 * The office pushes projects and schedules; the field pulls them and pushes
 * measurements back. Writes are field-scoped by role (see merge.mjs) and
 * guarded by an optimistic revision, so a stale client cannot quietly
 * overwrite a record that has moved on.
 *
 *   node server.mjs                       # PORT, STRANDLINE_DB from env
 *   node admin.mjs add-token --org "JC Concrete, LLC" --role office
 */

import express from 'express';
import { openDb, authenticate } from './db.mjs';
import { mergeRecord } from './merge.mjs';

const PORT = process.env.PORT || 8787;
const db = openDb();
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));

/* The iOS build is a Capacitor webview, whose origin is capacitor://localhost
   rather than an https page, so those schemes have to be allowed explicitly.
   Set STRANDLINE_ORIGINS to override. */
const ORIGINS = (process.env.STRANDLINE_ORIGINS ||
  'capacitor://localhost,ionic://localhost,http://localhost,https://localhost').split(',');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ORIGINS.includes('*') || ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'strandline-sync' }));

// ---- auth ----
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const who = authenticate(db, token);
  if (!who) return res.status(401).json({ error: 'unauthorized' });
  req.who = who;
  next();
}
const officeOnly = (req, res, next) =>
  req.who.role === 'office' ? next() : res.status(403).json({ error: 'office token required' });

const nowIso = () => new Date().toISOString();
const j = v => { try { return JSON.parse(v); } catch (e) { return null; } };

// ---- projects ----
app.get('/v1/projects', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, job_no, defaults, plan, rev, updated_at, deleted
       FROM projects WHERE org = ? ORDER BY updated_at DESC`).all(req.who.org);
  res.json({
    projects: rows.map(r => ({
      id: r.id, name: r.name, jobNo: r.job_no, defaults: j(r.defaults) || {},
      plan: j(r.plan), rev: r.rev, updatedAt: r.updated_at, deleted: !!r.deleted,
      formCount: db.prepare('SELECT COUNT(*) n FROM records WHERE org=? AND project_id=? AND deleted=0')
                   .get(req.who.org, r.id).n
    }))
  });
});

app.get('/v1/projects/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE org=? AND id=?').get(req.who.org, req.params.id);
  if (!p || p.deleted) return res.status(404).json({ error: 'not found' });
  const recs = db.prepare('SELECT id, payload, rev, updated_at FROM records WHERE org=? AND project_id=? AND deleted=0')
                 .all(req.who.org, req.params.id);
  res.json({
    project: { id: p.id, name: p.name, jobNo: p.job_no, defaults: j(p.defaults) || {},
               plan: j(p.plan), rev: p.rev, updatedAt: p.updated_at },
    records: recs.map(r => ({ id: r.id, rev: r.rev, updatedAt: r.updated_at, record: j(r.payload) }))
  });
});

app.post('/v1/projects', auth, officeOnly, (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.name) return res.status(400).json({ error: 'id and name are required' });
  const existing = db.prepare('SELECT rev FROM projects WHERE org=? AND id=?').get(req.who.org, b.id);
  if (existing && b.baseRev != null && b.baseRev !== existing.rev) {
    return res.status(409).json({ error: 'conflict', rev: existing.rev });
  }
  const rev = existing ? existing.rev + 1 : 1;
  db.prepare(`INSERT INTO projects (id, org, name, job_no, defaults, plan, rev, updated_at, deleted)
              VALUES (?,?,?,?,?,?,?,?,0)
              ON CONFLICT(org, id) DO UPDATE SET
                name=excluded.name, job_no=excluded.job_no, defaults=excluded.defaults,
                plan=excluded.plan, rev=excluded.rev, updated_at=excluded.updated_at, deleted=0`)
    .run(b.id, req.who.org, b.name, b.jobNo || '', JSON.stringify(b.defaults || {}),
         b.plan ? JSON.stringify(b.plan) : null, rev, nowIso());
  res.json({ ok: true, id: b.id, rev });
});

app.delete('/v1/projects/:id', auth, officeOnly, (req, res) => {
  const r = db.prepare('UPDATE projects SET deleted=1, updated_at=? WHERE org=? AND id=?')
              .run(nowIso(), req.who.org, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE records SET deleted=1, updated_at=? WHERE org=? AND project_id=?')
    .run(nowIso(), req.who.org, req.params.id);
  res.json({ ok: true });
});

// ---- records (forms) ----
app.post('/v1/projects/:id/records', auth, (req, res) => {
  const projectId = req.params.id;
  const p = db.prepare('SELECT id FROM projects WHERE org=? AND id=? AND deleted=0').get(req.who.org, projectId);
  if (!p) return res.status(404).json({ error: 'project not found' });

  const incoming = Array.isArray(req.body && req.body.records) ? req.body.records : null;
  if (!incoming) return res.status(400).json({ error: 'records array is required' });

  const results = [];
  for (const item of incoming) {
    const rec = item && item.record;
    const id = item && item.id;
    if (!id || !rec) { results.push({ id: id || null, status: 'rejected', reason: 'id and record required' }); continue; }

    const stored = db.prepare('SELECT payload, rev FROM records WHERE org=? AND id=?').get(req.who.org, id);
    if (stored && item.baseRev != null && item.baseRev !== stored.rev) {
      results.push({ id, status: 'conflict', rev: stored.rev, record: j(stored.payload) });
      continue;
    }
    const merged = mergeRecord(stored ? j(stored.payload) : null, rec, req.who.role);
    const unknown = merged._unknownMarks;
    delete merged._unknownMarks;
    const rev = stored ? stored.rev + 1 : 1;
    db.prepare(`INSERT INTO records (id, project_id, org, payload, rev, updated_at, updated_by, deleted)
                VALUES (?,?,?,?,?,?,?,0)
                ON CONFLICT(org, id) DO UPDATE SET
                  payload=excluded.payload, rev=excluded.rev,
                  updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted=0`)
      .run(id, projectId, req.who.org, JSON.stringify(merged), rev, nowIso(), req.who.role);
    const out = { id, status: stored ? 'updated' : 'created', rev };
    if (unknown && unknown.length) out.unknownMarks = unknown;
    results.push(out);
  }
  res.json({ results });
});

// ---- delta pull, so a device on a slow connection fetches only what moved ----
app.get('/v1/changes', auth, (req, res) => {
  const since = req.query.since || '1970-01-01T00:00:00.000Z';
  const projects = db.prepare(
    `SELECT id, name, job_no, defaults, plan, rev, updated_at, deleted
       FROM projects WHERE org=? AND updated_at > ? ORDER BY updated_at`).all(req.who.org, since);
  const records = db.prepare(
    `SELECT id, project_id, payload, rev, updated_at, deleted
       FROM records WHERE org=? AND updated_at > ? ORDER BY updated_at`).all(req.who.org, since);
  res.json({
    now: nowIso(),
    projects: projects.map(r => ({ id: r.id, name: r.name, jobNo: r.job_no,
      defaults: j(r.defaults) || {}, plan: j(r.plan), rev: r.rev,
      updatedAt: r.updated_at, deleted: !!r.deleted })),
    records: records.map(r => ({ id: r.id, projectId: r.project_id, rev: r.rev,
      updatedAt: r.updated_at, deleted: !!r.deleted, record: r.deleted ? null : j(r.payload) }))
  });
});

app.use((req, res) => res.status(404).json({ error: 'no such endpoint' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log('strandline-sync listening on ' + PORT));
}
export { app, db };
