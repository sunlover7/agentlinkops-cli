// `agentlinkops fleet`: one summary over several project ledgers, each read on its own.
//
// The fleet question is scale ("how much intent does the whole operation hold?"), and the one
// rule that makes the command safe is that it NEVER merges intent across repos. A platform
// that is `expected` for one site and merely `wanted` for another is two entries in two files,
// and a summary that deduplicated them would silently pick one. So every number below is
// per project, the only cross-project arithmetic is a sum of counts, and the output says so.
//
// "Earned" follows the ledger contract, not a status column: an entry is earned when its
// latest OBSERVATION says present. A project with no observation file has earned nothing and
// is reported as never checked rather than as zero links.
import { readLedger } from './ledger.js';
import { readObservations, latestByEntry } from './mirror.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One project's row. Everything is computed inside the project; nothing crosses the boundary. */
export async function fleetProject(name, ledgerPath, observationsPath) {
  const ledger = await readLedger(ledgerPath);
  if (ledger.missing) { const error = new Error(`no ledger at ${ledgerPath}`); error.code = 'NO_LEDGER'; throw error; }
  const byIntent = { wanted: 0, expected: 0, retired: 0 };
  for (const entry of ledger.entries) byIntent[entry.intent] = (byIntent[entry.intent] ?? 0) + 1;

  const { rows } = observationsPath ? await readObservations(observationsPath) : { rows: [] };
  const latest = latestByEntry(rows);
  let earned = 0, observed = 0;
  for (const [id, row] of latest) {
    if (!ledger.entries.some(entry => entry.id === id)) continue; // observations from another ledger's ids
    observed++;
    if (row.state === 'present') earned++;
  }
  const lastCheck = rows.length ? rows.map(row => row.checked_at).sort().at(-1) : null;
  return {
    project: name, ledger: ledgerPath,
    entries: ledger.entries.length, ...byIntent,
    problems: ledger.problems.length,
    observed_entries: observed, earned,
    never_checked: ledger.entries.filter(entry => entry.intent !== 'retired').length - observed,
    last_observation: lastCheck,
    // Due volume, the same arithmetic the dogfood records use to price a fleet.
    implied_weekly_checks: byIntent.wanted + byIntent.expected * 7,
  };
}

/** Summons the fleet. Same numbers per project, one sum of counts, no merged intent. */
export async function fleetSummary(projects, { observationsOf = {} } = {}) {
  const rows = [];
  for (const { name, ledger } of projects) rows.push(await fleetProject(name, ledger, observationsOf[name] ?? null));
  const totals = rows.reduce((acc, row) => {
    for (const key of ['entries', 'wanted', 'expected', 'retired', 'earned', 'observed_entries', 'never_checked', 'implied_weekly_checks']) {
      acc[key] = (acc[key] ?? 0) + row[key];
    }
    return acc;
  }, {});
  return {
    v: 1, projects: rows, totals,
    // The sum answers "how big is the operation". It is not a merged view: the same platform
    // counted in two projects is two intents, and only a human can say which one they meant.
    intent_merged_across_repos: false,
  };
}

export function renderFleet(summary, out = console.log) {
  out(`${plural(summary.projects.length, 'project')}; counts summed for scale only — intent is never merged across repos`);
  out('');
  out('project        entries  wanted  expected  retired  earned  never-checked  last-observation');
  for (const row of summary.projects) {
    out(`${row.project.padEnd(14)} ${String(row.entries).padStart(7)} ${String(row.wanted).padStart(7)} `
      + `${String(row.expected).padStart(9)} ${String(row.retired).padStart(8)} ${String(row.earned).padStart(7)} `
      + `${String(row.never_checked).padStart(13)}  ${row.last_observation?.slice(0, 10) ?? 'never checked'}`);
  }
  const t = summary.totals;
  out(`${'TOTAL'.padEnd(14)} ${String(t.entries).padStart(7)} ${String(t.wanted).padStart(7)} `
    + `${String(t.expected).padStart(9)} ${String(t.retired).padStart(8)} ${String(t.earned).padStart(7)} `
    + `${String(t.never_checked).padStart(13)}  (sum of counts)`);
  out('');
  out(`implied weekly check volume across the fleet: ${t.implied_weekly_checks}`);
  if (summary.projects.some(row => row.problems)) {
    out(`ledger problems: ${summary.projects.map(row => `${row.project}=${row.problems}`).filter(s => !s.endsWith('=0')).join(', ')}`);
  }
  return 0;
}
