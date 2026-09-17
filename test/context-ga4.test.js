// DP-0017-T04 acceptance, against the T01 contract's GA4 terms. Every state is proven by a fixture
// client over the real module — no live GA4, no credentials, no network. The HTTP transports in
// src/context/ga4.js and src/context/gsc.js are never touched by these tests; the day a customer
// connects a property, that evidence will be a separate dated file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  refreshGa4Context, landingPageContext, keyEventsContext, businessContextForPage,
  importGa4Handoff, forgetGa4Context, readGa4Rows, rowsFromGa4Response,
  validateGa4Report, parseGa4Property, ga4LandingPageOf, newestGa4Rows,
  createGa4Client, GA4_LIMITS, GA4_STATES, GA4_SCOPE, Ga4ApiError,
} from '../src/context/ga4.js';
import { contextPaths, windowFromRange, selectFocusPages, readManual, ContextError, createGoogleClient, readContextState } from '../src/context/gsc.js';

const NOW = () => new Date('2026-09-12T10:00:00Z');
const NO_SLEEP = () => Promise.resolve();
const WINDOW = windowFromRange('2026-08-15', '2026-09-11');
const METRICS = ['sessions', 'keyEvents', 'eventCount', 'totalRevenue'];

async function sandbox(t, { manual = null, state = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-ga4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = contextPaths({ dir });
  await mkdir(dirname(paths.ga4), { recursive: true });
  if (manual !== null) await writeFile(paths.manual, manual, 'utf8');
  if (state !== null) await writeFile(paths.contextState, JSON.stringify(state), 'utf8');
  return { dir, paths };
}

/** A scripted GA4 client. runReport `script` entries: { rows, rowCount?, metadata? } | { status }. */
function scriptedGa4Client({
  keyEvents = [{ name: 'properties/123/keyEvents/1', eventName: 'purchase', countingMethod: 'ONCE_PER_SESSION' }],
  keyEventsSecondPage = null, script = [],
} = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async listKeyEvents(property, { pageToken } = {}) {
      calls.push({ verb: 'listKeyEvents', property, pageToken: pageToken ?? null });
      if (pageToken) return keyEventsSecondPage ?? { keyEvents: [] };
      return { keyEvents, nextPageToken: keyEventsSecondPage ? 'page-2' : undefined };
    },
    async runReport(property, body) {
      calls.push({ verb: 'runReport', property, body });
      if (index >= script.length) throw new Error(`script exhausted at call ${calls.length} — the run made a call it should not have`);
      const step = script[index++];
      if (step.status !== undefined) throw new Ga4ApiError('data', step.status, step.body ?? null);
      return { rows: step.rows ?? [], rowCount: step.rowCount ?? (step.rows ?? []).length, metadata: step.metadata ?? {} };
    },
  };
}

/** One API-shaped row: dimensionValues in `dimensions` order, metricValues in METRICS order. */
const apiRow = (dimensions, keys, { sessions, keyEvents, eventCount, totalRevenue }) => ({
  dimensionValues: dimensions.map(name => ({ value: keys[name] ?? null })),
  metricValues: METRICS.map(name => ({
    value: String({ sessions, keyEvents, eventCount, totalRevenue }[name] ?? 0),
  })),
});

const KEY_EVENTS_LIST = [{ name: 'properties/123/keyEvents/1', eventName: 'purchase', countingMethod: 'ONCE_PER_SESSION' }, { name: 'properties/123/keyEvents/2', eventName: 'signup', countingMethod: 'ONCE_PER_EVENT' }];

// ---------------------------------------------------------------------------
// Fixture: ga4-absent — absent GA4 never blocks the core path
// ---------------------------------------------------------------------------

test('ga4-absent: no client resolves to ga4_absent, writes nothing, throws nothing, and the core path runs on', async t => {
  const { paths } = await sandbox(t, { manual: '# Site context\n\n## Target pages\n- https://example.com/guide\n' });
  const result = await refreshGa4Context({ client: null, paths, property: 'properties/123', now: NOW });
  assert.equal(result.state, 'ga4_absent');
  assert.equal(result.rows_written, 0);
  assert.equal(result.calls.run_report, 0);
  const { rows, missing } = await readGa4Rows(paths.ga4);
  assert.equal(rows.length, 0);
  assert.ok(missing, 'no ga4.jsonl was created by an absent connection');
  const state = await readContextState(paths.contextState);
  assert.equal(state.ga4.grant, 'none');
  // The core path is untouched: manual + GSC reads work with no GA4 anywhere.
  const manual = await readManual(paths.manual);
  const focus = selectFocusPages({ manual, rows: [] });
  assert.equal(focus.pages.length, 1, 'focus still nominates the manual target');
  const read = landingPageContext({ rows: [], page: 'https://example.com/guide', connection: { grant: 'none' } });
  assert.equal(read.state, 'ga4_absent');
  assert.ok(read.notes[0].includes('unaffected'));
  // The side-by-side read degrades to the search layer rather than failing.
  const business = businessContextForPage({ gscRows: [], ga4Rows: [], page: 'https://example.com/guide', ga4Connection: { grant: 'none' } });
  assert.equal(business.layers.business.state, 'ga4_absent');
  assert.equal(business.relation, 'side_by_side_not_joined');
});

// ---------------------------------------------------------------------------
// Fixture: landing-page aggregates carry property, dates and measurement caveats
// ---------------------------------------------------------------------------

test('landing-page context: raw counts stored, rates derived, property + window + caveats carried', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedGa4Client({
    keyEvents: KEY_EVENTS_LIST,
    script: [
      { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '412', keyEvents: '9', eventCount: '1600', totalRevenue: '730.5' })], metadata: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' } },
      { rows: [
        apiRow(['landingPagePlusQueryString', 'eventName'], { landingPagePlusQueryString: '/guide', eventName: 'purchase' }, { sessions: '412', keyEvents: '6', eventCount: '6', totalRevenue: '730.5' }),
        apiRow(['landingPagePlusQueryString', 'eventName'], { landingPagePlusQueryString: '/guide', eventName: 'signup' }, { sessions: '412', keyEvents: '3', eventCount: '3', totalRevenue: '0' }),
      ], metadata: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' } },
    ],
  });
  const result = await refreshGa4Context({ client, paths, property: '123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  assert.equal(result.state, 'ok');
  assert.equal(result.property, 'properties/123', 'a bare numeric id is normalized to the API path form');
  assert.deepEqual(result.key_events_configured.map(e => e.event_name), ['purchase', 'signup']);
  assert.equal(result.rows_written, 3);
  const { rows } = await readGa4Rows(paths.ga4);
  assert.ok(rows.every(r => r.property === 'properties/123'), 'every row carries the property');
  assert.ok(rows.filter(r => r.kind !== 'ga4.key_events_config').every(r => r.window.start === '2026-08-15' && r.window.end === '2026-09-11'), 'every windowed row carries the window');
  assert.ok(rows.every(r => r.retrieved_by === 'linktrail-ga4' && r.fetched_at));
  const read = landingPageContext({ rows, page: 'https://example.com/guide', connection: { grant: 'ok', property: 'properties/123' } });
  // GA4 landing pages are path + query string: /guide is the key here, and the match is stated as
  // a path match. A different query string is a DIFFERENT landing page and must not be joined to it.
  assert.equal(read.state, 'ok');
  const queryVariant = landingPageContext({ rows, page: 'https://example.com/guide?utm=x', connection: { grant: 'ok' } });
  assert.equal(queryVariant.state, 'ga4_no_row_for_page', 'a different query string is a distinct GA4 landing page, not a match');
  assert.equal(read.property, 'properties/123');
  assert.equal(read.window.start, '2026-08-15');
  assert.equal(read.match_basis, 'path_after_origin_strip');
  assert.deepEqual(read.totals, { sessions: 412, key_events: 9, event_count: 1600, total_revenue: 730.5, key_events_per_session: Math.round((9 / 412) * 10_000) / 10_000 });
  assert.equal(read.currency_code, 'USD');
  assert.equal(read.time_zone, 'America/Los_Angeles');
  const codes = read.caveats.map(c => c.code);
  for (const expected of ['property_dates', 'attribution', 'counting', 'currency', 'match_basis']) assert.ok(codes.includes(expected), `caveat ${expected} carried`);
  assert.ok(read.caveats.every(c => typeof c.note === 'string' && c.note.length > 20), 'each caveat carries its sentence');
  assert.deepEqual(read.events.map(e => e.event_name).sort(), ['purchase', 'signup']);
  // The event report was filtered to the CONFIGURED key events (the inList filter the run sent).
  const eventCall = client.calls.find(c => c.verb === 'runReport' && c.body.dimensions.length === 2);
  assert.deepEqual(eventCall.body.dimensionFilter.filter.inListFilter.values, ['purchase', 'signup']);
});

// ---------------------------------------------------------------------------
// Fixture: key-events context — configured events, counting method, totals
// ---------------------------------------------------------------------------

test('key-events context: configured names with counting methods, totals only from uncapped rows', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedGa4Client({
    keyEvents: KEY_EVENTS_LIST,
    script: [
      { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '412', keyEvents: '9', eventCount: '1600', totalRevenue: '730.5' })] },
      { rows: [apiRow(['landingPagePlusQueryString', 'eventName'], { landingPagePlusQueryString: '/guide', eventName: 'purchase' }, { sessions: '412', keyEvents: '6', eventCount: '6', totalRevenue: '730.5' })] },
    ],
  });
  await refreshGa4Context({ client, paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  const { rows } = await readGa4Rows(paths.ga4);
  const read = keyEventsContext({ rows, window: WINDOW });
  assert.equal(read.state, 'ok');
  assert.equal(read.property, 'properties/123');
  assert.equal(read.window.start, '2026-08-15');
  const purchase = read.key_events.find(e => e.event_name === 'purchase');
  assert.equal(purchase.counting_method, 'ONCE_PER_SESSION', 'the counting method is carried verbatim from the Admin API');
  assert.equal(purchase.key_events, 6);
  assert.equal(purchase.basis, 'sum_of_returned_rows');
  const signup = read.key_events.find(e => e.event_name === 'signup');
  assert.equal(signup.key_events, null, 'an event with no rows is reported as no_rows_for_event, never zero');
  assert.equal(signup.basis, 'no_rows_for_event');
  assert.ok(read.caveats.some(c => c.code === 'counting'));
  // A capped contributing report withholds totals rather than summing a floor.
  const capped = keyEventsContext({ rows: rows.map(r => r.kind === 'ga4.window' ? { ...r, truncated: true } : r), window: WINDOW });
  assert.equal(capped.state, 'ga4_truncated');
  assert.equal(capped.totals_withheld_because_capped, true);
  assert.ok(capped.key_events.every(e => e.key_events === null && e.basis === 'rows_capped_totals_withheld'));
});

test('no key events configured is its own named state, not zeros', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedGa4Client({
    keyEvents: [],
    script: [{ rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '90', keyEvents: '0', eventCount: '90', totalRevenue: '0' })] }],
  });
  const result = await refreshGa4Context({ client, paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  assert.ok(result.states.includes('ga4_no_key_events_configured'));
  assert.equal(client.calls.filter(c => c.verb === 'runReport').length, 1, 'no event report is spent when nothing is configured');
  const { rows } = await readGa4Rows(paths.ga4);
  const read = keyEventsContext({ rows, window: WINDOW });
  assert.equal(read.state, 'ga4_no_key_events_configured');
  assert.deepEqual(read.key_events, []);
});

// ---------------------------------------------------------------------------
// Fixture: measurement caveats from response metadata become states and sentences
// ---------------------------------------------------------------------------

test('dataLossFromOtherRow, thresholding, sampling and metric restrictions each become a named state', () => {
  const request = validateGa4Report({ dimensions: ['landingPagePlusQueryString'] });
  const cases = [
    [{ dataLossFromOtherRow: true }, 'ga4_data_loss_other_row', 'other_row'],
    [{ subjectToThresholding: true }, 'ga4_thresholded', 'thresholding'],
    [{ samplingMetadatas: [{ samplesReadCount: '5000', samplingSpaceSize: '20000' }] }, 'ga4_sampled', 'sampling'],
    [{ schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'totalRevenue', restrictedMetricTypes: ['REVENUE_DATA'] }] } }, 'ga4_metric_restricted', 'metric_restricted'],
  ];
  for (const [metadata, expectedState, expectedCaveat] of cases) {
    const { marker, factRows } = rowsFromGa4Response({
      property: 'properties/123', request: { ...request, window: WINDOW }, window: WINDOW,
      response: { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '10', keyEvents: '1', eventCount: '10', totalRevenue: '2' })], rowCount: 1, metadata },
      fetchedAt: '2026-09-12T10:00:00Z',
    });
    assert.ok(factRows[0].caveats.includes(expectedCaveat), `the ${expectedCaveat} caveat rides the fact row`);
    const read = landingPageContext({ rows: [factRows[0], marker], page: 'https://example.com/guide' });
    assert.equal(read.state, expectedState);
    assert.ok(read.caveats.some(c => c.code === expectedCaveat));
  }
  // The sampling ratio is carried as observed numbers, not summarized away.
  const { factRows } = rowsFromGa4Response({
    property: 'properties/123', request: { ...request, window: WINDOW }, window: WINDOW,
    response: { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '10', keyEvents: '1', eventCount: '10', totalRevenue: '2' })], metadata: { samplingMetadatas: [{ samplesReadCount: '5000', samplingSpaceSize: '20000' }] } },
    fetchedAt: '2026-09-12T10:00:00Z',
  });
  assert.deepEqual(factRows[0].sampling, [{ samples_read_count: 5000, sampling_space_size: 20000 }]);
});

// ---------------------------------------------------------------------------
// Fixture: the zero-rows-omitted discipline — absence is named, not zeroed or mystified
// ---------------------------------------------------------------------------

test('a landing page with no returned row is ga4_no_row_for_page with the omission caveat, never a zero', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedGa4Client({
    keyEvents: KEY_EVENTS_LIST,
    script: [
      { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '10', keyEvents: '0', eventCount: '10', totalRevenue: '0' })] },
      { rows: [] },
    ],
  });
  await refreshGa4Context({ client, paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  const { rows } = await readGa4Rows(paths.ga4);
  const read = landingPageContext({ rows, page: 'https://example.com/elsewhere', connection: { grant: 'ok' } });
  assert.equal(read.state, 'ga4_no_row_for_page');
  assert.equal(read.totals, null);
  assert.ok(read.notes[0].includes('omits rows where every metric is 0'), 'the documented omission behavior is the note');
  assert.ok(read.caveats.some(c => c.code === 'zero_rows_omitted'));
  // And an authorized property with NO rows at all is a valid empty window.
  const empty = await sandbox(t);
  const emptyClient = scriptedGa4Client({ keyEvents: KEY_EVENTS_LIST, script: [{ rows: [] }, { rows: [] }] });
  await refreshGa4Context({ client: emptyClient, paths: empty.paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  const emptyRows = (await readGa4Rows(empty.paths.ga4)).rows;
  assert.ok(emptyRows.filter(r => r.kind === 'ga4.window').every(m => m.state === 'ga4_empty_window'));
  const emptyRead = landingPageContext({ rows: emptyRows, page: 'https://example.com/any', connection: { grant: 'ok' } });
  assert.equal(emptyRead.state, 'ga4_empty_window');
});

// ---------------------------------------------------------------------------
// Fixture: the no-join acceptance, made executable
// ---------------------------------------------------------------------------

test('no invented query-to-person joins: query dimensions are refused by name, and the business layer never carries a query', () => {
  for (const dimension of ['searchTerm', 'googleAdsQuery', 'firstUserGoogleAdsQuery', 'sa360Query', 'firstUserSa360Query']) {
    assert.throws(() => validateGa4Report({ dimensions: ['landingPagePlusQueryString', dimension] }), e => e.reason === 'query_dimension_refused', dimension);
  }
  for (const dimension of ['userId', 'clientId', 'userKey']) {
    assert.throws(() => validateGa4Report({ dimensions: [dimension] }), e => e.reason === 'person_level_dimension_refused', dimension);
  }
  for (const dimension of ['userAgeBracket', 'userGender', 'audienceName']) {
    assert.throws(() => validateGa4Report({ dimensions: [dimension] }), e => e.reason === 'thresholded_dimension_refused', dimension);
  }
  assert.throws(() => validateGa4Report({ dimensions: ['sessionSource'] }), e => e.reason === 'dimension_not_allowed');
  assert.throws(() => validateGa4Report({ dimensions: ['landingPagePlusQueryString', 'date'] }), e => e.reason === 'unsupported_dimension_combination');
  assert.throws(() => validateGa4Report({ dimensions: ['landingPagePlusQueryString'], metrics: ['purchaseRevenue'] }), e => e.reason === 'metric_not_allowed');
  assert.equal(validateGa4Report({ dimensions: ['landingPagePlusQueryString'] }).rowLimit, GA4_LIMITS.defaultRowLimit);
  assert.throws(() => validateGa4Report({ dimensions: ['landingPagePlusQueryString'], rowLimit: 250_001 }), e => e.reason === 'row_limit_out_of_range');
});

test('businessContextForPage carries search and business as separate layers and constructs no join', () => {
  const window = WINDOW;
  const gscRows = [{
    kind: 'gsc.page_query', property: 'sc-domain:example.com', page: 'https://example.com/guide', query: 'probate checklist',
    window, type: 'web', aggregationType: 'byPage', dimensions: ['page', 'query'], dataState: 'final',
    clicks: 9, impressions: 300, position: 8.9, retrieved_by: 'linktrail-gsc', fetched_at: '2026-09-12T10:00:00Z',
  }, {
    kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide',
    window, type: 'web', aggregationType: 'byPage', dimensions: ['page'], dataState: 'final',
    clicks: 12, impressions: 340, position: 8.4, retrieved_by: 'linktrail-gsc', fetched_at: '2026-09-12T10:00:00Z',
  }];
  const ga4Rows = [{
    kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/guide', event_name: null, date: null,
    window, dimensions: ['landingPagePlusQueryString'], metrics: METRICS, keep_empty_rows: false,
    rows_returned: 1, truncated: false, caveats: ['property_dates', 'attribution', 'counting', 'currency'],
    retrieved_by: 'linktrail-ga4', fetched_at: '2026-09-12T10:00:00Z',
    sessions: 412, key_events: 9, event_count: 1600, total_revenue: 730.5,
  }];
  const result = businessContextForPage({ gscRows, ga4Rows, page: 'https://example.com/guide', window });
  assert.equal(result.relation, 'side_by_side_not_joined');
  assert.equal(result.layers.search.state, 'ok');
  assert.equal(result.layers.business.state, 'ok');
  assert.ok(result.caveats.some(c => c.code === 'no_join'));
  // The business layer is structurally free of query text; the search layer keeps its own.
  assert.ok(!JSON.stringify(result.layers.business).includes('probate checklist'));
  assert.ok(JSON.stringify(result.layers.search).includes('probate checklist'));
  // No field of the combined output combines a query with a conversion or a revenue figure.
  assert.equal(result.layers.business.totals.total_revenue, 730.5);
  assert.equal(result.layers.search.page_totals.clicks, 12);
  assert.ok(!('query' in result) && !('roi' in result) && !('attributed' in result));
});

// ---------------------------------------------------------------------------
// Fixtures: authorization loss, property errors, quota
// ---------------------------------------------------------------------------

test('revoked-mid-run: 401 after a partial write retains the rows written and labels the run', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedGa4Client({
    keyEvents: KEY_EVENTS_LIST,
    script: [
      { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '10', keyEvents: '1', eventCount: '10', totalRevenue: '0' })] },
      { status: 401 },
    ],
  });
  const result = await refreshGa4Context({ client, paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  assert.equal(result.state, 'ga4_revoked');
  const { rows } = await readGa4Rows(paths.ga4);
  assert.ok(rows.some(r => r.kind === 'ga4.landing_page'), 'partial rows retained');
  const state = await readContextState(paths.contextState);
  assert.equal(state.ga4.grant, 'revoked', 'the state file does not relabel a refusal as ok');
  const read = landingPageContext({ rows: [], page: 'https://example.com/guide', connection: { grant: 'revoked' } });
  assert.equal(read.state, 'ga4_revoked');
});

test('not_authorized on the config read, and property_not_found on a 404', async t => {
  const refused = await sandbox(t);
  const refusedClient = scriptedGa4Client({ keyEvents: [] });
  refusedClient.listKeyEvents = async () => { throw new Ga4ApiError('admin', 403, null); };
  const result = await refreshGa4Context({ client: refusedClient, paths: refused.paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  assert.equal(result.state, 'ga4_not_authorized');
  assert.equal(result.calls.run_report, 0);
  const notFound = await sandbox(t);
  const notFoundClient = scriptedGa4Client({ keyEvents: [] });
  notFoundClient.listKeyEvents = async () => { throw new Ga4ApiError('admin', 404, null); };
  const missing = await refreshGa4Context({ client: notFoundClient, paths: notFound.paths, property: 'properties/123', windows: [WINDOW], now: NOW, sleep: NO_SLEEP });
  assert.equal(missing.state, 'ga4_property_not_found');
});

test('quota-refusal: 429 -> ga4_quota_exceeded, ONE retry after the wait, then stop', async t => {
  const { paths } = await sandbox(t);
  const sleeps = [];
  const client = scriptedGa4Client({ keyEvents: KEY_EVENTS_LIST, script: [{ status: 429 }, { status: 429 }] });
  const result = await refreshGa4Context({
    client, paths, property: 'properties/123', windows: [WINDOW], now: NOW,
    sleep: ms => { sleeps.push(ms); return Promise.resolve(); },
  });
  assert.equal(result.state, 'ga4_quota_exceeded');
  assert.equal(result.quota.retries_used, 1);
  assert.deepEqual(sleeps, [GA4_LIMITS.quotaRetryWaitMs]);
  assert.equal(client.calls.filter(c => c.verb === 'runReport').length, 2, 'first attempt + ONE retry, then the run stops');
});

// ---------------------------------------------------------------------------
// Fixtures: the budget envelope, idempotence, pagination bound
// ---------------------------------------------------------------------------

test('the report budget is enforced, recorded, and an identical re-query is served from the repo', async t => {
  const window = WINDOW;
  const { paths } = await sandbox(t);
  const script = [
    { rows: [apiRow(['landingPagePlusQueryString'], { landingPagePlusQueryString: '/guide' }, { sessions: '10', keyEvents: '1', eventCount: '10', totalRevenue: '0' })] },
    { rows: [apiRow(['landingPagePlusQueryString', 'eventName'], { landingPagePlusQueryString: '/guide', eventName: 'purchase' }, { sessions: '10', keyEvents: '1', eventCount: '1', totalRevenue: '0' })] },
  ];
  const first = await refreshGa4Context({ client: scriptedGa4Client({ keyEvents: KEY_EVENTS_LIST, script }), paths, property: 'properties/123', windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.ok(first.calls.budget_per_property === GA4_LIMITS.refreshReportsPerProperty && first.calls.hard_cap_per_run === GA4_LIMITS.hardCapReportsPerRun, 'the envelope is recorded in the run output');
  // Re-run: the config read happens again (admin, not report tokens), but no report is re-fetched.
  const second = await refreshGa4Context({ client: scriptedGa4Client({ keyEvents: KEY_EVENTS_LIST, script: [{ rows: [] } /* any report call would be a defect */] }), paths, property: 'properties/123', windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.equal(second.calls.run_report, 0);
  assert.equal(second.served_from_repo, 2, 'both shapes were served from the repo');
  // Budget enforcement: a cap of 1 leaves the event shape unbought.
  const capped = await sandbox(t);
  const result = await refreshGa4Context({ client: scriptedGa4Client({ keyEvents: KEY_EVENTS_LIST, script: [{ rows: [] }] }), paths: capped.paths, property: 'properties/123', windows: [window], now: NOW, sleep: NO_SLEEP, limits: { refreshReportsPerProperty: 1 } });
  assert.ok(result.notes.some(note => note.startsWith('budget reached')));
});

test('key-events config pagination is bounded and a partial read says so', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedGa4Client({ keyEvents: KEY_EVENTS_LIST, keyEventsSecondPage: { keyEvents: [{ name: 'properties/123/keyEvents/3', eventName: 'demo', countingMethod: 'ONCE_PER_EVENT' }], nextPageToken: 'page-3' }, script: [] });
  const result = await refreshGa4Context({ client, paths, property: 'properties/123', windows: [], now: NOW, sleep: NO_SLEEP });
  assert.equal(result.key_events_config_partial, true);
  assert.ok(result.notes.some(note => note.includes('partial')));
  assert.equal(client.calls.filter(c => c.verb === 'listKeyEvents').length, GA4_LIMITS.keyEventListPages, 'pagination stops at the bound');
});

// ---------------------------------------------------------------------------
// Fixture: agent GA4 handoff (the T04 decision: same shape as the GSC handoff)
// ---------------------------------------------------------------------------

test('ga4 handoff: connector rows keep retrieved_by/captured_at; malformed rows refused with what is missing', async t => {
  const { paths } = await sandbox(t);
  const ours = {
    kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/guide', event_name: null, date: null,
    window: WINDOW, dimensions: ['landingPagePlusQueryString'], metrics: METRICS,
    sessions: 5, key_events: 0, event_count: 5, total_revenue: 0,
    retrieved_by: 'linktrail-ga4', fetched_at: '2026-09-10T09:00:00Z',
  };
  await writeFile(paths.ga4, JSON.stringify(ours) + '\n', 'utf8');
  const snapshot = [
    { kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/other', event_name: null, date: null,
      window: { start: '2026-08-15', end: '2026-09-11' }, dimensions: ['landingPagePlusQueryString'], metrics: METRICS,
      sessions: 77, key_events: 2, event_count: 77, total_revenue: 12,
      retrieved_by: 'customer-ga4-connector', captured_at: '2026-09-10T18:22:00Z' },
    { kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/no-window', retrieved_by: 'customer-ga4-connector' },
    { kind: 'gsc.page', property: 'sc-domain:example.com', window: { start: '2026-08-15', end: '2026-09-11' }, retrieved_by: 'customer-ga4-connector' },
    { kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/no-connector', window: { start: '2026-08-15', end: '2026-09-11' } },
    { kind: 'ga4.key_events_config', property: 'properties/123', key_events: [], retrieved_by: 'customer-ga4-connector', captured_at: '2026-09-10T18:22:00Z' },
    { kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/guide', event_name: null, date: null,
      window: { start: '2026-08-15', end: '2026-09-11' }, dimensions: ['landingPagePlusQueryString'], metrics: METRICS,
      sessions: 999, key_events: 99, event_count: 999, total_revenue: 999,
      retrieved_by: 'customer-ga4-connector', captured_at: '2026-09-11T00:00:00Z' },
  ];
  const result = await importGa4Handoff({ paths, text: JSON.stringify(snapshot), now: NOW });
  assert.equal(result.accepted, 2, 'the landing page and the unwindowed config row import');
  assert.deepEqual(result.refused.map(r => r.reason), [
    'missing window', 'missing kind (must start "ga4.")', 'missing retrieved_by (the connector must be named, and never us)',
    'a row we fetched for this key exists; ours is kept',
  ]);
  const { rows } = await readGa4Rows(paths.ga4);
  const imported = rows.find(r => r.landing_page === '/other');
  assert.equal(imported.retrieved_by, 'customer-ga4-connector', 'never re-labeled as fetched by us');
  assert.equal(imported.captured_at, '2026-09-10T18:22:00Z');
  assert.equal(imported.fetched_at, undefined);
  assert.equal(rows.filter(r => r.landing_page === '/guide' && r.retrieved_by === 'linktrail-ga4').length, 1, 'our row is intact');
  // Imported rows are readable with no grant from us at all.
  const read = landingPageContext({ rows, page: 'https://example.com/other', connection: { grant: 'none' }, window: WINDOW });
  assert.equal(read.state, 'ok');
  assert.equal(read.totals.sessions, 77);
});

// ---------------------------------------------------------------------------
// Property identity, path matching, forget, vocabulary, frozen transports
// ---------------------------------------------------------------------------

test('parseGa4Property normalizes every accepted spelling and refuses the rest', () => {
  assert.equal(parseGa4Property('properties/123'), 'properties/123');
  assert.equal(parseGa4Property('123'), 'properties/123');
  assert.equal(parseGa4Property(123), 'properties/123');
  assert.throws(() => parseGa4Property('example.com'), e => e.reason === 'invalid_ga4_property');
  assert.throws(() => parseGa4Property(''), e => e.reason === 'invalid_ga4_property');
  assert.equal(ga4LandingPageOf('https://example.com/guide?x=1'), '/guide?x=1');
  assert.equal(ga4LandingPageOf('not a url'), null);
});

test('landing-page matching tolerates percent-encoding differences and reports its basis', () => {
  const rows = [{ kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/g%C3%BCide', window: WINDOW, dimensions: ['landingPagePlusQueryString'], caveats: [], retrieved_by: 'linktrail-ga4', fetched_at: '2026-09-12T10:00:00Z', sessions: 1, key_events: 0, event_count: 1, total_revenue: 0 }];
  const read = landingPageContext({ rows, page: 'https://example.com/güide' });
  assert.equal(read.state, 'ok');
  assert.equal(read.match_basis, 'path_after_origin_strip');
});

test('forget removes only the GA4 facts and GA4 state; GSC rows and human-owned files survive', async t => {
  const { paths } = await sandbox(t, { manual: '# Site context\n', state: { connection: { grant: 'ok' } } });
  await writeFile(paths.gsc, '{"kind":"gsc.window"}\n', 'utf8');
  await writeFile(paths.ga4, '{"kind":"ga4.window"}\n', 'utf8');
  await writeFile(paths.siteProfile, '# Site profile\n', 'utf8');
  const result = await forgetGa4Context({ paths });
  assert.deepEqual(result.removed.map(r => r.name), ['ga4']);
  const state = await readContextState(paths.contextState);
  assert.equal(state.connection.grant, 'ok', 'the GSC half of the shared state file survives');
  assert.equal(state.ga4, undefined, 'the GA4 half is gone');
  const gsc = await readFile(paths.gsc, 'utf8');
  assert.ok(gsc.includes('gsc.window'), 'GSC rows untouched');
  const manual = await readFile(paths.manual, 'utf8');
  assert.equal(manual, '# Site context\n');
  const profile = await readFile(paths.siteProfile, 'utf8');
  assert.equal(profile, '# Site profile\n');
});

test('the GA4 state vocabulary is exactly the implemented set, and the scope is analytics.readonly only', () => {
  const expected = ['ok', 'ga4_absent', 'ga4_not_authorized', 'ga4_revoked', 'ga4_property_not_found',
    'ga4_empty_window', 'ga4_no_row_for_page', 'ga4_thresholded', 'ga4_sampled',
    'ga4_data_loss_other_row', 'ga4_metric_restricted', 'ga4_truncated', 'ga4_no_key_events_configured',
    'ga4_quota_exceeded'];
  assert.deepEqual([...GA4_STATES], expected);
  assert.equal(GA4_SCOPE, 'https://www.googleapis.com/auth/analytics.readonly');
});

test('the shipped Google transports expose exactly their documented read verbs and nothing else', () => {
  // The no-Links-API / no-AI-report-API boundary, made structural: neither transport can grow a
  // links or AI-report verb without this test failing. Verified against the published API
  // references on 2026-09-12 (see export-and-ai-report-boundaries-2026-09-12.md).
  const ga4 = createGa4Client({ getAccessToken: () => 'not-a-real-token' });
  assert.deepEqual(Object.keys(ga4).sort(), ['listKeyEvents', 'runReport', 'scope']);
  assert.throws(() => { ga4.links = () => {}; }, TypeError, 'the surface is frozen');
  const gsc = createGoogleClient({ getAccessToken: () => 'not-a-real-token' });
  assert.deepEqual(Object.keys(gsc).sort(), ['listSites', 'scope', 'searchAnalytics']);
});

// newest-wins discipline for GA4 rows
test('newest wins at read time for the same GA4 fact key', () => {
  const base = { kind: 'ga4.landing_page', property: 'properties/123', landing_page: '/guide', event_name: null, date: null, window: WINDOW, dimensions: ['landingPagePlusQueryString'], retrieved_by: 'linktrail-ga4' };
  const rows = [
    { ...base, sessions: 3, fetched_at: '2026-09-10T09:00:00Z' },
    { ...base, sessions: 412, fetched_at: '2026-09-12T10:04:00Z' },
  ];
  assert.equal(newestGa4Rows(rows).length, 1);
  const read = landingPageContext({ rows, page: 'https://example.com/guide' });
  assert.equal(read.totals.sessions, 412);
});
