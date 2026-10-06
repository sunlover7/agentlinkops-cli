import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CloudError} from '../cli/client.js';
import {pullEvents, pullTargetEvents, cloudObservationRows} from '../cli/sync.js';
import {appendObservations, readObservations, dedupeObservations} from '../cli/mirror.js';

const invalid = () => new CloudError('INVALID_CURSOR', 400, {resume_cursor: 'untrusted-resume'});
const state = () => ({cursors: {events: 'old-source', target_events: 'old-target'}, watches: {local: 'watch'}, customer: {keep: true}});
const observation = {state: 'present', uncertain: false, checked_at: '2026-09-30T12:00:00Z'};
function fixture({feed = 'events', deny = false, repeated = false, more = false} = {}) {
  const calls = [];
  const list = async query => {
    calls.push({kind: 'list', ...query});
    if (query.cursor === 'old-source' || query.cursor === 'old-target' || repeated) throw invalid();
    return {events: [{id: 'event', watch_id: 'watch', target_id: 'target', data: {after: observation}}], next_cursor: `${feed}-fresh`, has_more: more};
  };
  const snapshot = async query => {
    calls.push({kind: 'snapshot', ...query});
    if (deny) throw new CloudError('FORBIDDEN', 403);
    return {items: [{id: feed === 'events' ? 'watch' : 'target', observation_state: observation}], next_cursor: null};
  };
  return {calls, client: {listEvents: list, listTargetEvents: list, exportWatches: snapshot, listTargets: snapshot}};
}

test('invalid binding recovery is opt-in; default preserves the saved state', async () => {
  const f = fixture(), before = state(), bytes = JSON.stringify(before);
  await assert.rejects(pullEvents(f.client, before), e => e.code === 'INVALID_CURSOR');
  assert.equal(JSON.stringify(before), bytes);
  assert.equal(f.calls.length, 1);
});

for (const [feed, pull] of [['events', pullEvents], ['target_events', pullTargetEvents]]) {
  test(`${feed}: explicit recovery snapshots first, restarts without trusting supplied resume, and isolates feed state`, async () => {
    const f = fixture({feed}), before = state(), bytes = JSON.stringify(before);
    const r = await pull(f.client, before, {recoverInvalidCursor: true});
    assert.deepEqual(f.calls.map(c => c.kind), ['list', 'snapshot', 'list']);
    assert.equal(f.calls.at(-1).cursor, null);
    assert.equal(r.cursor, `${feed}-fresh`);
    assert.equal(r.events.length, 2, 'current snapshot and retained event both survive');
    assert.equal(r.gaps[0].reason, 'cursor_invalid');
    assert.equal(r.gaps[0].feed, feed);
    assert.equal(r.gaps[0].resumed_from, null);
    assert.equal(JSON.stringify(before), bytes, 'caller alone commits feed state');
  });
}

test('denied snapshot recovery preserves state and never attempts a cursorless event read', async () => {
  const f = fixture({deny: true}), before = state(), bytes = JSON.stringify(before);
  await assert.rejects(pullEvents(f.client, before, {recoverInvalidCursor: true}), e => e.code === 'FORBIDDEN' && e.status === 403);
  assert.deepEqual(f.calls.map(c => c.kind), ['list', 'snapshot']);
  assert.equal(JSON.stringify(before), bytes);
});

test('cursorless invalid response is refused; recovery does not loop', async () => {
  const f = fixture({repeated: true});
  await assert.rejects(pullEvents(f.client, state(), {recoverInvalidCursor: true}), e => e.code === 'INVALID_CURSOR');
  assert.equal(f.calls.length, 3);
});

test('invalid cursor without a saved position never initiates snapshot recovery', async () => {
  const f = fixture({repeated: true});
  await assert.rejects(pullEvents(f.client, {cursors: {}}, {recoverInvalidCursor: true}), e => e.code === 'INVALID_CURSOR');
  assert.equal(f.calls.length, 1);
});

test('recovery refuses an incomplete replay instead of returning a committable cursor', async () => {
  const f = fixture({more: true});
  await assert.rejects(pullEvents(f.client, state(), {recoverInvalidCursor: true, maxPages: 1}), e => e.code === 'RESYNC_EVENT_LIMIT');
});

test('recovery bounds snapshot scans and refuses repeated snapshot cursors', async () => {
  for (const repeat of [false, true]) {
    const f = fixture(); let n = 0;
    f.client.exportWatches = async () => ({items: [], next_cursor: repeat ? 'same' : `page-${++n}`});
    await assert.rejects(pullEvents(f.client, state(), {recoverInvalidCursor: true, maxPages: 2}), e => e.code === (repeat ? 'INVALID_SNAPSHOT_CURSOR' : 'RESYNC_SNAPSHOT_LIMIT'));
  }
});

test('nine independent library-ledger episodes replay after append without duplicate observations or authored changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alo-cursor-nine-'));
  try {
    for (let site = 0; site < 9; site++) {
      const ledger = join(dir, `site-${site}.jsonl`), mirror = join(dir, `site-${site}.observations.jsonl`);
      const authored = JSON.stringify({id: 'same-local-id', source: `https://site-${site}.example/a`, target: `https://site-${site}.example/b`}) + '\n';
      await writeFile(ledger, authored);
      const f = fixture();
      const pull = () => pullEvents(f.client, state(), {recoverInvalidCursor: true});
      const rows = result => cloudObservationRows(result.events, new Map([['watch', 'same-local-id']]));
      const first = await pull();
      await appendObservations(mirror, dedupeObservations([], rows(first)).fresh);
      // An interrupted caller has appended history but not saved the replacement cursor.
      const replay = await pull(), existing = await readObservations(mirror);
      const recovered = dedupeObservations(existing.rows, rows(replay));
      await appendObservations(mirror, recovered.fresh);
      assert.equal(recovered.fresh.length, 0);
      assert.equal((await readObservations(mirror)).rows.length, 1);
      assert.equal(await readFile(ledger, 'utf8'), authored);
      assert.ok(f.calls.every(c => ['list', 'snapshot'].includes(c.kind)));
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
