import { pageDirectives } from './page-extraction/html.js';
import { validateCaptureReceipt } from './page-acquisition/contracts.js';
import { nativeRenderEvidence } from './verifier/render-evidence.js';

const reason = value => typeof value === 'string' && /^[a-z0-9_:.-]{1,100}$/u.test(value) ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;

function sourceObservation(watch, observation) {
  const result = observation?.result;
  const observedAt = date(observation?.checked_at ?? result?.checkedAt);
  if (!result || result.sourceUrl !== watch.source_url || !observedAt || typeof observation.id !== 'string') return null;
  return { result, observedAt, id: observation.id };
}
function completePage(observation) {
  const result = observation?.result;
  // The verifier initializes empty directives before fetching. A 404, failed parse,
  // access wall or incomplete capture must never turn those defaults into facts.
  if (result?.evidence?.complete === true && ['present', 'absent'].includes(result.state)) return true;
  // This verdict is reached only after a complete HTML body, successful parsing,
  // directives and the access/login-wall checks. Rendering can still be required
  // to verify the link; it does not erase already observed page directives.
  const evidence = result?.evidence;
  const parsedShell = result?.reason === 'possible_render_required'
    && evidence?.readiness?.possibleLoginWall === false
    && typeof evidence?.readiness?.requiresRender === 'boolean';
  const staticShell = parsedShell && evidence?.method === 'http_html';
  const unconfirmedDom = (parsedShell || ['render_no_positive_evidence', 'render_readiness_unconfirmed'].includes(result?.reason))
    && evidence?.method === 'browser_html' && evidence.rendered === true && typeof evidence.ready === 'boolean';
  if (result?.state !== 'unknown' || !(staticShell || unconfirmedDom)
    || result.httpStatus !== 200
    || !/^text\/html(?:\s*;|$)/iu.test(evidence.contentType ?? '')
    || !Array.isArray(result.directives?.meta)
    || !result.directives.meta.every(item => typeof item?.name === 'string' && typeof item?.content === 'string')
    || !Array.isArray(result.directives?.xRobotsTag)
    || !result.directives.xRobotsTag.every(item => typeof item === 'string')) return false;
  try {
    const capture = validateCaptureReceipt(evidence.capture, { finalUrl: result.finalUrl });
    if (unconfirmedDom && (!Array.isArray(result.redirects) || nativeRenderEvidence({ ...evidence.browser,
      finalUrl: result.finalUrl, redirects: result.redirects }, 1).reason)) return false;
    return capture.representation === (staticShell ? 'raw_html' : 'rendered_dom') && capture.requestedUrl === result.sourceUrl
      && capture.httpStatus === 200 && capture.body.bytes > 0
      && capture.body.bytes === evidence.bytes && capture.body.sha256 === evidence.sha256
      && capture.body.decodedSha256 === evidence.decodedSha256
      && capture.acquiredAt === evidence.fetchedAt;
  } catch { return false; }
}
function completeLink(watch, observation) {
  const result = observation?.result;
  return result?.evidence?.complete === true && ['present', 'absent'].includes(result.state)
    && result.targetUrl === watch.target_url
    && result.targetScope === watch.target_scope;
}
function googleDirectives(directives) {
  if (!directives || typeof directives !== 'object') return { noindex: null, nofollow: null };
  if (directives.googlebot) return {
    noindex: bool(directives.googlebot.noindex), nofollow: bool(directives.googlebot.nofollow),
  };
  // Old full observations retain the actual meta/header inputs. Reuse the same
  // targeted-directive parser instead of inferring Google facts from our bot.
  if (Array.isArray(directives.meta) && directives.meta.every(item => typeof item?.name === 'string' && typeof item?.content === 'string')
    && Array.isArray(directives.xRobotsTag) && directives.xRobotsTag.every(item => typeof item === 'string')) {
    return pageDirectives(directives.meta, directives.xRobotsTag.join(',')).googlebot;
  }
  return { noindex: directives.noindex === true ? true : null,
    nofollow: directives.nofollow === true ? true : null };
}
function observedRel(observation) {
  const result = observation?.result;
  if (result?.state !== 'present' || result.occurrencesTruncated === true
    || !Array.isArray(result.occurrences) || !result.occurrences.length) return null;
  const tokens = new Set();
  for (const occurrence of result.occurrences) {
    if (!Array.isArray(occurrence?.rel)) return null;
    for (const value of occurrence.rel) {
      if (typeof value !== 'string' || !/^[a-z0-9_-]{1,40}$/iu.test(value)) return null;
      tokens.add(value.toLowerCase());
    }
  }
  return [...tokens].sort();
}
function latestRobots(observation) {
  const result = observation?.result;
  const native = result?.evidence?.browser?.robotsHistory;
  if (Array.isArray(native) && native.length) {
    const urls = new Set([result.sourceUrl, result.finalUrl].filter(value => typeof value === 'string'));
    for (const hop of Array.isArray(result.redirects) ? result.redirects : []) {
      if (typeof hop?.from === 'string') urls.add(hop.from);
      if (typeof hop?.to === 'string') urls.add(hop.to);
    }
    // Native traces also contain script/font requests. Only the document's
    // actual URL chain supports a claim about Google crawling this page.
    const rows = native.filter(row => urls.has(row?.sourceUrl));
    for (const url of urls) if (!rows.some(row => row.sourceUrl === url)) rows.push(null);
    return { rows, observedAt: observation.observedAt };
  }
  if (Array.isArray(result?.robotsHistory) && result.robotsHistory.length) return { rows: result.robotsHistory, observedAt: observation.observedAt };
  if (result?.robots) return { rows: [result.robots], observedAt: observation.observedAt };
  const original = result?.evidence?.staticObservation;
  return { rows: Array.isArray(original?.robotsHistory) ? original.robotsHistory : [],
    observedAt: date(original?.checkedAt) ?? observation?.observedAt ?? null };
}

/** Read-only facts from saved observations; never a live Google indexing test. */
export function projectWatchCrawlability(watch, { latestObservation = null, latestPageObservation = null, lastSuccessfulObservation = null } = {}) {
  const latest = sourceObservation(watch, latestObservation);
  const savedPage = sourceObservation(watch, latestPageObservation);
  const successful = sourceObservation(watch, lastSuccessfulObservation);
  const page = [latest, savedPage, successful].filter(completePage)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null;
  const verified = completeLink(watch, latest) ? latest : completeLink(watch, successful) ? successful : null;
  const directives = googleDirectives(page?.result.directives);
  const currentVerifiable = completeLink(watch, latest);
  const projection = {
    google_crawlable: null,
    google_crawl_reason: latest ? 'googlebot_not_observed' : 'not_checked',
    robots_rule: null,
    noindex: directives.noindex,
    page_nofollow: directives.nofollow,
    link_rel: verified ? observedRel(verified) : null,
    can_verify_reason: currentVerifiable ? null : reason(latest?.result.reason)
      ?? (latest ? 'verification_unknown' : latestObservation ? 'observation_source_mismatch' : 'not_checked'),
    last_verified_at: verified?.observedAt ?? null,
    crawlability_provenance: {
      robots_observed_at: null, page_observed_at: page?.observedAt ?? null,
      link_observed_at: verified?.result.state === 'present' ? verified.observedAt : null,
      robots_observation_id: null, page_observation_id: page?.id ?? null,
      link_observation_id: verified?.result.state === 'present' ? verified.id : null,
    },
  };
  const { rows, observedAt } = latestRobots(latest);
  if (!rows.length) return projection;
  const decisions = rows.map(row => row?.googlebot?.productToken === 'Googlebot' ? row.googlebot : null);
  const blocked = decisions.find(item => item?.allowed === false);
  const unknown = decisions.find(item => !item || bool(item.allowed) === null);
  const decision = blocked ?? unknown ?? decisions.at(-1);
  projection.google_crawlable = blocked ? false : unknown !== undefined ? null : true;
  projection.google_crawl_reason = reason(decision?.reason)
    ?? (blocked ? 'robots_disallowed' : unknown !== undefined ? 'googlebot_not_observed' : 'robots_allowed');
  projection.robots_rule = typeof decision?.matchedRule === 'string' ? decision.matchedRule.slice(0, 8192) : null;
  projection.crawlability_provenance.robots_observed_at = observedAt;
  projection.crawlability_provenance.robots_observation_id = latest.id;
  return projection;
}
