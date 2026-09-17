import test from 'node:test';
import assert from 'node:assert/strict';
import { pullEvents, pullTargetEvents, cloudObservationRows } from '../cli/sync.js';
import { observationKey, dedupeObservations } from '../cli/mirror.js';
import { upgradeState, STATE_VERSION } from '../cli/state.js';
import { normalizeEntry, refTruncatedInTransit, toWatchInput, ORIGIN_KINDS, LOCAL_REFERENCE_LIMIT } from '../cli/ledger.js';
import { CloudError } from '../cli/client.js';

const page = (events, next, more) => ({ events, next_cursor: next, has_more: more });

/** A cloud whose two feeds are genuinely independent, and which records what each was asked. */
function cloud({ events = [], targetEvents = [], expire = null } = {}) {
  const asked = { events: [], target_events: [] };
  return {
    asked,
    listEvents: async query => {
      asked.events.push(query.cursor ?? null);
      if (expire === 'events' && query.cursor !== 'ev_resume') throw new CloudError('CURSOR_EXPIRED', 410, { resume_cursor: 'ev_resume', snapshot: '/v1/exports/watches' });
      return page(events, 'ev_9', false);
    },
    listTargetEvents: async query => {
      asked.target_events.push(query.cursor ?? null);
      if (expire === 'target_events' && query.cursor !== 'tg_resume') throw new CloudError('CURSOR_EXPIRED', 410, { resume_cursor: 'tg_resume' });
      return page(targetEvents, 'tg_4', false);
    },
    listTargets: async () => ({items: [{id: 'target_1'}], next_cursor: null}),
    exportWatches: async () => ({ watches: [{ id: 'w_1' }] }),
  };
}

test('the two feeds have separate cursors, because the cloud keeps separate sequences', async () => {
  const client = cloud({ events: [{ id: 'e1' }], targetEvents: [{ id: 't1' }] });
  const state = { v: 2, cursors: { events: 'ev_1', target_events: 'tg_1' } };
  const source = await pullEvents(client, state);
  const targets = await pullTargetEvents(client, state);
  assert.equal(source.feed, 'events');
  assert.equal(targets.feed, 'target_events');
  assert.equal(source.cursor, 'ev_9');
  assert.equal(targets.cursor, 'tg_4');
  // Each feed was asked with ITS OWN cursor. Sharing one would have sent 'ev_1' to both, and
  // sequence 41 in one feed has nothing to do with sequence 41 in the other.
  assert.deepEqual(client.asked.events, ['ev_1']);
  assert.deepEqual(client.asked.target_events, ['tg_1']);
});

test('an expiry on one feed resyncs that feed and never touches the other cursor', async () => {
  const client = cloud({ events: [{ id: 'e1' }], targetEvents: [{ id: 't1' }], expire: 'events' });
  const state = { v: 2, cursors: { events: 'ev_old', target_events: 'tg_1' } };
  let snapshots = 0;
  const source = await pullEvents(client, state, { onSnapshot: () => { snapshots += 1; } });
  const targets = await pullTargetEvents(client, state);
  assert.equal(source.resynced, true);
  assert.equal(snapshots, 1, 'the snapshot is taken before the cursor moves');
  assert.equal(source.cursor, 'ev_9');
  assert.equal(source.gaps[0].reason, 'cursor_expired');
  // The target feed is untouched: it had no reason to expire and its cursor did not move past
  // anything unread.
  assert.equal(targets.resynced, false);
  assert.deepEqual(targets.gaps, []);
  assert.deepEqual(client.asked.target_events, ['tg_1']);
});

test('a target-feed expiry does not fabricate a watch snapshot', async () => {
  const client = cloud({ expire: 'target_events' });
  const seen = [];
  const targets = await pullTargetEvents(client, { v: 2, cursors: { target_events: 'tg_old' } }, { onSnapshot: snapshot => seen.push(snapshot) });
  assert.equal(targets.resynced, true);
  assert.deepEqual(seen, [{items: [{id: 'target_1'}], next_cursor: null}]);
});

test('a v1 state upgrades without losing anything and without inventing a target cursor', () => {
  const upgraded = upgradeState({ v: 1, entries: { lk_a: { checks: 3 } }, cursors: { events: 'ev_7' }, somethingNewer: { keep: true } });
  assert.equal(upgraded.v, STATE_VERSION);
  assert.equal(upgraded.upgraded_from, 1);
  assert.deepEqual(upgraded.entries, { lk_a: { checks: 3 } });
  assert.equal(upgraded.cursors.events, 'ev_7');
  // Null, not 'ev_7'. Seeding the target cursor from the source cursor would skip every target
  // event ever emitted, and the feed would simply look quiet.
  assert.equal(upgraded.cursors.target_events, null);
  assert.deepEqual(upgraded.somethingNewer, { keep: true }, 'a key written by a newer version survives an older one');
});

test('upgrading twice is the same as upgrading once', () => {
  const once = upgradeState({ v: 1, cursors: { events: 'ev_7' } });
  const twice = upgradeState(once);
  assert.deepEqual(twice, { ...once, upgraded_from: 1 });
});

test('a replayed page appends nothing, which is what makes the write-then-advance order safe', () => {
  const rows = [
    { id: 'lk_a', checked_at: '2026-09-11T10:00:00.000Z', source: 'cloud', state: 'present' },
    { id: 'lk_b', checked_at: '2026-09-11T10:00:00.000Z', source: 'cloud', state: 'absent' },
  ];
  const first = dedupeObservations([], rows);
  assert.equal(first.fresh.length, 2);
  const replay = dedupeObservations(first.fresh, rows);
  assert.equal(replay.fresh.length, 0);
  assert.equal(replay.duplicates.length, 2);
  // A later, genuinely new observation of the same entry still lands.
  const later = dedupeObservations(first.fresh, [{ id: 'lk_a', checked_at: '2026-09-11T11:00:00.000Z', source: 'cloud', state: 'absent' }]);
  assert.equal(later.fresh.length, 1);
});

test('a local and a cloud check at the same instant are two observations, not a duplicate', () => {
  const at = '2026-09-11T10:00:00.000Z';
  const { fresh } = dedupeObservations(
    [{ id: 'lk_a', checked_at: at, source: 'local' }],
    [{ id: 'lk_a', checked_at: at, source: 'cloud' }]);
  assert.equal(fresh.length, 1, 'who looked is part of the key');
  assert.equal(observationKey({ id: 'lk_a', checked_at: at, source: 'cloud' }), `lk_a|${at}|cloud`);
  assert.equal(observationKey({ id: 'lk_a', checked_at: at }), `lk_a|${at}|local`);
});

test('a replayed cloud event produces a byte-identical row, which is why the key works', () => {
  const event = { watch_id: 'w_1', data: { after: { state: 'present', checked_at: '2026-09-11T10:00:00.000Z', uncertain: false, latestAttempt: { reason: 'link_present', occurrences: [], evidence: { checkerVersion: '1' } } }, evidence_key: 'ev/1' } };
  const index = new Map([['w_1', 'lk_a']]);
  const [first] = cloudObservationRows([event], index);
  const [second] = cloudObservationRows([event], index);
  assert.deepEqual(first, second);
  assert.equal(observationKey(first), observationKey(second));
  assert.equal(first.source, 'cloud');
});

test('lineage is its own field, because ref is the half the cloud truncates', () => {
  const origin = { kind: 'mention', id: 'mn_7', run_id: 'run_2026_09_11', observed_at: '2026-09-11T12:00:00.000Z', source_url: 'https://publisher.example.com/a' };
  const entry = normalizeEntry({ id: 'lk_abcd1234', intent: 'wanted', source: 'https://p.example.com/a', target: 'https://c.example.com/', origin });
  assert.deepEqual(entry.origin, origin);
  // The lineage does NOT ride to the cloud inside local_reference, where it would be cut off.
  const input = toWatchInput(entry);
  assert.equal(input.localReference, 'lk_abcd1234');
  assert.equal(/mn_7/.test(input.localReference), false);
});

test('whether a ref survives transit depends on the ID in front of it, so the check is per entry', () => {
  const make = (id, ref) => normalizeEntry({ id, intent: 'wanted', source: 'https://p.example.com/a', target: 'https://c.example.com/', ref });
  // The SAME ref, on two entries whose ids differ in length. A single constant could not be
  // right about both, which is the reason this is a function.
  const ref = 'r'.repeat(LOCAL_REFERENCE_LIMIT - 20);
  const shortId = make('lk_abcd', ref);
  const longId = make(`lk_${'z'.repeat(32)}`, ref);
  assert.equal(refTruncatedInTransit(shortId), false);
  assert.equal(refTruncatedInTransit(longId), true);
  assert.equal(toWatchInput(longId).localReference.length, LOCAL_REFERENCE_LIMIT);
  assert.equal(toWatchInput(shortId).localReference, `lk_abcd ${ref}`);
  // A ref that obviously fits is untouched, and an absent one is never "truncated".
  assert.equal(refTruncatedInTransit(make('lk_abcd1234', 'CRM-4412')), false);
  assert.equal(refTruncatedInTransit(make('lk_abcd1234', undefined)), false);
});

test('an unknown lineage kind is refused, and an unknown lineage KEY is kept', () => {
  assert.throws(() => normalizeEntry({ id: 'lk_abcd1234', intent: 'wanted', source: 'https://p.example.com/a', target: 'https://c.example.com/', origin: { kind: 'guesswork' } }),
    error => /origin.kind must be one of/.test(error.message));
  const entry = normalizeEntry({ id: 'lk_abcd1234', intent: 'wanted', source: 'https://p.example.com/a', target: 'https://c.example.com/', origin: { kind: 'citation', confidence_note: 'from the 2026-09-11 crawl' } });
  assert.equal(entry.origin.confidence_note, 'from the 2026-09-11 crawl');
  assert.ok(ORIGIN_KINDS.includes('discovery_candidate'));
});

test('an entry with lineage round-trips through the ledger unchanged', async () => {
  const { serializeLedger } = await import('../cli/ledger.js');
  const entry = normalizeEntry({ id: 'lk_abcd1234', intent: 'expected', source: 'https://p.example.com/a', target: 'https://c.example.com/', origin: { kind: 'discovery_candidate', id: 'dc_9', provider: 'owned_corpus' } });
  const line = serializeLedger([entry]).trim();
  assert.deepEqual(normalizeEntry(JSON.parse(line)), entry);
  // Stable key order, so adding lineage does not reorder every other line of the file.
  assert.ok(line.indexOf('"ref"') < line.indexOf('"origin"') || !line.includes('"ref"'));
});
