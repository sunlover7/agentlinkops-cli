import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Only advisory acquisition is doubled in the module-mock lane. Ordinary package
// tests use the actual native binding. This file exercises the CLI and its files;
// supplied HTTP replies remain an offline fixture, not a hosted soak or billing proof.
if (typeof mock.module === 'function') mock.module('../cli/native-lock.js', {
  namedExports: {nativeLock: async () => ({acquire: () => true})},
});
const {main} = await import('../cli/main.js');

const COUNT = 2003;
const ORIGIN = 'https://large-sync.fixture.invalid';
const PROJECT = 'pr_large_fixture';
const localId = n => `lk_large${String(n).padStart(7, '0')}`;
const watchId = id => `wat_${id}`;
const RETIRED = 'lk_retired000001';
const authoredEntry = n => ({
  id: localId(n), intent: 'expected', source: `https://publisher.fixture.invalid/${n}`,
  target: 'https://customer.fixture.invalid/guide', scope: 'exact', cadence: 'weekly',
  ref: `external/row/${n}`, note: `private note ${n}`, tags: ['customer-tag'],
  customer: {originalRow: n, retain: true},
});

async function ledgerFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'alo-large-sync-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const dir = join(cwd, '.agentlinkops');
  await mkdir(dir, {mode: 0o700});
  const entries = Array.from({length: COUNT}, (_, n) => authoredEntry(n));
  const wanted = Array.from({length: 3}, (_, n) => ({
    ...authoredEntry(COUNT + n), id: `lk_wanted${String(n).padStart(7, '0')}`, intent: 'wanted',
  }));
  const retired = {...authoredEntry(COUNT + 3), id: RETIRED, intent: 'retired'};
  const ledger = [...entries, ...wanted, retired].map(row => JSON.stringify(row)).join('\n') + '\n';
  const config = JSON.stringify({project: {id: PROJECT}, cloud: {origin: ORIGIN, token: 'offline-fixture'}});
  const state = {
    v: 2, entries: {}, watches: {[RETIRED]: 'wat_retired', lk_preserved0001: 'wat_preserved'},
    cursors: {events: 'old-source', target_events: 'old-target'},
    customerCheckpoint: {externalRevision: 42, notes: 'retain original state'},
  };
  const stateBytes = JSON.stringify(state) + '\n';
  await writeFile(join(dir, 'links.jsonl'), ledger);
  await writeFile(join(dir, 'config.json'), config);
  await writeFile(join(dir, 'state.json'), stateBytes);
  return {cwd, dir, entries, wanted, ledger, config, state, stateBytes};
}

function requestLog(url, init, calls) {
  const parsed = new URL(url);
  assert.equal(parsed.origin, ORIGIN, 'Every request stays inside the injected fixture');
  const row = {
    method: init.method, path: parsed.pathname, cursor: parsed.searchParams.get('cursor'),
    project: parsed.searchParams.get('projectId'), body: init.body ? JSON.parse(init.body) : null,
  };
  calls.push(row);
  return row;
}

async function unchangedAuthored(f) {
  assert.equal(await readFile(join(f.dir, 'links.jsonl'), 'utf8'), f.ledger);
  assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), f.config);
}

test('actual CLI persists all acknowledged positions of a 2,003-row upload across reordered chunks and row refusals', async t => {
  const f = await ledgerFixture(t), calls = [], output = [], errors = [];
  const rejected = new Set([localId(137), localId(COUNT - 1)]);
  const existing = new Set([localId(0), localId(1700)]);
  const supplied = new Set();
  const fetchImpl = async (url, init) => {
    const request = requestLog(url, init, calls);
    if (request.method === 'PATCH') {
      assert.equal(request.path, '/v1/watches/wat_retired');
      assert.deepEqual(request.body, {status: 'paused'});
      return Response.json({id: 'wat_retired', status: 'paused'});
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/watches/import');
    assert.equal(request.body.projectId, PROJECT);
    const rows = request.body.watches.map((watch, index) => {
      const id = watch.localReference.split(' ')[0];
      assert.equal(supplied.has(id), false, 'An input position is submitted only once');
      supplied.add(id);
      assert.ok(!JSON.stringify(watch).includes('private note'));
      assert.ok(!JSON.stringify(watch).includes('customer-tag'));
      if (rejected.has(id)) return {index, error: {code: 'WATCH_LIMIT_REACHED', message: 'No remaining watch capacity.'}};
      return {index, watch: {id: watchId(id), created: !existing.has(id)}};
    }).reverse();
    return Response.json({status: rows.some(row => row.error) ? 'partial' : 'succeeded', rows});
  };
  assert.equal(await main(['sync', '--push-only'], {cwd: f.cwd, env: {}, fetchImpl,
    out: value => output.push(value), err: value => errors.push(value)}), 2);
  assert.deepEqual(errors, []);
  assert.equal(output[0], 'pushed 2003 (1999 new, 1 retired, 3 kept local)');
  assert.ok(output.some(line => line.includes(`${localId(137)}: WATCH_LIMIT_REACHED`)));
  assert.ok(output.some(line => line.includes(`${localId(COUNT - 1)}: WATCH_LIMIT_REACHED`)));
  const uploads = calls.filter(row => row.method === 'POST');
  assert.deepEqual(uploads.map(row => row.body.watches.length), [...Array(20).fill(100), 3]);
  assert.equal(supplied.size, COUNT);
  assert.equal(calls.length, 22, 'The only other request deliberately pauses the retired watch');
  assert.equal(calls.at(-1).method, 'PATCH');
  const state = JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8'));
  for (const entry of f.entries) assert.equal(state.watches[entry.id], rejected.has(entry.id) ? undefined : watchId(entry.id));
  for (const entry of f.wanted) assert.equal(state.watches[entry.id], undefined);
  assert.equal(state.watches[RETIRED], 'wat_retired');
  assert.equal(state.watches.lk_preserved0001, 'wat_preserved');
  assert.equal(Object.keys(state.watches).length, COUNT, 'Every success and both preexisting mappings survive; rejects get no guessed ID');
  assert.deepEqual(state.cursors, f.state.cursors, 'A push cannot advance either read cursor');
  assert.deepEqual(state.customerCheckpoint, f.state.customerCheckpoint);
  await unchangedAuthored(f);
  assert.ok(!(await readdir(f.dir)).includes('observations.jsonl'), 'An import acknowledgement does not invent observations');
});

test('a dropped final large-import acknowledgement preserves local state and recovers by paged reads without another POST', async t => {
  const f = await ledgerFixture(t), calls = [], committed = new Map(), uploadOutput = [], uploadErrors = [];
  const upload = async (url, init) => {
    const request = requestLog(url, init, calls);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/watches/import');
    assert.equal(request.body.projectId, PROJECT);
    const rows = request.body.watches.map((watch, index) => {
      const id = watch.localReference.split(' ')[0];
      assert.equal(committed.has(id), false, 'A committed write is never automatically replayed');
      committed.set(id, {...watch, id: watchId(id), project_id: PROJECT, local_reference: watch.localReference,
        source_url: watch.sourceUrl, target_url: watch.targetUrl, target_scope: watch.targetScope});
      return {index, watch: {id: watchId(id), created: true}};
    });
    // The fixture accepted every last position before its response disappeared.
    // The client cannot infer that outcome from the transport exception.
    if (committed.size === COUNT) throw new DOMException('Injected dropped committed response', 'TimeoutError');
    return Response.json({status: 'succeeded', rows: rows.reverse()});
  };
  assert.equal(await main(['sync'], {cwd: f.cwd, env: {}, fetchImpl: upload,
    out: value => uploadOutput.push(value), err: value => uploadErrors.push(value)}), 2);
  assert.match(uploadErrors.join('\n'), /Check the operation result before sending it again/);
  assert.deepEqual(uploadOutput, [], 'The CLI must not claim the full push finished');
  assert.equal(committed.size, COUNT, 'Only the fixture knows the ambiguous POST committed');
  assert.deepEqual(calls.map(row => row.body.watches.length), [...Array(20).fill(100), 3]);
  assert.ok(calls.every(row => row.method === 'POST'), 'No subsequent pause, check, event read or replay follows the ambiguous acknowledgement');
  assert.equal(await readFile(join(f.dir, 'state.json'), 'utf8'), f.stateBytes);
  await unchangedAuthored(f);
  assert.ok(!(await readdir(f.dir)).includes('events.jsonl'));

  const checkedAt = '2026-10-06T12:00:00.000Z';
  const current = {state: 'unknown', uncertain: true, checked_at: checkedAt,
    latestAttempt: {state: 'unknown', reason: 'timeout', evidence: {complete: false}}};
  const watches = [...committed.values()].map(watch => ({...watch, observation_state: current}));
  const echo = n => ({id: `event_large_${n}`, watch_id: watchId(localId(n)), project_id: PROJECT,
    data: {after: {state: 'unknown', uncertain: true, checked_at: checkedAt, reason: 'timeout',
      source_url: f.entries[n].source, target_url: f.entries[n].target, target_scope: 'exact'}}});
  const readOnly = async (url, init) => {
    const request = requestLog(url, init, calls);
    assert.equal(request.method, 'GET', 'Recovery reconciles results without replaying remote writes or requesting checks');
    assert.equal(request.project, PROJECT, 'Read recovery retains the configured project scope');
    if (request.path === '/v1/events') {
      if (request.cursor === 'old-source') return Response.json({error: {code: 'INVALID_CURSOR',
        message: 'The saved binding cannot be used.', details: {resume_cursor: 'untrusted-resume'}}}, {status: 400});
      if (request.cursor === 'source-done') return Response.json({events: [], next_cursor: 'source-done', has_more: false});
      if (request.cursor === null) return Response.json({events: [echo(0)], next_cursor: 'source-page2', has_more: true});
      assert.equal(request.cursor, 'source-page2');
      return Response.json({events: [echo(COUNT - 1)], next_cursor: 'source-done', has_more: false});
    }
    if (request.path === '/v1/target-events') {
      assert.ok(['old-target', 'target-done'].includes(request.cursor));
      return Response.json({events: [], next_cursor: 'target-done', has_more: false});
    }
    assert.ok(['/v1/exports/watches', '/v1/watches'].includes(request.path));
    const offset = request.cursor === null ? 0 : Number(request.cursor.slice('offset-'.length));
    assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset < COUNT);
    return Response.json({items: watches.slice(offset, offset + 100), next_cursor: offset + 100 < COUNT ? `offset-${offset + 100}` : null});
  };
  const recover = extra => main(['sync', '--pull-only', '--recover-cursors'], {cwd: f.cwd, env: {},
    fetchImpl: readOnly, out: () => {}, err: () => {}, ...extra});
  const beforeRecovery = calls.length;
  let checkpoint = false;
  assert.equal(await recover({afterHistoryPersisted: () => {checkpoint = true; throw new Error('Injected history-before-state interruption');}}), 2);
  assert.equal(checkpoint, true, 'The interruption occurred after actual history persistence');
  assert.equal(await readFile(join(f.dir, 'state.json'), 'utf8'), f.stateBytes);
  const observationBytes = await readFile(join(f.dir, 'observations.jsonl'), 'utf8');
  const eventBytes = await readFile(join(f.dir, 'events.jsonl'), 'utf8');
  const rows = observationBytes.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, COUNT);
  assert.equal(new Set(rows.map(row => row.id)).size, COUNT);
  assert.ok(rows.every(row => row.state === 'unknown' && row.complete === false && row.reason === 'timeout'));
  assert.ok(rows.every(row => row.evidence_key === null && row.result.evidence.sha256 === null));
  for (const row of rows) assert.equal(row.result.sourceUrl, f.entries.find(entry => entry.id === row.id).source);
  assert.equal(eventBytes.trim().split('\n').length, COUNT + 2, 'The complete snapshot and both retained feed events survive');
  const firstReads = calls.slice(beforeRecovery);
  assert.equal(firstReads.filter(row => row.path === '/v1/exports/watches').length, 21);
  assert.equal(firstReads.filter(row => row.path === '/v1/watches').length, 21);
  assert.deepEqual(firstReads.filter(row => row.path === '/v1/events').map(row => row.cursor), ['old-source', null, 'source-page2']);
  assert.ok(firstReads.findIndex(row => row.path === '/v1/events' && row.cursor === null) >
    firstReads.findLastIndex(row => row.path === '/v1/exports/watches'), 'The complete snapshot precedes cursorless replay');

  assert.equal(await recover(), 0);
  assert.equal(await readFile(join(f.dir, 'observations.jsonl'), 'utf8'), observationBytes, 'History replay appends no duplicate observations');
  assert.equal(await readFile(join(f.dir, 'events.jsonl'), 'utf8'), eventBytes, 'History replay appends no duplicate events');
  const state = JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8'));
  assert.deepEqual(state.cursors, {events: 'source-done', target_events: 'target-done'});
  assert.deepEqual(state.gaps.map(row => [row.feed, row.reason, row.resumed_from]), [['events', 'cursor_invalid', null]]);
  assert.deepEqual(state.watches, f.state.watches, 'Read recovery does not fabricate import acknowledgements');
  assert.deepEqual(state.customerCheckpoint, f.state.customerCheckpoint);
  const snapshots = (await readdir(f.dir)).filter(name => name.startsWith('snapshot-events-'));
  assert.equal(snapshots.length, 2, 'Both interruption and recovery snapshots remain inspectable');
  for (const name of snapshots) {
    const snapshot = JSON.parse(await readFile(join(f.dir, name), 'utf8'));
    assert.equal(snapshot.items.length, COUNT);
    assert.equal(snapshot.next_cursor, null);
  }
  const savedBytes = await readFile(join(f.dir, 'state.json'), 'utf8'), beforeSettledPull = calls.length;
  assert.equal(await recover(), 0);
  assert.equal(await readFile(join(f.dir, 'state.json'), 'utf8'), savedBytes);
  assert.equal(await readFile(join(f.dir, 'observations.jsonl'), 'utf8'), observationBytes);
  assert.equal(await readFile(join(f.dir, 'events.jsonl'), 'utf8'), eventBytes);
  assert.deepEqual(calls.slice(beforeSettledPull).filter(row => row.path.includes('events')).map(row => row.cursor), ['source-done', 'target-done']);
  assert.ok(calls.slice(beforeRecovery).every(row => row.method === 'GET' && row.project === PROJECT));
  assert.equal(calls.filter(row => row.method === 'POST').length, 21, 'No acknowledgement failure or recovery causes an extra write');
  await unchangedAuthored(f);
});
