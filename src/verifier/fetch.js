import { validatePublicUrl } from './url.js';
import { robotsDecision } from './robots.js';

export class VerificationError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'VerificationError';
    this.reason = reason;
    Object.assign(this, details);
  }
}

function cancelBody(response) {
  // Cancellation must not extend the request deadline on a misbehaving transport.
  response.body?.cancel().catch(() => {});
}

export async function readBounded(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  const encoded = response.headers.get('content-encoding');
  if (!encoded && length && Number(length) > maxBytes) {
    cancelBody(response);
    throw new VerificationError('body_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new VerificationError('body_too_large');
      chunks.push(value);
    }
    if (!encoded && length && Number(length) !== bytes) throw new VerificationError('incomplete_body');
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    const contentType = response.headers.get('content-type') ?? '';
    const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? 'utf-8';
    let text;
    try { text = new TextDecoder(charset, { fatal: true }).decode(combined); }
    catch { throw new VerificationError('unsupported_or_invalid_encoding'); }
    return { text, bytes, data: combined };
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new VerificationError('timeout'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new VerificationError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** One shared budget for robots, redirects, hooks and source-body reads. */
export const PRODUCT_TOKEN = 'LinktrailBot';

// A day. Anything longer is a publisher saying "not today", and a scheduler that honoured a
// month-long Retry-After would silently retire the check instead of retrying it.
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * RFC 9110 `Retry-After`: delta-seconds or an HTTP-date. Returns null for anything else.
 *
 * Both forms appear in the wild and a parser that reads only the integer form silently discards
 * the date form, which is the one a CDN tends to send.
 */
export function retryAfterSeconds(value, now = Date.now()) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+$/u.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : null;
  }
  // `Date.parse` accepts far more than an HTTP-date — it reads "-5" as a year and returns a real
  // timestamp, which turned a malformed header into a wait of zero. An IMF-fixdate always carries
  // a month and day name, so requiring a letter is enough to keep the loose parser off junk.
  if (!/[A-Za-z]/u.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  // A date already in the past means "now", never a negative wait.
  return Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

export function publicFetcher(options, signal) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const robotsByOrigin = new Map();
  // The product token is what robots matches on and never changes. A contact URL may be appended
  // so a publisher who sees us in their logs can find out who we are — the convention every
  // reputable crawler follows, and the thing most likely to move a reflexive 403 or 429.
  //
  // It defaults to ABSENT on purpose. It was written before AgentLinkOps had a public domain, and a bot
  // advertising a URL that does not resolve is worse than one advertising nothing: it reads as
  // impersonation rather than identification. Set it when a real domain exists.
  const userAgent = options.userAgentContact
    ? `${PRODUCT_TOKEN}/0.1 (+${String(options.userAgentContact).slice(0, 200)})`
    : `${PRODUCT_TOKEN}/0.1`;
  const maxRedirects = Math.min(options.maxRedirects ?? 5, 5);
  const maxBytes = Math.min(options.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024);

  async function request(url, context = {}) {
    const checked = validatePublicUrl(url);
    if (!checked.valid) throw new VerificationError(`unsafe_url:${checked.reason}`);
    if (options.beforeFetch) await withAbort(Promise.resolve().then(() => options.beforeFetch(checked.url, { ...context, signal })), signal);
    let response;
    try {
      response = await withAbort(Promise.resolve().then(() => {
        if (signal.aborted) throw new VerificationError('timeout');
        return fetchImpl(checked.url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          signal,
          headers: {
            'User-Agent': userAgent,
            Accept: context.kind === 'robots' ? 'text/plain' : 'text/html',
          },
        });
      }), signal);
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      throw new VerificationError(signal.aborted ? 'timeout' : 'network_error');
    }
    // Custom transports must never silently follow redirects or bypass destination checks.
    if (response.redirected || (response.url && new URL(response.url).href !== checked.url)) {
      cancelBody(response);
      throw new VerificationError('transport_followed_redirect');
    }
    return response;
  }

  async function fetchRobots(origin, diagnostic) {
    let url = `${origin}/robots.txt`;
    const seen = new Set();
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      diagnostic.robotsUrl = url;
      diagnostic.httpStatus = null;
      if (seen.has(url)) throw new VerificationError('robots_redirect_loop');
      seen.add(url);
      const response = await request(url, { kind: 'robots' });
      diagnostic.httpStatus = response.status;
      // A challenge replaces the requested resource, even when its status would
      // otherwise mean missing robots or a redirect. Never infer policy from it.
      if (response.headers.get('cf-mitigated') === 'challenge') {
        cancelBody(response);
        const retry = retryAfterSeconds(response.headers.get('retry-after'));
        if (retry !== null) diagnostic.retryAfterSeconds = retry;
        throw new VerificationError('robots_access_challenge', retry === null ? {} : { retryAfterSeconds: retry });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        cancelBody(response);
        const location = response.headers.get('location');
        if (!location) throw new VerificationError('robots_redirect_missing_location');
        const next = validatePublicUrl(new URL(location, url).href);
        if (!next.valid) throw new VerificationError(`unsafe_robots_redirect:${next.reason}`);
        if (diagnostic.redirects.length < 5) diagnostic.redirects.push({ from: url, to: next.url, status: response.status });
        url = next.url;
        continue;
      }
      // RFC 9309 §2.3.1.3 and Google's implementation agree: a 4xx on robots.txt means the file is
      // UNAVAILABLE, and an unavailable robots.txt imposes no restrictions. Only 404 and 410 were
      // honoured that way here, so a 401 or 403 — a WAF answering before the file is even looked
      // for — was read as "this publisher forbids us" and refused the whole fetch. Measured on 800
      // real destinations, that was 39 refusals, about 5% of the run, attributed to publishers who
      // had said nothing.
      //
      // Proceeding is also BETTER REPORTING even when the page then fails: `target_http_403` says
      // the publisher refused the page, where `robots_http_403` said we never asked.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        cancelBody(response);
        return { text: '', reason: response.status === 404 || response.status === 410 ? 'robots_not_found' : `robots_unavailable_${response.status}` };
      }
      // 429 and 5xx are the other half of the same rule and stay a refusal: they mean TEMPORARILY
      // unavailable, and the spec's answer to that is to stay away rather than to assume consent.
      if (!response.ok) {
        cancelBody(response);
        const retry = retryAfterSeconds(response.headers.get('retry-after'));
        if (retry !== null) diagnostic.retryAfterSeconds = retry;
        throw new VerificationError(`robots_http_${response.status}`, retry === null ? {} : { retryAfterSeconds: retry });
      }
      const body = await readBounded(response, 512 * 1024, signal);
      if (/text\/html/iu.test(response.headers.get('content-type') ?? '') || /<(?:!doctype|html|body)\b/iu.test(body.text)) {
        throw new VerificationError('robots_not_plain_text');
      }
      return { text: body.text, reason: 'robots_fetched' };
    }
    throw new VerificationError('robots_redirect_limit');
  }

  async function checkRobots(url, trace) {
    const origin = new URL(url).origin;
    const diagnostic = { sourceUrl: url, robotsUrl: `${origin}/robots.txt`, httpStatus: null,
      productToken: PRODUCT_TOKEN, allowed: null, reason: null, matchedRule: null,
      crawlDelaySeconds: null, fetched: null, redirects: [] };
    // Write before fetching/evaluating so refusals keep the failing hop, not the
    // last allowed origin. Both histories are capped by our redirect budget.
    trace.robots = diagnostic;
    trace.robotsHistory ??= [];
    if (trace.robotsHistory.length < 6) trace.robotsHistory.push(diagnostic);
    try {
      if (!robotsByOrigin.has(origin)) {
        const record = await fetchRobots(origin, diagnostic);
        robotsByOrigin.set(origin, { ...record, diagnostic: structuredClone(diagnostic) });
      }
      const record = robotsByOrigin.get(origin);
      Object.assign(diagnostic, structuredClone(record.diagnostic), { sourceUrl: url });
      const decision = robotsDecision(record.text, url);
      Object.assign(diagnostic, decision, { fetched: record.reason });
      options.onRobots?.(url, decision);
      if (decision.allowed !== true) throw new VerificationError(decision.reason);
      if (decision.crawlDelaySeconds > 0 && !options.beforeFetch) {
        throw new VerificationError('robots_crawl_delay_requires_scheduler');
      }
      return diagnostic;
    } catch (error) {
      diagnostic.reason = error instanceof VerificationError ? error.reason : 'verification_error';
      throw error;
    }
  }

  return {
    // Authorize a native browser document without refetching its body through HTTP.
    // The caller still needs an independently verified browser egress boundary.
    async authorizeNavigation(url, trace = {}) {
      const checked = validatePublicUrl(url);
      if (!checked.valid) throw new VerificationError('unsafe_render_navigation');
      const robots = await checkRobots(checked.url, trace);
      if (signal.aborted) throw new VerificationError('timeout');
      await options.beforeFetch?.(checked.url, { kind: 'source', crawlDelaySeconds: robots.crawlDelaySeconds, signal });
      if (signal.aborted) throw new VerificationError('timeout');
      return robots;
    },
    async source(initialUrl, trace) {
      let url = initialUrl;
      const seen = new Set();
      for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        trace.finalUrl = url;
        if (seen.has(url)) throw new VerificationError('redirect_loop');
        seen.add(url);
        const robots = await checkRobots(url, trace);
        trace.robots = robots;
        const response = await request(url, { kind: 'source', crawlDelaySeconds: robots.crawlDelaySeconds });
        trace.httpStatus = response.status;
        trace.sourceResponse = { url, httpStatus: response.status,
          contentType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+/iu.exec(response.headers.get('content-type') ?? '')?.[0].slice(0, 128) ?? null,
          retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
          challenge: response.headers.get('cf-mitigated') === 'challenge' };
        if (trace.sourceResponse.challenge) {
          cancelBody(response);
          const retry = trace.sourceResponse.retryAfterSeconds;
          throw new VerificationError('access_challenge', retry === null ? {} : { retryAfterSeconds: retry });
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          cancelBody(response);
          const location = response.headers.get('location');
          if (!location) throw new VerificationError('redirect_missing_location');
          let next;
          try { next = validatePublicUrl(new URL(location, url).href); }
          catch { throw new VerificationError('invalid_redirect'); }
          if (!next.valid) throw new VerificationError(`unsafe_redirect:${next.reason}`);
          trace.redirects.push({ from: url, to: next.url, status: response.status });
          url = next.url;
          continue;
        }
        if ([404, 410].includes(response.status)) {
          cancelBody(response);
          return { response, body: null };
        }
        if (response.status === 304) {
          cancelBody(response);
          throw new VerificationError('not_modified_without_baseline');
        }
        if (response.status !== 200) {
          cancelBody(response);
          // A 429 or a 503 may state WHEN to come back. We keep it and never act on it here:
          // sleeping inside a request holds an origin lease and a worker for someone else's
          // backoff, and this system already decided that **the cron is the sleep**. Surfacing it
          // lets a scheduler re-queue at the stated time, the same way a robots crawl delay is
          // handed to the scheduler rather than slept on.
          throw new VerificationError(`source_http_${response.status}`,
            retryAfterSeconds(response.headers.get('retry-after')) === null ? {}
              : { retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')) });
        }
        if (!/^text\/html(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
          cancelBody(response);
          throw new VerificationError('unsupported_content_type');
        }
        const body = await readBounded(response, maxBytes, signal);
        return { response, body };
      }
      throw new VerificationError('redirect_limit');
    },
  };
}
