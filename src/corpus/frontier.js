import { validatePublicUrl } from '../verifier/url.js';

// Decides what the crawler is allowed to queue, and in what order. Pure: no fetch, no
// persistence, no clock of its own. Persistence and leasing belong to the store; this
// module owns the judgement that keeps a crawl finite and on-topic.
export const FRONTIER_VERSION = 1;

export const FRONTIER_LIMITS = Object.freeze({
  pathDepth: 12,          // deeper than any editorial page we want; archives spiral past this
  querySize: 4,           // faceted navigation multiplies past this
  repeatedSegment: 3,     // /a/b/a/b/a/b is a cycle, not a hierarchy
  urlLength: 2048,
  hostPages: 500,         // per host, per run
});

// Stripped before deduplication, never a reason to reject. These change nothing about the
// page served, so keeping them would fetch one page once per inbound campaign link.
const TRACKING_PARAMS = [/^utm_/i, /^(gclid|fbclid|msclkid|mc_[ce]id|igshid|ref|ref_src|source|_ga|yclid|dclid|s_kwcid|vero_id|oly_enc_id)$/i];
// Parameters whose whole purpose is to enumerate. Presence is a trap signal, not a strip.
const ENUMERATING_PARAMS = /^(sid|sessionid|jsessionid|phpsessid|calendar|cal_date|date|from_date|to_date|start_date|end_date|month|year|day|week|filter|facet|orderby|order_by|sort_by|price_min|price_max|replytocom)$/i;
// Endpoints that generate results rather than publish pages.
const GENERATED_PATHS = /(^|\/)(search|cart|checkout|login|signin|signup|register|logout|account|wp-admin|wp-login\.php|xmlrpc\.php|feed|rss|atom|print|amp|tag|author|comment-page-\d+|page\/\d{3,})(\/|$)/i;
// Files that are not pages we can extract editorial links from.
const NON_PAGE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|flac|pdf|zip|gz|tar|rar|7z|dmg|exe|msi|pkg|deb|rpm|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot)$/i;

export class FrontierRejection extends Error {
  constructor(reason) { super(reason); this.name = 'FrontierRejection'; this.reason = reason; }
}

/**
 * Canonical deduplication key. Two URLs sharing a key serve the same page for our purposes,
 * so the frontier fetches one of them. Returns null when the URL is not crawlable at all.
 */
export function frontierKey(rawUrl) {
  const checked = validatePublicUrl(rawUrl);
  if (!checked.valid) return null;
  const url = new URL(checked.url);
  // Sorting alone is not enough. Scrapy's canonicalize_url sorts query keys and keeps
  // duplicates, so `?a=1&a=1` and `?a=1` fetch the same page twice; collapse identical pairs.
  const seen = new Set();
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAMS.some(pattern => pattern.test(name)))
    .filter(([name, value]) => { const pair = `${name}=${value}`; if (seen.has(pair)) return false; seen.add(pair); return true; })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);
  // A trailing slash and an explicit directory index address the same document far more
  // often than not, and treating them as two pages doubles every crawl.
  url.pathname = url.pathname.replace(/\/index\.(html?|php|aspx?)$/i, '/').replace(/(.)\/$/, '$1');
  return url.href;
}

/** Longest run of a repeated path segment, which marks a cycle rather than a hierarchy. */
function repeatedSegmentRun(segments) {
  const seen = new Map();
  let worst = 0;
  for (const segment of segments) {
    const count = (seen.get(segment) ?? 0) + 1;
    seen.set(segment, count);
    if (count > worst) worst = count;
  }
  return worst;
}

/**
 * Decides whether a discovered URL may enter the frontier.
 *
 * @param rawUrl        Absolute URL found on a crawled page.
 * @param context.reason        How it was found: seed, sitemap, outlink or refresh.
 * @param context.seenKeys      Keys already queued or crawled. A Set, read only.
 * @param context.hostPages     Pages already queued or crawled for this host, this run.
 * @param context.allowedHosts  When present, only these hosts (and their subdomains) admit.
 * @param context.robotsAllows  Callback (pathname) => boolean. Defaults to allowing.
 * @returns {{admit: boolean, reason: string, key: string|null, hostname: string|null, priority: number}}
 */
export function admitUrl(rawUrl, context = {}) {
  const { reason = 'outlink', seenKeys, hostPages = 0, allowedHosts, robotsAllows } = context;
  const reject = why => ({ admit: false, reason: why, key: null, hostname: null, priority: 0 });

  if (typeof rawUrl !== 'string' || rawUrl.length > FRONTIER_LIMITS.urlLength) return reject('url_too_long');
  const checked = validatePublicUrl(rawUrl);
  if (!checked.valid) return reject(checked.reason);
  const key = frontierKey(rawUrl);
  if (!key) return reject('invalid_url');
  const url = new URL(key), hostname = checked.hostname;

  if (allowedHosts?.length && !allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`)))
    return reject('host_not_in_scope');
  if (seenKeys?.has(key)) return reject('already_seen');
  // The budget is per host so one large publisher cannot consume a whole run.
  if (hostPages >= FRONTIER_LIMITS.hostPages) return reject('host_budget_exhausted');
  if (NON_PAGE_EXTENSION.test(url.pathname)) return reject('not_a_page');
  if (GENERATED_PATHS.test(url.pathname)) return reject('generated_endpoint');

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > FRONTIER_LIMITS.pathDepth) return reject('path_too_deep');
  if (repeatedSegmentRun(segments) >= FRONTIER_LIMITS.repeatedSegment) return reject('repeated_path_segment');

  const params = [...url.searchParams.keys()];
  if (params.length > FRONTIER_LIMITS.querySize) return reject('query_too_large');
  if (params.some(name => ENUMERATING_PARAMS.test(name))) return reject('enumerating_parameter');
  // robots is consulted last so a rejected URL is described by its own defect first.
  if (robotsAllows && !robotsAllows(url.pathname + url.search)) return reject('robots_disallowed');

  return { admit: true, reason, key, hostname, priority: priorityFor(reason, segments.length) };
}

/**
 * Lower sorts first. Seeds and sitemaps outrank pages we merely stumbled onto, and a
 * shallow page outranks a deep one, because editorial resource pages sit near the root.
 */
export function priorityFor(reason, depth) {
  const base = { seed: 0, sitemap: 100, refresh: 200, outlink: 300 }[reason] ?? 400;
  return base + Math.min(depth, FRONTIER_LIMITS.pathDepth);
}

/**
 * Selects the next batch to fetch: cheapest priority first, at most one URL per host per
 * batch so a batch never stacks requests on one origin, and nothing whose host is still
 * inside its crawl delay.
 *
 * @param entries  [{ key, hostname, priority, nextEligibleAt }]
 * @param now      ISO timestamp.
 * @param batchSize Maximum URLs to return.
 */
export function selectBatch(entries, { now, batchSize = 10 } = {}) {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new FrontierRejection('invalid_clock');
  const ready = entries
    .filter(entry => !entry.nextEligibleAt || Date.parse(entry.nextEligibleAt) <= at)
    .sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));
  const hosts = new Set(), batch = [];
  for (const entry of ready) {
    if (hosts.has(entry.hostname)) continue;
    hosts.add(entry.hostname);
    batch.push(entry);
    if (batch.length >= batchSize) break;
  }
  return batch;
}

/**
 * When a host may next be fetched. A robots crawl delay is honoured as stated; otherwise a
 * courtesy floor applies. Never returns a time earlier than the delay a publisher asked for.
 */
export function nextEligibleAt(now, { crawlDelaySeconds = null, courtesySeconds = 5 } = {}) {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new FrontierRejection('invalid_clock');
  const seconds = Math.max(courtesySeconds, crawlDelaySeconds ?? 0);
  return new Date(at + seconds * 1000).toISOString();
}
