/* Storage for the sync service. Uses node:sqlite, built into Node 22+, so
   there is no native module to compile on a host. */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export function openDb(file = process.env.STRANDLINE_DB || './strandline.sqlite') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      hash       TEXT PRIMARY KEY,
      org        TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('office','field')),
      label      TEXT,
      created_at TEXT NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT NOT NULL,
      org        TEXT NOT NULL,
      name       TEXT NOT NULL,
      job_no     TEXT,
      defaults   TEXT NOT NULL DEFAULT '{}',
      plan       TEXT,
      rev        INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org, id)
    );
    CREATE TABLE IF NOT EXISTS records (
      id         TEXT NOT NULL,
      project_id TEXT NOT NULL,
      org        TEXT NOT NULL,
      payload    TEXT NOT NULL,
      rev        INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      deleted    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org, id)
    );
    CREATE INDEX IF NOT EXISTS records_project ON records (org, project_id);
    CREATE INDEX IF NOT EXISTS records_updated ON records (org, updated_at);
    CREATE INDEX IF NOT EXISTS projects_updated ON projects (org, updated_at);
  `);
  return db;
}

// Tokens are stored only as hashes, so a copy of the database does not hand
// over working credentials.
export const hashToken = t => createHash('sha256').update(String(t), 'utf8').digest('hex');
export const newToken = () => 'slp_' + randomBytes(24).toString('base64url');

export function authenticate(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT org, role, revoked FROM tokens WHERE hash = ?').get(hashToken(token));
  if (!row || row.revoked) return null;
  return { org: row.org, role: row.role };
}

export function addToken(db, { org, role, label }) {
  const token = newToken();
  db.prepare('INSERT INTO tokens (hash, org, role, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), org, role, label || null, new Date().toISOString());
  return token;
}
