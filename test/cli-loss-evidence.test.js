import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/main.js';
import { normalizeEntry, serializeLedger } from '../cli/ledger.js';
import { observationRow, readObservations, writeObservations } from '../cli/mirror.js';
import { disagreements, transitions } from '../cli/status.js';
import { summarize } from '../cli/check.js';
import { CASES, SOURCE, TARGET } from './fixtures/verifier-cases.js';
import { eventSnapshot } from '../shared/observation-event.js';
import { cloudObservationRows } from '../cli/sync.js';
import { localCheck } from '../cli/local-result.js';
import { verifyLink } from '../src/verifier/index.js';

const entry = normalizeEntry({ id: 'lk_evidence01', intent: 'expected', source: SOURCE, target: TARGET });
const timestamp = index => new Date(Date.UTC(2026, 8, 30, 0, index)).toISOString();
function observation(state, complete = true, index = 0, source = 'local') {
  return observationRow(entry.id, { state, checkedAt: timestamp(index), reason: `fixture_${state}`,
    occurrences: state === 'present' ? [{}] : [], evidence: { complete, checkerVersion: 'fixture_v1' } }, { source });
}
function hosted(state, uncertain = false) {
  const snapshot = eventSnapshot({ state, uncertain, watch_id: 'wat_loss_fixture', source_url: SOURCE,
    target_url: TARGET, target_scope: 'exact', checked_at: timestamp(0),
    latestAttempt: { state: 'absent', reason: 'no_matching_link_in_complete_html', occurrences: [],
      evidence: { complete: true, checkerVersion: 'fixture_v1', sha256: 'a'.repeat(64), method: 'http_html' } } });
  return cloudObservationRows([{ watch_id: 'wat_loss_fixture', type: 'watch.checked', data: { after: snapshot } }],
    new Map([['wat_loss_fixture', entry.id]]))[0];
}
async function invoke(dir, argv, fetchImpl = async () => { throw Error('Unexpected fixture network request'); }) {
  const out = [], err = [];
  const code = await main(argv, { cwd: dir, env: {}, fetchImpl,
    out: line => out.push(String(line)), err: line => err.push(String(line)) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
async function workspace(t, rows = []) {
  const dir = await mkdtemp(join(tmpdir(), 'agentlinkops-loss-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await invoke(dir, ['init'])).code, 0);
  const ledger = join(dir, '.agentlinkops', 'links.jsonl'), mirror = join(dir, '.agentlinkops', 'observations.jsonl');
  await writeFile(ledger, serializeLedger([entry]), 'utf8');
  await writeObservations(mirror, rows);
  return { dir, ledger, mirror };
}
async function bytes(dir) {
  const result = {};
  async function visit(path, prefix = '') {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name, absolute = join(path, item.name);
      if (item.isDirectory()) await visit(absolute, `${name}/`);
      else result[name] = (await readFile(absolute)).toString('base64');
    }
  }
  await visit(dir); return result;
}

test('expected-link status separates complete absence and suspicion from explicit complete confirmation', () => {
  for (const [state, expected] of [['absent', 'suspected_missing'], ['suspected_missing', 'suspected_missing'], ['confirmed_missing', 'lost']]) {
    const row = observation(state), found = disagreements([entry], [row]);
    assert.equal(found.length, 1); assert.equal(found[0].kind, expected); assert.equal(found[0].row, row);
    assert.equal(row.state, state); assert.equal(row.result.state, state);
  }
});

test('incomplete missing evidence and unavailable or unknown source produce cannot-say, never loss', () => {
  for (const state of ['absent', 'suspected_missing', 'confirmed_missing']) {
    const found = disagreements([entry], [observation(state, false)]);
    assert.equal(found.length, 1, state); assert.equal(found[0].kind, 'cannot_say', state);
  }
  for (const state of ['source_unavailable', 'unknown']) for (const complete of [false, true])
    assert.equal(disagreements([entry], [observation(state, complete)])[0].kind, 'cannot_say');
  for (const complete of ['true', 1, null, undefined])
    assert.equal(disagreements([entry], [{ ...observation('confirmed_missing'), complete }])[0].kind, 'cannot_say');
});

test('retained local changes and repeated absence cannot synthesize hosted confirmation', () => {
  const changes = ['present', 'absent', 'present', 'absent'].map((state, index) => observation(state, true, index));
  const repeated = [...changes, observation('absent', true, 4), observation('absent', true, 5)];
  for (const rows of [changes, repeated, [changes[0], changes[3]], [...changes].reverse()]) {
    const found = disagreements([entry], rows);
    assert.equal(found.length, 1); assert.equal(found[0].kind, 'suspected_missing');
    assert.equal(found[0].row.state, 'absent');
  }
  const oldConfirmation = observation('confirmed_missing', true, 0, 'cloud');
  assert.equal(disagreements([entry], [oldConfirmation, observation('absent', true, 6)])[0].kind, 'suspected_missing');
});

test('real local status JSON and human output report suspected missing and leave all workspace bytes unchanged', async t => {
  const f = await workspace(t, [observation('present', true, 0), observation('absent', true, 1)]);
  const before = await bytes(f.dir);
  const json = await invoke(f.dir, ['status', '--json']);
  assert.equal(json.code, 0); assert.equal(json.err, '');
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.length, 1); assert.equal(parsed[0].kind, 'suspected_missing');
  assert.equal(parsed[0].row.state, 'absent'); assert.equal(parsed[0].row.complete, true);
  const human = await invoke(f.dir, ['status']);
  assert.equal(human.code, 0); assert.match(human.out, /suspected missing \(1\)/);
  assert.doesNotMatch(human.out, /\bLOST\b/); assert.match(human.out, /lk_evidence01/);
  assert.deepEqual(await bytes(f.dir), before);
});

test('real status retains hosted confirmed-missing evidence but refuses incomplete confirmation', async t => {
  const f = await workspace(t, [observation('confirmed_missing', true, 0, 'cloud')]);
  const confirmed = await invoke(f.dir, ['status', '--json']);
  assert.equal(JSON.parse(confirmed.out)[0].kind, 'lost');
  assert.match((await invoke(f.dir, ['status'])).out, /\bLOST \(1\)/);
  await writeObservations(f.mirror, [observation('confirmed_missing', false, 1, 'cloud')]);
  const before = await bytes(f.dir), incomplete = await invoke(f.dir, ['status', '--json']);
  assert.equal(JSON.parse(incomplete.out)[0].kind, 'cannot_say');
  const human = await invoke(f.dir, ['status']);
  assert.match(human.out, /cannot say \(1\)/); assert.doesNotMatch(human.out, /\bLOST\b/);
  assert.deepEqual(await bytes(f.dir), before);
});

test('real diff retains raw present-to-absent transition without replacing it with loss', async t => {
  const rows = [observation('present', true, 0), observation('absent', true, 1)];
  assert.deepEqual(transitions(rows).map(row => [row.from, row.to]), [['present', 'absent']]);
  const f = await workspace(t, rows), before = await bytes(f.dir);
  const json = await invoke(f.dir, ['diff', '--json']), change = JSON.parse(json.out)[0];
  assert.equal(change.from, 'present'); assert.equal(change.to, 'absent'); assert.equal(change.row.result.state, 'absent');
  const human = await invoke(f.dir, ['diff']);
  assert.match(human.out, /present -> absent/); assert.doesNotMatch(human.out, /\bLOST\b|confirmed_missing/);
  assert.deepEqual(await bytes(f.dir), before);
});

test('real human check labels complete raw absence ABSENT and retains verifier evidence and exit one', async t => {
  const f = await workspace(t);
  const scenario = CASES.find(row => row.name === 'a page that simply does not link to the target is absent');
  let requests = 0;
  const fetchImpl = async url => {
    requests++;
    const parsed = new URL(url); assert.equal(parsed.hostname, 'publisher.com');
    if (parsed.pathname === '/robots.txt') return new Response('', { status: 404 });
    assert.equal(String(url), SOURCE);
    return new Response(scenario.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const result = await invoke(f.dir, ['check', '--all', '--host-delay', '0', '--concurrency', '1'], fetchImpl);
  assert.equal(result.code, 1); assert.match(result.out, /^ABSENT\s+lk_evidence01/m);
  assert.doesNotMatch(result.out, /\bLOST\b/); assert.ok(requests > 0);
  const mirror = await readObservations(f.mirror);
  assert.equal(mirror.problems.length, 0); assert.equal(mirror.rows.length, 1);
  const row = mirror.rows[0];
  assert.equal(row.state, 'absent'); assert.equal(row.result.state, 'absent'); assert.equal(row.complete, true);
  assert.equal(row.reason, 'no_matching_link_in_complete_html'); assert.ok(row.result.evidence.sha256);
  assert.equal(summarize([entry], [row]).exitCode, 1);
  assert.equal(disagreements([entry], [row])[0].kind, 'suspected_missing');
});

test('appearance, agreement and never-checked controls remain distinct from missing evidence', () => {
  const wanted = { ...entry, intent: 'wanted' };
  assert.equal(disagreements([wanted], [observation('present')])[0].kind, 'appeared');
  assert.deepEqual(disagreements([wanted], [observation('absent')]), []);
  assert.deepEqual(disagreements([entry], [observation('present')]), []);
  assert.equal(disagreements([entry], [])[0].kind, 'never_checked');
});

test('actual hosted snapshot normalization preserves confirmed watch state through raw absence to real status', async t => {
  const row = hosted('confirmed_missing');
  assert.equal(row.source, 'cloud'); assert.equal(row.state, 'absent'); assert.equal(row.complete, true);
  assert.equal(row.result.watchState, 'confirmed_missing'); assert.equal(row.result.checkState, 'absent');
  assert.equal(disagreements([entry], [row])[0].kind, 'lost');
  const f = await workspace(t, [row]), before = await bytes(f.dir);
  const status = await invoke(f.dir, ['status', '--json']), human = await invoke(f.dir, ['status']);
  const found = JSON.parse(status.out)[0];
  assert.equal(found.kind, 'lost'); assert.equal(found.row.state, 'absent');
  assert.equal(found.row.result.watchState, 'confirmed_missing'); assert.match(human.out, /\bLOST \(1\)/);
  assert.deepEqual(await bytes(f.dir), before);
});

test('hosted uncertain confirmation stays cannot-say and complete provisional snapshot stays suspected', async t => {
  const f = await workspace(t);
  for (const [state, uncertain, expected, label] of [
    ['confirmed_missing', true, 'cannot_say', 'cannot say'],
    ['suspected_missing', true, 'cannot_say', 'cannot say'],
    ['suspected_missing', false, 'suspected_missing', 'suspected missing'],
  ]) {
    const row = hosted(state, uncertain);
    assert.equal(row.state, 'unknown'); assert.equal(row.complete, !uncertain);
    assert.equal(row.result.watchState, state); assert.equal(row.result.checkState, 'absent');
    assert.equal(disagreements([entry], [row])[0].kind, expected);
    await writeObservations(f.mirror, [row]); const before = await bytes(f.dir);
    assert.equal(JSON.parse((await invoke(f.dir, ['status', '--json'])).out)[0].kind, expected);
    const human = await invoke(f.dir, ['status']);
    assert.ok(human.out.includes(`${label} (1)`)); assert.doesNotMatch(human.out, /\bLOST\b/);
    assert.deepEqual(await bytes(f.dir), before);
  }
});

test('local raw evidence cannot gain confirmed loss from a forged hosted watch-state field', () => {
  const absent = observation('absent'); absent.result.watchState = 'confirmed_missing'; absent.result.checkState = 'absent';
  assert.equal(disagreements([entry], [absent])[0].kind, 'suspected_missing');
  const unknown = observation('unknown'); unknown.result.watchState = 'confirmed_missing'; unknown.result.checkState = 'absent';
  assert.equal(disagreements([entry], [unknown])[0].kind, 'cannot_say');
  unknown.result.watchState = 'suspected_missing';
  assert.equal(disagreements([entry], [unknown])[0].kind, 'cannot_say');
});

test('actual local-result adoption preserves raw absence for status and report without a loss claim', async t => {
  const f = await workspace(t);
  const scenario = CASES.find(row => row.name === 'a page that simply does not link to the target is absent');
  const fetchImpl = async url => new URL(url).pathname === '/robots.txt' ? new Response('', { status: 404 })
    : new Response(scenario.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const result = await localCheck({ source: SOURCE, target: TARGET, scope: 'exact' }, {
    hostDelayMs: 0, verify: (input, options) => verifyLink(input, { ...options, fetchImpl, now: timestamp(0) }) });
  const path = join(f.dir, 'local-result.json'); await writeFile(path, JSON.stringify(result), 'utf8');
  const adopted = await invoke(f.dir, ['adopt-result', path, '--intent=expected']);
  assert.equal(adopted.code, 0, adopted.err); assert.equal(JSON.parse(adopted.out).ledger_id, entry.id);
  const mirror = await readObservations(f.mirror);
  assert.equal(mirror.rows.length, 1); assert.equal(mirror.rows[0].state, 'absent');
  assert.deepEqual(mirror.rows[0].result, result.observation);
  const before = await bytes(f.dir), status = await invoke(f.dir, ['status', '--json']);
  assert.equal(JSON.parse(status.out)[0].kind, 'suspected_missing');
  const report = await invoke(f.dir, ['report', '--as-of=2026-09-30']);
  assert.equal(report.code, 0); assert.match(report.out, /Not found/); assert.doesNotMatch(report.out, /\bLOST\b|Confirmed missing/);
  const receipt = await invoke(f.dir, ['report', '--json', '--as-of=2026-09-30']);
  assert.equal(JSON.parse(receipt.out).rows[0].state, 'absent');
  assert.deepEqual(await bytes(f.dir), before);
});
