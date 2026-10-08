import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRun, selectChanged, lastCheckedMap, upgradeState, STATE_VERSION } from '../cli/state.js';
import { observationRow, compactionPlan } from '../cli/mirror.js';
import { placementIdentity, projectPlacement } from '../cli/placement-projection.js';
import { disagreements } from '../cli/status.js';
import { freezeDataset, renderReport, datasetDigest } from '../cli/report.js';
import { fleetSummary } from '../cli/fleet.js';

const entry = { id: 'lk_fresh001', intent: 'expected', source: 'https://publisher.example/a', target: 'https://customer.example/', scope: 'exact', cadence: 'daily' };
const at = minutes => new Date(Date.parse('2026-10-07T00:00:00.000Z') + minutes * 60_000).toISOString();
const row = (state, minutes, changes = {}) => observationRow(entry.id, {
  sourceUrl: entry.source, targetUrl: entry.target, targetScope: entry.scope, state,
  reason: state === 'unknown' ? 'timeout' : state === 'present' ? 'link_found' : state,
  checkedAt: at(minutes), linkSignature: state === 'present' ? 'present-signature' : null,
  occurrences: state === 'present' ? [{ anchor: 'Guide', rel: [], targetUrl: entry.target }] : [],
  evidence: { complete: state !== 'unknown', sha256: String(minutes).padStart(64, '0'), method: 'http_html', checkerVersion: '1' }, ...changes,
});
const empty = () => ({ v: 2, entries: {}, cursors: { events: 'source-cursor', target_events: 'target-cursor' }, future: { keep: true } });

test('the existing frozen v2 report still renders byte-for-byte identically', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report-v2-snapshot.json', import.meta.url), 'utf8'));
  assert.equal(fixture.dataset.v, 2);
  assert.equal(createHash('sha256').update(renderReport(fixture.dataset)).digest('hex'), fixture.html_sha256);
});

test('unchanged success advances activity without manufacturing a retained receipt or change', () => {
  const original = row('present', 0), unchanged = row('present', 50);
  const before = applyRun(empty(), [original]);
  const selected = selectChanged([unchanged], before);
  assert.equal(selected.changed.length, 0);
  assert.equal(selected.repeated.length, 1);
  const state = applyRun(before, [unchanged]);
  const view = projectPlacement(entry, [original], { state });
  assert.equal(view.evidence_observed_at, at(0));
  assert.equal(view.last_successful_observation.checked_at, at(50));
  assert.equal(view.last_link_verification.checked_at, at(50));
  assert.equal(view.last_link_verification.evidence_reference, null, 'an omitted receipt cannot be located');
  assert.equal(view.last_link_verification.content_hash, unchanged.result.evidence.sha256);
  const dataset = freezeDataset([entry], [original], { asOf: '2026-10-07', activityState: state });
  assert.equal(dataset.rows[0].checked_at, at(0));
  assert.equal(dataset.rows[0].evidence.content_hash, original.result.evidence.sha256);
  assert.equal(dataset.rows[0].activity.latest_attempt.checked_at, at(50));
  assert.equal(renderReport(dataset), renderReport(JSON.parse(JSON.stringify(dataset))));
  assert.notEqual(datasetDigest(dataset), datasetDigest(freezeDataset([entry], [original], { asOf: '2026-10-07', activityState: before })));
});

test('blocked attempts retain the last conclusive observation and verified link alongside unknown reason/date', () => {
  const original = row('present', 0), unchanged = row('present', 50);
  for (const reason of ['source_http_403', 'timeout', 'robots_disallowed', 'access_challenge']) {
    const blocked = row('unknown', 100, { reason });
    const state = applyRun(applyRun(empty(), [original, unchanged]), [blocked]);
    const view = projectPlacement(entry, [original, blocked], { state });
    assert.equal(view.current_state, 'present');
    assert.equal(view.uncertain, true);
    assert.equal(view.latest_attempt.reason, reason);
    assert.equal(view.latest_attempt.checked_at, at(100));
    assert.equal(view.last_successful_observation.checked_at, at(50));
    assert.equal(view.last_link_verification.state, 'present');
    const mismatch = disagreements([entry], [original, blocked], { state })[0];
    assert.equal(mismatch.kind, 'cannot_say');
    assert.equal(mismatch.activity.last_link_verification.checked_at, at(50));
    const report = freezeDataset([entry], [original, blocked], { asOf: '2026-10-07', activityState: state });
    assert.equal(report.rows[0].state, 'unknown', 'raw retained receipt is never rewritten');
    assert.equal(report.rows[0].current_state, 'present');
    assert.match(renderReport(report), /latest attempt inconclusive/);
  }
});

test('source unavailable advances conclusive freshness but cannot replace link verification or prove loss', () => {
  const original = row('present', 0), unavailable = row('source_unavailable', 100, { httpStatus: 410 });
  const state = applyRun(empty(), [original, unavailable]);
  const view = projectPlacement(entry, [original, unavailable], { state });
  assert.equal(view.current_state, 'source_unavailable');
  assert.equal(view.last_successful_observation.checked_at, at(100));
  assert.equal(view.last_link_verification.checked_at, at(0));
  assert.equal(disagreements([entry], [original, unavailable], { state })[0].kind, 'cannot_say');
});

test('identity-bound activity without a retained receipt proves a check, without inventing receipt evidence', () => {
  const state = applyRun(empty(), [row('present', 50)]);
  const dataset = freezeDataset([entry], [], { asOf: '2026-10-07', activityState: state });
  assert.equal(dataset.rows[0].state, 'unchecked', 'the raw receipt field remains empty');
  assert.equal(dataset.rows[0].evidence, null);
  assert.equal(dataset.rows[0].current_state, 'present');
  assert.equal(dataset.rows[0].activity.latest_attempt.evidence_reference, null);
  assert.equal(dataset.rows[0].activity.last_link_verification.evidence_reference, null);
  assert.equal(dataset.coverage.checked, 1);
  assert.equal(dataset.coverage.never_checked, 0);
  assert.equal(dataset.coverage.retained_receipt_entries, 0);
  assert.match(renderReport(dataset), /No retained observation/);
});

test('raw local absence stays suspected after repeats; authoritative hosted confirmation survives compaction', () => {
  const first = row('absent', 1), repeated = row('absent', 40);
  const local = applyRun(empty(), [first, repeated]);
  assert.equal(disagreements([entry], [first], { state: local })[0].kind, 'suspected_missing');
  assert.equal(projectPlacement(entry, [first], { state: local }).first_present, null);
  const present = row('present', 0);
  const confirmed = { ...row('absent', 60, { watchState: 'confirmed_missing', checkState: 'absent' }), source: 'cloud' };
  const history = compactionPlan([present, first, confirmed]).keep;
  assert.equal(disagreements([entry], history)[0].kind, 'lost');
  const blocked = row('unknown', 100);
  assert.equal(projectPlacement(entry, [...history, blocked]).current_state, 'confirmed_missing');
  assert.equal(disagreements([entry], [...history, blocked])[0].kind, 'cannot_say');
  assert.equal(disagreements([entry], [...history, row('absent', 110)])[0].kind, 'suspected_missing',
    'a newer independent local absence does not inherit the old hosted confirmation');
  assert.equal(projectPlacement(entry, [...history, row('present', 120)]).current_state, 'present');
});

test('duplicate, out-of-order and invalid timestamps do not regress activity or increment checks', () => {
  const recent = row('present', 50);
  const state = applyRun(empty(), [recent]);
  const retry = [recent, row('unknown', 40), { ...row('absent', 60), checked_at: 'invalid' }];
  assert.deepEqual(applyRun(state, retry), state);
  const selected = selectChanged(retry, state);
  assert.equal(selected.changed.length, 0);
  assert.equal(selected.repeated.length, 0);
  assert.equal(selected.ignored.length, 3);
  assert.deepEqual(state.cursors, empty().cursors);
  assert.deepEqual(state.future, { keep: true });
});

test('equal-time retained receipt selection is deterministic and matches its projected evidence', () => {
  const present = row('present', 50), absent = row('absent', 50, { evidence: present.result.evidence });
  const forward = freezeDataset([entry], [present, absent], { asOf: '2026-10-07' });
  const reverse = freezeDataset([entry], [absent, present], { asOf: '2026-10-07' });
  assert.deepEqual(forward, reverse);
  assert.equal(forward.rows[0].state, forward.rows[0].activity.latest_attempt.state);
  const otherAnchor = structuredClone(present);
  otherAnchor.result.occurrences[0].anchor = 'Different';
  assert.deepEqual(freezeDataset([entry], [present, otherAnchor], { asOf: '2026-10-07' }),
    freezeDataset([entry], [otherAnchor, present], { asOf: '2026-10-07' }));
  const malformed = { id: entry.id, intent: 'expected' };
  assert.equal(projectPlacement(malformed, [{ ...present, result: {} }]).latest_attempt, null);
});

test('source, target and scope corrections cannot inherit activity, presence or cadence from the same ledger id', () => {
  const original = row('present', 0);
  const old = applyRun(empty(), [original]);
  old.entries[entry.id].futureEntry = { keep: true };
  for (const correction of [{ source: 'https://publisher.example/b' }, { target: 'https://customer.example/new' }, { scope: 'domain' }]) {
    const corrected = { ...entry, ...correction };
    assert.equal(lastCheckedMap(old, [corrected]).has(entry.id), false);
    const unbound = projectPlacement(corrected, [original], { state: old });
    assert.equal(unbound.current_state, 'unchecked');
    assert.equal(unbound.first_present, null);
    const blocked = row('unknown', 50, { sourceUrl: corrected.source, targetUrl: corrected.target, targetScope: corrected.scope });
    assert.equal(selectChanged([blocked], old).changed.length, 1);
    const updated = applyRun(old, [blocked]);
    const activity = updated.entries[entry.id];
    assert.equal(activity.last_placement, placementIdentity(corrected));
    assert.equal(activity.first_present, null);
    assert.equal(activity.last_successful_observation, null);
    assert.equal(activity.last_link_verification, null);
    assert.deepEqual(activity.futureEntry, { keep: true });
  }
});

test('legacy migration preserves unknown keys, cursors and truthful missing last-success provenance', () => {
  const original = row('present', 0);
  const legacy = { ...empty(), entries: { [entry.id]: { last_checked: at(100), last_state: 'unknown', last_complete: false, last_placement: placementIdentity(entry), future: 'keep' } } };
  const migrated = upgradeState(legacy);
  assert.equal(migrated.v, STATE_VERSION);
  assert.equal(migrated.entries[entry.id].future, 'keep');
  const view = projectPlacement(entry, [original], { state: migrated });
  assert.equal(view.latest_attempt.checked_at, at(100));
  assert.equal(view.last_successful_observation.checked_at, at(0), 'unretained prior rechecks cannot be reconstructed');
  assert.equal(view.last_successful_observation.method, 'http_html');
  const completeLegacy = structuredClone(migrated);
  Object.assign(completeLegacy.entries[entry.id], { last_state: 'present', last_complete: true });
  const fresh = projectPlacement(entry, [original], { state: completeLegacy });
  assert.equal(fresh.last_successful_observation.checked_at, at(100));
  assert.equal(fresh.last_successful_observation.method, null);
  assert.equal(fresh.last_successful_observation.evidence_reference, null);
});

test('method and completeness changes are retained even when link signature is unchanged', () => {
  const original = row('present', 0);
  const state = applyRun(empty(), [original]);
  const browser = row('present', 50, { evidence: { complete: true, method: 'browser_html', checkerVersion: '1', sha256: 'b'.repeat(64) } });
  assert.equal(selectChanged([browser], state).changed.length, 1);
  const incomplete = row('present', 50, { evidence: { complete: false, method: 'http_html', checkerVersion: '1' } });
  assert.equal(selectChanged([incomplete], state).changed.length, 1);
  assert.equal(projectPlacement(entry, [original], { state: applyRun(state, [incomplete]) }).uncertain, true);
});

test('fleet reads explicit per-project activity and keeps scope/denominators separate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'alo-freshness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = row('present', 0);
  const projects = [], observationsOf = {}, statesOf = {};
  for (const [name, minutes] of [['a', 50], ['b', 90]]) {
    const ledger = join(dir, `${name}-links.jsonl`);
    await writeFile(ledger, JSON.stringify(entry) + '\n' + JSON.stringify({ ...entry, id: 'lk_retired1', intent: 'retired' }) + '\n');
    observationsOf[name] = join(dir, `${name}-observations.jsonl`);
    await writeFile(observationsOf[name], JSON.stringify(original) + '\n' + JSON.stringify({ ...original, id: 'lk_retired1' }) + '\n');
    statesOf[name] = join(dir, `${name}-state.json`);
    await writeFile(statesOf[name], JSON.stringify(applyRun(empty(), [original, row('present', minutes)])));
    projects.push({ name, ledger });
  }
  const summary = await fleetSummary(projects, { observationsOf, statesOf });
  assert.equal(summary.projects[0].last_attempt_at, at(50));
  assert.equal(summary.projects[1].last_attempt_at, at(90));
  assert.equal(summary.projects[0].last_observation, at(0));
  assert.equal(summary.totals.earned, 2);
  assert.equal(summary.totals.never_checked, 0, 'retired history does not make a negative active denominator');
  const noActivity = await fleetSummary(projects, { observationsOf });
  assert.equal(noActivity.projects[0].activity_available, false);
  assert.equal(noActivity.projects[0].coverage.activity_input, 'not_supplied');
});
