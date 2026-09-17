import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/main.js';
import { readLedger, normalizeEntry, serializeLedger, toWatchInput, ledgerIdOf, cadenceSeconds } from '../cli/ledger.js';
import { runCheck, selectEntries, dueEntries, summarize, createPacer } from '../cli/check.js';
import { observationRow, compactionPlan } from '../cli/mirror.js';
import { selectChanged, applyRun, lastCheckedMap } from '../cli/state.js';
import { disagreements, transitions } from '../cli/status.js';
import { verifyLink } from '../src/verifier/index.js';
import { CASES, SOURCE, TARGET } from './fixtures/verifier-cases.js';

const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines = [];
  const code = await main(['init'], { cwd: dir, out: line => lines.push(line), err: () => {} });
  assert.equal(code, 0);
  return { dir, ledger: join(dir, '.agentlinkops/links.jsonl'), observations: join(dir, '.agentlinkops/observations.jsonl') };
}
const run = (dir, argv) => {
  const out = [], err = [];
  return main(argv, { cwd: dir, out: line => out.push(String(line)), err: line => err.push(String(line)) })
    .then(code => ({ code, out: out.join('\n'), err: err.join('\n') }));
};

test('the CLI runs the EXACT cloud verifier, asserted on the shared cases', async () => {
  // Every case here is also asserted against `verifyLink` directly in test/verifier.test.js.
  // A fork would show two green suites while the two answers drifted, which is the failure
  // this arrangement exists to make impossible.
  const entries = CASES.map((scenario, index) => normalizeEntry({
    id: `lk_case${String(index).padStart(4, '0')}`, intent: 'expected',
    source: `https://publisher${index}.com/article`, target: TARGET, scope: scenario.input?.targetScope ?? 'exact',
  }));
  const routes = new Map(CASES.map((scenario, index) => [`https://publisher${index}.com/article`, scenario.html]));
  const fetchImpl = async url => {
    if (new URL(url).pathname === '/robots.txt') return new Response('', { status: 404 });
    const body = routes.get(url);
    assert.ok(body !== undefined, `unexpected request ${url}`);
    return html(body);
  };
  const rows = await runCheck(entries, {
    hostDelayMs: 0,
    verify: (input, options) => verifyLink(input, { ...options, fetchImpl }),
  });
  assert.equal(rows.length, CASES.length);
  rows.forEach((row, index) => {
    const scenario = CASES[index];
    assert.equal(row.state, scenario.expect.state, scenario.name);
    if (scenario.expect.reason) assert.equal(row.reason, scenario.expect.reason, scenario.name);
    if (scenario.expect.occurrences !== undefined) assert.equal(row.occurrences, scenario.expect.occurrences, scenario.name);
    // The mirror row carries the verifier's own result object, which is what makes "the same
    // shape as the cloud" a fact rather than a promise.
    assert.equal(row.result.state, row.state);
    assert.equal(row.result.targetUrl, TARGET);
  });
});

test('the page body never reaches the repository, while the occurrence evidence does', async () => {
  const entry = normalizeEntry({ id: 'lk_htmlguard', intent: 'expected', source: SOURCE, target: TARGET });
  const secret = 'DO-NOT-COMMIT-THIS-PAGE-BODY';
  const fetchImpl = async url => (new URL(url).pathname === '/robots.txt'
    ? new Response('', { status: 404 })
    : html(`<p>${secret}</p>${'<p>filler paragraph.</p>'.repeat(60)}<p>Here: <a href="${TARGET}">Guide</a>.</p>`));
  const [row] = await runCheck([entry], { hostDelayMs: 0, verify: (input, options) => verifyLink(input, { ...options, fetchImpl }) });
  assert.equal(row.state, 'present');

  // A repository is the wrong place for a publisher's bytes, and they are not ours to
  // redistribute. The receipt survives; the document does not.
  assert.equal(JSON.stringify(row).includes(secret), false, 'the page body did not travel');
  assert.equal('html' in row.result, false);
  assert.equal('html' in (row.result.evidence ?? {}), false);
  assert.ok(row.result.evidence.checkerVersion);
  assert.ok(row.result.evidence.sha256, 'the digest is what makes the claim checkable later');

  // What DOES travel is the bounded per-occurrence evidence, because anchor plus surrounding
  // context is the whole proof that a placement exists. Keeping the receipt and dropping the
  // document is the distinction, not keeping nothing.
  assert.equal(row.result.occurrences[0].anchor, 'Guide');
  assert.ok(row.result.occurrences[0].context.includes('Here'));
  assert.ok(row.result.occurrences[0].context.length <= 400);
});

test('an unknown never fails the build, and an expected link observed absent does', async () => {
  const entries = [
    normalizeEntry({ id: 'lk_expect01', intent: 'expected', source: SOURCE, target: TARGET }),
    normalizeEntry({ id: 'lk_wanted01', intent: 'wanted', source: 'https://other.com/a', target: TARGET }),
  ];
  const absent = observationRow('lk_expect01', { state: 'absent', reason: 'no_matching_link_in_complete_html', checkedAt: '2026-09-11T00:00:00.000Z', occurrences: [], evidence: { complete: true, checkerVersion: '1' } });
  const unknown = observationRow('lk_expect01', { state: 'unknown', reason: 'possible_login_wall', checkedAt: '2026-09-11T00:00:00.000Z', occurrences: [], evidence: { complete: false } });
  const appeared = observationRow('lk_wanted01', { state: 'present', reason: 'link_found', checkedAt: '2026-09-11T00:00:00.000Z', occurrences: [{}], evidence: { complete: true } });

  assert.equal(summarize(entries, [unknown, appeared]).exitCode, 0, 'an unknown is not evidence a link is gone');
  assert.equal(summarize(entries, [absent]).exitCode, 1);
  assert.equal(summarize(entries, [appeared]).appeared.length, 1, 'a wanted link turning up is the headline');
  // An absent with INCOMPLETE evidence is not a loss either: the page was not fully read.
  const partial = observationRow('lk_expect01', { state: 'absent', reason: 'incomplete_html', checkedAt: '2026-09-11T00:00:00.000Z', occurrences: [], evidence: { complete: false } });
  assert.equal(summarize(entries, [partial]).exitCode, 0);
});

test('a malformed ledger line is reported with its number and never dropped', async t => {
  const workspaceDir = await workspace(t);
  const bad = [
    JSON.stringify({ id: 'lk_good0001', intent: 'expected', source: SOURCE, target: TARGET }),
    '{not json at all',
    JSON.stringify({ id: 'lk_bad00001', intent: 'nonsense', source: SOURCE, target: TARGET }),
    JSON.stringify({ id: 'lk_good0001', intent: 'wanted', source: 'https://x.com/', target: TARGET }),
  ].join('\n');
  await writeFile(workspaceDir.ledger, `${bad}\n`, 'utf8');
  const { entries, problems } = await readLedger(workspaceDir.ledger);
  assert.equal(entries.length, 1, 'only the valid entry is usable');
  assert.equal(problems.length, 3);
  assert.deepEqual(problems.map(problem => problem.line), [2, 3, 4]);
  assert.match(problems[1].reason, /intent must be one of/u);
  // A duplicate id is an ambiguity, not a preference: which history belongs to which entry
  // stops having an answer, so neither is guessed at.
  assert.match(problems[2].reason, /duplicate id, first seen on line 1/u);
});

test('the ledger maps to a watch, and a corrected URL keeps its history', () => {
  const entry = normalizeEntry({ id: 'lk_map00001', intent: 'expected', source: SOURCE, target: TARGET,
    expect: { anchor: 'guide', rel: ['UGC', 'nofollow'] }, cadence: 'weekly', ref: 'q3/441' });
  const watch = toWatchInput(entry);
  assert.equal(watch.cadenceSeconds, 604_800);
  assert.deepEqual(watch.expectedRel, ['nofollow', 'ugc'], 'tokens lowercase and sorted, as the cloud stores them');
  assert.equal(watch.localReference, 'lk_map00001 q3/441');
  assert.equal(ledgerIdOf(watch.localReference), 'lk_map00001');

  // The cloud deduplicates watches on (source, target, scope), so correcting a typo creates a
  // NEW watch. The ledger id is what makes both answer to one entry, which a content hash of
  // the URLs could never do.
  const corrected = { ...entry, source: 'https://publisher.com/articles' };
  assert.equal(ledgerIdOf(toWatchInput(corrected).localReference), entry.id);

  // A very long customer reference must not push the id out of the 200-character field.
  const long = normalizeEntry({ ...entry, ref: 'r'.repeat(400) });
  assert.equal(toWatchInput(long).localReference.length, 200);
  assert.equal(ledgerIdOf(toWatchInput(long).localReference), entry.id);
  assert.equal(cadenceSeconds('nonsense'), null);
});

test('status proposes a promotion and refuses to make it', async () => {
  const entries = [normalizeEntry({ id: 'lk_pitched1', intent: 'wanted', source: SOURCE, target: TARGET })];
  const rows = [observationRow('lk_pitched1', { state: 'present', reason: 'link_found', checkedAt: '2026-09-14T09:00:00.000Z', occurrences: [{}], evidence: { complete: true } })];
  const found = disagreements(entries, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'appeared');
  // Promotion is a judgement about a relationship, not about HTML, so the tool proposes and a
  // human commits.
  assert.deepEqual(found[0].suggest, { intent: 'expected' });
  assert.equal(entries[0].intent, 'wanted', 'nothing was rewritten');
});

test('a diff shows state changes and never calls a bad afternoon a loss', () => {
  const at = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const rows = [
    observationRow('lk_a0000001', { state: 'present', checkedAt: at(1), occurrences: [{}], evidence: { complete: true } }),
    observationRow('lk_a0000001', { state: 'unknown', reason: 'timeout', checkedAt: at(2), occurrences: [], evidence: {} }),
    observationRow('lk_a0000001', { state: 'present', checkedAt: at(3), occurrences: [{}], evidence: { complete: true } }),
    observationRow('lk_a0000001', { state: 'absent', checkedAt: at(4), occurrences: [], evidence: { complete: true } }),
  ];
  const changes = transitions(rows);
  // present -> unknown -> present is one publisher hiccup, not two events.
  assert.equal(changes.length, 1);
  assert.deepEqual([changes[0].from, changes[0].to], ['present', 'absent']);
});

test('compaction collapses repetition and is never automatic', () => {
  const at = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const rows = Array.from({ length: 12 }, (unused, index) => observationRow('lk_rep00001',
    { state: index < 9 ? 'present' : 'absent', checkedAt: at(index + 1), occurrences: [], evidence: { complete: true } }));
  const plan = compactionPlan(rows);
  assert.ok(plan.dropped.length > 0);
  assert.ok(plan.keep.length < rows.length);
  // The boundary of each run survives, so when it changed is still answerable.
  assert.deepEqual(plan.keep.map(row => row.state), ['present', 'present', 'absent', 'absent']);
  assert.equal(plan.keep.at(0).checked_at, at(1));
  assert.equal(plan.keep.at(-1).checked_at, at(12));
});

test('the pacer waits per host, and honours a longer stated crawl delay', async () => {
  let clock = 0;
  const waits = [];
  const pacer = createPacer({ hostDelayMs: 2000, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; } });
  await pacer.beforeFetch('https://a.com/1');
  await pacer.beforeFetch('https://b.com/1');
  assert.deepEqual(waits, [], 'different hosts do not wait for each other');
  await pacer.beforeFetch('https://a.com/2');
  assert.deepEqual(waits, [2000]);
  // A publisher asking for 30 seconds gets 30, not our two-second floor. Supplying this hook
  // at all is also what stops the verifier refusing such a host outright.
  clock += 2000;
  await pacer.beforeFetch('https://c.com/1', { crawlDelaySeconds: 30 });
  await pacer.beforeFetch('https://c.com/2');
  assert.equal(waits.at(-1), 30_000);
});

test('check is due-driven, so running it twice does not refetch the web', () => {
  const entries = [
    normalizeEntry({ id: 'lk_due00001', intent: 'expected', source: SOURCE, target: TARGET, cadence: 'daily' }),
    normalizeEntry({ id: 'lk_notdue01', intent: 'expected', source: 'https://b.com/', target: TARGET, cadence: 'monthly' }),
    normalizeEntry({ id: 'lk_retired1', intent: 'retired', source: 'https://c.com/', target: TARGET }),
  ];
  const now = Date.parse('2026-09-11T00:00:00.000Z');
  const yesterday = new Date(now - 2 * 86_400_000).toISOString();
  // Due-ness reads `state.json`, not the mirror. The mirror records only CHANGES, so an entry
  // that has been stably present for a month has no recent row — reading the last check time
  // from there would make it look like it had never been checked since the day it appeared.
  const state = applyRun({ v: 1, entries: {} }, [
    observationRow('lk_due00001', { state: 'present', checkedAt: yesterday, occurrences: [], evidence: {} }),
    observationRow('lk_notdue01', { state: 'present', checkedAt: yesterday, occurrences: [], evidence: {} }),
  ]);
  const selected = selectEntries(entries);
  assert.deepEqual(selected.map(entry => entry.id), ['lk_due00001', 'lk_notdue01'], 'retired is kept for its history, never fetched');
  assert.deepEqual(dueEntries(selected, lastCheckedMap(state), { now }).map(entry => entry.id), ['lk_due00001']);
});

test('a repeated answer is activity, not a new observation', () => {
  const at = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const present = day => observationRow('lk_stable01', { state: 'present', reason: 'link_found', checkedAt: at(day), occurrences: [{}], linkSignature: 'sig1', evidence: { complete: true } });
  let state = { v: 1, entries: {} };

  let split = selectChanged([present(1)], state);
  assert.equal(split.changed.length, 1, 'the first observation is always recorded');
  state = applyRun(state, split.changed);

  split = selectChanged([present(2), present(3)], state);
  assert.equal(split.changed.length, 0, 'nothing moved, so nothing is written');
  assert.equal(split.repeated.length, 2);
  state = applyRun(state, [present(2), present(3)]);
  assert.equal(state.entries.lk_stable01.checks, 3, 'every check is counted even when none is recorded');
  assert.equal(state.entries.lk_stable01.last_checked, at(3), 'so "when was this last confirmed" still has an answer');
  assert.equal(state.entries.lk_stable01.first_present, at(1));

  // A link still present whose anchor or rel changed IS an event. Comparing only the state
  // would file it as more of the same.
  const changedAnchor = observationRow('lk_stable01', { state: 'present', reason: 'link_found', checkedAt: at(4), occurrences: [{}], linkSignature: 'sig2', evidence: { complete: true } });
  assert.equal(selectChanged([changedAnchor], state).changed.length, 1);
});

test('init, add, fmt and check work end to end from the command line', async t => {
  const space = await workspace(t);
  let result = await run(space.dir, ['add', '--source', SOURCE, '--target', TARGET, '--intent', 'expected', '--anchor', 'guide', '--ref', 'q3/1']);
  assert.equal(result.code, 0);
  const id = result.out.trim();
  assert.match(id, /^lk_[a-z0-9]+$/u);

  // The same placement twice is a mistake, not a second link.
  result = await run(space.dir, ['add', '--source', SOURCE, '--target', TARGET]);
  assert.equal(result.code, 2);

  const ledger = await readLedger(space.ledger);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].expect.anchor, 'guide');
  assert.equal(serializeLedger(ledger.entries).endsWith('\n'), true);

  result = await run(space.dir, ['fmt']);
  assert.equal(result.code, 0);
  result = await run(space.dir, ['status']);
  assert.match(result.out, /never checked/u);

  // A ledger with nothing due says so rather than silently doing nothing. Due-ness comes from
  // state.json, so a recorded observation alone does not make an entry not-due.
  const row = observationRow(id, { state: 'present', reason: 'link_found', checkedAt: new Date().toISOString(), occurrences: [{}], evidence: { complete: true } });
  await writeFile(space.observations, `${JSON.stringify(row)}\n`, 'utf8');
  await writeFile(join(space.dir, '.agentlinkops/state.json'), `${JSON.stringify(applyRun({ v: 1, entries: {} }, [row]), null, 1)}\n`, 'utf8');
  result = await run(space.dir, ['check']);
  assert.equal(result.code, 0);
  assert.match(result.out, /nothing due/u);

  result = await run(space.dir, ['status']);
  assert.match(result.out, /intent and observations agree/u);
});

test('a command outside a ledger says so instead of inventing one', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'nested'), { recursive: true });
  const result = await run(join(dir, 'nested'), ['check']);
  assert.equal(result.code, 2);
  assert.match(result.err, /agentlinkops init/u);
});
