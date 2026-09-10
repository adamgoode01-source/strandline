#!/usr/bin/env node
/* Token administration. Tokens are shown once and stored only as a hash, so
   there is no way to recover one later - issue a new token instead.

     node admin.mjs add-token --org "JC Concrete, LLC" --role office --label "office pc"
     node admin.mjs list
     node admin.mjs revoke <token>
*/
import { openDb, addToken, hashToken } from './db.mjs';

const db = openDb();
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = n => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv[i + 1]; };

if (cmd === 'add-token') {
  const org = flag('org'), role = flag('role') || 'field', label = flag('label');
  if (!org) { console.error('--org is required'); process.exit(1); }
  if (!['office', 'field'].includes(role)) { console.error('--role must be office or field'); process.exit(1); }
  const t = addToken(db, { org, role, label });
  console.log('');
  console.log('  org:   ' + org);
  console.log('  role:  ' + role);
  console.log('  token: ' + t);
  console.log('');
  console.log('  Copy it now. Only a hash is stored, so it cannot be shown again.');
  if (role === 'office') console.log('  An office token can rewrite schedules. Keep it off field devices.');
} else if (cmd === 'list') {
  const rows = db.prepare('SELECT org, role, label, created_at, revoked FROM tokens ORDER BY created_at').all();
  if (!rows.length) console.log('no tokens yet');
  rows.forEach(r => console.log('  ' + r.org.padEnd(24) + r.role.padEnd(8) +
    (r.label || '').padEnd(16) + r.created_at.slice(0, 10) + (r.revoked ? '  REVOKED' : '')));
} else if (cmd === 'revoke') {
  const t = argv[1];
  if (!t) { console.error('usage: node admin.mjs revoke <token>'); process.exit(1); }
  const r = db.prepare('UPDATE tokens SET revoked=1 WHERE hash=?').run(hashToken(t));
  console.log(r.changes ? 'revoked' : 'no such token');
} else {
  console.log('commands: add-token --org <name> --role office|field [--label x]');
  console.log('          list');
  console.log('          revoke <token>');
}
