// The SQLite CRM as one adapter, not the local surface.
//
// The toolkit's six-table CRM works, is tested, and fits an agency that wants contacts and
// outreach activity in the same place. What it is no longer is the ONLY way to keep links
// locally — the ledger file is — so this reads a CRM into ledger entries and leaves the CRM
// untouched. **Read-only, and no new required schema**: the adapter adapts to what is there.
//
// Adopting an existing CRM is a MIGRATION rather than a discovery import, which is why it is
// `adopt` and not `import`. An import brings in a supplier's index of backlinks the customer has
// not decided about; a CRM holds decisions they already made.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { normalizeEntry } from '../ledger.js';

export class CrmError extends Error {
  constructor(message) { super(message); this.name = 'CrmError'; this.exitCode = 2; }
}

// Words that mean "stop watching this". Everything else keeps the default for its table,
// because `status` in this CRM is free text and refusing every unrecognised value would refuse
// nearly every row. What the adapter does instead is REPORT the statuses it saw.
const RETIRING = new Set(['rejected', 'declined', 'dead', 'lost', 'removed', 'abandoned', 'closed-lost', 'disavowed']);

const idFor = (table, value) => `lk_${createHash('sha256').update(`crm:${table}:${value}`).digest('hex').slice(0, 10)}`;

export function readCrm(path, { defaultScope = 'exact' } = {}) {
  let db;
  try { db = new DatabaseSync(path, { readOnly: true }); }
  catch (error) { throw new CrmError(`could not open ${path}: ${error.message}`); }
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const missing = ['placements', 'opportunities'].filter(name => !tables.has(name));
    if (missing.length === 2) throw new CrmError(`${path} has no placements or opportunities table, so it is not an AgentLinkOps CRM`);

    const entries = [], unmapped = [], statuses = { placement: {}, opportunity: {} };
    const placementSources = new Set();

    const add = (table, row, intent) => {
      try {
        entries.push(normalizeEntry({
          id: idFor(table, row.id), intent,
          source: row.source_url, target: row.target_url, scope: defaultScope,
          ref: `crm/${table}/${row.id}`,
          ...(row.notes ? { note: String(row.notes).slice(0, 200) } : {}),
          added: (row.created_at ?? '').slice(0, 10) || undefined,
        }, { assignId: false }));
      } catch (error) { unmapped.push({ table, id: row.id, reason: error.message }); }
    };

    if (tables.has('placements')) {
      for (const row of db.prepare('SELECT * FROM placements').all()) {
        const status = String(row.status ?? '').trim().toLowerCase();
        statuses.placement[status || '(blank)'] = (statuses.placement[status || '(blank)'] ?? 0) + 1;
        // A placement is a link the customer believes exists, so it is EXPECTED — absence is the
        // alarm. That is the whole difference between the two intents.
        add('placements', row, RETIRING.has(status) ? 'retired' : 'expected');
        if (row.opportunity_id) placementSources.add(row.opportunity_id);
      }
    }
    if (tables.has('opportunities')) {
      for (const row of db.prepare('SELECT * FROM opportunities').all()) {
        // An opportunity that became a placement is superseded by it; carrying both would watch
        // one link twice and report it twice.
        if (placementSources.has(row.id)) continue;
        const status = String(row.status ?? '').trim().toLowerCase();
        statuses.opportunity[status || '(blank)'] = (statuses.opportunity[status || '(blank)'] ?? 0) + 1;
        add('opportunities', row, RETIRING.has(status) ? 'retired' : 'wanted');
      }
    }
    return {
      entries, unmapped, statuses,
      // Named so an operator can see what was ASSUMED active rather than discovering it later.
      assumed_active: {
        placement: Object.keys(statuses.placement).filter(status => !RETIRING.has(status)),
        opportunity: Object.keys(statuses.opportunity).filter(status => !RETIRING.has(status)),
      },
    };
  } finally { db?.close(); }
}
