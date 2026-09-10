/* Field-scoped merge.
 *
 * The office and the crew write to the same record but never to the same
 * facts. The office owns the schedule and the equipment setup; the crew owns
 * what was measured. Splitting ownership means:
 *
 *   - A revised elongation can be pushed from the office without wiping
 *     measurements the crew has already recorded.
 *   - A field device cannot alter the calculated elongation its own work is
 *     judged against, even by accident or by pushing a stale copy.
 *
 * That second property is the reason this is enforced on the server rather
 * than trusted to the client.
 */

// Written by the office: the schedule, the equipment, the acceptance criteria.
export const OFFICE_RECORD_FIELDS = [
  'recName', 'company', 'job', 'jobNo', 'gc', 'bldg', 'pour', 'level', 'ptSupplier',
  'shopDwg', 'eor', 'dia', 'aps', 'fpu', 'eps', 'jackPct', 'ramArea', 'calPct',
  'ramId', 'gaugeId', 'calDate', 'calExp', 'fciReq', 'frictionPct',
  'tolInd', 'tolGrp', 'loMin', 'loMax', 'lenMode', 'den', 'paper',
  'emailTo', 'emailCc'
];

// Written by the crew in the field.
export const FIELD_RECORD_FIELDS = [
  'dateStressed', 'stressedBy', 'fciActual', 'cylNo', 'witnessedBy', 'superintendent'
];

// Per-tendon split. Anything not listed as a field entry belongs to the office.
export const FIELD_TENDON_FIELDS = ['apsi', 'mka', 'mkb', 'seat', 'lopsi', 'notes', 'accepted'];
export const OFFICE_TENDON_FIELDS = ['mark', 'loc', 'grp', 'strands', 'len', 'calc', 'anchor', 'est'];

const pick = (src, keys) => {
  const o = {};
  for (const k of keys) if (src && Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k];
  return o;
};

/* Merge an incoming record onto the stored one according to who is pushing.
   `stored` may be null for a new record. */
export function mergeRecord(stored, incoming, role) {
  if (!stored) {
    // Nothing to protect yet. A field client creating a record is unusual but
    // legitimate - a crew adding a pour that the office has not entered.
    return JSON.parse(JSON.stringify(incoming));
  }
  const base = JSON.parse(JSON.stringify(stored));
  const inc = incoming || {};

  if (role === 'office') {
    Object.assign(base, pick(inc, OFFICE_RECORD_FIELDS));
  } else {
    Object.assign(base, pick(inc, FIELD_RECORD_FIELDS));
  }

  const storedT = Array.isArray(base.tendons) ? base.tendons : [];
  const incT = Array.isArray(inc.tendons) ? inc.tendons : [];

  if (role === 'office') {
    // The office defines which tendons exist. Field entries are carried over
    // by mark so a re-issued schedule does not discard recorded work.
    const byMark = new Map();
    storedT.forEach(t => { if (t && t.mark != null) byMark.set(String(t.mark), t); });
    base.tendons = incT.map(t => {
      const prev = byMark.get(String(t && t.mark));
      const merged = Object.assign({}, t);
      if (prev) Object.assign(merged, pick(prev, FIELD_TENDON_FIELDS));
      return merged;
    });
  } else {
    // The crew may only fill in entries against tendons that already exist.
    // An unknown mark is reported rather than silently added, because a tendon
    // the schedule does not contain is a discrepancy someone must resolve.
    const byMark = new Map();
    incT.forEach(t => { if (t && t.mark != null) byMark.set(String(t.mark), t); });
    const unknown = [];
    base.tendons = storedT.map(t => {
      const inT = byMark.get(String(t && t.mark));
      if (!inT) return t;
      byMark.delete(String(t.mark));
      return Object.assign({}, t, pick(inT, FIELD_TENDON_FIELDS));
    });
    for (const leftover of byMark.keys()) unknown.push(leftover);
    if (unknown.length) base._unknownMarks = unknown;
  }
  return base;
}

/* What a client is told when its push is out of date. */
export function conflict(stored, storedRev) {
  return { error: 'conflict', rev: storedRev, record: stored };
}
