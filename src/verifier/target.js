import { validatePublicUrl } from './url.js';
import { parseDocument, pageDirectives } from './parser.js';
import { publicFetcher, VerificationError } from './fetch.js';
import {capturedDocument} from '../page-acquisition/capture.js';
import { analyzeReadiness, isAccessChallenge } from './readiness.js';

export const TARGET_CHECKER_VERSION = '1';
export function unknownTargetObservation({targetUrl},{now,reason='timeout'}={}){
  return {state:'unknown',reason,targetUrl,finalUrl:targetUrl,httpStatus:null,checkedAt:new Date(typeof now==='function'?now():now??Date.now()).toISOString(),
    redirects:[],target_checker_version:TARGET_CHECKER_VERSION,evidence:{method:'http_html',checkerVersion:TARGET_CHECKER_VERSION,complete:false,fetchedAt:null}};
}
const CONFIRMATION_MS = 30 * 60 * 1000;
const timeOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};
const bounded = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.max(min, Math.min(Math.floor(value), max)) : fallback;

async function sha256(data) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks only the supplied destination URL (plus robots and validated redirects).
 * Healthy means a complete accessible static HTML response, not Google indexing,
 * semantic page correctness, rendered availability, or any backlink's presence.
 * publicFetchSafe must assert a transport-level public-only destination boundary.
 */
export async function verifyTarget({ targetUrl }, options = {}) {
  const checkedAt = new Date(typeof options.now === 'function' ? options.now() : options.now ?? Date.now()).toISOString();
  const result = unknownTargetObservation({targetUrl},{now:checkedAt,reason:'not_checked'});
  const target = validatePublicUrl(targetUrl);
  if (!target.valid) { result.reason = `invalid_target:${target.reason}`; return result; }
  result.targetUrl = result.finalUrl = target.url;
  if (options.publicFetchSafe !== true) { result.reason = 'public_fetch_not_configured'; return result; }

  if(options.signal?.aborted||(Number.isFinite(options.deadlineAt)&&options.deadlineAt<=Date.now())){result.reason='timeout';return result;}
  const controller = new AbortController();
  const ownerAbort=()=>controller.abort();
  options.signal?.addEventListener('abort',ownerAbort,{once:true});
  const timer = setTimeout(() => controller.abort(), Math.min(bounded(options.timeoutMs, 20_000, 1, 20_000),options.deadlineAt?Math.max(1,options.deadlineAt-Date.now()):20_000));
  const fetchOptions = {
    ...options,
    robotsPolicy: 'respect',
    maxBytes: bounded(options.maxBytes, 2 * 1024 * 1024, 1, 2 * 1024 * 1024),
    maxRedirects: bounded(options.maxRedirects, 5, 0, 5),
  };
  try {
    const { response, body } = await publicFetcher(fetchOptions, controller.signal).source(target.url, result);
    if(controller.signal.aborted||(Number.isFinite(options.deadlineAt)&&Date.now()>=options.deadlineAt))throw new VerificationError('timeout');
    result.evidence.fetchedAt = checkedAt;
    result.evidence.contentType = response.headers.get('content-type');
    if ([404, 410].includes(response.status)) {
      result.state = 'unavailable';
      result.reason = `target_http_${response.status}`;
      result.evidence.method = 'http_status';
      result.evidence.complete = true;
      return result;
    }
    result.evidence.bytes = body.bytes;
    result.evidence.sha256 = await sha256(body.data);
    result.evidence.decodedSha256 = await sha256(new TextEncoder().encode(body.text));
    result.evidence.capture=capturedDocument(result,{requestedUrl:target.url,transportId:options.captureTransport?.id??'public_http',
      transportVersion:options.captureTransport?.version??'1',qualified:options.publicFetchSafe===true,
      charset:/charset\s*=\s*["']?([^\s;"']+)/iu.exec(response.headers.get('content-type')??'')?.[1]??'utf-8'});
    result.evidence.etag = response.headers.get('etag');
    result.evidence.lastModified = response.headers.get('last-modified');
    if (!body.text.trim()) throw new VerificationError('empty_document');
    let parsed;
    try { parsed = parseDocument(body.text, result.finalUrl); }
    catch (error) { throw new VerificationError(error.reason ?? 'html_parse_error'); }
    if (parsed.incomplete) throw new VerificationError('incomplete_html', { parseErrors: parsed.parseErrors });
    const { readiness, managedClientChallenge } = analyzeReadiness({ html: body.text, parsed, targetUrl: target.url });
    if (isAccessChallenge(parsed, { managedClientChallenge })) throw new VerificationError('access_challenge');
    if (parsed.meta.some((item) => item.name === 'refresh')) throw new VerificationError('navigation_requires_browser');
    if (readiness.possibleLoginWall) throw new VerificationError('possible_login_wall');
    if (parsed.hasScript && !parsed.links.length && parsed.visibleText.length < 80) throw new VerificationError('possible_render_required');
    if(readiness.requiresRender)throw new VerificationError('possible_render_required');
    const robotsHeader = response.headers.get('x-robots-tag');
    if (robotsHeader?.length > 4096) throw new VerificationError('page_directive_too_long');
    result.directives = pageDirectives(parsed.meta, robotsHeader);
    result.state = 'healthy';
    result.reason = 'target_html_available';
    result.evidence.complete = true;
    result.evidence.rendered = false;
    result.evidence.baseUrl = parsed.baseUrl;
    if (options.includeHtml !== false) result.evidence.html = body.text;
    if(controller.signal.aborted||(Number.isFinite(options.deadlineAt)&&Date.now()>=options.deadlineAt))throw new VerificationError('timeout');
    result.warnings = ['Static HTML availability only; rendered content, soft 404s and Google indexing were not verified.'];
    return result;
  } catch (error) {
    result.state = 'unknown';
    result.evidence.complete = false;
    const reason = error instanceof VerificationError ? error.reason : controller.signal.aborted ? 'timeout' : 'verification_error';
    result.reason = reason.replace(/^source_http_/u, 'target_http_');
    // Carried so a scheduler can come back when the publisher said to, rather than on our cadence.
    if (Number.isFinite(error?.retryAfterSeconds)) result.retryAfterSeconds = error.retryAfterSeconds;
    if (result.httpStatus !== null) result.evidence.fetchedAt = checkedAt;
    if (error.parseErrors) result.evidence.parseErrors = error.parseErrors;
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener('abort',ownerAbort);
  }
}

function summary(observation, checkedAt = observation?.checkedAt) {
  if (!observation) return null;
  const evidence = observation.evidence;
  return {
    observationId: observation.observationId ?? observation.id ?? null,
    state: observation.state, reason: observation.reason,
    targetUrl: observation.targetUrl, finalUrl: observation.finalUrl,
    httpStatus: observation.httpStatus, checkedAt,
    target_checker_version: observation.target_checker_version,
    // Compact receipts only: full bodies and headers belong to the private evidence object.
    evidence: evidence ? {
      complete: evidence.complete, method: evidence.method, checkerVersion: evidence.checkerVersion,
      sha256: evidence.sha256, decodedSha256:evidence.decodedSha256, bytes: evidence.bytes, fetchedAt: evidence.fetchedAt,
    } : undefined,
  };
}

/** Pure reducer. Persist atomically with the target observation and target event. */
export function transitionTargetState(previous, observation, now = Date.now()) {
  const prior = previous ?? {};
  const checkedMs = timeOf(observation.checkedAt) ?? timeOf(typeof now === 'function' ? now() : now);
  if (checkedMs === null) throw new TypeError('A valid observation timestamp is required');
  const checkedAt = new Date(checkedMs).toISOString();
  const base = {
    state: prior.state ?? 'unknown',
    confirmedState: prior.confirmedState ?? (['healthy', 'unavailable'].includes(prior.state) ? prior.state : null),
    latestAttempt: prior.latestAttempt ?? null,
    lastSuccessfulObservation: prior.lastSuccessfulObservation ?? null,
    lastSuccessfulAt: prior.lastSuccessfulAt ?? null,
    lastHealthyAt: prior.lastHealthyAt ?? null,
    firstUnavailableAt: prior.firstUnavailableAt ?? null,
    unavailableCount: prior.unavailableCount ?? 0,
    wasEverHealthy: prior.wasEverHealthy ?? prior.lastSuccessfulObservation?.state === 'healthy',
    uncertain: prior.uncertain ?? true,
    // Carried forward so a later conclusive observation does not silently drop a floor the
    // publisher set and the scheduler has not yet reached.
    retryNotBefore: prior.retryNotBefore ?? null,
    nextCheckAt: null, event: null, ignored: false,
  };
  const latestMs = timeOf(prior.latestAttempt?.checkedAt);
  const observationId = observation.observationId ?? observation.id;
  const repeatedId = observationId && [prior.latestAttempt?.observationId, prior.lastSuccessfulObservation?.observationId].includes(observationId);
  if ((latestMs !== null && checkedMs <= latestMs) || repeatedId) {
    return { ...base, nextCheckAt: prior.nextCheckAt ?? null, ignored: true };
  }
  base.latestAttempt = summary(observation, checkedAt);
  if (!['healthy', 'unavailable', 'unknown'].includes(observation.state)) throw new TypeError('Invalid target observation state');
  const conclusive = observation.evidence?.complete === true
    && ((observation.state === 'healthy' && observation.httpStatus === 200)
      || (observation.state === 'unavailable' && [404, 410].includes(observation.httpStatus)));
  if (!conclusive) {
    base.uncertain = true;
    // A publisher that answered 429 or 503 may have said when to come back. It is a FLOOR, not a
    // schedule: "not before" is not "then". So it is surfaced as its own field and the scheduler
    // takes the later of this and the target's own cadence — writing it as the next check time
    // would re-check a rate-limiting host every ninety seconds, which is worse than ignoring it.
    if (Number.isFinite(observation.retryAfterSeconds)) {
      base.retryNotBefore = new Date(checkedMs + observation.retryAfterSeconds * 1000).toISOString();
    }
    return base;
  }

  base.lastSuccessfulObservation = base.latestAttempt;
  base.lastSuccessfulAt = checkedAt;
  base.uncertain = false;
  if (observation.state === 'healthy') {
    base.state = base.confirmedState = 'healthy';
    base.lastHealthyAt = checkedAt;
    base.firstUnavailableAt = null;
    base.unavailableCount = 0;
    base.wasEverHealthy = true;
    const type = prior.confirmedState === 'unavailable' || prior.state === 'unavailable'
      ? 'target_recovered' : !prior.wasEverHealthy && !prior.lastHealthyAt ? 'target_healthy' : null;
    if (type) base.event = { type, before: summary(prior.lastSuccessfulObservation), after: base.latestAttempt };
    return base;
  }

  const first = timeOf(base.firstUnavailableAt);
  base.firstUnavailableAt = first === null ? checkedAt : base.firstUnavailableAt;
  base.unavailableCount = first === null ? 1 : base.unavailableCount + 1;
  const confirmed = first !== null && checkedMs - first >= CONFIRMATION_MS && base.unavailableCount >= 2;
  base.state = confirmed ? 'unavailable' : 'suspected_unavailable';
  if (!confirmed) base.nextCheckAt = new Date((first ?? checkedMs) + CONFIRMATION_MS).toISOString();
  else {
    base.confirmedState = 'unavailable';
    if (prior.confirmedState !== 'unavailable' && prior.state !== 'unavailable') {
      base.event = { type: 'target_unavailable', before: summary(prior.lastSuccessfulObservation), after: base.latestAttempt };
    }
  }
  return base;
}
