import { publicFetcher, VerificationError } from '../verifier/fetch.js';
import { validatePublicUrl } from '../verifier/url.js';

// One interface over every way we acquire a page, so a runtime can be added without
// rebuilding the corpus. Direct fetching is implemented here on the verifier's public
// fetcher, which already validates every redirect hop, applies robots per hop, bounds the
// body and refuses a transport that follows redirects on its own.
//
// Rendered and proxied acquisition are declared and NOT configured. They return an explicit
// `not_configured` outcome, the same stance the discovery adapter takes towards a supplier
// it has no credentials for: an unconfigured path yields an error, never fabricated data.
export const FETCH_KINDS = Object.freeze(['direct', 'rendered', 'proxied']);
export const ACQUISITION_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 });

// Every way a page attempt can end. The frontier records the outcome; none of them is ever
// allowed to reach the corpus as "this page has no links".
export const OUTCOMES = Object.freeze(['fetched', 'not_found', 'blocked', 'unavailable', 'not_configured', 'deferred']);

const BLOCKED_REASONS = /^(robots_disallowed|robots_|access_challenge|source_http_(401|403|429))/;
// A slot we could not take is not the publisher's fault and not a defect: retry it later.
const DEFERRABLE = new Set(['origin_busy']);
const NOT_FOUND = new Set([404, 410]);

export class AcquisitionError extends Error {
  constructor(reason) { super(reason); this.name = 'AcquisitionError'; this.reason = reason; }
}

/** Sorts a fetch failure into an outcome. Everything unrecognised is unavailable, never empty. */
export function classifyFailure(reason) {
  if (DEFERRABLE.has(reason)) return 'deferred';
  if (reason === 'robots_crawl_delay_requires_scheduler') return 'blocked';
  if (BLOCKED_REASONS.test(reason)) return 'blocked';
  if (/^source_http_(404|410)$/.test(reason)) return 'not_found';
  return 'unavailable';
}

/**
 * @param options.publicFetchSafe  Asserts the transport enforces a public-only destination
 *   boundary, which lexical URL screening cannot. Required for direct fetching.
 * @param options.runtimes  { rendered, proxied } acquisition runtimes. Each must assert its
 *   OWN boundary; see the safety note on `assertRuntime`.
 * @param options.beforeFetch  Pacing hook, called before robots and page requests. Required
 *   whenever a publisher asks for a crawl delay, which is why the frontier owns scheduling.
 */
export function createAcquisition(options = {}) {
  const maxBytes = Math.min(options.maxBytes ?? ACQUISITION_LIMITS.maxBytes, ACQUISITION_LIMITS.maxBytes);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? ACQUISITION_LIMITS.timeoutMs, 1), ACQUISITION_LIMITS.timeoutMs);
  const runtimes = options.runtimes ?? {};
  const clock = options.now ?? (() => new Date().toISOString());

  async function direct(url, beforeFetch) {
    // The public boundary is a property of the transport, not of this module. Refuse rather
    // than fetch on an unasserted one; a lexically public hostname can still resolve inside.
    if (options.publicFetchSafe !== true) throw new AcquisitionError('public_fetch_boundary_not_asserted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const trace = { finalUrl: url, redirects: [], robots: null, httpStatus: null };
    try {
      const fetcher = publicFetcher({ ...options, beforeFetch: beforeFetch ?? options.beforeFetch, maxBytes, maxRedirects: ACQUISITION_LIMITS.maxRedirects }, controller.signal);
      const { response, body } = await fetcher.source(url, trace);
      if (NOT_FOUND.has(response.status)) return { outcome: 'not_found', trace, html: null };
      return { outcome: 'fetched', trace, html: body?.text ?? '', bytes: body?.bytes ?? 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A runtime that is not the platform's own public fetch does NOT inherit its guarantees.
   * A proxy or headless browser resolves and connects on its own, so the boundary that makes
   * direct fetching safe says nothing about it. Each must assert its own, explicitly.
   */
  function assertRuntime(kind) {
    const runtime = runtimes[kind];
    if (!runtime) throw new AcquisitionError(`${kind}_runtime_not_configured`);
    if (runtime.publicFetchSafe !== true) throw new AcquisitionError(`${kind}_runtime_boundary_not_asserted`);
    if (typeof runtime.fetchPage !== 'function') throw new AcquisitionError(`${kind}_runtime_invalid`);
    return runtime;
  }

  return {
    /**
     * Whether a fetch kind can actually be served. The crawl loop asks before escalating a
     * page to a browser, because queueing work no runtime can serve would leave the frontier
     * permanently non-empty and the run never finished.
     */
    supports(kind) {
      if (kind === 'direct') return options.publicFetchSafe === true;
      const runtime = runtimes[kind];
      return Boolean(runtime) && runtime.publicFetchSafe === true && typeof runtime.fetchPage === 'function';
    },

    /**
     * Acquires one page. Always resolves: an attempt that failed is a recorded outcome, not
     * a thrown error, because the corpus must keep attempted outcomes and not only successes.
     */
    async fetchPage(rawUrl, { kind = 'direct', beforeFetch = null } = {}) {
      const at = clock();
      const base = { url: rawUrl, final_url: null, kind, http_status: null, robots: null,
        html: null, body_truncated: false, fetched_at: at, reason: null };
      if (!FETCH_KINDS.includes(kind)) return { ...base, outcome: 'unavailable', reason: 'unsupported_fetch_kind' };
      const checked = validatePublicUrl(rawUrl);
      if (!checked.valid) return { ...base, outcome: 'unavailable', reason: `unsafe_url:${checked.reason}` };

      try {
        if (kind === 'direct') {
          const { outcome, trace, html } = await direct(checked.url, beforeFetch);
          return { ...base, outcome, final_url: trace.finalUrl, http_status: trace.httpStatus,
            robots: trace.robots, redirects: trace.redirects, html,
            // The verifier's reader refuses an oversized body outright, so a returned body was
            // read to the end. Truncation reaches extraction from runtimes with their own caps.
            body_truncated: false, render_ms: 0, proxy_bytes: 0 };
        }
        const runtime = assertRuntime(kind);
        const result = await runtime.fetchPage(checked.url, { maxBytes, timeoutMs });
        return { ...base, outcome: result.outcome ?? 'fetched', final_url: result.finalUrl ?? checked.url,
          http_status: result.httpStatus ?? null, html: result.html ?? null,
          body_truncated: result.bodyTruncated === true, reason: result.reason ?? null,
          // The units a runtime actually consumed. Rendering and proxy traffic are what make
          // these paths expensive, so dropping them here would leave every metered run
          // reporting zero and make the ceiling unenforceable for exactly the kinds that need
          // one. A direct fetch reports neither, which is correct: it spends neither.
          render_ms: Number.isInteger(result.renderMs) ? result.renderMs : 0,
          proxy_bytes: Number.isInteger(result.proxyBytes) ? result.proxyBytes : 0 };
      } catch (error) {
        // Any error carrying its own reason keeps it, including the pacing hook's, so a
        // slot we could not take is classified as deferrable rather than as a failure.
        const reason = typeof error?.reason === 'string' ? error.reason : 'acquisition_error';
        const outcome = error instanceof AcquisitionError && /not_configured|not_asserted|_invalid$/.test(reason)
          ? 'not_configured' : classifyFailure(reason);
        return { ...base, outcome, reason };
      }
    },
  };
}
