import { validatePublicUrl, matchesTarget } from './url.js';
import { parseDocument, pageDirectives } from './parser.js';
import { publicFetcher, VerificationError } from './fetch.js';
import { assessReadiness } from './readiness.js';
import { nativeRenderEvidence } from './render-evidence.js';

export { validatePublicUrl } from './url.js';
export { parseLinks } from './parser.js';
export { transitionState } from './transition.js';
export { checkObservationKind, normalizeDeclaredSite, withinDeclaredSite } from './observation-kind.js';

export const CHECKER_VERSION = '4';
const sharedDocument = Symbol('sharedDocument');
const suppliedDocument = Symbol('suppliedDocument');

const RENDER_REASONS = new Set(['possible_render_required', 'navigation_requires_browser']);

/** Optional adaptive lane. The default remains one bounded HTTP observation. */
export async function verifyLink(input, options = {}) {
  const initial = await verifyHttpLink(input, options);
  const eligible = RENDER_REASONS.has(initial.reason)
    || (options.compareRendered === true && ['absent', 'present'].includes(initial.state));
  if (!eligible) return initial;
  initial.evidence.renderEligibility = RENDER_REASONS.has(initial.reason) ? 'required' : 'comparison';
  if (!options.renderPage) return initial;
  if (options.renderPage.publicFetchSafe !== true || options.renderPage.requiresNavigationAuthorization !== true) {
    initial.evidence.renderAttempt = { attempted: false, reason: 'render_public_fetch_not_configured' };
    return initial;
  }
  // Grouping shares only acquisition. Target scope, expectations and comparison remain independent.
  const shared = options[sharedDocument];
  const render = async () => {
    const controller = new AbortController();
    const timeout = Math.min(Math.max(options.renderTimeoutMs ?? 20_000, 1), 20_000);
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new VerificationError('render_timeout')); }, timeout);
      });
      return { value: await Promise.race([
        Promise.resolve().then(() => options.renderPage({ sourceUrl: initial.sourceUrl }, { signal: controller.signal })),
        deadline,
      ]) };
    } catch (error) {
      // Provider exception messages can contain credentials or remote page text.
      return { error: controller.signal.aborted ? 'render_timeout' : 'render_failed',
        ...(Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? {retryAfterSeconds:Math.min(86400,Math.ceil(error.retryAfterSeconds))} : {}) };
    } finally { clearTimeout(timer); controller.abort(); }
  };
  const acquired = shared ? await (shared.render ??= render()) : await render();
  const fail = (reason) => {
    initial.evidence.renderAttempt = { attempted: true, reason };
    // A failed comparison cannot overrule an already observed anchor. Static absence,
    // however, cannot be promoted when the requested browser comparison did not finish.
    if (initial.state === 'absent') {
      initial.state = 'unknown'; initial.reason = reason; initial.evidence.complete = false;
      delete initial.linkSignature;
    }
    return initial;
  };
  if (acquired.error) {
    if (acquired.retryAfterSeconds !== undefined) initial.retryAfterSeconds = acquired.retryAfterSeconds;
    return fail(acquired.error);
  }
  const doc = acquired.value;
  if (!doc || typeof doc.html !== 'string' || !validatePublicUrl(doc.finalUrl).valid
    || !Number.isInteger(doc.httpStatus) || !Array.isArray(doc.redirects) || doc.redirects.length > 5
    || doc.bodyTruncated !== false || typeof doc.ready !== 'boolean') return fail('invalid_render_evidence');
  let cursor = initial.sourceUrl;
  const redirects = [];
  for (const hop of doc.redirects) {
    if (!hop || hop.from !== cursor || !validatePublicUrl(hop.to).valid
      || ![301, 302, 303, 307, 308].includes(hop.status)) return fail('invalid_render_redirects');
    cursor = hop.to;
    redirects.push({ from: hop.from, to: hop.to, status: hop.status });
  }
  if (cursor !== doc.finalUrl) return fail('invalid_render_redirects');
  let nativeEvidence;
  if (options.renderPage.strictEvidenceVersion !== undefined) {
    const checked = nativeRenderEvidence(doc, options.renderPage.strictEvidenceVersion);
    if (checked.reason) return fail(checked.reason);
    nativeEvidence = checked.evidence;
  }
  if (doc.httpStatus !== 200) return fail(`render_http_${doc.httpStatus}`);
  if (doc.xRobotsTag !== undefined && (typeof doc.xRobotsTag !== 'string' || doc.xRobotsTag.length > 4096
    || /[^\t\x20-\x7e\x80-\xff]/u.test(doc.xRobotsTag))) return fail('invalid_render_directives');
  if (doc.html.length > 2 * 1024 * 1024) return fail('render_body_too_large');
  const data = new TextEncoder().encode(doc.html);
  if (data.length > Math.min(options.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024)) return fail('render_body_too_large');
  const rendered = await verifyHttpLink(input, {
    ...options, [sharedDocument]: undefined,
    [suppliedDocument]: {
      metadata: { finalUrl: doc.finalUrl, httpStatus: doc.httpStatus, redirects },
      document: {
        response: new Response(null, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(doc.xRobotsTag ? { 'x-robots-tag': doc.xRobotsTag } : {}) } }),
        body: { text: doc.html, bytes: data.length, data },
      },
    },
  });
  rendered.evidence.method = 'browser_html';
  rendered.evidence.rendered = true;
  rendered.evidence.ready = doc.ready;
  if (nativeEvidence) {
    rendered.evidence.browser = nativeEvidence;
    if (nativeEvidence.retryAfterSeconds !== undefined && nativeEvidence.retryAfterSeconds !== null) rendered.retryAfterSeconds = nativeEvidence.retryAfterSeconds;
  }
  rendered.evidence.renderAttempt = { attempted: true, reason: 'render_completed' };
  rendered.evidence.staticObservation = {
    state: initial.state, reason: initial.reason, checkedAt: initial.checkedAt,
    sha256: initial.evidence.sha256 ?? null, method: 'http_html',
    ...(initial.robotsHistory ? { robotsHistory: structuredClone(initial.robotsHistory) } : {}),
    ...(initial.sourceResponse ? { sourceResponse: structuredClone(initial.sourceResponse) } : {}),
  };
  if (rendered.state === 'absent' && options.renderPage.positiveOnly === true) {
    rendered.state = 'unknown'; rendered.reason = 'render_no_positive_evidence';
    rendered.evidence.complete = false; delete rendered.linkSignature;
  } else if (rendered.state === 'absent' && !doc.ready) {
    rendered.state = 'unknown'; rendered.reason = 'render_readiness_unconfirmed';
    rendered.evidence.complete = false; delete rendered.linkSignature;
  } else if (rendered.state === 'absent') rendered.reason = 'no_matching_link_in_ready_dom';
  for (const occurrence of rendered.occurrences) occurrence.visibility = 'rendered_dom_not_visual';
  rendered.warnings = ['Rendered DOM observation; visual visibility and search-engine indexing were not checked.'];
  if (initial.state === 'present' && rendered.state !== 'present') {
    initial.evidence.renderAttempt = { attempted: true, reason: 'render_disagreement', state: rendered.state };
    return initial;
  }
  return rendered;
}

// The cache lives only for this bounded invocation, never across tenants or jobs.
// Evaluation stays per target, including redirect-to-target and expectation rules.
export async function verifyLinks(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length > 20 || new Set(inputs.map(input => input.sourceUrl)).size > 1) {
    throw new Error('A verification group requires at most 20 identical source URLs.');
  }
  const shared = {};
  options = { ...options, now: timestamp(options.now) };
  const results = [];
  for (const input of inputs) results.push(await verifyLink(input, { ...options, [sharedDocument]: shared }));
  return results;
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function timestamp(now) {
  return new Date(typeof now === 'function' ? now() : now ?? Date.now()).toISOString();
}

function expectations(occurrences, expectedAnchor, expectedRel) {
  const anchor = expectedAnchor === undefined || expectedAnchor === null ? null : String(expectedAnchor).replace(/\s+/gu, ' ').trim();
  const rel = expectedRel === undefined || expectedRel === null ? null
    : [...new Set((Array.isArray(expectedRel) ? expectedRel : String(expectedRel).split(/\s+/u)).map((item) => item.toLowerCase()).filter(Boolean))].sort();
  return {
    expectedAnchor: anchor,
    expectedRel: rel,
    anchorMatches: anchor === null ? null : occurrences.some((item) => item.anchor === anchor),
    relMatches: rel === null ? null : occurrences.some((item) => [...item.rel].sort().join(' ') === rel.join(' ')),
    satisfied: occurrences.some((item) => (anchor === null || item.anchor === anchor)
      && (rel === null || [...item.rel].sort().join(' ') === rel.join(' '))),
  };
}

/**
 * Verify a public page. publicFetchSafe asserts a transport-enforced public-only
 * destination boundary; input screening alone cannot protect against DNS rebinding.
 * The source page and robots.txt are the only fetched documents. No link is clicked.
 */
async function verifyHttpLink({ sourceUrl, targetUrl, targetScope = 'exact', expectedAnchor, expectedRel }, options = {}) {
  const checkedAt = timestamp(options.now);
  const result = {
    state: 'unknown', reason: 'not_checked', sourceUrl, finalUrl: sourceUrl, targetUrl,
    targetScope, httpStatus: null, checkedAt, occurrences: [], directives: pageDirectives([], ''),
    redirects: [], evidence: { method: 'http_html', checkerVersion: CHECKER_VERSION, complete: false, fetchedAt: null },
  };
  const source = validatePublicUrl(sourceUrl);
  const target = validatePublicUrl(targetUrl);
  if (!source.valid || !target.valid) {
    result.reason = `invalid_${!source.valid ? 'source' : 'target'}:${!source.valid ? source.reason : target.reason}`;
    return result;
  }
  if (!['exact', 'domain', 'subdomain', 'path'].includes(targetScope)) {
    result.reason = 'unsupported_target_scope';
    return result;
  }
  result.sourceUrl = source.url;
  result.finalUrl = source.url;
  result.targetUrl = target.url;
  if (options.publicFetchSafe !== true) {
    result.reason = 'public_fetch_not_configured';
    return result;
  }
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 20_000, 1), 20_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const shared = options[sharedDocument];
    const fetchSource = async () => {
      try {
        const supplied = options[suppliedDocument];
        if (supplied) Object.assign(result, structuredClone(supplied.metadata));
        const document = supplied?.document ?? await publicFetcher(options, controller.signal).source(source.url, result);
        return { document, metadata: structuredClone({ finalUrl: result.finalUrl, httpStatus: result.httpStatus, redirects: result.redirects, ...(result.robots ? { robots: result.robots } : {}), ...(result.robotsHistory ? { robotsHistory: result.robotsHistory } : {}), ...(result.sourceResponse ? { sourceResponse: result.sourceResponse } : {}) }) };
      } catch (error) {
        return { error: controller.signal.aborted ? new VerificationError('timeout') : error, metadata: structuredClone({ finalUrl: result.finalUrl, httpStatus: result.httpStatus, redirects: result.redirects, ...(result.robots ? { robots: result.robots } : {}), ...(result.robotsHistory ? { robotsHistory: result.robotsHistory } : {}), ...(result.sourceResponse ? { sourceResponse: result.sourceResponse } : {}) }) };
      }
    };
    const fetched = shared ? await (shared.fetch ??= fetchSource()) : await fetchSource();
    Object.assign(result, structuredClone(fetched.metadata));
    if (fetched.error) throw fetched.error;
    const { response, body } = fetched.document;
    result.evidence.fetchedAt = checkedAt;
    if ([404, 410].includes(response.status)) {
      result.state = 'source_unavailable';
      result.reason = `source_http_${response.status}`;
      result.evidence.complete = true;
      return result;
    }
    result.evidence.bytes = body.bytes;
    result.evidence.contentType = response.headers.get('content-type');
    result.evidence.etag = response.headers.get('etag');
    result.evidence.lastModified = response.headers.get('last-modified');
    // Preserve a replayable private artifact even when classification remains unknown.
    result.evidence.sha256 = await sha256(body.data);
    if (options.includeHtml !== false) result.evidence.html = body.text;
    if (!body.text.trim()) throw new VerificationError('empty_document');
    let parsed;
    try { parsed = shared ? (shared.parsed ??= parseDocument(body.text, result.finalUrl)) : parseDocument(body.text, result.finalUrl); }
    catch (error) { throw new VerificationError(error.reason ?? 'html_parse_error'); }
    const robotsHeader = response.headers.get('x-robots-tag');
    if (robotsHeader?.length > 4096) throw new VerificationError('page_directive_too_long');
    result.directives = pageDirectives(parsed.meta, robotsHeader);
    if (parsed.incomplete) throw new VerificationError('incomplete_html', { parseErrors: parsed.parseErrors });
    // Strong, recognizable access-wall evidence. Generic references to captchas in
    // an article are deliberately insufficient to classify a document as blocked.
    if (/^(?:just a moment(?:\.\.\.)?|access denied|attention required!?\s*(?:\|\s*cloudflare)?|verify (?:you are|you're) human)$/iu.test(parsed.title)
      || parsed.hasChallengeScript) {
      throw new VerificationError('access_challenge');
    }
    // A URL that REDIRECTS into the placement's scope is not a page that links to the target:
    // following it lands on the destination, and parsing that document counts the destination's
    // own navigation as placements. Measured on real data: two shortened links each reported
    // `present` with **120 occurrences**, every one of them an internal link on the target's own
    // homepage, anchored "Skip to main content". The one legitimate same-scope redirect is the
    // source page canonicalizing ITSELF — same path (trailing slash, stripped tracking query)
    // on the same host or a parent/child host of it (apex/www, blog to apex) — because then the
    // destination's links ARE the source page's links. A redirect onto a DIFFERENT page inside
    // the scope is not that, even when the whole site is the customer's own: DP-0020's
    // `internal` kind made that case reachable (a blog post whose URL now bounces to the guide
    // must not verify as a placement carried by the guide's own nav), so the carve-out keys on
    // same-page canonicalization rather than on where the source started. One rule set for
    // internal and external; the moved-page case reports `unknown` naming the redirect, and the
    // customer points the ledger at the new URL.
    const canonicalPage = (url) => {
      const { hostname, pathname } = new URL(url);
      return { host: hostname.toLowerCase().replace(/\.$/, ''),
        path: pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname };
    };
    const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
    const from = canonicalPage(source.url);
    const to = canonicalPage(result.finalUrl);
    const samePage = from.path === to.path && sameSite(from.host, to.host);
    if (result.redirects.length && !samePage && matchesTarget(result.finalUrl, target.url, targetScope)) {
      throw new VerificationError('source_redirects_to_target');
    }
    result.occurrences = parsed.links.filter((link) => matchesTarget(link.targetUrl, target.url, targetScope));
    if (new TextEncoder().encode(JSON.stringify(result.occurrences)).byteLength > 96 * 1024) throw new VerificationError('evidence_too_large');
    result.expectations = expectations(result.occurrences, expectedAnchor, expectedRel);
    // Meta refresh and a password form are access/navigation evidence, not proof of
    // absence. A server-rendered occurrence can still be positively observed.
    if (!result.occurrences.length && parsed.meta.some((item) => item.name === 'refresh')) {
      throw new VerificationError('navigation_requires_browser');
    }
    const readiness = assessReadiness({ html: body.text, parsed, targetUrl: target.url });
    result.evidence.readiness = readiness;
    if (!result.occurrences.length && readiness.possibleLoginWall) {
      throw new VerificationError('possible_login_wall');
    }
    if (!result.occurrences.length && (readiness.requiresRender
      || (parsed.hasScript && !parsed.links.length && parsed.visibleText.length < 80))) {
      throw new VerificationError('possible_render_required');
    }
    result.state = result.occurrences.length ? 'present' : 'absent';
    result.reason = result.state === 'present' ? 'link_found' : 'no_matching_link_in_complete_html';
    result.evidence.complete = true;
    result.evidence.baseUrl = parsed.baseUrl;
    result.evidence.rendered = false;
    result.linkSignature = await sha256(new TextEncoder().encode(JSON.stringify({
      source: result.finalUrl,
      occurrences: result.occurrences.map(({ targetUrl: destination, anchor, rel }) => ({ targetUrl: destination, anchor, rel: [...rel].sort() })),
      noindex: result.directives.noindex,
      nofollow: result.directives.nofollow,
    })));
    result.warnings = ['Static HTML observation; JavaScript execution and visual visibility were not checked.'];
    return result;
  } catch (error) {
    result.state = 'unknown';
    result.occurrences = [];
    result.reason = error instanceof VerificationError ? error.reason : controller.signal.aborted ? 'timeout' : 'verification_error';
    // The same floor a destination check keeps. A publisher rate-limiting the SOURCE page is the
    // more common case of the two, since a source is fetched on a cadence and a destination is not.
    if (Number.isFinite(error?.retryAfterSeconds)) result.retryAfterSeconds = error.retryAfterSeconds;
    if (error.parseErrors) result.evidence.parseErrors = error.parseErrors;
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
