import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachReceiptPerformance } from '../cli/receipt-performance.js';
import { main } from '../cli/main.js';
import { loadConfig } from '../cli/config.js';
import { writeReceipt } from '../cli/receipts.js';

const before = { start: '2026-08-01', end: '2026-08-07' }, after = { start: '2026-08-09', end: '2026-08-15' };
const receipt = { id: 'ar_aaaa', ledger: 'lk_aaaa', target: 'https://example.com/guide', source: 'https://publisher.example.com/post', acted_at: '2026-08-08T12:00:00Z', declared_at: '2026-08-09T12:00:00Z', baseline: { state: 'unknown', checked_at: '2026-08-07T00:00:00Z', complete: false } };
const history = [{ receipt, latest: { state: 'unknown' }, novelty: 'unproven' }];
const spec = { receipt_id: receipt.id, before, after, gsc_property: 'sc-domain:example.com', confounders: ['Title changed during the after window'] };
const row = (window, clicks) => ({ kind: 'gsc.page', property: spec.gsc_property, page: receipt.target, type: 'web', aggregationType: 'byPage', dimensions: ['page'], dataState: 'final', window, clicks, impressions: 100, position: 10, fetched_at: '2026-08-17T00:00:00Z', retrieved_by: 'fixture' });
const options = { gscRows: [row(before, 2), row(after, 5)], now: '2026-08-20T12:00:00Z' };
const context = (s = spec, o = options) => attachReceiptPerformance(history, s, o)[0].performance_context;

test('dated comparison preserves unknown baseline and confounders without changing verification', () => {
  const original = structuredClone(history), result = attachReceiptPerformance(history, spec, options);
  assert.deepEqual(history, original);
  assert.deepEqual(result[0].latest, original[0].latest);
  const value = result[0].performance_context;
  assert.equal(value.search.delta.clicks, 3);
  assert.equal(value.search.before.fetched_at, options.gscRows[0].fetched_at);
  assert.deepEqual(value.verification_baseline, receipt.baseline);
  assert.deepEqual(value.confounders.reported, spec.confounders);
  assert.equal(value.attribution, 'not_established');
  assert.equal(value.business.state, 'ga4_absent');
});

test('rejects unequal, overlapping, impossible, action-day and unfinished windows', () => {
  for (const patch of [
    { before: { ...before, end: '2026-08-06' } }, { before: after },
    { before: { start: '2026-02-30', end: '2026-03-08' } },
    { after: { start: '2026-08-08', end: '2026-08-14' } },
    { after: { start: '2026-08-14', end: '2026-08-20' } },
  ]) assert.throws(() => context({ ...spec, ...patch }));
  assert.throws(() => context({ ...spec, gsc_property: 'sc-domain:other.example' }));
  assert.throws(() => context({ ...spec, receipt_id: 'ar_missing' }));
});

test('missing, partial, mixed property and missing metrics never become invented deltas', () => {
  for (const patch of [{ property: 'sc-domain:elsewhere.com' }, { type: 'image' }, { dataState: 'all' }, { dimensions: ['page', 'query'] }, { aggregationType: 'byProperty' }]) {
    const value = context(spec, { ...options, gscRows: [row(before, 2), { ...row(after, 5), ...patch }] });
    assert.equal(value.search.delta, null);
    assert.equal(value.search.state, 'missing_window');
  }
  for (const patch of [{ truncated: true }, { first_incomplete_date: after.end }, { clicks: null }]) {
    assert.equal(context(spec, { ...options, gscRows: [row(before, 2), { ...row(after, 5), ...patch }] }).search.delta, null);
  }
  assert.equal(context(spec, { ...options, gscRows: [] }).search.delta, null);
  const marker = { ...row(after, 0), kind: 'gsc.window', page: null, state: 'empty_site', fetched_at: '2026-08-18T00:00:00Z' };
  assert.equal(context(spec, { ...options, gscRows: [...options.gscRows, marker] }).search.state, 'superseded_window');
});

test('GA4 uses only selected property and carries timezone/caveats separately', () => {
  const ga = (window, sessions, property = 'properties/123') => ({ kind: 'ga4.landing_page', property, window, landing_page: '/guide', sessions, key_events: 1, event_count: 2, total_revenue: 0, currency_code: 'USD', time_zone: 'America/New_York', caveats: ['sampling'], fetched_at: '2026-08-17T00:00:00Z' });
  const value = context({ ...spec, ga4_property: 'properties/123' }, { ...options, ga4Rows: [ga(before, 5), ga(after, 10), ga(after, 999, 'properties/456')] });
  assert.equal(value.business.before.totals.sessions, 5);
  assert.equal(value.business.after.totals.sessions, 10);
  assert.equal(value.business.state, 'not_comparable');
  assert.equal(value.business.before.time_zone, 'America/New_York');
  assert.equal(value.business.relation, 'side_by_side_not_joined');
  assert.equal(value.business.delta, null);
});

test('receipt history CLI reads saved context on opt-in and preserves owned files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'receipt-performance-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '.agentlinkops'); await mkdir(join(dir, 'context'), { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ project: { site: ['example.com'] } }));
  await writeFile(join(dir, 'links.jsonl'), '');
  const config = await loadConfig({ cwd: root });
  const created = await writeReceipt(config, { kind: 'external', source: receipt.source, target: receipt.target, acted_at: receipt.acted_at, actor: { role: 'agent' } }, { now: receipt.declared_at });
  const saved = await readFile(config.paths.receipts, 'utf8');
  await writeFile(join(dir, 'context', 'gsc.jsonl'), options.gscRows.map(v => JSON.stringify(v)).join('\n'));
  const file = join(root, 'performance.json'); await writeFile(file, JSON.stringify({ ...spec, receipt_id: created.receipt.id }));
  const out = [], err = [];
  assert.equal(await main(['receipt', 'history', '--performance', file], { cwd: root, out: v => out.push(v), err: v => err.push(v) }), 0, err.join('\n'));
  assert.equal(JSON.parse(out[0])[0].performance_context.search.delta.clicks, 3);
  assert.equal(await readFile(config.paths.receipts, 'utf8'), saved);
});
