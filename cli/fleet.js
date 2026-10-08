// `agentlinkops fleet`: one summary over several project ledgers, each read on its own.
//
// The fleet question is scale ("how much intent does the whole operation hold?"), and the one
// rule that makes the command safe is that it NEVER merges intent across repos. A platform
// that is `expected` for one site and merely `wanted` for another is two entries in two files,
// and a summary that deduplicated them would silently pick one. So every number below is
// per project, the only cross-project arithmetic is a sum of counts, and the output says so.
//
// "Earned" follows known conclusive presence; a later inconclusive attempt is disclosed
// separately. Activity is supplied explicitly per project, never discovered in another repo.
import { readLedger } from './ledger.js';
import { readObservations } from './mirror.js';
import { readState } from './state.js';
import { projectPlacements } from './placement-projection.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One project's row. Everything is computed inside the project; nothing crosses the boundary. */
export async function fleetProject(name, ledgerPath, observationsPath, statePath = null) {
  const ledger = await readLedger(ledgerPath);
  if (ledger.missing) { const error = new Error(`no ledger at ${ledgerPath}`); error.code = 'NO_LEDGER'; throw error; }
  const byIntent = { wanted: 0, expected: 0, retired: 0 };
  for (const entry of ledger.entries) byIntent[entry.intent] = (byIntent[entry.intent] ?? 0) + 1;

  const { rows } = observationsPath ? await readObservations(observationsPath) : { rows: [] };
  const state = statePath ? await readState(statePath) : null;
  const eligible = ledger.entries.filter(entry => entry.intent !== 'retired');
  const projected = projectPlacements(eligible, rows, { state });
  const observed = projected.filter(item => item.latest_attempt).length;
  const earned = projected.filter(item => item.current_state === 'present').length;
  const newest = values => values.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  return {
    project: name, ledger: ledgerPath,
    entries: ledger.entries.length, ...byIntent,
    problems: ledger.problems.length,
    observed_entries: observed, earned,
    never_checked: eligible.length - observed,
    last_observation: newest(projected.map(item => item.evidence_observed_at)),
    last_attempt_at: newest(projected.map(item => item.latest_attempt?.checked_at)),
    last_success_at: newest(projected.map(item => item.last_successful_observation?.checked_at)),
    last_link_verification_at: newest(projected.map(item => item.last_link_verification?.checked_at)),
    uncertain_entries: projected.filter(item => item.uncertain).length,
    activity_available: projected.some(item => item.activity_available),
    activity_entries: projected.filter(item => item.activity_available).length,
    coverage: { denominator: 'non_retired_ledger_entries', eligible_entries: eligible.length,
      identity_unmatched_entries: projected.filter(item => item.identity_status === 'not_matched').length,
      activity_input: statePath ? 'explicit_state_file' : 'not_supplied' },
    // Due volume, the same arithmetic the dogfood records use to price a fleet.
    implied_weekly_checks: byIntent.wanted + byIntent.expected * 7,
  };
}

/** Summons the fleet. Same numbers per project, one sum of counts, no merged intent. */
export async function fleetSummary(projects, { observationsOf = {}, statesOf = {} } = {}) {
  const rows = [];
  for (const { name, ledger } of projects) rows.push(await fleetProject(name, ledger, observationsOf[name] ?? null, statesOf[name] ?? null));
  const totals = rows.reduce((acc, row) => {
    for (const key of ['entries', 'wanted', 'expected', 'retired', 'earned', 'observed_entries', 'never_checked', 'uncertain_entries', 'activity_entries', 'implied_weekly_checks']) {
      acc[key] = (acc[key] ?? 0) + row[key];
    }
    return acc;
  }, {});
  return {
    v: 2, projects: rows, totals,
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
  for (const row of summary.projects) {
    out(`${row.project}: latest attempt ${row.last_attempt_at ?? 'not recorded'}; last conclusive check ${row.last_success_at ?? 'not recorded'}; last link verification ${row.last_link_verification_at ?? 'not recorded'}; activity ${row.activity_available ? `${row.activity_entries} entr(ies)` : 'not available'}; uncertain ${row.uncertain_entries}`);
  }
  if (summary.projects.some(row => row.problems)) {
    out(`ledger problems: ${summary.projects.map(row => `${row.project}=${row.problems}`).filter(s => !s.endsWith('=0')).join(', ')}`);
  }
  return 0;
}
