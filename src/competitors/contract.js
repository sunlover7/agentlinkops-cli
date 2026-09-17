import { z } from 'zod';
import { DiscoveryQuery, DiscoveryRun, DiscoveryCandidate, candidateId, discoveryHash, queryHash, sourceQueryTerms } from '../discovery/contract.js';
import { matchesTarget, validatePublicUrl } from '../verifier/url.js';

// Pure internal boundary. No persistence, transport, provider calls or scheduling.
export const COMPETITOR_VERSION = 1;
export const COMPETITOR_LIMITS = Object.freeze({ competitors: 10, retrievalSkewMs: 86400000 });
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const timestamp = z.iso.datetime({ precision: 3 });
// Scope validation only needs a well-formed query, so it borrows one source's ordering
// terms. Snapshot comparison uses each run's own source, never this template.
const policy = { backlinks_status_type: 'live', exclude_internal_backlinks: true, mode: 'as_is',
  filters: null, ...sourceQueryTerms('dataforseo'), page_limit: 100, row_limit: 1000 };
const fail = code => { throw new CompetitorContractError(code); };
export class CompetitorContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const TargetScope = z.strictObject({ target_kind: z.enum(['domain', 'exact_url']),
  target: z.string().min(1).max(4096), include_subdomains: z.boolean(),
}).superRefine((scope, ctx) => {
  if (!DiscoveryQuery.safeParse({ ...scope, ...policy }).success)
    ctx.addIssue({ code: 'custom', message: 'Expected an explicit canonical discovery target scope.' });
});
const memberSchema = z.strictObject({ id: identifier, role: z.enum(['customer', 'competitor']), scope: TargetScope });
export const ApprovedCompetitorSet = z.strictObject({
  v: z.literal(COMPETITOR_VERSION), id: identifier, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  workspace_id: identifier, project_id: identifier, approved_by: identifier, approved_at: timestamp,
  members: z.array(memberSchema).min(2).max(COMPETITOR_LIMITS.competitors + 1),
}).superRefine((set, ctx) => {
  if (set.members.filter(m => m.role === 'customer').length !== 1 || new Set(set.members.map(m => m.id)).size !== set.members.length)
    ctx.addIssue({ code: 'custom', message: 'Exactly one customer and distinct member IDs are required.' });
  if (set.members.some(m => !TargetScope.safeParse(m.scope).success)) return;
  for (let i = 0; i < set.members.length; i++) for (let j = i + 1; j < set.members.length; j++) {
    if (scopesOverlap(set.members[i].scope, set.members[j].scope))
      ctx.addIssue({ code: 'custom', message: 'Approved target scopes must not overlap.' });
  }
});

function contains(scope, url) {
  return matchesTarget(url, scope.target_kind === 'domain' ? `https://${scope.target}/` : scope.target,
    scope.target_kind === 'exact_url' ? 'exact' : scope.include_subdomains ? 'domain' : 'subdomain');
}
function scopesOverlap(a, b) {
  if (a.target_kind === 'exact_url') return contains(b, a.target);
  if (b.target_kind === 'exact_url') return contains(a, b.target);
  return contains(a, `https://${b.target}/`) || contains(b, `https://${a.target}/`);
}
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function orderedSet(input) {
  const set = ApprovedCompetitorSet.parse(input);
  set.members.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return set;
}
export function approveCompetitorSet(input) {
  // approved_by is supplied by the future authenticated service, never inferred
  // from suggestions or from a provider's competitor ranking.
  return freeze(orderedSet(input));
}
export async function competitorSetHash(input) { return discoveryHash(orderedSet(input)); }
export async function targetScopeId(input) {
  return `ts_${await discoveryHash([COMPETITOR_VERSION, TargetScope.parse(input)])}`;
}
export function sourceGroupKey(sourceUrl, grouping = 'page') {
  const checked = validatePublicUrl(sourceUrl);
  if (!checked.valid || checked.url !== sourceUrl || sourceUrl.length > 4096) fail('INVALID_SOURCE_URL');
  if (grouping === 'page') return checked.url;
  if (grouping === 'source_host') return checked.hostname;
  fail('UNSUPPORTED_SOURCE_GROUPING');
}

const receiptSchema = z.strictObject({ provider_task_id: identifier, provider_retrieved_at: timestamp });
const terminal = new Set(['succeeded', 'partial', 'failed', 'reconciliation_required']);

export async function freezeInventorySnapshot({ id, set: inputSet, memberId, run: inputRun, candidates: inputCandidates, receipts: inputReceipts, capturedAt }) {
  identifier.parse(id); timestamp.parse(capturedAt);
  const set = orderedSet(inputSet), run = DiscoveryRun.parse(inputRun);
  const member = set.members.find(m => m.id === memberId);
  if (!member) fail('COMPETITOR_MEMBER_NOT_FOUND');
  if (run.workspace_id !== set.workspace_id || run.project_id !== set.project_id) fail('SNAPSHOT_SCOPE_MISMATCH');
  if (!terminal.has(run.status) || !run.finished_at) fail('SNAPSHOT_RUN_NOT_TERMINAL');
  if (run.query_hash !== await queryHash(run.query) || await targetScopeId(member.scope) !== await targetScopeId(scopeFromQuery(run.query)))
    fail('SNAPSHOT_QUERY_MISMATCH');
  if (run.created_at < set.approved_at || (run.started_at !== null && run.started_at < run.created_at) ||
      run.finished_at < (run.started_at ?? run.created_at) || capturedAt < run.finished_at) fail('SNAPSHOT_TIME_MISMATCH');
  const candidates = z.array(DiscoveryCandidate).max(run.query.row_limit).parse(inputCandidates);
  const receipts = z.array(receiptSchema).max(1000).parse(inputReceipts);
  if (candidates.length !== run.usage.accepted_candidates || new Set(candidates.map(c => c.id)).size !== candidates.length)
    fail('SNAPSHOT_INVENTORY_INCOMPLETE');
  if (receipts.length > run.usage.request_count || new Set(receipts.map(r => r.provider_task_id)).size !== receipts.length)
    fail('SNAPSHOT_RECEIPT_MISMATCH');
  const receiptById = new Map(receipts.map(r => [r.provider_task_id, r]));
  for (const receipt of receipts) {
    if (!run.started_at || receipt.provider_retrieved_at < run.started_at || receipt.provider_retrieved_at > run.finished_at)
      fail('SNAPSHOT_TIME_MISMATCH');
  }
  for (const c of candidates) {
    if (c.workspace_id !== run.workspace_id || c.project_id !== run.project_id || c.discovery_run_id !== run.id ||
        c.provider !== run.provider || c.data_mode !== run.data_mode || !contains(member.scope, c.target_url) ||
        c.id !== await candidateId(run.id, c.source_url, c.target_url)) fail('SNAPSHOT_CANDIDATE_MISMATCH');
    if (receiptById.get(c.provider_task_id)?.provider_retrieved_at !== c.provider_retrieved_at) fail('SNAPSHOT_RECEIPT_MISMATCH');
  }
  if (run.coverage === 'complete_for_query' && (run.provider_total_count !== run.usage.returned_rows ||
      receipts.length === 0 || receipts.length !== run.usage.request_count || run.coverage_reason !== null))
    fail('SNAPSHOT_COMPLETENESS_MISMATCH');
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  receipts.sort((a, b) => a.provider_task_id < b.provider_task_id ? -1 : a.provider_task_id > b.provider_task_id ? 1 : 0);
  const dates = receipts.map(r => r.provider_retrieved_at).sort();
  const snapshot = { v: COMPETITOR_VERSION, id, workspace_id: set.workspace_id, project_id: set.project_id,
    set_id: set.id, set_revision: set.revision, set_hash: await competitorSetHash(set),
    member_id: member.id, member_role: member.role, target_scope_id: await targetScopeId(member.scope),
    captured_at: capturedAt, provider_retrieved_from: dates[0] ?? null, provider_retrieved_to: dates.at(-1) ?? null,
    run, receipts, candidates };
  return freeze({ ...snapshot, content_hash: await discoveryHash(snapshot) });
}

const scopeFromQuery = q => ({ target_kind: q.target_kind, target: q.target, include_subdomains: q.include_subdomains });
const comparisonProfile = q => { const { target, ...profile } = DiscoveryQuery.parse(q); return profile; };

export async function validateInventorySnapshot(snapshot, set) {
  if (!snapshot || typeof snapshot !== 'object') fail('INVALID_INVENTORY_SNAPSHOT');
  const reconstructed = await freezeInventorySnapshot({ id: snapshot.id, set, memberId: snapshot.member_id,
    run: snapshot.run, candidates: snapshot.candidates, receipts: snapshot.receipts, capturedAt: snapshot.captured_at });
  // Compare all fields; a hash alone is not validation or authorization.
  if (Object.keys(snapshot).length !== Object.keys(reconstructed).length ||
      Object.keys(reconstructed).some(key => JSON.stringify(snapshot[key]) !== JSON.stringify(reconstructed[key])))
    fail('SNAPSHOT_CONTENT_MISMATCH');
  return reconstructed;
}

export async function compareInventoryCollection({ set, snapshots, maxRetrievalSkewMs = COMPETITOR_LIMITS.retrievalSkewMs }) {
  if (!Number.isSafeInteger(maxRetrievalSkewMs) || maxRetrievalSkewMs < 0 || maxRetrievalSkewMs > COMPETITOR_LIMITS.retrievalSkewMs)
    fail('INVALID_COMPARISON_WINDOW');
  if (!Array.isArray(snapshots) || snapshots.length < 2 || snapshots.length > COMPETITOR_LIMITS.competitors + 1)
    fail('INVALID_COMPARISON_INVENTORIES');
  const validated = [];
  for (const snapshot of snapshots) validated.push(await validateInventorySnapshot(snapshot, set));
  if (new Set(validated.map(s => s.member_id)).size !== validated.length) fail('COMPARISON_REQUIRES_DISTINCT_MEMBERS');
  const a = validated[0];
  const reasons = [];
  if (validated.some(b => a.run.provider !== b.run.provider)) reasons.push('provider_mismatch');
  if (validated.some(b => a.run.data_mode !== b.run.data_mode)) reasons.push('data_mode_mismatch');
  if (validated.some(b => JSON.stringify(comparisonProfile(a.run.query)) !== JSON.stringify(comparisonProfile(b.run.query)))) reasons.push('query_profile_mismatch');
  if (reasons.length) return { snapshots: validated, comparison: freeze({ mode: 'incompatible', reasons, absence_claim: 'not_supported' }) };
  if (validated.some(s => s.run.coverage !== 'complete_for_query')) reasons.push('incomplete_query_coverage');
  const dates = validated.flatMap(s => [s.provider_retrieved_from, s.provider_retrieved_to]);
  if (dates.some(d => d === null)) reasons.push('retrieval_time_unknown');
  else if (Math.max(...dates.map(Date.parse)) - Math.min(...dates.map(Date.parse)) > maxRetrievalSkewMs) reasons.push('retrieval_window_exceeded');
  return { snapshots: validated, comparison: freeze({ mode: reasons.length ? 'observed_overlap_only' : 'complete_query_datasets', reasons, absence_claim: 'not_supported' }) };
}

export async function compareInventorySnapshots({ set, left, right, maxRetrievalSkewMs }) {
  return (await compareInventoryCollection({ set, snapshots: [left, right], maxRetrievalSkewMs })).comparison;
}
