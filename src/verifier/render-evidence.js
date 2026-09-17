import { validatePublicUrl } from './url.js';
import { retryAfterSeconds } from './fetch.js';

const text = (value, max = 256) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const url = value => text(value, 2048) && validatePublicUrl(value).valid;

// Native transport metadata is checked separately from the DOM parser. A provider's
// ready flag cannot turn a challenge, failed session or partial document into proof.
export function nativeRenderEvidence(doc, version) {
  const invalid = reason => ({ reason });
  if (version !== 1 || doc.rendererVersion !== 'cf-native-1'
    || !text(doc.contentType) || !text(doc.cfMitigated)
    || typeof doc.challenge !== 'boolean' || typeof doc.visibleLogin !== 'boolean'
    || typeof doc.browserClosed !== 'boolean'
    || !text(doc.browserVersion) || !doc.browserVersion || !text(doc.userAgent, 512) || !doc.userAgent
    || !Number.isInteger(doc.requestCount) || doc.requestCount < 1 || doc.requestCount > 150
    || !Number.isFinite(doc.durationMs) || doc.durationMs < 0 || doc.durationMs > 20_000
    || !(doc.terminationReason === null || text(doc.terminationReason, 80))
    || !Array.isArray(doc.robotsHistory) || !doc.robotsHistory.length || doc.robotsHistory.length > 150) return invalid('invalid_native_render_evidence');
  if (doc.browserClosed !== true) return invalid('render_close_unconfirmed');
  if (doc.terminationReason) return invalid('render_acquisition_incomplete');
  if (doc.cfMitigated.toLowerCase() === 'challenge' || doc.challenge) return invalid('render_access_challenge');
  if (doc.cfMitigated) return invalid('render_access_mitigated');
  if (doc.visibleLogin) return invalid('render_login_wall');
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/iu.test(doc.contentType)) return invalid('render_not_html');
  const robotsHistory = [];
  for (const row of doc.robotsHistory) {
    if (!row || !url(row.sourceUrl) || !url(row.robotsUrl) || row.allowed !== true
      || row.productToken !== 'LinktrailBot' || !text(row.reason, 80)
      || !Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599
      || (row.crawlDelaySeconds !== null && (!Number.isFinite(row.crawlDelaySeconds) || row.crawlDelaySeconds < 0))) return invalid('invalid_render_robots_evidence');
    robotsHistory.push({ sourceUrl: row.sourceUrl, robotsUrl: row.robotsUrl, allowed: true,
      productToken: 'LinktrailBot', reason: row.reason, httpStatus: row.httpStatus,
      crawlDelaySeconds: row.crawlDelaySeconds });
  }
  // Each main-document hop must have a recorded authorization, including the final URL.
  const authorized = new Set(robotsHistory.map(row => row.sourceUrl));
  if (!authorized.has(doc.finalUrl) || doc.redirects.some(hop => !authorized.has(hop.from) || !authorized.has(hop.to))) return invalid('invalid_render_robots_evidence');
  const evidence = { rendererVersion: doc.rendererVersion, contentType: doc.contentType,
    cfMitigated: doc.cfMitigated, challenge: false, visibleLogin: false, browserClosed: true,
    browserVersion: doc.browserVersion, userAgent: doc.userAgent, requestCount: doc.requestCount,
    durationMs: doc.durationMs, terminationReason: null, robotsHistory };
  for (const key of ['blockedMutationRequests','blockedEssentialRequests']) {
    if (doc[key] === undefined) continue;
    if (!Number.isInteger(doc[key]) || doc[key] < 0 || doc[key] > 150) return invalid('invalid_native_render_evidence');
    evidence[key] = doc[key];
  }
  if (doc.sessionId !== undefined) {
    if (!text(doc.sessionId, 128)) return invalid('invalid_native_render_evidence');
    evidence.sessionId = doc.sessionId;
  }
  if (doc.retryAfter !== undefined) {
    if (!text(doc.retryAfter,128)) return invalid('invalid_native_render_evidence');
    evidence.retryAfterSeconds = retryAfterSeconds(doc.retryAfter);
  }
  return { evidence };
}
