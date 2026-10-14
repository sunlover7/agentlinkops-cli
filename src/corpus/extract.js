import { parseDocument, pageDirectives } from '../verifier/parser.js';
import { validatePublicUrl } from '../verifier/url.js';
import { frontierKey } from './frontier.js';
import { analyzeReadiness, isAccessChallenge } from '../verifier/readiness.js';

// Turns one fetched public HTML page into the outbound edges our corpus stores.
// Pure: no fetch, no persistence, no scheduling. The caller owns acquisition.
//
// This deliberately reuses the verifier's parser rather than adopting an audit crawler's.
// That parser already keeps every anchor/area occurrence instead of collapsing them by
// destination, keeps raw rel tokens rather than a nofollow boolean, and THROWS on its
// complexity limits instead of returning a short list. The last property is the one that
// matters most here: a page we could not fully read must never be recorded as a page with
// few links, because absence is what the whole product must not fake.
export const EXTRACTION_VERSION = 1;

// A link carrying any of these is a hint, not an endorsement, so it does not pass equity.
const UNFOLLOWED_REL = new Set(['nofollow', 'sponsored', 'ugc']);

export class ExtractionError extends Error {
  constructor(reason) { super(reason); this.name = 'ExtractionError'; this.reason = reason; }
}

/** Same host, or one host is a subdomain of the other. */
function relatedHost(host, other) {
  return host === other || host.endsWith(`.${other}`) || other.endsWith(`.${host}`);
}

/**
 * @param html   Decoded response body. The caller must say if it was cut short.
 * @param pageUrl Canonical URL of the page the body came from, after redirects.
 * @param options.fetchKind      How the body was acquired: direct, rendered or proxied.
 * @param options.bodyTruncated  True when the byte budget stopped the read.
 * @param options.xRobotsTag     Raw X-Robots-Tag response header, if any.
 * @param options.internalHosts  Hosts to treat as the source's own. Defaults to the source
 *                               host and its subdomains. Pass the site's real host list
 *                               when siblings such as blog. and www. must count as internal;
 *                               without a public suffix list this cannot be inferred.
 * @throws ExtractionError with `.reason` when the page could not be read completely enough
 *         to enumerate its links. Callers record an unknown page, never an empty one.
 */
export function extractEdges(html, { pageUrl, fetchKind, bodyTruncated = false, xRobotsTag = null, internalHosts } = {}) {
  if (!['direct', 'rendered', 'proxied'].includes(fetchKind)) throw new ExtractionError('unsupported_fetch_kind');
  const page = validatePublicUrl(pageUrl);
  if (!page.valid) throw new ExtractionError(`source_${page.reason}`);

  let document;
  // Complexity limits reject the page rather than returning part of it. Re-thrown as an
  // ExtractionError so a caller cannot mistake a refusal for a result.
  try { document = parseDocument(html, page.url); }
  catch (error) { throw new ExtractionError(error.reason ?? 'unreadable_document'); }

  // A page whose links we could not have seen must not be stored as a page with few links.
  // These are the verifier's own "cannot conclude absence" rules, which matter even more
  // here: a plain-fetch crawler that records a JavaScript-rendered publisher as link-free
  // poisons the corpus silently, and that is the single most common false-negative in this
  // category. The rules are asymmetric on purpose — a real article that happens to carry a
  // login form still extracts, because it produced links.
  const { readiness, managedClientChallenge } = analyzeReadiness({ html, parsed: document });
  if (isAccessChallenge(document, { managedClientChallenge })) throw new ExtractionError('access_challenge');
  if (!document.links.length) {
    if (document.meta.some(item => item.name === 'refresh')) throw new ExtractionError('navigation_requires_browser');
    if (readiness.possibleLoginWall) throw new ExtractionError('possible_login_wall');
    if (document.hasScript && document.visibleText.length < 80) throw new ExtractionError('possible_render_required');
  }
  // Navigation links around an empty application root do not make its content complete.
  if(readiness.requiresRender)throw new ExtractionError('possible_render_required');

  const directives = pageDirectives(document.meta, xRobotsTag);
  const owned = internalHosts?.length
    ? internalHosts.map(host => host.toLowerCase())
    : [page.hostname];

  // Group occurrences by canonical destination. Discovery reports that an edge exists and
  // how often; per-occurrence anchor, rel and evidence belong to a verification check,
  // which the verifier already produces on demand for a selected candidate.
  const byTarget = new Map();
  let outlinks = 0, externalOutlinks = 0;
  for (const link of document.links) {
    const target = validatePublicUrl(link.targetUrl);
    if (!target.valid) continue;
    outlinks++;
    const internal = owned.some(host => relatedHost(target.hostname, host));
    if (!internal) externalOutlinks++;
    const existing = byTarget.get(target.url);
    const followed = !directives.nofollow && !link.rel.some(token => UNFOLLOWED_REL.has(token));
    if (existing) {
      existing.links_count++;
      // Any followed occurrence makes the edge followed: a nofollow copy in a comment does
      // not undo a followed link in the body. `rel` stays the first occurrence's tokens,
      // so `dofollow` is NOT a function of the `rel` reported beside it.
      existing.dofollow ||= followed;
      continue;
    }
    byTarget.set(target.url, {
      target_url: target.url, target_hostname: target.hostname, internal,
      anchor: link.anchor || null, rel: link.rel.length ? link.rel : null, dofollow: followed,
      links_count: 1, context: link.context || null, locator: link.locator,
    });
  }

  return {
    v: EXTRACTION_VERSION,
    source_url: page.url, source_hostname: page.hostname, fetch_kind: fetchKind,
    // A body the byte budget cut short, or a document with unfinished markup, was not read
    // to the end. The contract refuses `complete_for_query` coverage on such a page.
    extraction_complete: !bodyTruncated && !document.incomplete,
    page_nofollow: directives.nofollow, page_noindex: directives.noindex,
    // Non-null when the page declares a DIFFERENT URL as canonical, i.e. it is a duplicate
    // of that one. Recorded and surfaced, never used to silently drop the page: cross-domain
    // and plain wrong canonicals are common, and discarding them would lose real links.
    // Compared through the frontier key, so a canonical differing only by a trailing slash,
    // an index filename or a tracking parameter is the SAME page, not a duplicate of another.
    // Measured against real publishers, raw string comparison flagged 11 of 14 pages as
    // duplicates when almost all of them were declaring themselves.
    canonical_url: document.canonical && frontierKey(document.canonical) !== frontierKey(page.url)
      ? document.canonical : null,
    source_outlink_count: outlinks, source_external_outlink_count: externalOutlinks,
    title: document.title || null,
    edges: [...byTarget.values()],
  };
}

/**
 * Shapes one extracted edge as a discovery candidate for the owned corpus. The caller
 * supplies run lineage and the crawl clocks; nothing here invents a date or a check.
 */
export function edgeToCandidate(edge, page, { runId, workspaceId, projectId, candidateId, taskId, retrievedAt, firstSeen = null, prevSeen = null, lastSeen = null }) {
  return {
    v: 1, id: candidateId, workspace_id: workspaceId, project_id: projectId, discovery_run_id: runId,
    source_url: page.source_url, target_url: edge.target_url,
    provider: 'linktrail_corpus', data_mode: 'owned_corpus',
    provider_task_id: taskId, provider_retrieved_at: retrievedAt,
    provider_first_seen: firstSeen, provider_prev_seen: prevSeen, provider_last_seen: lastSeen,
    // A crawl that saw the link says nothing about loss or breakage, and our own crawl
    // clocks are still upstream data rather than a check against a customer expectation.
    provider_status: { is_lost: null, is_broken: null, is_new: null },
    anchor: edge.anchor, rel: edge.rel, dofollow: edge.dofollow, link_type: 'anchor',
    source_http_status: null, target_http_status: null, links_count: edge.links_count,
    provider_metrics: { linktrail_corpus: {
      source_outlink_count: page.source_outlink_count,
      source_external_outlink_count: page.source_external_outlink_count,
      fetch_kind: page.fetch_kind, extraction_complete: page.extraction_complete,
    } },
    verification_status: 'not_checked', verified_at: null, observation_id: null, evidence_id: null,
  };
}
