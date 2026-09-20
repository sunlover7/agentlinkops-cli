// Opportunity library record contract (DP-0030-T01).
//
// One record is one publisher surface where a link or citation could be earned, described only by
// what we observed on public pages, verified by the product's own verifier, and dated. The schema
// is strict on purpose: a field that is not named here cannot exist on a record, so a vendor
// metric, a contact address or a seller's column can never ride along.
//
// Shared by the Worker, the console and the CLI. Do not import from src/ here.
import {z} from 'zod';

export const OPPORTUNITY_RECORD_VERSION = 1;

/** How a link would be earned on the surface. */
export const OPPORTUNITY_TYPES = Object.freeze([
  'directory',            // per-listing pages plus a published submission route
  'resource_page',        // an editorially maintained page of outbound links
  'listicle_or_review',   // a ranked or reviewed list an editor writes
  'guest_post_program',   // a published contributor route
  'link_insertion',       // an existing editorial page that cites comparable destinations
  'ai_citation_source',   // a page an assistant cited for a recorded query, model and date
]);

/** Where the record's subject came from. Redistribution is decided per class, never per row. */
export const SOURCE_CLASSES = Object.freeze([
  'owned_corpus',            // DP-0011 crawl edges under robots, coverage stated per run
  'directory_inventory',     // DP-0006-T17 route-verified inventory, internal columns dropped
  'cc_host_graph_seed',      // Common Crawl host graph: may seed a fetch, may never populate a field
  'consented_project_lane',  // DP-0009 mention or citation lane, only with the project's written consent
  'owned_submission',        // our own listing outcome with listing_url and verified_on
]);

/** Inputs that can never produce a record. Named so a test can refuse them by value. */
export const FORBIDDEN_SOURCE_CLASSES = Object.freeze([
  'bought_list', 'vendor_export', 'customer_import', 'competitor_list', 'vault_capture', 'private_registry',
]);

/** The six gates of the niche-directory guide, in order. Verdicts reuse DP-0009's vocabulary. */
export const ELIGIBILITY_GATES = Object.freeze([
  'owned_observation', 'redistribution_safe_fields', 'route_evidence',
  're_verified_within_window', 'policy_screen', 'no_contact_enrichment',
]);
export const OBSERVATION_GATES = Object.freeze(['owned_observation', 'route_evidence', 're_verified_within_window']);
export const JUDGEMENT_GATES = Object.freeze(['redistribution_safe_fields', 'policy_screen', 'no_contact_enrichment']);
export const GATE_VERDICTS = Object.freeze(['satisfied', 'not_satisfied', 'agent_judgement']);

export const ROUTE_STATES = Object.freeze(['verified', 'partial', 'unverified']);
export const LISTING_STATES = Object.freeze(['present', 'absent', 'unknown', 'not_checked']);
export const OBSERVERS = Object.freeze(['corpus_crawl', 'verifier', 'route_fetch', 'browser_read', 'assistant_query']);
export const OBSERVATION_OUTCOMES = Object.freeze(['fetched', 'present', 'absent', 'unknown', 'blocked', 'not_found', 'unavailable']);
export const CONTACT_ROUTE_CLASSES = Object.freeze([
  'published_submission_page', 'published_form', 'published_email', 'platform_account', 'none_observed', 'unknown',
]);
export const RECORD_STATUSES = Object.freeze(['held', 'published', 'withdrawn']);
export const WITHDRAWAL_REASONS = Object.freeze([
  'publisher_request', 'policy_screen_failed', 'route_gone_confirmed', 'rights_review', 'owner_decision',
]);
export const TYPE_BASES = Object.freeze(['observed', 'heuristic']);

/** Freshness: every class re-verifies within 90 days; a record is `aging` in the last 30 of them. */
export const VERIFICATION_WINDOW_DAYS = 90;
export const AGING_DAYS = 30;
/** Mirrors the verifier's loss-confirmation window. A test asserts they are equal. */
export const CONFIRMATION_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = z.iso.datetime({offset: true});
const url = z.url().max(4096);
const hostname = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/, 'lowercase hostname');
const short = max => z.string().max(max);

export const observationSchema = z.strictObject({
  observed_at: isoDate,
  observer: z.enum(OBSERVERS),
  outcome: z.enum(OBSERVATION_OUTCOMES),
  reason: short(64).nullable(),
  page_url: url,
  http_status: z.number().int().min(0).max(999).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  complete: z.boolean(),
  run_id: short(128).nullable(),
  checker_version: short(64).nullable(),
  rel_tokens: z.array(short(32)).max(20).nullable(),
  anchor: short(256).nullable(),
});

export const gateVerdictSchema = z.strictObject({
  gate: z.enum(ELIGIBILITY_GATES),
  verdict: z.enum(GATE_VERDICTS),
  because: short(64),
  observed_at: isoDate.nullable(),
});

export const opportunityRecordSchema = z.strictObject({
  schema_version: z.literal(OPPORTUNITY_RECORD_VERSION),
  record_id: z.string().regex(/^opp_[a-z0-9-]+_[a-f0-9]{16}$/),
  status: z.enum(RECORD_STATUSES),
  niche: z.strictObject({id: z.string().regex(/^[a-z0-9-]+$/).max(64), label: short(120)}),
  opportunity_type: z.enum(OPPORTUNITY_TYPES),
  type_basis: z.enum(TYPE_BASES),
  subject: z.strictObject({
    host: hostname,
    page_url: url.nullable(),
    route_url: url.nullable(),
    surface: short(64).nullable(),
  }),
  observed: z.strictObject({
    rel_tokens: z.array(short(32)).max(20).nullable(),
    indexing: z.enum(['indexable', 'noindex', 'robots_disallowed', 'unknown']),
    cost_basis: z.enum(['free', 'paid', 'mixed', 'unknown']),
    audience_statement: z.boolean().nullable(),
    cited_destinations: z.array(z.strictObject({
      host: hostname, referring_pages: z.number().int().min(1), publishers_linking: z.number().int().min(1),
    })).max(50),
    ai_citation: z.strictObject({query: short(512), model: short(64), observed_at: isoDate}).nullable(),
  }),
  contact_route: z.strictObject({
    class: z.enum(CONTACT_ROUTE_CLASSES),
    deliverability: z.literal('not_checked'),
    observed_at: isoDate.nullable(),
  }),
  eligibility: z.strictObject({
    gates: z.array(gateVerdictSchema).length(ELIGIBILITY_GATES.length),
  }),
  verification: z.strictObject({
    route_state: z.enum(ROUTE_STATES),
    listing_state: z.enum(LISTING_STATES),
    last_verified_at: isoDate.nullable(),
    next_due_at: isoDate.nullable(),
    window_days: z.literal(VERIFICATION_WINDOW_DAYS),
    unknown_streak: z.number().int().min(0),
    reason: short(64).nullable(),
  }),
  provenance: z.strictObject({
    source_class: z.enum(SOURCE_CLASSES),
    run_id: short(128).nullable(),
    seed_reason: short(160).nullable(),
    consent_ref: short(160).nullable(),
    first_seen_at: isoDate,
    last_seen_at: isoDate,
  }),
  rights: z.strictObject({
    basis: z.literal('owned_observation_of_public_page'),
    redistributable: z.boolean(),
    excluded_inputs_attested: z.literal(true),
    takedown_route: z.literal('withdraw_on_request'),
  }),
  evidence: z.array(observationSchema).min(1).max(40),
  dates: z.strictObject({
    created_at: isoDate,
    updated_at: isoDate,
    last_observed_at: isoDate,
  }),
  withdrawal: z.strictObject({at: isoDate, reason: z.enum(WITHDRAWAL_REASONS)}).nullable(),
});

/** What a source covers, stated beside every answer. Absence from the library proves nothing. */
export const libraryCoverageSchema = z.strictObject({
  schema_version: z.literal(OPPORTUNITY_RECORD_VERSION),
  niche: z.strictObject({id: z.string().regex(/^[a-z0-9-]+$/).max(64), label: short(120)}),
  source_class: z.enum(SOURCE_CLASSES),
  run_id: short(128).nullable(),
  generated_at: isoDate,
  scope: short(600),
  pages_read: z.number().int().min(0),
  hosts_read: z.number().int().min(0),
  records_emitted: z.number().int().min(0),
  absence_claim: z.literal('not_supported'),
  whole_web_coverage: z.literal(false),
});

export class OpportunityRecordError extends Error {
  constructor(message, issues = []) { super(message); this.name = 'OpportunityRecordError'; this.issues = issues; }
}

const gateSet = new Set(ELIGIBILITY_GATES);

/** Parse and apply the rules the schema alone cannot express. */
export function parseOpportunityRecord(value) {
  const parsed = opportunityRecordSchema.safeParse(value);
  if (!parsed.success) throw new OpportunityRecordError('Invalid opportunity record.', parsed.error.issues);
  const record = parsed.data;
  const seen = new Set();
  for (const {gate} of record.eligibility.gates) {
    if (seen.has(gate)) throw new OpportunityRecordError(`Duplicate gate verdict: ${gate}`);
    seen.add(gate);
  }
  if (seen.size !== gateSet.size) throw new OpportunityRecordError('Every eligibility gate needs exactly one verdict.');
  if (record.provenance.source_class === 'cc_host_graph_seed' && record.evidence.every(item => item.observer === 'corpus_crawl'))
    throw new OpportunityRecordError('A graph seed must be followed by an owned fetch before it is a record.');
  if (record.provenance.source_class === 'consented_project_lane' && !record.provenance.consent_ref)
    throw new OpportunityRecordError('A project-lane record needs a consent reference.');
  if (record.opportunity_type === 'ai_citation_source' && !record.observed.ai_citation)
    throw new OpportunityRecordError('An AI citation record carries query, model and date.');
  if ((record.status === 'withdrawn') !== (record.withdrawal !== null))
    throw new OpportunityRecordError('Withdrawn status and withdrawal detail travel together.');
  if (record.status === 'published' && !publicationVerdict(record, record.dates.updated_at).publishable)
    throw new OpportunityRecordError('A published record must pass the publication verdict at its update time.');
  return record;
}

/** fresh | aging | stale, from last_verified_at and the fixed window. Never verified is stale. */
export function freshness(record, now = new Date().toISOString()) {
  const verified = record.verification.last_verified_at;
  if (!verified) return 'stale';
  const age = new Date(now).getTime() - new Date(verified).getTime();
  if (age > VERIFICATION_WINDOW_DAYS * DAY_MS) return 'stale';
  if (age > (VERIFICATION_WINDOW_DAYS - AGING_DAYS) * DAY_MS) return 'aging';
  return 'fresh';
}

/**
 * Whether a record may be shown as published. No score: a list of reasons, all of which must be
 * empty. Judgement gates block only when someone recorded `not_satisfied`; `agent_judgement` is
 * allowed and travels with the record so the reader sees what was not decided.
 */
export function publicationVerdict(record, now = new Date().toISOString()) {
  const reasons = [];
  const verdicts = Object.fromEntries(record.eligibility.gates.map(item => [item.gate, item.verdict]));
  for (const gate of OBSERVATION_GATES) if (verdicts[gate] !== 'satisfied') reasons.push(`${gate}:${verdicts[gate]}`);
  for (const gate of JUDGEMENT_GATES) if (verdicts[gate] === 'not_satisfied') reasons.push(`${gate}:not_satisfied`);
  if (!record.rights.redistributable) reasons.push('rights:not_redistributable');
  if (record.provenance.source_class === 'cc_host_graph_seed') reasons.push('provenance:seed_only');
  if (record.verification.route_state === 'unverified' && record.opportunity_type !== 'ai_citation_source' && record.opportunity_type !== 'link_insertion' && record.opportunity_type !== 'resource_page')
    reasons.push('route:unverified');
  if (freshness(record, now) === 'stale') reasons.push('freshness:stale');
  if (record.withdrawal) reasons.push(`withdrawn:${record.withdrawal.reason}`);
  return {publishable: reasons.length === 0, reasons, freshness: freshness(record, now)};
}

/**
 * Listing loss is confirmed only by two complete `absent` observations at least CONFIRMATION_MS
 * apart. An `unknown` between them does not advance the clock and never confirms anything.
 */
export function confirmListingLoss(observations) {
  const absents = observations
    .filter(item => item.outcome === 'absent' && item.complete)
    .map(item => new Date(item.observed_at).getTime())
    .sort((a, b) => a - b);
  if (absents.length < 2) return {confirmed: false, reason: absents.length ? 'one_absent_observation' : 'no_absent_observation'};
  const first = absents[0], last = absents[absents.length - 1];
  return last - first >= CONFIRMATION_MS
    ? {confirmed: true, reason: 'two_absent_observations'}
    : {confirmed: false, reason: 'confirmation_window_not_elapsed'};
}

/** Deterministic id from the fields that identify the subject; the same surface never gets two ids. */
export async function opportunityRecordId(nicheId, subject) {
  const key = [nicheId, subject.host, subject.page_url ?? '', subject.route_url ?? ''].join('\n');
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `opp_${nicheId}_${hex.slice(0, 16)}`;
}

/** Next re-verification time from the last one. Null when never verified. */
export function nextDueAt(lastVerifiedAt) {
  if (!lastVerifiedAt) return null;
  return new Date(new Date(lastVerifiedAt).getTime() + VERIFICATION_WINDOW_DAYS * DAY_MS).toISOString();
}
