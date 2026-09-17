// Imported discovery rows: the customer's own supplier export, as a first-class source.
//
// This is the lane that makes "we do not make you depend on our data" true while our corpus is
// near empty. The customer keeps paying Ahrefs, or exports Search Console, and AgentLinkOps
// verifies and watches what they already own.
//
// Three rules shape it, and each is a refusal rather than a feature.
//
//   **An import never claims completeness.** Nothing in an export says whether it is page one
//   of forty or a filtered view, so coverage is `partial` and says so. It is the one claim in
//   the discovery contract we would have no way at all to check.
//
//   **A malformed row is reported, with its position and what failed.** Never dropped. An
//   import that silently discards forty rows of a paid export produces a number that is wrong
//   in a way the customer finds months later.
//
//   **The supplier's numbers stay the supplier's.** Ahrefs DR, Moz DA and Majestic Trust Flow
//   measure different things on different scales. They are carried named and unnormalised, and
//   nothing here turns them into an AgentLinkOps score.
import { z } from 'zod';
import { validatePublicUrl, matchesTarget } from '../verifier/url.js';
import { DISCOVERY_VERSION, DISCOVERY_LIMITS, IMPORT_SUPPLIERS, DiscoveryCandidate, candidateId, sourceQueryTerms } from './contract.js';

export class ImportError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'ImportError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ImportError(code, status); };

/** One row as a caller may supply it. Deliberately loose on the supplier's own fields. */
export const ImportRow = z.object({
  source_url: z.string().max(4096),
  target_url: z.string().max(4096),
  anchor: z.string().max(4096).nullish(),
  rel: z.union([z.string().max(1024), z.array(z.string().max(128)).max(32)]).nullish(),
  dofollow: z.boolean().nullish(),
  link_type: z.string().max(64).nullish(),
  first_seen: z.string().max(64).nullish(),
  last_seen: z.string().max(64).nullish(),
  is_lost: z.boolean().nullish(),
  supplier_row_id: z.string().max(256).nullish(),
  supplier_metrics: z.record(z.string().min(1).max(64), z.union([z.number(), z.string().max(256), z.null()])).nullish(),
});

const REL_TOKEN = /^[a-zA-Z0-9_-]{1,128}$/u;
const toIso = value => {
  if (value === null || value === undefined || value === '') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

/**
 * Normalizes one supplier row into the candidate shape, or explains why it cannot be.
 *
 * A supplier date that cannot be parsed is an ERROR rather than a null, because a null would
 * read as "the supplier did not say" when in fact it said something we failed to understand.
 */
export function normalizeRow(row, { runId, workspaceId, projectId, supplier, taskId, retrievedAt, target, scope, generatedAt = null }) {
  const parsed = ImportRow.safeParse(row);
  if (!parsed.success) return { error: parsed.error.issues.map(issue => `${issue.path.join('.') || 'row'}: ${issue.message}`).join('; ') };
  const value = parsed.data;
  // An EMPTY cell and a malformed URL are different problems with different fixes — a column
  // mapped to the wrong field, versus rows that need cleaning — and `invalid_url` for both
  // sends the reader to the wrong one.
  for (const field of ['source_url', 'target_url']) {
    if (!String(value[field] ?? '').trim()) return { error: `${field}: empty` };
  }
  const source = validatePublicUrl(value.source_url);
  if (!source.valid) return { error: `source_url: ${source.reason}` };
  const destination = validatePublicUrl(value.target_url);
  if (!destination.valid) return { error: `target_url: ${destination.reason}` };
  // A row about someone else's site is not a row about this import's target. Accepting it
  // would quietly widen the run's scope past what its coverage statement describes.
  if (!matchesTarget(destination.url, target, scope)) return { error: 'target_url: outside the scope of this import' };

  const dates = {};
  for (const field of ['first_seen', 'last_seen']) {
    const iso = toIso(value[field]);
    if (iso === undefined) return { error: `${field}: not a date we can read (${String(value[field]).slice(0, 40)})` };
    dates[field] = iso;
  }
  let rel = null;
  if (value.rel !== null && value.rel !== undefined) {
    const tokens = (Array.isArray(value.rel) ? value.rel : String(value.rel).split(/[\s,]+/u)).filter(Boolean);
    if (tokens.some(token => !REL_TOKEN.test(token))) return { error: 'rel: not a list of relation tokens' };
    rel = [...new Set(tokens.map(token => token.toLowerCase()))].sort();
  }
  return {
    candidate: {
      v: DISCOVERY_VERSION, id: null,
      workspace_id: workspaceId, project_id: projectId, discovery_run_id: runId,
      source_url: source.url, target_url: destination.url,
      provider: 'imported', data_mode: 'imported',
      provider_task_id: taskId, provider_retrieved_at: retrievedAt,
      provider_first_seen: dates.first_seen, provider_prev_seen: null, provider_last_seen: dates.last_seen,
      provider_status: { is_lost: value.is_lost ?? null, is_broken: null, is_new: null },
      anchor: value.anchor ?? null, rel,
      // A supplier that states `rel` and no follow flag has still told us the answer; one that
      // states neither has not, and a guess would become a fact the moment it was stored.
      dofollow: value.dofollow ?? (rel ? !rel.includes('nofollow') : null),
      link_type: value.link_type ?? null,
      source_http_status: null, target_http_status: null, links_count: null,
      provider_metrics: { imported: {
        supplier, supplier_row_id: value.supplier_row_id ?? null,
        supplier_generated_at: generatedAt, supplier_metrics: value.supplier_metrics ?? null,
      } },
      verification_status: 'not_checked', verified_at: null, observation_id: null, evidence_id: null,
    },
  };
}

/**
 * Turns a supplier export into a run's worth of candidates.
 *
 * Returns accepted candidates, per-row rejections and per-row duplicates. The caller decides
 * what to do with the rejections; this function's only obligation is never to hide them.
 */
export async function prepareImport({ runId, workspaceId, projectId, supplier, rows, target, scope, taskId, retrievedAt, generatedAt = null, seen = new Map(), rowOffset = 0 }) {
  if (!IMPORT_SUPPLIERS.includes(supplier)) fail('UNKNOWN_IMPORT_SUPPLIER');
  if (!Array.isArray(rows)) fail('INVALID_IMPORT_ROWS');
  if (rows.length > DISCOVERY_LIMITS.rows) {
    // A bare code tells the customer nothing about a file they are looking at right now.
    const error = new ImportError('IMPORT_TOO_LARGE', 413);
    error.message = `IMPORT_TOO_LARGE: ${rows.length} rows, and one import holds at most ${DISCOVERY_LIMITS.rows}`;
    throw error;
  }
  const accepted = [], rejected = [], duplicates = [];
  // `seen` may be shared across calls so a file larger than one import can still detect a
  // placement repeated in two different chunks of itself.
  for (const [position, row] of rows.entries()) {
    const index = position + rowOffset;
    const result = normalizeRow(row, { runId, workspaceId, projectId, supplier, taskId, retrievedAt, target, scope, generatedAt });
    if (result.error) { rejected.push({ row: index + 1, reason: result.error }); continue; }
    const candidate = result.candidate;
    candidate.id = await candidateId(runId, candidate.source_url, candidate.target_url);
    // The same placement twice in one export is the supplier's duplicate, not a second link.
    if (seen.has(candidate.id)) { duplicates.push({ row: index + 1, first_seen_on_row: seen.get(candidate.id) }); continue; }
    seen.set(candidate.id, index + 1);
    // Parsed rather than trusted: a row that cannot satisfy the candidate contract is a
    // rejection with a reason, even when it came from our own normalizer.
    const checked = DiscoveryCandidate.safeParse(candidate);
    if (!checked.success) { rejected.push({ row: index + 1, reason: checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }); continue; }
    accepted.push(checked.data);
  }
  return { accepted, rejected, duplicates, returned_rows: rows.length };
}

/** The query an import describes: this target, as supplied, no ranking claimed. */
export function importQuery({ targetKind, target, includeSubdomains = false, statusType = 'all', rowLimit = DISCOVERY_LIMITS.rows }) {
  return {
    target_kind: targetKind, target, include_subdomains: includeSubdomains,
    backlinks_status_type: statusType, exclude_internal_backlinks: true,
    mode: 'as_is', filters: null,
    ...sourceQueryTerms('imported'),
    page_limit: rowLimit, row_limit: rowLimit,
  };
}
