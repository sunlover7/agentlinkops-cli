import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DiscoveryQuery, DiscoveryCandidate, DiscoveryRun, ProviderPage, candidateId, queryHash, createDiscoveryRun } from '../src/discovery/contract.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/discovery/cases.json', import.meta.url), 'utf8'));
const run = () => createDiscoveryRun({ id: 'dr_synthetic', workspaceId: 'ws_synthetic', projectId: 'pr_synthetic', provider: 'dataforseo',
  query: fixture.query, dataMode: 'synthetic', quoteId: 'quote_synthetic', maxCostMicrousd: 100, now: fixture.retrieved_at });
async function candidate() {
  const source_url = 'https://publisher.example.org/Guide?x=1', target_url = 'https://example.com/Article';
  return { v: 1, id: await candidateId('dr_synthetic', source_url, target_url), workspace_id: 'ws_synthetic',
    project_id: 'pr_synthetic', discovery_run_id: 'dr_synthetic', source_url, target_url,
    provider: 'dataforseo', data_mode: 'synthetic', provider_task_id: 'synthetic-task-001', provider_retrieved_at: fixture.retrieved_at,
    provider_first_seen: null, provider_prev_seen: null, provider_last_seen: '2026-09-01T12:00:00.000Z',
    provider_status: { is_lost: true, is_broken: null, is_new: false }, anchor: null, rel: null, dofollow: null,
    link_type: null, source_http_status: null, target_http_status: null, links_count: null,
    provider_metrics: { dataforseo: { rank: null, page_from_rank: null, domain_from_rank: null, backlink_spam_score: null, rank_scale: 'one_thousand' } },
    verification_status: 'not_checked', verified_at: null, observation_id: null, evidence_id: null };
}

test('discovery fixtures are synthetic with distinct success, partial, empty and HTTP-200 task failures', () => {
  assert.equal(fixture.synthetic, true);
  DiscoveryQuery.parse(fixture.query);
  for (const name of ['success', 'partial', 'empty', 'task_failure']) assert.ok(fixture.cases.some(c => c.name === name));
  const failure = fixture.cases.find(c => c.name === 'task_failure').response;
  assert.equal(failure.status_code, 20000);
  assert.notEqual(failure.tasks[0].status_code, 20000);
  assert.equal(failure.tasks[0].result, null);
  assert.equal(fixture.cases.find(c => c.name === 'empty').response.tasks[0].result[0].total_count, 0);
});

test('query scope and caps reject implicit broadening and unsafe supplier targets', () => {
  for (const target of ['example.com/path', 'example.com:443', 'EXAMPLE.com', 'www.example.com', '127.0.0.1', 'metadata.google.internal', 'user@example.com'])
    assert.equal(DiscoveryQuery.safeParse({ ...fixture.query, target }).success, false, target);
  for (const patch of [{ page_limit: 0 }, { row_limit: 1001 }, { row_limit: 1 }, { page_limit: '2' }, { filters: ['rank', '>', 1] }, { unexpected: true }])
    assert.equal(DiscoveryQuery.safeParse({ ...fixture.query, ...patch }).success, false);
  assert.equal(DiscoveryQuery.safeParse({ ...fixture.query, target_kind: 'exact_url', target: 'https://example.com/Article' }).success, false);
  DiscoveryQuery.parse({ ...fixture.query, target_kind: 'exact_url', target: 'https://example.com/Article', include_subdomains: false });
});

test('query fingerprints ignore input key order but bind all scope, sorting and cap choices', async () => {
  const original = await queryHash(fixture.query);
  assert.equal(await queryHash(Object.fromEntries(Object.entries(fixture.query).reverse())), original);
  for (const patch of [{ target: 'example.org' }, { include_subdomains: false }, { row_limit: 5 }, { page_limit: 1 },
    { backlinks_status_type: 'lost' }, { exclude_internal_backlinks: false }])
    assert.notEqual(await queryHash({ ...fixture.query, ...patch }), original);
});

test('candidate identity is stable within a run, preserves URL distinctions and separates snapshots', async () => {
  const source = 'https://example.org/Guide?a=1', target = 'https://example.com/';
  const id = await candidateId('dr_one', source, target);
  assert.equal(await candidateId('dr_one', source, target), id);
  for (const args of [['dr_two', source, target], ['dr_one', source.toLowerCase(), target], ['dr_one', `${source}&b=2`, target], ['dr_one', source, `${target}other`]])
    assert.notEqual(await candidateId(...args), id);
  await assert.rejects(candidateId('dr_one', `${source}#fragment`, target));
  await assert.rejects(candidateId('dr_one', 'http://127.0.0.1/', target));
});

test('provider loss and three separate clocks cannot masquerade as Linktrail verification', async () => {
  const c = await candidate();
  const parsed = DiscoveryCandidate.parse(c);
  assert.equal(parsed.provider_status.is_lost, true);
  assert.equal(parsed.verification_status, 'not_checked');
  assert.notEqual(parsed.provider_retrieved_at, parsed.provider_last_seen);
  for (const patch of [{ verified_at: fixture.retrieved_at }, { verification_status: 'present' }, { observation_id: 'obs_synthetic' }])
    assert.equal(DiscoveryCandidate.safeParse({ ...c, ...patch }).success, false);
  DiscoveryCandidate.parse({ ...c, verification_status: 'unknown', verified_at: '2026-09-10T05:00:00.000Z', observation_id: 'obs_synthetic', evidence_id: 'ev_synthetic' });
});

test('nullable attributes preserve explicitly empty, false and zero without score renaming', async () => {
  const c = await candidate();
  assert.equal(DiscoveryCandidate.parse(c).anchor, null);
  const known = DiscoveryCandidate.parse({ ...c, anchor: '', rel: [], dofollow: false, links_count: 0 });
  assert.equal(known.anchor, ''); assert.deepEqual(known.rel, []); assert.equal(known.dofollow, false); assert.equal(known.links_count, 0);
  assert.equal(DiscoveryCandidate.safeParse({ ...c, provider_metrics: { ahrefs: { dr: 42 } } }).success, false);
  for (const source_url of ['https://user:pass@example.org/', 'https://example.org/Guide#part', 'ftp://example.org/', 'http://10.0.0.1/'])
    assert.equal(DiscoveryCandidate.safeParse({ ...c, source_url }).success, false);
});

test('new runs record unknown cost and pending coverage without reserving checks or watches', async () => {
  const r = await run();
  assert.equal(r.status, 'queued'); assert.equal(r.coverage, 'pending');
  assert.equal(r.usage.unit, 'discovery'); assert.equal(r.usage.provider_reported_cost_microusd, null);
  assert.equal(r.usage.reserved_cost_microusd, 0); assert.equal(r.started_at, null); assert.equal(r.checkpoint, null);
  assert.equal(DiscoveryRun.safeParse({ ...r, usage: { ...r.usage, unit: 'checks' } }).success, false);
});

test('run accounting rejects cap overflow, unbalanced rows and foreign-query checkpoints', async () => {
  const r = await run();
  for (const patch of [{ returned_rows: 1 }, { returned_rows: 5, accepted_candidates: 5 }, { reserved_cost_microusd: 101 }, { request_count: -1 }, { max_cost_microusd: 0.5 }])
    assert.equal(DiscoveryRun.safeParse({ ...r, usage: { ...r.usage, ...patch } }).success, false);
  assert.equal(DiscoveryRun.safeParse({ ...r, checkpoint: { query_hash: '0'.repeat(64), page_index: 1, offset: 2, search_after_token: 'synthetic-next' } }).success, false);
  // An unexpectedly high actual receipt must remain recordable for reconciliation.
  DiscoveryRun.parse({ ...r, status: 'reconciliation_required', usage: { ...r.usage, provider_reported_cost_microusd: 101 } });
});

test('coverage cannot hide a rejected row, pending cursor or unknown total', async () => {
  const r = await run();
  assert.equal(DiscoveryRun.safeParse({ ...r, coverage: 'complete_for_query' }).success, false);
  assert.equal(DiscoveryRun.safeParse({ ...r, status: 'succeeded', coverage: 'complete_for_query', usage: { ...r.usage, returned_rows: 1, rejected_rows: 1 } }).success, false);
  const page = { v: 1, provider: 'dataforseo', data_mode: 'synthetic', provider_task_id: 'synthetic-task-001',
    provider_retrieved_at: fixture.retrieved_at, provider_total_count: 0, provider_reported_cost_microusd: 7,
    returned_rows: 0, rejected_rows: 0, duplicate_rows: 0, candidates: [], coverage: 'complete_for_query', coverage_reason: null, next_checkpoint: null };
  ProviderPage.parse(page);
  assert.equal(ProviderPage.safeParse({ ...page, provider_total_count: null }).success, false);
  assert.equal(ProviderPage.safeParse({ ...page, returned_rows: 1, rejected_rows: 1 }).success, false);
  assert.equal(ProviderPage.safeParse({ ...page, next_checkpoint: { query_hash: r.query_hash, page_index: 1, offset: 2, search_after_token: 'synthetic-next' } }).success, false);
});

// --- Source neutrality (DP-0002-T09) -------------------------------------------------
// The contract must be able to represent an edge we crawled ourselves, and must refuse
// the combinations that cannot exist. A supplier is one source, never the assumed one.

const ownedMetrics = { linktrail_corpus: { source_outlink_count: 42, source_external_outlink_count: 7,
  fetch_kind: 'direct', extraction_complete: true } };
const ownedQuery = { ...fixture.query, order_by: ['first_seen,desc'], rank_scale: null };
const ownedRun = (patch = {}) => createDiscoveryRun({ id: 'dr_owned', workspaceId: 'ws_synthetic', projectId: 'pr_synthetic',
  provider: 'linktrail_corpus', query: ownedQuery, dataMode: 'synthetic', quoteId: 'quote_synthetic',
  maxCostMicrousd: 100, now: fixture.retrieved_at, ...patch });
async function ownedCandidate(patch = {}) {
  return { ...await candidate(), id: await candidateId('dr_owned', 'https://publisher.example.org/Guide?x=1', 'https://example.com/Article'),
    discovery_run_id: 'dr_owned', provider: 'linktrail_corpus', provider_metrics: ownedMetrics, ...patch };
}

test('an owned crawl is a first-class discovery source with its own metrics and ordering', async () => {
  const r = await ownedRun();
  assert.equal(r.provider, 'linktrail_corpus');
  DiscoveryCandidate.parse(await ownedCandidate());
  // An owned corpus publishes what it observed and borrows no authority score.
  const metrics = (await ownedCandidate()).provider_metrics.linktrail_corpus;
  assert.equal(Object.hasOwn(metrics, 'rank'), false);
  assert.equal(Object.hasOwn(metrics, 'rank_scale'), false);
  assert.equal(DiscoveryRun.safeParse({ ...r, provider: 'ahrefs' }).success, false);
});

test('a source cannot claim another source data mode, metrics or ordering terms', async () => {
  const supplier = await run(), owned = await ownedRun();
  // Fixtures may model any source; a live mode belongs to exactly one.
  assert.equal(DiscoveryRun.safeParse({ ...owned, data_mode: 'provider_index' }).success, false);
  assert.equal(DiscoveryRun.safeParse({ ...supplier, data_mode: 'owned_corpus' }).success, false);
  assert.equal(DiscoveryRun.safeParse({ ...owned, data_mode: 'owned_corpus' }).success, true);
  // Ordering terms are the source's own; an owned corpus has no supplier rank to sort on.
  assert.equal(DiscoveryRun.safeParse({ ...owned, query: fixture.query }).success, false);
  assert.equal(DiscoveryRun.safeParse({ ...owned, query: { ...ownedQuery, rank_scale: 'one_thousand' } }).success, false);
  assert.equal(DiscoveryRun.safeParse({ ...supplier, query: ownedQuery }).success, false);
  // Metrics must be keyed by the source that produced the row, and only that source.
  assert.equal(DiscoveryCandidate.safeParse({ ...await ownedCandidate(), provider_metrics: (await candidate()).provider_metrics }).success, false);
  assert.equal(DiscoveryCandidate.safeParse({ ...await candidate(), provider_metrics: ownedMetrics }).success, false);
  assert.equal(DiscoveryCandidate.safeParse({ ...await ownedCandidate(), data_mode: 'provider_index' }).success, false);
});

test('candidate identity is the run and the edge, so relabelling a source cannot move an ID', async () => {
  const source = 'https://publisher.example.org/Guide?x=1', target = 'https://example.com/Article';
  // Same run and edge means the same candidate, whichever source filled the run. The
  // schema's own uniqueness is (run_id, source_url, target_url) and identity now matches it.
  assert.equal(await candidateId('dr_owned', source, target), (await ownedCandidate()).id);
  assert.notEqual(await candidateId('dr_synthetic', source, target), await candidateId('dr_owned', source, target));
});

test('a page cannot mix sources, and a truncated read cannot close a query', async () => {
  const base = { v: 1, provider: 'linktrail_corpus', data_mode: 'synthetic', provider_task_id: 'synthetic-task-001',
    provider_retrieved_at: fixture.retrieved_at, provider_total_count: 1, provider_reported_cost_microusd: 7,
    returned_rows: 1, rejected_rows: 0, duplicate_rows: 0, candidates: [await ownedCandidate()],
    coverage: 'complete_for_query', coverage_reason: null, next_checkpoint: null };
  ProviderPage.parse(base);
  // Rows from another source cannot ride on this page.
  assert.equal(ProviderPage.safeParse({ ...base, candidates: [await candidate()] }).success, false);
  assert.equal(ProviderPage.safeParse({ ...base, provider: 'dataforseo' }).success, false);
  // The OpenSEO body-cap trap, made structural: an incomplete extraction saw the link it
  // reports and cannot have seen every other link, so it may not claim complete coverage.
  const truncated = await ownedCandidate({ provider_metrics: { linktrail_corpus: { ...ownedMetrics.linktrail_corpus, extraction_complete: false } } });
  assert.equal(ProviderPage.safeParse({ ...base, candidates: [truncated] }).success, false);
  ProviderPage.parse({ ...base, candidates: [truncated], coverage: 'partial', coverage_reason: 'extraction_truncated', provider_total_count: null });
});
