// DP-0069-T02: local migration assessment over the existing verifiers.
//
// The customer supplies an old-to-new URL map and a ledger. This module validates the map,
// joins it to ledger placements, and either plans the work (dry run: no fetch, no check, no
// enrollment) or runs the EXISTING link verifier and target verifier and reports, per affected
// placement, source presence and destination continuity as two independent observations.
//
// What it deliberately does not do:
// - It never rewrites a ledger entry. The original source-to-old-target expectation stays.
// - It never decides equivalence. HTTP success to the mapped URL is route evidence; only the
//   map's recorded decision makes it `continuous`.
// - It does not invent a failure state machine: destination repeats go through the existing
//   `transitionTargetState` reducer, and a mapping mismatch is not a backlink-loss event.
// - It does not enroll watches, call the cloud or edit redirects. Monitoring is DP-0069-T04.
import { readFile } from 'node:fs/promises';
import { verifyLink } from '../src/verifier/index.js';
import { verifyTarget, transitionTargetState } from '../src/verifier/target.js';
import { validatePublicUrl } from '../src/verifier/url.js';
import { createPacer } from './check.js';

export const MIGRATION_REPORT_SCHEMA = 'agentlinkops.migration_report/v1';
export const DISPOSITIONS = Object.freeze(['move', 'merge', 'retire']);
export const EQUIVALENCE_DECISIONS = Object.freeze(['equivalent', 'not_equivalent', 'undecided']);
export const MAX_MAP_ROWS = 5000;

const ISO = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value != null && typeof value === 'object' && !Array.isArray(value);
// Fragments are never sent over HTTP, so two URLs differing only there are one fetch identity.
const fetchKey = href => { const url = new URL(href); url.hash = ''; return url.href; };

export class MigrationMapError extends Error {
  constructor(problems) {
    super(`migration map rejected: ${problems.map(p => `${p.row == null ? 'map' : `row ${p.row}`} ${p.code}`).join('; ')}`);
    this.name = 'MigrationMapError';
    this.problems = problems;
  }
}

/**
 * Resolves one map URL against the declared base, preserving path, query and fragment, and
 * screens it with the same public-destination rules every redirect hop must pass.
 */
function resolveUrl(raw, base) {
  if (!text(raw)) return { error: 'missing_url' };
  let url;
  try { url = new URL(raw); }
  catch {
    if (!base) return { error: 'relative_url_without_base' };
    try { url = new URL(raw, base); } catch { return { error: 'invalid_url' }; }
  }
  const screened = validatePublicUrl(url.href);
  if (!screened.valid) return { error: `non_public_url:${screened.reason}` };
  // validatePublicUrl drops the fragment; keep it as the customer wrote it.
  return { href: url.hash ? `${screened.url}${url.hash}` : screened.url };
}

/**
 * Validates a supplied migration map. Every problem is collected and the whole map is rejected:
 * a partially accepted map would produce a report whose denominator nobody chose.
 */
export function parseMigrationMap(input) {
  const problems = [];
  const fail = (code, row = null, detail) => problems.push({ row, code, ...(detail ? { detail } : {}) });
  if (!plain(input)) throw new MigrationMapError([{ row: null, code: 'map_must_be_object' }]);
  if (typeof input.migration_id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(input.migration_id)) fail('invalid_migration_id');
  if (!Number.isInteger(input.version) || input.version < 1) fail('invalid_version');
  if (input.cutover_at != null && !ISO(input.cutover_at)) fail('invalid_cutover_at');
  if (!plain(input.provenance) || !text(input.provenance.source)) fail('missing_provenance');
  else if (input.provenance.prepared_at != null && !ISO(input.provenance.prepared_at)) fail('invalid_provenance_prepared_at');

  let base = null;
  if (input.base != null) {
    const resolved = resolveUrl(input.base, null);
    if (resolved.error) fail('invalid_base', null, resolved.error); else base = resolved.href;
  }
  const origins = new Set();
  if (!plain(input.site) || !Array.isArray(input.site.origins) || !input.site.origins.length) fail('missing_site_scope');
  else for (const origin of input.site.origins) {
    const resolved = resolveUrl(origin, null);
    if (resolved.error) fail('invalid_site_origin', null, String(origin));
    else origins.add(new URL(resolved.href).origin);
  }
  if (!Array.isArray(input.rows) || !input.rows.length) fail('missing_rows');
  else if (input.rows.length > MAX_MAP_ROWS) fail('too_many_rows', null, `at most ${MAX_MAP_ROWS}`);
  if (problems.length) throw new MigrationMapError(problems);

  const rows = [];
  input.rows.forEach((raw, index) => {
    const n = index + 1;
    const before = problems.length;
    if (!plain(raw)) { fail('row_must_be_object', n); return; }
    const disposition = DISPOSITIONS.includes(raw.disposition) ? raw.disposition : null;
    if (!disposition) fail('invalid_disposition', n);
    const old = resolveUrl(raw.old_url, base);
    if (old.error) fail('invalid_old_url', n, old.error);
    else if (!origins.has(new URL(old.href).origin)) fail('old_url_outside_site_scope', n);
    let next = null;
    if (disposition === 'retire') {
      if (raw.new_url != null) fail('retire_must_not_have_new_url', n);
    } else if (disposition) {
      const resolved = resolveUrl(raw.new_url, base);
      if (resolved.error) fail('invalid_new_url', n, resolved.error);
      else if (!origins.has(new URL(resolved.href).origin)) fail('new_url_outside_site_scope', n);
      else next = resolved.href;
    }
    if (!old.error && next && fetchKey(old.href) === fetchKey(next)) fail('self_mapping', n);
    let equivalence = null;
    if (disposition && disposition !== 'retire') {
      const decision = raw.equivalence?.decision;
      if (!EQUIVALENCE_DECISIONS.includes(decision)) fail('missing_equivalence_decision', n);
      else if (decision !== 'undecided' && !text(raw.equivalence.reason)) fail('equivalence_reason_required', n);
      else equivalence = { decision, reason: raw.equivalence.reason ?? null };
      if (disposition === 'merge' && decision !== 'equivalent') fail('merge_requires_equivalent_decision', n);
    }
    const variants = [];
    if (raw.approved_variants != null && !Array.isArray(raw.approved_variants)) fail('approved_variants_must_be_array', n);
    for (const variant of Array.isArray(raw.approved_variants) ? raw.approved_variants : []) {
      const resolved = plain(variant) ? resolveUrl(variant.url, base) : { error: 'variant_must_be_object' };
      if (resolved.error) fail('invalid_approved_variant', n, resolved.error);
      // A variant is an accepted final URL for the same row, so it stays inside the declared site.
      else if (!origins.has(new URL(resolved.href).origin)) fail('approved_variant_outside_site_scope', n);
      else if (!text(variant.evidence)) fail('approved_variant_requires_evidence', n);
      else variants.push({ url: resolved.href, evidence: variant.evidence });
    }
    if (variants.length && disposition === 'retire') fail('retire_cannot_have_variants', n);
    if (problems.length > before) return;
    rows.push({ row: n, old_url: old.href, new_url: next, disposition, equivalence,
      approved_variants: variants, evidence: raw.evidence ?? null, note: raw.note ?? null });
  });
  if (problems.length) throw new MigrationMapError(problems);

  // Identity checks run over the accepted rows so every collision is named at once.
  const byOld = new Map(), byKey = new Map(), byNew = new Map();
  const content = row => JSON.stringify([row.new_url, row.disposition, row.equivalence, row.approved_variants]);
  for (const row of rows) {
    const exact = byOld.get(row.old_url);
    if (exact) fail(content(exact) === content(row) ? 'duplicate_row' : 'conflicting_row', row.row, `same old_url as row ${exact.row}`);
    else {
      const sibling = byKey.get(fetchKey(row.old_url));
      if (sibling) fail('ambiguous_old_url', row.row, `differs from row ${sibling.row} only by fragment`);
      byOld.set(row.old_url, row);
      byKey.set(fetchKey(row.old_url), row);
    }
    if (row.new_url) {
      const key = fetchKey(row.new_url);
      if (!byNew.has(key)) byNew.set(key, []);
      byNew.get(key).push(row);
    }
  }
  for (const group of byNew.values()) {
    if (group.length < 2) continue;
    // Many-to-one is a merge, and a merge is a documented decision, never an inference.
    for (const row of group) if (row.disposition !== 'merge') fail('undocumented_merge', row.row, `shares new_url with rows ${group.filter(r => r !== row).map(r => r.row).join(', ')}`);
  }
  if (problems.length) throw new MigrationMapError(problems);

  const warnings = [];
  for (const row of rows) {
    if (row.new_url && byKey.has(fetchKey(row.new_url))) warnings.push({ row: row.row, code: 'chained_mapping', detail: `new_url is the old_url of row ${byKey.get(fetchKey(row.new_url)).row}` });
    if (row.new_url && new URL(row.new_url).pathname === '/' && new URL(row.old_url).pathname !== '/') warnings.push({ row: row.row, code: 'homepage_target', detail: 'a homepage redirect does not establish equivalence' });
  }
  return { migration_id: input.migration_id, version: input.version, cutover_at: input.cutover_at ?? null,
    provenance: input.provenance, base, origins: [...origins].sort(), rows, warnings };
}

export async function readMigrationMap(path) {
  let raw;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new MigrationMapError([{ row: null, code: error.code === 'ENOENT' ? 'map_file_missing' : 'map_not_json', detail: error.message }]); }
  return parseMigrationMap(raw);
}

/**
 * Joins the map to ledger placements. Pure: the entries come back by reference to their ids,
 * never modified. `retired` ledger entries are kept for history and not selected.
 */
export function selectAffected(map, entries) {
  const byKey = new Map(map.rows.map(row => [fetchKey(row.old_url), row]));
  const newKeys = new Set(map.rows.filter(row => row.new_url).map(row => fetchKey(row.new_url)));
  const affected = [], unmapped = [];
  let retiredExcluded = 0, onNewUrl = 0, outsideScope = 0;
  const usedRows = new Set();
  for (const entry of entries) {
    let key, origin;
    try { key = fetchKey(entry.target); origin = new URL(entry.target).origin; } catch { continue; }
    if (!map.origins.includes(origin)) { outsideScope++; continue; }
    if (entry.intent === 'retired') { retiredExcluded++; continue; }
    const row = byKey.get(key);
    const identity = { ledger_id: entry.id, intent: entry.intent, group: entry.intent === 'expected' ? 'earned' : 'wanted',
      source: entry.source, original_target: entry.target, scope: entry.scope ?? 'exact' };
    // `expect` rides along for the source check only, so presence is judged exactly as `check` judges it.
    if (row) { usedRows.add(row.row); affected.push({ ...identity, map_row: row.row, row, expect: entry.expect ?? null }); continue; }
    if (newKeys.has(key)) { onNewUrl++; continue; }
    // No row is not a failure: the map simply says nothing about this target.
    unmapped.push(identity);
  }
  return { affected, unmapped, rowsWithoutPlacements: map.rows.filter(row => !usedRows.has(row.row)).map(row => row.row),
    counts: { ledger_entries: entries.length, retired_excluded: retiredExcluded, already_on_new_url: onNewUrl, outside_site_scope: outsideScope } };
}

const sourceSummary = result => ({ state: result.state, reason: result.reason, complete: result.evidence?.complete === true,
  occurrences: result.occurrences?.length ?? 0,
  expectations: result.expectations ?? null, http_status: result.httpStatus ?? null, final_url: result.finalUrl ?? null, checked_at: result.checkedAt });

const destinationSummary = (result, transition) => ({ state: result.state, reason: result.reason,
  complete: result.evidence?.complete === true, http_status: result.httpStatus ?? null, requested_url: result.targetUrl,
  // Exact hops as observed, including partial chains ended by a loop, limit or unsafe hop.
  redirects: (result.redirects ?? []).map(hop => ({ from: hop.from, to: hop.to, status: hop.status })),
  final_url: result.finalUrl ?? null, checked_at: result.checkedAt,
  confirmation: transition ? { state: transition.state, confirmed_state: transition.confirmedState,
    unavailable_count: transition.unavailableCount, next_check_at: transition.nextCheckAt, event: transition.event?.type ?? null } : null });

const REFUSED = /^(?:unsafe_redirect|invalid_target|invalid_redirect|unsafe_robots_redirect|public_fetch_not_configured)/;

/** Destination continuity for one map row, from the target observation alone. */
export function classifyContinuity(row, destination) {
  if (row.disposition === 'retire') return { status: 'intentional_retirement', continuity: 'intentional_retirement' };
  if (destination.state === 'unknown') {
    return REFUSED.test(destination.reason) ? { status: 'refused', continuity: 'refused' } : { status: 'unknown', continuity: 'unknown' };
  }
  if (destination.state === 'unavailable') return { status: 'checked', continuity: 'destination_unavailable' };
  const final = fetchKey(destination.final_url);
  const route = final === fetchKey(row.new_url) ? 'mapped'
    : row.approved_variants.some(variant => fetchKey(variant.url) === final) ? 'approved_variant' : null;
  // A reachable wrong destination is a mismatch even when it returned 200.
  if (!route) return { status: 'checked', continuity: 'mismatch', route: null, redirected: destination.redirects.length > 0 };
  // HTTP reached the mapped route; only the customer's recorded decision makes it equivalent.
  // A recorded `not_equivalent` is the customer's decision and is reported as such, not as "unconfirmed".
  const decision = row.equivalence?.decision;
  return { status: 'checked', route, continuity: decision === 'equivalent' ? 'continuous'
    : decision === 'not_equivalent' ? 'route_matched_not_equivalent' : 'route_matched_equivalence_unconfirmed' };
}

function coverage(map, selection, rows) {
  const tally = {};
  for (const row of rows) tally[row.status] = (tally[row.status] ?? 0) + 1;
  return { denominator: 'supplied map rows and ledger entries only', map_rows: map.rows.length,
    map_rows_without_placements: selection.rowsWithoutPlacements.length, ...selection.counts,
    affected_placements: selection.affected.length, unmapped_placements: selection.unmapped.length,
    earned: rows.filter(row => row.group === 'earned').length, wanted: rows.filter(row => row.group === 'wanted').length,
    by_status: tally };
}

function header(map, mode, generatedAt) {
  return { schema: MIGRATION_REPORT_SCHEMA, mode, generated_at: generatedAt, migration_id: map.migration_id,
    map_version: map.version, cutover_at: map.cutover_at, provenance: map.provenance, warnings: map.warnings,
    boundary: 'Technical continuity only. No ranking, PageRank, index transfer or traffic claim. No watch was created.' };
}

const rowBase = item => ({ ledger_id: item.ledger_id, group: item.group, intent: item.intent, source: item.source,
  original_target: item.original_target, scope: item.scope, expected_target: item.row.new_url, disposition: item.row.disposition,
  map_row: item.map_row, equivalence: item.row.equivalence });

/**
 * Dry run. Accepts the supplied inputs and reports what a checked run would do, with no fetch,
 * no check consumed and no enrollment. It takes no transport on purpose.
 */
export function planMigration(map, entries, { now = new Date().toISOString() } = {}) {
  const selection = selectAffected(map, entries);
  const rows = selection.affected.map(item => ({ ...rowBase(item),
    status: item.row.disposition === 'retire' ? 'intentional_retirement' : 'unattempted' }));
  for (const item of selection.unmapped) rows.push({ ...item, expected_target: null, map_row: null, status: 'unmapped' });
  const destinations = new Set(selection.affected.map(item => fetchKey(item.row.old_url)));
  return { ...header(map, 'dry_run', now), network: false,
    planned: { source_checks: selection.affected.length, destination_checks: destinations.size, enrollments: 0 },
    coverage: coverage(map, selection, rows), rows };
}

/**
 * Checked run. Source presence uses `verifyLink` against the ORIGINAL target; destination uses
 * `verifyTarget` on the old URL, once per distinct old URL. Both use the public-fetch boundary
 * and the same pacing as `agentlinkops check`. `priorTargetStates` (old URL -> reducer state)
 * lets repeated observations reuse the existing confirmation rules; the next states come back
 * in `target_states` for the caller to keep locally.
 */
export async function assessMigration(map, entries, {
  now = () => new Date().toISOString(), timeoutMs = 20_000, hostDelayMs = 2000, fetchImpl,
  verify = verifyLink, verifyDestination = verifyTarget, pacer = null, priorTargetStates = {},
} = {}) {
  const selection = selectAffected(map, entries);
  const paced = pacer ?? createPacer({ hostDelayMs });
  const common = { publicFetchSafe: true, timeoutMs, includeHtml: false, beforeFetch: paced.beforeFetch,
    ...(fetchImpl ? { fetchImpl } : {}) };
  const destinations = new Map(), targetStates = {};
  for (const item of selection.affected) {
    const key = fetchKey(item.row.old_url);
    if (destinations.has(key)) continue;
    const result = await verifyDestination({ targetUrl: item.row.old_url }, { ...common, now: now() });
    const transition = transitionTargetState(priorTargetStates[key] ?? null, result, result.checkedAt);
    targetStates[key] = transition;
    destinations.set(key, destinationSummary(result, transition));
  }
  const rows = [];
  for (const item of selection.affected) {
    const destination = destinations.get(fetchKey(item.row.old_url));
    const source = await verify({ sourceUrl: item.source, targetUrl: item.original_target, targetScope: item.scope,
      expectedAnchor: item.expect?.anchor, expectedRel: item.expect?.rel }, { ...common, now: now() });
    rows.push({ ...rowBase(item), ...classifyContinuity(item.row, destination), source_presence: sourceSummary(source), destination });
  }
  for (const item of selection.unmapped) rows.push({ ...item, expected_target: null, map_row: null, status: 'unmapped' });
  const generatedAt = now();
  const failures = rows.filter(row => ['mismatch', 'destination_unavailable'].includes(row.continuity));
  return { ...header(map, 'checked', generatedAt), network: true, coverage: coverage(map, selection, rows), rows,
    target_states: targetStates,
    // A mapping mismatch or failed destination is not a backlink-loss event; loss stays with `check`.
    loss_events: [], exitCode: failures.length ? 1 : 0 };
}
