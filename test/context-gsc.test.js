// DP-0017-T02 acceptance, against the contract's fixture table. Every state is proven by a
// fixture client over the real module — no live Google, no credentials, no network. Mocks and
// any real authorized connection are separate by construction: the HTTP transport in
// src/context/gsc.js is never touched by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  contextPaths, refreshContext, pageContext, siteTotalsContext, windowComparison,
  selectFocusPages, buildManualContext, parseManual, readManual, importHandoff, forgetContext,
  readContextState, readGscRows, rowsFromResponse, validateSearchQuery, pageWithinProperty,
  classifyPageCoverage, assertComparable, recentWindows, windowFromRange, probeFirstAvailableDate,
  newestWinningRows, CONTEXT_LIMITS, GscApiError, ContextError, CONTEXT_STATES,
} from '../src/context/gsc.js';

const NOW = () => new Date('2026-09-12T10:00:00Z');
const NO_SLEEP = () => Promise.resolve();

async function sandbox(t, { manual = null, state = null, gsc = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = contextPaths({ dir });
  await mkdir(dirname(paths.gsc), { recursive: true });
  if (manual !== null) await writeFile(paths.manual, manual, 'utf8');
  if (state !== null) await writeFile(paths.contextState, JSON.stringify(state), 'utf8');
  if (gsc !== null) await writeFile(paths.gsc, gsc.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  else await writeFile(paths.gsc, '', 'utf8');
  return { dir, paths };
}

/** A scripted GSC client. `script` entries: { rows, firstIncompleteDate? } | { status } (an HTTP refusal). */
function scriptedClient({ sites = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }], script = [] } = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async listSites() { calls.push({ verb: 'listSites' }); return sites; },
    async searchAnalytics(property, body) {
      calls.push({ verb: 'query', property, body });
      if (index >= script.length) throw new Error(`script exhausted at call ${calls.length} — the run made a call it should not have`);
      const step = script[index++];
      if (step.status !== undefined) throw new GscApiError(step.status, step.body ?? null);
      return { rows: step.rows ?? [], responseMetadata: step.firstIncompleteDate ? { firstIncompleteDate: step.firstIncompleteDate } : undefined };
    },
  };
}

const row = (keys, clicks, impressions, position) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const win = windowFromRange;

// ---------------------------------------------------------------------------
// Fixture: empty-site
// ---------------------------------------------------------------------------

test('empty-site: authorized, covered, zero rows -> empty_site marker, no error, no invented zeros', async t => {
  const window = win('2026-09-01', '2026-09-11');
  const { paths } = await sandbox(t);
  const client = scriptedClient({
    script: [
      { rows: [row([], 0, 0, 0)] },  // availability probe: September has rows, keep probing
      { rows: [row([], 5, 50, 9)] },  // August has rows
      { rows: [] },                   // July: the observed floor is 2026-07-01
      { rows: [] },                   // window grouping page: empty
      { rows: [] },                   // window grouping page+query: empty
    ],
  });
  const result = await refreshContext({ client, paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP });
  const property = result.properties[0];
  assert.equal(property.state, 'ok');
  assert.deepEqual(property.windows.map(w => w.state).filter(s => s === 'empty_site').length, 2, 'both groupings are empty_site');
  const { rows } = await readGscRows(paths.gsc);
  const markers = rows.filter(r => r.kind === 'gsc.window');
  assert.equal(markers.length, 2);
  assert.ok(markers.every(m => m.state === 'empty_site'));
  // No invented zeros: there are no metric rows at all, and the marker carries no page-metrics.
  assert.equal(rows.filter(r => r.kind !== 'gsc.window').length, 0);
  assert.equal(markers[0].clicks, undefined);
  const read = pageContext({ rows, page: 'https://example.com/any', window, properties: ['sc-domain:example.com'], connection: { grant: 'ok' } });
  assert.equal(read.state, 'empty_site');
  assert.equal(read.page_totals, null);
  assert.ok(read.notes[0].includes('a valid state, not an error'));
});

// ---------------------------------------------------------------------------
// Fixture: truncated-top-rows
// ---------------------------------------------------------------------------

test('truncated-top-rows: the cap sets truncated, and a sum of returned rows is never a site total', async t => {
  const window = win('2026-08-15', '2026-09-11');
  const many = Array.from({ length: CONTEXT_LIMITS.defaultRowLimit }, (_, i) => row([`https://example.com/p/${i}`], 1, 10, 5));
  const { paths } = await sandbox(t);
  const client = scriptedClient({
    script: [
      { rows: [row([], 1, 1, 1)] }, { rows: [] },     // probe: floor two months back
      { rows: many },                                  // page grouping hits the cap
      { rows: many.slice(0, 3) },                      // page+query under the cap
    ],
  });
  const result = await refreshContext({ client, paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.ok(result.states.includes('truncated_top_rows'));
  const { rows } = await readGscRows(paths.gsc);
  const marker = rows.find(r => r.kind === 'gsc.window' && r.truncated === true);
  assert.ok(marker, 'the window marker carries truncated:true');
  assert.equal(marker.rows_returned, CONTEXT_LIMITS.defaultRowLimit);
  const read = pageContext({ rows, page: 'https://example.com/p/1', window });
  assert.equal(read.state, 'truncated_top_rows');
  assert.ok(read.notes[0].includes('not in the returned top rows'));
  // A capped byProperty answer refuses to be a site total.
  const totals = siteTotalsContext({
    rows: [{ ...rows.find(r => r.kind === 'gsc.page'), kind: 'gsc.property', page: null, truncated: true }],
    window,
  });
  assert.equal(totals.state, 'truncated_top_rows');
  assert.equal(totals.totals, null);
  assert.ok(totals.notes[0].includes('would be presented as a site total it is not'));
});

// ---------------------------------------------------------------------------
// Fixture: incomplete-window
// ---------------------------------------------------------------------------

test('incomplete-window: first_incomplete_date labels rows, final-through is stated, nothing blends', async t => {
  const window = win('2026-08-15', '2026-09-11');
  const { paths } = await sandbox(t);
  const client = scriptedClient({
    script: [
      { rows: [row([], 1, 1, 1)] }, { rows: [] },
      { rows: [row(['https://example.com/guide'], 12, 340, 8.4)], firstIncompleteDate: '2026-09-11' },
      { rows: [row(['https://example.com/guide', 'probate checklist'], 9, 300, 8.9)], firstIncompleteDate: '2026-09-11' },
    ],
  });
  const result = await refreshContext({ client, paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.ok(result.states.includes('incomplete_window'));
  const { rows } = await readGscRows(paths.gsc);
  const factRow = rows.find(r => r.kind === 'gsc.page');
  assert.equal(factRow.first_incomplete_date, '2026-09-11');
  const read = pageContext({ rows, page: 'https://example.com/guide', window });
  assert.equal(read.state, 'incomplete_window');
  assert.equal(read.final_through, '2026-09-10', 'final-through is the day BEFORE the incomplete boundary');
  assert.equal(read.page_totals.ctr, Math.round((12 / 340) * 10_000) / 10_000, 'ctr is derived at read time, raw counts stored');
  assert.equal(read.page_totals.average_position, 8.4);
});

// ---------------------------------------------------------------------------
// Fixture: omitted-days
// ---------------------------------------------------------------------------

test('omitted-days: days_reported sits beside days_requested, never backfilled', () => {
  const window = win('2026-09-05', '2026-09-11'); // 7 days
  const present = ['2026-09-05', '2026-09-06', '2026-09-08', '2026-09-09', '2026-09-11'];
  const request = validateSearchQuery({ type: 'web', aggregationType: 'byProperty', dimensions: ['date'], rowLimit: 1000 });
  const { marker } = rowsFromResponse({
    property: 'sc-domain:example.com', request, window, fetchedAt: '2026-09-12T10:00:00Z',
    response: { rows: present.map(day => row([day], 3, 40, 7)) },
  });
  assert.equal(marker.days_requested, 7);
  assert.equal(marker.days_reported, 5, 'an omitted day is Google returning no row, which is not zero impressions');
  assert.equal(marker.days_reported_basis, 'distinct_dates_in_rows');
  // Without a date dimension the count is not derivable, and says so instead of inventing 7.
  const pageRequest = validateSearchQuery({ type: 'web', aggregationType: 'byPage', dimensions: ['page'] });
  const { marker: pageMarker } = rowsFromResponse({
    property: 'sc-domain:example.com', request: pageRequest, window,
    response: { rows: [row(['https://example.com/'], 3, 40, 7)] },
  });
  assert.equal(pageMarker.days_reported, null);
  assert.equal(pageMarker.days_reported_basis, 'not_derivable_from_grouping');
});

// ---------------------------------------------------------------------------
// Fixture: revoked-mid-run
// ---------------------------------------------------------------------------

test('revoked-mid-run: 401 after a partial fetch keeps the rows already written and labels the run', async t => {
  const window = win('2026-08-15', '2026-09-11');
  const { paths } = await sandbox(t);
  const client = scriptedClient({
    script: [
      { rows: [row([], 1, 1, 1)] }, { rows: [] },  // probe
      { rows: [row(['https://example.com/guide'], 12, 340, 8.4)] }, // written
      { status: 401 },                              // revoked before the second grouping
    ],
  });
  const result = await refreshContext({ client, paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.equal(result.state, 'revoked');
  const { rows } = await readGscRows(paths.gsc);
  assert.equal(rows.filter(r => r.kind === 'gsc.page').length, 1, 'partial rows retained');
  assert.ok(rows.every(r => r.retrieved_by === 'linktrail-gsc' && r.fetched_at));
  const state = await readContextState(paths.contextState);
  assert.equal(state.connection.grant, 'revoked', 'the state file does not relabel a refusal as ok');
  const refused = result.properties[0].windows.find(w => w.state === 'revoked');
  assert.equal(refused.partial, true);
});

// ---------------------------------------------------------------------------
// Fixture: property-coverage (and the restricted/unverified permission levels)
// ---------------------------------------------------------------------------

test('property-coverage: a page outside every property is page_outside_property, never zeros', () => {
  assert.equal(pageWithinProperty('https://example.com/a', 'sc-domain:example.com'), true);
  assert.equal(pageWithinProperty('https://shop.example.com/a', 'sc-domain:example.com'), true, 'a domain property covers subdomains');
  assert.equal(pageWithinProperty('https://notexample.com/a', 'sc-domain:example.com'), false);
  assert.equal(pageWithinProperty('https://example.com/blog/x', 'https://example.com/blog/'), true, 'a URL-prefix property covers exactly that prefix');
  assert.equal(pageWithinProperty('https://example.com/other', 'https://example.com/blog/'), false);
  assert.equal(classifyPageCoverage('https://elsewhere.org/x', ['sc-domain:example.com']), 'page_outside_property');
  const read = pageContext({ rows: [], page: 'https://elsewhere.org/x', properties: ['sc-domain:example.com'] });
  assert.equal(read.state, 'page_outside_property');
  assert.equal(read.rows_returned, 0);
  assert.deepEqual(read.queries, []);
});

test('permission-restricted and unverified properties are surfaced, not silently used', async t => {
  const { paths } = await sandbox(t);
  const client = scriptedClient({
    sites: [
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
      { siteUrl: 'sc-domain:unverified.com', permissionLevel: 'siteUnverifiedUser' },
    ],
    script: [],
  });
  const result = await refreshContext({ client, paths, properties: ['sc-domain:example.com', 'sc-domain:unverified.com'], windows: [win('2026-09-01', '2026-09-11')], now: NOW, sleep: NO_SLEEP });
  assert.deepEqual(result.properties.map(p => p.state), ['permission_restricted', 'property_not_verified']);
  assert.equal(result.calls.search_analytics, 0, 'no query is spent on a property we may not read');
  assert.deepEqual(result.properties.map(p => p.permissionLevel), ['siteRestrictedUser', 'siteUnverifiedUser'], 'the level is surfaced to the customer');
});

// ---------------------------------------------------------------------------
// Fixture: quota-refusal
// ---------------------------------------------------------------------------

test('quota-refusal: 429 -> quota_exceeded with the 15-minute hint, ONE retry, then stop', async t => {
  const window = win('2026-08-15', '2026-09-11');
  const { paths } = await sandbox(t);
  const sleeps = [];
  const client = scriptedClient({
    script: [
      { rows: [row([], 1, 1, 1)] }, { rows: [] }, // probe
      { status: 429 }, { status: 429 },           // first refusal, then the single retry's refusal
    ],
  });
  const result = await refreshContext({
    client, paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW,
    sleep: ms => { sleeps.push(ms); return Promise.resolve(); },
  });
  assert.equal(result.state, 'quota_exceeded');
  assert.equal(result.quota.hint_minutes, 15);
  assert.equal(result.quota.retries_used, 1);
  assert.deepEqual(sleeps, [CONTEXT_LIMITS.quotaRetryHintMinutes * 60_000], 'the documented wait is 15 minutes');
  assert.equal(client.calls.filter(c => c.verb === 'query').length, 4, 'probe(2) + first attempt + ONE retry, then the run stops');
});

// ---------------------------------------------------------------------------
// Fixture: manual-only
// ---------------------------------------------------------------------------

const MANUAL_MD = `# Site context

## Target pages
- https://example.com/probate-checklist
- https://example.com/tools/estate-estimator

## Site description
A plain-English estate-settlement guide for families in probate.

## What we sell
A guided probate checklist product with a free estimator tool.

## Known assets
- Estate cost estimator
- State-by-state probate guide

## Competitors
- biglaw-example.com
`;

test('manual-only: the whole context path runs from manual.md with no Google at all', async t => {
  const { paths } = await sandbox(t, { manual: MANUAL_MD });
  const result = await refreshContext({ client: null, paths, now: NOW, sleep: NO_SLEEP });
  assert.equal(result.state, 'manual_only');
  assert.equal(result.rows_written, 0);
  const manual = await readManual(paths.manual);
  assert.equal(manual.present, true);
  assert.equal(manual.target_pages.length, 2);
  assert.equal(manual.site_description, 'A plain-English estate-settlement guide for families in probate.');
  assert.deepEqual(manual.assets, ['Estate cost estimator', 'State-by-state probate guide']);
  const context = buildManualContext({ manual });
  assert.equal(context.state, 'manual_only');
  assert.equal(context.pages.length, 2);
  assert.ok(context.pages.every(p => p.nominated_by[0] === 'manual' && p.observation === null && p.inference === null && p.recommendation === null));
  const focus = selectFocusPages({ manual, rows: [] });
  assert.equal(focus.pages.length, 2, 'selection works with zero GSC rows');
  assert.equal(focus.basis.gsc, 'no_rows');
  const read = pageContext({ rows: [], page: 'https://example.com/probate-checklist', connection: { grant: 'none' }, manual });
  assert.equal(read.state, 'manual_only');
  assert.ok(manual.entries.every(e => e.source === 'manual'));
});

test('parseManual is tolerant of heading case, numbered bullets and missing sections', () => {
  const parsed = parseManual('## target PAGES\n1. https://a.example/x\n\n## ASSETS\n* Study 2026\n');
  assert.deepEqual(parsed.target_pages, ['https://a.example/x']);
  assert.deepEqual(parsed.assets, ['Study 2026']);
  assert.equal(parsed.offering, null);
  assert.deepEqual(parseManual(''), { present: false, entries: [], target_pages: [], site_description: null, offering: null, assets: [], competitors: [] });
});

// ---------------------------------------------------------------------------
// Fixture: agent-handoff
// ---------------------------------------------------------------------------

test('agent-handoff: connector rows keep retrieved_by/captured_at; malformed rows refused with what is missing', async t => {
  const { paths } = await sandbox(t);
  const ours = {
    kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide',
    window: win('2026-08-15', '2026-09-11'), type: 'web', aggregationType: 'byPage', dimensions: ['page'],
    dataState: 'final', clicks: 5, impressions: 100, position: 12, retrieved_by: 'linktrail-gsc', fetched_at: '2026-09-10T09:00:00Z',
  };
  await writeFile(paths.gsc, JSON.stringify(ours) + '\n', 'utf8');
  const snapshot = [
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide2', query: null,
      window: { start: '2026-08-15', end: '2026-09-11' }, aggregationType: 'byPage', dataState: 'final',
      clicks: 7, impressions: 210, position: 6.2, retrieved_by: 'customer-connector', captured_at: '2026-09-10T18:22:00Z' },
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/no-window', aggregationType: 'byPage', retrieved_by: 'customer-connector' },
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/no-agg', window: { start: '2026-08-15', end: '2026-09-11' }, retrieved_by: 'customer-connector' },
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/no-connector', window: { start: '2026-08-15', end: '2026-09-11' }, aggregationType: 'byPage' },
    // Same fact key as the row WE fetched, offered by a connector: ours is kept, never overwritten.
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', query: null,
      window: { start: '2026-08-15', end: '2026-09-11' }, type: 'web', aggregationType: 'byPage', dimensions: ['page'],
      dataState: 'final', clicks: 99, impressions: 999, position: 1, retrieved_by: 'customer-connector', captured_at: '2026-09-11T00:00:00Z' },
  ];
  const result = await importHandoff({ paths, text: JSON.stringify(snapshot), now: NOW });
  assert.equal(result.accepted, 1);
  assert.deepEqual(result.refused.map(r => r.reason), [
    'missing window', 'missing aggregationType', 'missing retrieved_by (the connector must be named, and never us)',
    'a row we fetched for this key exists; ours is kept',
  ]);
  const { rows } = await readGscRows(paths.gsc);
  const imported = rows.find(r => r.page === 'https://example.com/guide2');
  assert.equal(imported.retrieved_by, 'customer-connector', 'never re-labeled as fetched by us');
  assert.equal(imported.captured_at, '2026-09-10T18:22:00Z', "the connector's capture date survives");
  assert.equal(imported.fetched_at, undefined);
  assert.equal(rows.filter(r => r.page === 'https://example.com/guide' && r.retrieved_by === 'linktrail-gsc').length, 1, 'our row is intact');
  const state = await readContextState(paths.contextState);
  assert.deepEqual(state.handoff.connectors, ['customer-connector']);
  // The imported rows are readable by the ordinary read path with no grant from us at all.
  const read = pageContext({ rows, page: 'https://example.com/guide2', connection: { grant: 'none' } });
  assert.equal(read.state, 'ok');
  assert.equal(read.page_totals.clicks, 7);
});

test('agent-handoff: a Markdown snapshot table imports the same way', async t => {
  const { paths } = await sandbox(t);
  const markdown = [
    '| kind | property | page | window.start | window.end | aggregationType | dataState | clicks | impressions | position | retrieved_by | captured_at |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| gsc.page | sc-domain:example.com | https://example.com/md | 2026-08-15 | 2026-09-11 | byPage | final | 3 | 90 | 11 | md-connector | 2026-09-11T08:00:00Z |',
  ].join('\n');
  const result = await importHandoff({ paths, text: markdown, now: NOW });
  assert.equal(result.accepted, 1);
  const { rows } = await readGscRows(paths.gsc);
  assert.equal(rows[0].window.days, 28, 'days are derived when the snapshot omits them');
});

// ---------------------------------------------------------------------------
// Fixture: availability-probe
// ---------------------------------------------------------------------------

test('availability-probe: bounded at 24 monthly probes, cached, floor reported as observed', async t => {
  const { paths } = await sandbox(t);
  const dataEverywhere = Array.from({ length: 30 }, () => ({ rows: [row([], 1, 1, 1)] }));
  const client = scriptedClient({ script: dataEverywhere });
  const first = await probeFirstAvailableDate({ client, property: 'sc-domain:example.com', state: {}, now: NOW });
  assert.equal(first.probes_used, CONTEXT_LIMITS.availabilityProbes, 'the probe stops at its bound');
  assert.equal(first.first_available_date, null);
  assert.equal(first.basis, 'probe_exhausted_data_in_every_probed_month');
  const second = await probeFirstAvailableDate({ client, property: 'sc-domain:example.com', state: { availability: { 'sc-domain:example.com': first } }, now: NOW });
  assert.equal(second.cached, true);
  assert.equal(second.calls, 0, 'a cached floor costs no calls within its lifetime');
  // A floor found three months back refuses older windows.
  const floored = scriptedClient({ script: [{ rows: [row([], 1, 1, 1)] }, { rows: [row([], 1, 1, 1)] }, { rows: [] }] });
  const probe = await probeFirstAvailableDate({ client: floored, property: 'sc-domain:example.com', state: {}, now: NOW });
  assert.equal(probe.first_available_date, '2026-07-01');
  assert.equal(probe.basis, 'observed_first_month_without_rows');
  const refresh = await refreshContext({
    client: scriptedClient({ script: [{ rows: [row([], 1, 1, 1)] }, { rows: [] }] }),
    paths, properties: ['sc-domain:example.com'], windows: [win('2026-05-01', '2026-05-28')], now: NOW, sleep: NO_SLEEP,
    limits: {},
  });
  assert.ok(refresh.states.includes('window_before_available_data'));
  assert.equal(refresh.rows_written, 0, 'a pre-floor window writes no rows — not zeros');
  const older = refresh.properties[0].windows[0];
  assert.equal(older.state, 'window_before_available_data');
});

// ---------------------------------------------------------------------------
// Idempotence and the self-imposed call budget.
// ---------------------------------------------------------------------------

test('an identical re-query inside the freshness lifetime is served from the repo and makes no API call', async t => {
  const window = win('2026-08-15', '2026-09-11');
  const { paths } = await sandbox(t);
  const script = [
    { rows: [row([], 1, 1, 1)] }, { rows: [] },
    { rows: [row(['https://example.com/guide'], 12, 340, 8.4)] },
    { rows: [row(['https://example.com/guide', 'probate checklist'], 9, 300, 8.9)] },
  ];
  const first = await refreshContext({ client: scriptedClient({ script }), paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.ok(first.rows_written >= 2);
  const second = await refreshContext({ client: scriptedClient({ script: [{ rows: [row([], 9, 9, 9)] }] /* any call would be a defect */ }), paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP });
  assert.equal(second.calls.search_analytics, 0);
  assert.equal(second.served_from_repo, 2, 'both groupings were served from the repo');
  assert.ok(second.calls.budget_per_property === CONTEXT_LIMITS.refreshCallsPerProperty && second.calls.hard_cap_per_run === CONTEXT_LIMITS.hardCapCallsPerRun, 'the envelope is recorded in the run output');
});

test('the refresh budget is enforced and reported when the standard set would exceed it', async t => {
  const window = win('2026-08-15', '2026-09-11');
  const { paths } = await sandbox(t);
  const client = scriptedClient({ script: [{ rows: [row([], 1, 1, 1)] }, { rows: [] }, { rows: [row(['https://example.com/guide'], 1, 2, 3)] }] });
  const result = await refreshContext({ client, paths, properties: ['sc-domain:example.com'], windows: [window], now: NOW, sleep: NO_SLEEP, limits: { refreshCallsPerProperty: 3 } });
  assert.ok(result.notes.some(note => note.startsWith('budget reached')), 'the cap the run hit is reported');
  assert.equal(result.calls.search_analytics, 3);
  assert.equal(result.properties[0].availability.basis, 'probe_budget_reached');
  assert.equal(result.properties[0].windows.length, 2, 'report calls are reserved before optional availability probes');
});

// ---------------------------------------------------------------------------
// Window comparability, aggregation validation, read-time discipline.
// ---------------------------------------------------------------------------

test('only comparable windows may be compared: unequal, overlapping and identical are refused', () => {
  const a = win('2026-08-15', '2026-09-11');
  const sameLength = win('2026-08-16', '2026-09-12');
  const yearApart = win('2025-08-15', '2025-09-11');
  const longer = win('2026-08-08', '2026-09-11');
  assert.throws(() => assertComparable(a, longer), e => e.reason === 'windows_not_comparable');
  assert.throws(() => assertComparable(a, sameLength), e => e.details.reason === 'overlapping');
  assert.throws(() => assertComparable(a, { ...a }), e => e.details.reason === 'same_window');
  assert.equal(assertComparable(a, yearApart), true, 'aligned windows a year apart are seasonality, allowed');
  assert.deepEqual(recentWindows({ days: 28, count: 2, end: '2026-09-11' }).map(w => `${w.start}..${w.end}`), ['2026-07-18..2026-08-14', '2026-08-15..2026-09-11']);
});

test("aggregationType is always explicit and Google's own constraints travel with the rule", () => {
  assert.throws(() => validateSearchQuery({ type: 'web' }), e => e.reason === 'aggregation_type_required');
  assert.throws(() => validateSearchQuery({ type: 'web', aggregationType: 'auto' }), e => e.reason === 'aggregation_type_required');
  assert.throws(() => validateSearchQuery({ type: 'discover', aggregationType: 'byProperty' }), e => e.reason === 'byProperty_not_supported_for_type');
  assert.throws(() => validateSearchQuery({ type: 'web', aggregationType: 'byProperty', dimensions: ['page'] }), e => e.reason === 'page_grouping_cannot_aggregate_by_property');
  assert.throws(() => validateSearchQuery({ type: 'web', aggregationType: 'byPage', rowLimit: 25_001 }), e => e.reason === 'row_limit_out_of_range');
  assert.equal(validateSearchQuery({ type: 'web', aggregationType: 'byPage' }).rowLimit, CONTEXT_LIMITS.defaultRowLimit);
});

test('windowComparison: comparable windows delta; mixed aggregationTypes refused; absence reported not zeroed', () => {
  const a = win('2026-08-15', '2026-09-11'), b = win('2026-07-18', '2026-08-14');
  const rows = [
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', window: a, aggregationType: 'byPage', clicks: 25, impressions: 500, position: 7 },
    { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', window: b, aggregationType: 'byPage', clicks: 10, impressions: 400, position: 9 },
  ];
  const delta = windowComparison({ rows, windowA: a, windowB: b, page: 'https://example.com/guide' });
  assert.equal(delta.state, 'ok');
  assert.equal(delta.delta.clicks, 15);
  assert.equal(delta.delta.clicks_change, 1.5, '25 from 10 is +150%');
  assert.equal(delta.delta.average_position, -2, 'an average-position delta, labeled as one');
  assert.throws(() => windowComparison({
    rows: [
      { kind: 'gsc.property', property: 'sc-domain:example.com', window: a, aggregationType: 'byProperty', clicks: 1, impressions: 2, position: 3 },
      { kind: 'gsc.property', property: 'sc-domain:example.com', window: b, aggregationType: 'byPage', clicks: 1, impressions: 2, position: 3 },
    ],
    windowA: a, windowB: b,
  }), e => e.reason === 'aggregation_types_mixed');
  const missing = windowComparison({ rows: [rows[0]], windowA: a, windowB: b, page: 'https://example.com/guide' });
  assert.equal(missing.delta, null);
  assert.deepEqual(missing.missing, ['b']);
});

test('nulls stay null: a row missing a metric keeps it null rather than coercing to 0', () => {
  const window = win('2026-08-15', '2026-09-11');
  const rows = [{
    kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', window,
    type: 'web', aggregationType: 'byPage', dimensions: ['page'], dataState: 'final',
    clicks: null, impressions: null, position: null, retrieved_by: 'linktrail-gsc', fetched_at: '2026-09-12T10:00:00Z',
    rows_returned: 1, truncated: false,
  }];
  const read = pageContext({ rows, page: 'https://example.com/guide', window });
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.page_totals, { clicks: null, impressions: null, ctr: null, average_position: null });
});

test('newest wins at read time: a changed answer for the same window is a new row, and the newest one is read', () => {
  const window = win('2026-08-15', '2026-09-11');
  const base = { kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', window, aggregationType: 'byPage', retrieved_by: 'linktrail-gsc' };
  const rows = [
    { ...base, clicks: 3, impressions: 30, position: 20, fetched_at: '2026-09-10T09:00:00Z' },
    { ...base, clicks: 12, impressions: 340, position: 8.4, fetched_at: '2026-09-12T10:04:00Z' },
  ];
  assert.equal(newestWinningRows(rows).length, 1);
  const read = pageContext({ rows, page: 'https://example.com/guide', window });
  assert.equal(read.page_totals.clicks, 12);
  assert.equal(read.rows_returned, 1);
});

// ---------------------------------------------------------------------------
// forget: deletion is a decision, and the human-owned files are never its collateral.
// ---------------------------------------------------------------------------

test('forget removes tool-owned files and reports the human-owned ones as kept', async t => {
  const { paths } = await sandbox(t, { manual: MANUAL_MD, state: { connection: { grant: 'ok' } } });
  await writeFile(paths.siteFacts, '', 'utf8');
  await writeFile(paths.siteProfile, '# Site profile\n', 'utf8');
  const result = await forgetContext({ paths, source: 'gsc' });
  assert.deepEqual(result.removed.map(r => r.name).sort(), ['contextState', 'gsc']);
  assert.deepEqual(result.kept.map(r => r.name).sort(), ['manual', 'siteFacts', 'siteProfile']);
  const all = await forgetContext({ paths, source: 'all' });
  assert.ok(!all.kept.some(r => r.owner === 'tool'));
  assert.ok(all.kept.every(r => r.owner === 'human/agent'), 'manual.md and site-profile.md survive every forget');
  await assert.rejects(() => forgetContext({ paths, source: 'nope' }), e => e instanceof ContextError && e.reason === 'unknown_forget_source');
});

test('the state vocabulary is exactly the contract table plus ok', () => {
  const expected = ['ok', 'manual_only', 'not_authorized', 'revoked', 'property_not_verified', 'permission_restricted',
    'empty_site', 'incomplete_window', 'truncated_top_rows', 'page_outside_property', 'quota_exceeded', 'window_before_available_data'];
  assert.deepEqual([...CONTEXT_STATES], expected);
});


test('availability probes and reports share the real per-property and whole-run budgets', async t => {
  const { paths } = await sandbox(t);
  const properties = Array.from({ length: 6 }, (_, i) => `sc-domain:budget-${i}.example`);
  let calls = 0;
  const client = {
    async listSites() { return properties.map(siteUrl => ({ siteUrl, permissionLevel: 'siteOwner' })); },
    async searchAnalytics() { calls++; return { rows: [row([], 1, 10, 2)] }; },
  };
  const result = await refreshContext({ paths, client, properties: [...properties, properties[0]], now: NOW });
  assert.equal(calls, 50);
  assert.equal(result.calls.search_analytics, calls);
  assert.deepEqual(result.properties.map(p => p.calls), [12, 12, 12, 12, 2, 0]);
  assert.equal(result.properties.length, 6, 'duplicate properties cannot reset the per-property budget');
  assert.equal(result.properties[0].availability.first_available_date, null);
  assert.equal(result.properties[0].availability.basis, 'probe_budget_reached');
  assert.equal(result.properties[0].availability.probes_used, 4);
  assert.equal(result.properties[0].windows.length, 8, 'long history cannot starve page/query reads');
});

test('a final-budget quota refusal cannot make a retry beyond the envelope', async t => {
  const { paths } = await sandbox(t);
  const sleeps = [];
  const client = scriptedClient({ script: [{ status: 429 }] });
  const result = await refreshContext({ paths, client, properties: ['sc-domain:example.com'], windows: [win('2026-08-01', '2026-08-07')],
    limits: { refreshCallsPerProperty: 1 }, now: NOW, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(result.calls.search_analytics, 1);
  assert.equal(result.quota.retries_used, 0);
  assert.equal(result.state, 'quota_exceeded');
  assert.deepEqual(sleeps, []);
});

test('calendar validation refuses rolled-over days at reads and before refresh calls', async t => {
  for (const date of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-2-01']) {
    assert.throws(() => windowFromRange(date, '2026-12-31'), /invalid_window/);
    assert.throws(() => recentWindows({ days: 7, end: date }), /invalid_window/);
  }
  assert.equal(windowFromRange('2024-02-29', '2024-03-01').days, 2);
  const { paths } = await sandbox(t), client = scriptedClient();
  await assert.rejects(refreshContext({ paths, client, properties: ['sc-domain:example.com'], windows: [{ start: '2026-02-30', end: '2026-03-08' }] }), /invalid_window/);
  assert.equal(client.calls.length, 0);
});
