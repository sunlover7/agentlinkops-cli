import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, CloudError } from '../cli/client.js';
import { pushExpectations, pullEvents, cloudObservationRows, watchIndex } from '../cli/sync.js';
import { normalizeEntry, toWatchInput } from '../cli/ledger.js';

const TARGET = 'https://customer.com/guide';
const entry = (id, over = {}) => normalizeEntry({ id, intent: 'expected', source: `https://p${id}.com/a`, target: TARGET, ...over });

/** A cloud that records what it was asked and can answer with a real 410. */
function cloud(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.pathname}`;
    calls.push({ key, url: parsed, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const handler = routes[key];
    assert.ok(handler, `unexpected request ${key}`);
    const result = typeof handler === 'function' ? handler(parsed, init, calls) : handler;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, client: createClient({ origin: 'https://api.example.com', token: 'k_test', workspaceId: 'ws_1', fetchImpl }) };
}
const imported = (parsed, init) => ({
  status: 'succeeded',
  rows: JSON.parse(init.body).watches.map((watch, index) => ({ index, watch: { id: `wat_${index}_${watch.localReference.split(' ')[0]}`, created: true } })),
});

test('pushing the same ledger twice creates nothing the second time', async () => {
  const entries = [entry('lk_aaaaaaaa'), entry('lk_bbbbbbbb')];
  const first = cloud({ 'POST /v1/watches/import': imported });
  const pushed = await pushExpectations(first.client, entries, { watches: {} }, { projectId: 'pr_1' });
  assert.equal(pushed.pushed, 2);
  assert.equal(pushed.created, 2);
  assert.equal(pushed.watches.lk_aaaaaaaa, 'wat_0_lk_aaaaaaaa');

  // The cloud deduplicates a watch on (source, target, scope) and reports created: false, so
  // idempotency is a property of the server rather than bookkeeping this side has to get right.
  const again = cloud({ 'POST /v1/watches/import': (parsed, init) => ({
    status: 'succeeded',
    rows: JSON.parse(init.body).watches.map((watch, index) => ({ index, watch: { id: `wat_${index}_${watch.localReference.split(' ')[0]}`, created: false } })),
  }) });
  const second = await pushExpectations(again.client, entries, pushed, { projectId: 'pr_1' });
  assert.equal(second.created, 0);
  assert.equal(second.pushed, 2);
});

test('a retired entry is paused, never deleted', async () => {
  const entries = [entry('lk_cccccccc'), entry('lk_dddddddd', { intent: 'retired' })];
  const patched = [];
  const { client } = cloud({
    'POST /v1/watches/import': imported,
    'PATCH /v1/watches/wat_known': (parsed, init) => { patched.push(JSON.parse(init.body)); return { id: 'wat_known', status: 'paused' }; },
  });
  const result = await pushExpectations(client, entries, { watches: { lk_dddddddd: 'wat_known' } }, { projectId: 'pr_1' });
  assert.equal(result.pushed, 1, 'a retired entry is not pushed as a watch');
  assert.equal(result.retired, 1);
  // Its observations are the customer's history, and deleting the watch would take them with it.
  assert.deepEqual(patched, [{ status: 'paused' }]);
});

test('a row the cloud refuses is reported, and the rest still land', async () => {
  const entries = [entry('lk_eeeeeeee'), entry('lk_ffffffff')];
  const { client } = cloud({ 'POST /v1/watches/import': () => ({
    status: 'partial',
    rows: [{ index: 0, watch: { id: 'wat_ok', created: true } }, { index: 1, error: { code: 'WATCH_LIMIT_REACHED', message: 'The plan allows 100 watches.' } }],
  }) });
  const result = await pushExpectations(client, entries, { watches: {} }, { projectId: 'pr_1' });
  assert.equal(result.created, 1);
  assert.deepEqual(result.failed, [{ id: 'lk_ffffffff', code: 'WATCH_LIMIT_REACHED', message: 'The plan allows 100 watches.' }]);
});

test('a page applies before the cursor advances', async () => {
  const pages = [
    { events: [{ id: 'e1', watch_id: 'w1', type: 'watch.checked', cursor: 'c1', data: {} }], next_cursor: 'c1', has_more: true },
    { events: [{ id: 'e2', watch_id: 'w1', type: 'watch.state_changed', cursor: 'c2', data: {} }], next_cursor: 'c2', has_more: false },
  ];
  let index = 0;
  const { client, calls } = cloud({ 'GET /v1/events': () => pages[index++] });
  const result = await pullEvents(client, { cursors: {} });
  assert.equal(result.events.length, 2);
  assert.equal(result.cursor, 'c2');
  // The second request carries the FIRST page's cursor, which is what "applied, then advanced"
  // looks like from outside: a crash between the two re-fetches that page rather than skipping it.
  assert.equal(calls[1].url.searchParams.get('cursor'), 'c1');
});

test('an expired cursor takes the snapshot BEFORE it moves, and records the gap', async () => {
  const expired = new Response(JSON.stringify({ error: { code: 'CURSOR_EXPIRED', message: 'gone', details: {
    resync_required: true, snapshot_endpoint: '/v1/exports/watches', resume_cursor: 'c_resume',
  } } }), { status: 410, headers: { 'content-type': 'application/json' } });
  let seen = 0;
  const order = [];
  const { client } = cloud({
    'GET /v1/events': () => { order.push('events'); return seen++ === 0 ? expired : { events: [{ id: 'e9', watch_id: 'w1', cursor: 'c9', data: {} }], next_cursor: 'c9', has_more: false }; },
    'GET /v1/exports/watches': () => { order.push('snapshot'); return { schema_version: 1, items: [{ id: 'wat_1' }] }; },
  });
  const snapshots = [];
  const result = await pullEvents(client, { cursors: { events: 'c_old' } }, { onSnapshot: snapshot => { snapshots.push(snapshot); } });
  // Advancing to the resume cursor without taking the snapshot would silently drop every change
  // in the gap, which is the exact failure the 410 exists to prevent.
  assert.deepEqual(order, ['events', 'snapshot', 'events']);
  assert.equal(snapshots.length, 1);
  assert.equal(result.resynced, true);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].resumed_from, 'c_resume');
  assert.equal(result.events.length, 1);
});

test('an error that is not an expiry is raised, not swallowed into an empty pull', async () => {
  const { client } = cloud({ 'GET /v1/events': () => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429 }) });
  await assert.rejects(pullEvents(client, { cursors: {} }), error => error instanceof CloudError && error.code === 'RATE_LIMITED');
});

test('a cloud observation keeps the label of the machine that looked', () => {
  const events = [{
    watch_id: 'wat_1', type: 'watch.state_changed',
    data: { evidence_key: 'private/ws_1/checks/job_1/1/abc.json', observation_id: 'obs_01synced',
      after: { state: 'present', uncertain: false, checked_at: '2026-09-14T09:00:00.000Z',
        latestAttempt: { reason: 'link_found', occurrences: [{ anchor: 'guide' }], linkSignature: 'sig', evidence: { checkerVersion: '1' } } } },
  }];
  const rows = cloudObservationRows(events, new Map([['wat_1', 'lk_11111111']]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'lk_11111111');
  // Which machine looked matters when two rows disagree, so the label never comes off.
  assert.equal(rows[0].source, 'cloud');
  assert.equal(rows[0].evidence_key, 'private/ws_1/checks/job_1/1/abc.json');
  assert.equal(rows[0].occurrences, 1);
  // The hosted observation id travels too, so a receipt export can name the workspace row
  // (agentlinkops:evidence/1/link/hosted/<id>) beside the mirror reference that resolves
  // offline. Snapshot-derived rows have none, and null says exactly that.
  assert.equal(rows[0].cloud_observation_id, 'obs_01synced');
  const snapshotsOnly = cloudObservationRows([{ watch_id: 'wat_1', type: 'watch.checked', data: { after: events[0].data.after } }], new Map([['wat_1', 'lk_11111111']]));
  assert.equal(snapshotsOnly[0].cloud_observation_id, null);
  // An event for a watch this ledger does not know is skipped rather than filed under a guess.
  assert.equal(cloudObservationRows(events, new Map()).length, 0);
});

test('the watch index works for a watch this machine never pushed, across pages', async () => {
  // The list endpoint signals more pages with a non-null `next_cursor` and returns no
  // `has_more` flag. Reading one would have indexed only the first hundred watches and skipped
  // every event past them as belonging to an unknown watch.
  const pages = [
    { items: [{ id: 'wat_elsewhere', local_reference: 'lk_22222222 campaign/7' }], next_cursor: 'page2' },
    { items: [{ id: 'wat_page_two', local_reference: 'lk_44444444' }, { id: 'wat_unlabelled', local_reference: null }], next_cursor: null },
  ];
  let page = 0;
  const { client } = cloud({ 'GET /v1/watches': () => pages[page++] });
  const index = await watchIndex(client, { watches: { lk_33333333: 'wat_local' } });
  assert.equal(index.get('wat_local'), 'lk_33333333');
  // `localReference` carries the ledger id, so the mapping does not depend on this laptop
  // having been the machine that created the watch.
  assert.equal(index.get('wat_elsewhere'), 'lk_22222222');
  assert.equal(index.get('wat_page_two'), 'lk_44444444', 'the second page was read');
  assert.equal(index.has('wat_unlabelled'), false);
});

test('the client refuses to run without an origin or a token', () => {
  assert.throws(() => createClient({ token: 'k' }), error => error.code === 'NO_CLOUD_ORIGIN');
  assert.throws(() => createClient({ origin: 'https://a.com' }), error => error.code === 'NO_TOKEN');
});

test('the ledger maps to exactly the watch fields the cloud accepts', async () => {
  const { client, calls } = cloud({ 'POST /v1/watches/import': imported });
  const rich = normalizeEntry({ id: 'lk_99999999', intent: 'wanted', source: 'https://p.com/a', target: TARGET,
    scope: 'domain', expect: { anchor: 'guide', rel: ['nofollow'] }, cadence: 'weekly', ref: 'q3/9', tags: ['x'], note: 'private' });
  await pushExpectations(client, [rich], { watches: {} }, { projectId: 'pr_1', includeWanted: true });
  const sent = calls[0].body.watches[0];
  assert.deepEqual(Object.keys(sent).sort(), Object.keys(toWatchInput(rich)).sort());
  // Tags and notes are the customer's, and stay on their machine.
  assert.equal(JSON.stringify(sent).includes('private'), false);
  assert.equal(JSON.stringify(sent).includes('"x"'), false);
  assert.equal(sent.cadenceSeconds, 604_800);
});


test('legacy cloud events do not invent a content hash or measurement method', () => {
  const [row] = cloudObservationRows([{watch_id: 'wat_legacy', data: {after: {
    schema_version: 1, state: 'present', uncertain: false, checked_at: '2026-09-19T00:00:00.000Z',
  }}}], new Map([['wat_legacy', 'lk_legacy01']]));
  assert.equal(row.result.evidence.sha256, null);
  assert.equal(row.result.evidence.method, null);
  assert.equal(row.result.evidence.rendered, null);
  assert.equal(row.cloud_observation_id, null);
});
