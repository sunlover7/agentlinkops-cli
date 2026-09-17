import { z } from 'zod';
import { validatePublicUrl } from '../verifier/url.js';

// Internal v1 contract only. No route, queue or source is activated by this module.
export const DISCOVERY_VERSION = 1;
export const DISCOVERY_LIMITS = Object.freeze({ rows: 1000, bodyBytes: 2 * 1024 * 1024, timeoutMs: 15000, cursorBytes: 8192 });

// Where an edge came from. `linktrail_corpus` is our own crawl; a purchased index is one
// alternative, never the assumed default. The `provider_*` prefix is deliberately kept for
// owned rows: it marks upstream data that has NOT been checked against the customer's
// expectation, whoever produced it. Only the verification_* fields carry a real check.
export const DISCOVERY_SOURCES = Object.freeze(['linktrail_corpus', 'dataforseo', 'imported']);
export const DISCOVERY_DATA_MODES = Object.freeze(['synthetic', 'owned_corpus', 'provider_index', 'imported']);

// Suppliers whose exports we know how to read. The name is recorded so a row can always say
// where it came from; it is NOT a claim that we queried them or that they endorse anything.
export const IMPORT_SUPPLIERS = Object.freeze([
  'ahrefs', 'google_search_console', 'bing_webmaster_tools', 'semrush', 'majestic', 'moz', 'dataforseo', 'linkody', 'csv',
]);

// A data mode belongs to exactly one source, except fixtures, which any source may model.
const SOURCE_DATA_MODES = Object.freeze({ linktrail_corpus: 'owned_corpus', dataforseo: 'provider_index', imported: 'imported' });
// A source orders and scores rows in its own terms. An owned corpus has no authority metric,
// so it must not borrow a supplier's rank scale to look like one — and an IMPORT has no
// ordering at all. A customer's export arrives in whatever order their tool wrote it, filtered
// however they filtered it, so `as_supplied` is the only honest ordering to claim.
const SOURCE_ORDER_BY = Object.freeze({ linktrail_corpus: 'first_seen,desc', dataforseo: 'rank,desc', imported: 'as_supplied' });
const SOURCE_RANK_SCALE = Object.freeze({ linktrail_corpus: null, dataforseo: 'one_thousand', imported: null });
const discoverySource = z.enum(DISCOVERY_SOURCES);
const dataMode = z.enum(DISCOVERY_DATA_MODES);

// Reject a source/mode pair that cannot exist, and hold each source to its own ordering terms.
function refineSourceShape(row, ctx) {
  if (row.data_mode !== 'synthetic' && SOURCE_DATA_MODES[row.provider] !== row.data_mode)
    ctx.addIssue({ code: 'custom', message: `Data mode ${row.data_mode} does not belong to source ${row.provider}.`, path: ['data_mode'] });
}
function refineQueryForSource(provider, query, ctx) {
  if (query.order_by[0] !== SOURCE_ORDER_BY[provider])
    ctx.addIssue({ code: 'custom', message: `Source ${provider} cannot order by ${query.order_by[0]}.`, path: ['query', 'order_by'] });
  if (query.rank_scale !== SOURCE_RANK_SCALE[provider])
    ctx.addIssue({ code: 'custom', message: `Source ${provider} does not publish that rank scale.`, path: ['query', 'rank_scale'] });
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ precision: 3 });
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const nullableText = max => z.string().max(max).nullable();
const publicUrl = z.string().max(4096).refine(value => {
  const checked = validatePublicUrl(value);
  return checked.valid && checked.url === value;
}, 'Expected a canonical public HTTP(S) URL.');
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const DiscoveryQuery = z.strictObject({
  target_kind: z.enum(['domain', 'exact_url']),
  target: z.string().min(1).max(4096),
  include_subdomains: z.boolean(),
  backlinks_status_type: z.enum(['live', 'lost', 'all']),
  exclude_internal_backlinks: z.boolean(),
  mode: z.literal('as_is'),
  filters: z.null(),
  order_by: z.tuple([z.enum(Object.values(SOURCE_ORDER_BY))]),
  rank_scale: z.enum(['one_thousand']).nullable(),
  page_limit: count.min(1).max(DISCOVERY_LIMITS.rows),
  row_limit: count.min(1).max(DISCOVERY_LIMITS.rows),
}).superRefine((q, ctx) => {
  const url = validatePublicUrl(q.target_kind === 'domain' ? `https://${q.target}/` : q.target);
  if (!url.valid || (q.target_kind === 'domain' ? url.hostname !== q.target || q.target.startsWith('www.') : url.url !== q.target))
    ctx.addIssue({ code: 'custom', message: 'Invalid or noncanonical discovery target.', path: ['target'] });
  if (q.target_kind === 'exact_url' && q.include_subdomains)
    ctx.addIssue({ code: 'custom', message: 'Exact URL scope cannot include subdomains.', path: ['include_subdomains'] });
  if (q.page_limit > q.row_limit)
    ctx.addIssue({ code: 'custom', message: 'Page limit exceeds run row limit.', path: ['page_limit'] });
});

export const DiscoveryCandidate = z.strictObject({
  v: z.literal(DISCOVERY_VERSION),
  id: z.string().regex(/^dc_[a-f0-9]{64}$/),
  workspace_id: identifier, project_id: identifier, discovery_run_id: identifier,
  source_url: publicUrl, target_url: publicUrl,
  provider: discoverySource, data_mode: dataMode,
  provider_task_id: identifier,
  provider_retrieved_at: timestamp,
  provider_first_seen: timestamp.nullable(), provider_prev_seen: timestamp.nullable(), provider_last_seen: timestamp.nullable(),
  provider_status: z.strictObject({ is_lost: z.boolean().nullable(), is_broken: z.boolean().nullable(), is_new: z.boolean().nullable() }),
  anchor: nullableText(4096), rel: z.array(z.string().min(1).max(128)).max(32).nullable(),
  dofollow: z.boolean().nullable(), link_type: nullableText(64),
  source_http_status: z.number().int().min(100).max(599).nullable(),
  target_http_status: z.number().int().min(100).max(599).nullable(),
  links_count: count.nullable(),
  // Exactly one source's metric block, keyed by that source. No shape is mandatory across
  // sources: an owned crawl publishes what it actually observed and no authority score.
  provider_metrics: z.union([
    z.strictObject({ dataforseo: z.strictObject({
      rank: count.max(1000).nullable(), page_from_rank: count.max(1000).nullable(),
      domain_from_rank: count.max(1000).nullable(), backlink_spam_score: count.max(100).nullable(),
      rank_scale: z.literal('one_thousand'),
    }) }),
    z.strictObject({ imported: z.strictObject({
      supplier: z.enum(IMPORT_SUPPLIERS),
      supplier_row_id: nullableText(256),
      // What the EXPORT says about its own age, which is often nothing. `provider_retrieved_at`
      // on the row above is when WE read the file; these are different facts and conflating
      // them would let an import of a two-year-old export read as fresh data.
      supplier_generated_at: timestamp.nullable(),
      // The supplier's own numbers, on the supplier's own scale, never normalised. Ahrefs DR,
      // Moz DA and Majestic Trust Flow measure different things on different scales; a single
      // "authority" column would be nonsense dressed as a metric. Each keeps its own name, and
      // the scale is the supplier's name itself.
      supplier_metrics: z.record(z.string().min(1).max(64), z.union([z.number(), z.string().max(256), z.null()]))
        .refine(value => Object.keys(value).length <= 32, 'At most 32 supplier metrics.').nullable(),
    }) }),
    z.strictObject({ linktrail_corpus: z.strictObject({
      // Real crawl facts. Outlink counts qualify a page; they are not an authority metric.
      source_outlink_count: count.nullable(), source_external_outlink_count: count.nullable(),
      fetch_kind: z.enum(['direct', 'rendered', 'proxied']),
      // False when the body was truncated or parsing stopped early. Carries the truncation
      // rule into the data: an incomplete read can confirm a link it saw, never absence.
      extraction_complete: z.boolean(),
    }) }),
  ]),
  // Provider flags, dates and scores may never fill these independent check fields.
  verification_status: z.enum(['not_checked', 'present', 'absent', 'unknown', 'source_unavailable']),
  verified_at: timestamp.nullable(), observation_id: identifier.nullable(), evidence_id: z.string().min(1).max(1024).nullable(),
}).superRefine((c, ctx) => {
  const unverified = c.verification_status === 'not_checked';
  if ([c.verified_at, c.observation_id, c.evidence_id].some(value => (value === null) !== unverified))
    ctx.addIssue({ code: 'custom', message: 'A check result requires its own timestamp, observation and evidence; unverified candidates have none.' });
  refineSourceShape(c, ctx);
  if (!Object.hasOwn(c.provider_metrics, c.provider))
    ctx.addIssue({ code: 'custom', message: `Metrics are not keyed by the source ${c.provider} that produced this row.`, path: ['provider_metrics'] });
});

export const ProviderCheckpoint = z.strictObject({
  query_hash: hash,
  page_index: count,
  offset: count.max(20000),
  search_after_token: z.string().min(1).max(DISCOVERY_LIMITS.cursorBytes).nullable(),
  // Preserve the offset of the request that started a token chain, if any.
  request_offset: count.max(20000).nullable().default(null),
});

export const ProviderPage = z.strictObject({
  v: z.literal(DISCOVERY_VERSION), provider: discoverySource, data_mode: dataMode,
  provider_task_id: identifier, provider_retrieved_at: timestamp,
  provider_total_count: count.nullable(), provider_reported_cost_microusd: count.nullable(),
  returned_rows: count.max(DISCOVERY_LIMITS.rows), rejected_rows: count, duplicate_rows: count,
  candidates: z.array(DiscoveryCandidate).max(DISCOVERY_LIMITS.rows),
  coverage: z.enum(['complete_for_query', 'capped', 'partial']),
  coverage_reason: nullableText(128), next_checkpoint: ProviderCheckpoint.nullable(),
}).superRefine((page, ctx) => {
  if (page.candidates.length + page.rejected_rows + page.duplicate_rows !== page.returned_rows)
    ctx.addIssue({ code: 'custom', message: 'Provider page row accounting does not balance.' });
  if (page.coverage === 'complete_for_query' && (page.rejected_rows > 0 || page.next_checkpoint !== null || page.provider_total_count === null))
    ctx.addIssue({ code: 'custom', message: 'Provider page cannot claim complete query coverage.' });
  // An import can never claim completeness. We are reading a file a customer exported, and
  // nothing in it tells us whether they took page one of forty or filtered it first. Saying
  // "complete" about someone else's export would be the one claim in this contract we have no
  // way at all to check.
  if (page.provider === 'imported' && page.coverage === 'complete_for_query')
    ctx.addIssue({ code: 'custom', message: 'An import cannot claim complete query coverage: its scope is the export, which is unknown.', path: ['coverage'] });
  refineSourceShape(page, ctx);
  if (page.candidates.some(c => c.provider !== page.provider || c.data_mode !== page.data_mode))
    ctx.addIssue({ code: 'custom', message: 'A page cannot carry rows from another source or data mode.', path: ['candidates'] });
  // A truncated read cannot have seen every link on the page, so it cannot close the query.
  if (page.coverage === 'complete_for_query'
    && page.candidates.some(c => c.provider_metrics.linktrail_corpus?.extraction_complete === false))
    ctx.addIssue({ code: 'custom', message: 'An incomplete extraction cannot claim complete query coverage.', path: ['coverage'] });
});

export const DiscoveryRun = z.strictObject({
  v: z.literal(DISCOVERY_VERSION), id: identifier, workspace_id: identifier, project_id: identifier,
  provider: discoverySource, data_mode: dataMode,
  query: DiscoveryQuery, query_hash: hash,
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'reconciliation_required']),
  created_at: timestamp, started_at: timestamp.nullable(), finished_at: timestamp.nullable(),
  coverage: z.enum(['pending', 'complete_for_query', 'capped', 'partial', 'unknown']),
  coverage_reason: nullableText(128),
  provider_total_count: count.nullable(), checkpoint: ProviderCheckpoint.nullable(),
  usage: z.strictObject({
    unit: z.literal('discovery'), currency: z.literal('USD'), quote_id: identifier,
    max_cost_microusd: count, reserved_cost_microusd: count,
    provider_reported_cost_microusd: count.nullable(),
    request_count: count, returned_rows: count, accepted_candidates: count, rejected_rows: count, duplicate_rows: count,
  }),
}).superRefine((run, ctx) => {
  const u = run.usage;
  if (u.returned_rows > run.query.row_limit || u.accepted_candidates + u.rejected_rows + u.duplicate_rows !== u.returned_rows)
    ctx.addIssue({ code: 'custom', message: 'Discovery row accounting does not balance within the cap.' });
  if (u.reserved_cost_microusd > u.max_cost_microusd)
    ctx.addIssue({ code: 'custom', message: 'Reservation exceeds the authorized ceiling.' });
  if (run.checkpoint && run.checkpoint.query_hash !== run.query_hash)
    ctx.addIssue({ code: 'custom', message: 'Checkpoint belongs to another query.' });
  if (run.coverage === 'complete_for_query' && (run.status !== 'succeeded' || u.rejected_rows > 0 || run.checkpoint !== null || run.provider_total_count === null))
    ctx.addIssue({ code: 'custom', message: 'Incomplete or rejected data cannot claim complete query coverage.' });
  if (run.provider === 'imported' && run.coverage === 'complete_for_query')
    ctx.addIssue({ code: 'custom', message: 'An import cannot claim complete query coverage: its scope is the export, which is unknown.', path: ['coverage'] });
  // An import is a file, not a metered request. A ceiling above zero would mean we intended to
  // spend on it, and a receipt for a purchase nobody made is worse than no receipt.
  if (run.provider === 'imported' && (u.max_cost_microusd !== 0 || u.reserved_cost_microusd !== 0 || (u.provider_reported_cost_microusd ?? 0) !== 0))
    ctx.addIssue({ code: 'custom', message: 'An import costs nothing and must not carry a spend.', path: ['usage'] });
  refineSourceShape(run, ctx);
  refineQueryForSource(run.provider, run.query, ctx);
});

export async function discoveryHash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Parsing fixes key order before hashing; transport pagination is not query identity.
export async function queryHash(query) { return discoveryHash(DiscoveryQuery.parse(query)); }
// Identity is (run, source page, target page), which is exactly the uniqueness the schema
// enforces. A run already fixes its source, so naming one here would only make the ID
// unstable if a source were ever relabelled.
export async function candidateId(runId, sourceUrl, targetUrl) {
  identifier.parse(runId); publicUrl.parse(sourceUrl); publicUrl.parse(targetUrl);
  return `dc_${await discoveryHash([DISCOVERY_VERSION, runId, sourceUrl, targetUrl])}`;
}

// The ordering terms a source accepts, for a caller assembling a query it can run.
export function sourceQueryTerms(provider) {
  discoverySource.parse(provider);
  return { order_by: [SOURCE_ORDER_BY[provider]], rank_scale: SOURCE_RANK_SCALE[provider] };
}

export async function createDiscoveryRun({ id, workspaceId, projectId, provider, query, dataMode, quoteId, maxCostMicrousd, now }) {
  const normalized = DiscoveryQuery.parse(query);
  return DiscoveryRun.parse({
    v: DISCOVERY_VERSION, id, workspace_id: workspaceId, project_id: projectId,
    provider: discoverySource.parse(provider), data_mode: dataMode, query: normalized, query_hash: await queryHash(normalized),
    status: 'queued', created_at: now, started_at: null, finished_at: null,
    coverage: 'pending', coverage_reason: null, provider_total_count: null, checkpoint: null,
    usage: { unit: 'discovery', currency: 'USD', quote_id: quoteId, max_cost_microusd: maxCostMicrousd,
      reserved_cost_microusd: 0, provider_reported_cost_microusd: null, request_count: 0,
      returned_rows: 0, accepted_candidates: 0, rejected_rows: 0, duplicate_rows: 0 },
  });
}
