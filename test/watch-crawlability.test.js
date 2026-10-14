import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWatchCrawlability } from '../src/watch-crawlability.js';
import { pageDirectives } from '../src/page-extraction/html.js';
import { verifyLink } from '../src/verifier/index.js';

const watch = { source_url: 'https://publisher.example.com/article', target_url: 'https://example.com/guide', target_scope: 'exact' };
const first = '2026-10-11T12:00:00.000Z';
const later = '2026-10-11T13:00:00.000Z';
const robot = (allowed, overrides = {}) => ({ productToken: 'Googlebot', allowed,
  reason: allowed === false ? 'robots_disallowed' : allowed === true ? 'robots_allowed' : 'robots_http_429',
  matchedRule: allowed === false ? '/article' : null, crawlDelaySeconds: null, ...overrides });
const observed = (id, at, changes = {}) => ({ id, checked_at: at, result: {
  state: 'present', reason: 'link_found', checkedAt: at, sourceUrl: watch.source_url,
  targetUrl: watch.target_url, targetScope: watch.target_scope,
  evidence: { complete: true }, directives: pageDirectives([], ''),
  occurrences: [{ rel: [] }], robotsHistory: [{ googlebot: robot(true) }], ...changes,
} });
const shell = '<!doctype html><html><head><meta name="googlebot" content="noindex,nofollow"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
async function httpObservation(html, { status = 200, contentType = 'text/html; charset=utf-8', verifierOptions = {} } = {}) {
  const result = await verifyLink({ sourceUrl: watch.source_url, targetUrl: watch.target_url, targetScope: watch.target_scope }, {
    publicFetchSafe: true, now: Date.parse(later),
    fetchImpl: async url => url.endsWith('/robots.txt')
      ? new Response('User-agent: *\nAllow: /', { headers: { 'content-type': 'text/plain' } })
      : new Response(html, { status, headers: { 'content-type': contentType } }),
    ...verifierOptions,
  });
  return { id: 'obs_shell', checked_at: later, result };
}
function nativeOptions({ positiveOnly, ready = true, shellOnly = false } = {}) {
  const html = shellOnly ? shell : shell.replace('<div id="root"></div>', '<article>A complete public profile biography with enough substantive text to parse its page directives without inferring that a target link is present.</article>');
  const doc = { html, finalUrl: watch.source_url, httpStatus: 200, redirects: [], ready, bodyTruncated: false,
    rendererVersion: 'alo-native-1', contentType: 'text/html; charset=utf-8', cfMitigated: '', challenge: false,
    visibleLogin: false, browserClosed: true, browserVersion: 'Chromium/128', userAgent: 'LinktrailBot/0.1',
    requestCount: 1, durationMs: 20, terminationReason: null,
    cleanup: { unitStopped: true, cgroupEmpty: true, namespaceDestroyed: true },
    executor: { version: 'alo-public-node-v1', browserEgressEnforced: true, browserEgressPolicy: 'private-network-unix-bridge-v1' },
    robotsHistory: [{ sourceUrl: watch.source_url, robotsUrl: 'https://publisher.example.com/robots.txt',
      httpStatus: 200, productToken: 'LinktrailBot', allowed: true, reason: 'robots_allowed', crawlDelaySeconds: 0, googlebot: robot(true) }] };
  return { renderPage: Object.assign(async () => doc, { publicFetchSafe: true, requiresNavigationAuthorization: true,
    strictEvidenceVersion: 1, positiveOnly, transportId: 'qualified_browser', transportVersion: '1' }) };
}

test('unobserved facts stay null and do not claim Google indexing or link absence', () => {
  const result = projectWatchCrawlability(watch);
  for (const field of ['google_crawlable', 'noindex', 'page_nofollow', 'link_rel', 'last_verified_at']) assert.equal(result[field], null, field);
  assert.equal(result.can_verify_reason, 'not_checked');
  assert.ok(Object.values(result.crawlability_provenance).every(value => value === null));
  assert.equal(Object.hasOwn(result, 'google_indexed'), false);
});

test('Google permission is independent of monitor authorization, noindex and link rel', () => {
  const latest = observed('obs_current', later, {
    directives: pageDirectives([{ name: 'googlebot', content: 'noindex,nofollow' }], ''),
    occurrences: [{ rel: ['UGC'] }, { rel: ['nofollow', 'ugc'] }],
    robotsHistory: [{ allowed: false, policy: 'customer_supplied_monitor', fetchAuthorized: true,
      overrideUsed: true, googlebot: robot(true) }],
  });
  const before = structuredClone(latest);
  const result = projectWatchCrawlability(watch, { latestObservation: latest });
  assert.equal(result.google_crawlable, true);
  assert.equal(result.noindex, true);
  assert.equal(result.page_nofollow, true);
  assert.deepEqual(result.link_rel, ['nofollow', 'ugc']);
  assert.equal(result.can_verify_reason, null);
  assert.equal(result.last_verified_at, later);
  assert.deepEqual(latest, before, 'projection cannot mutate saved evidence');
});

test('a blocked latest check keeps prior page/link facts with their original observation IDs and dates', () => {
  const previous = observed('obs_old', first, { directives: pageDirectives([], 'noindex'), occurrences: [{ rel: ['sponsored'] }] });
  const latest = observed('obs_blocked', later, { state: 'unknown', reason: 'robots_disallowed',
    evidence: { complete: false }, directives: pageDirectives([], ''), occurrences: [],
    robotsHistory: [{ googlebot: robot(false) }] });
  const result = projectWatchCrawlability(watch, { latestObservation: latest, lastSuccessfulObservation: previous });
  assert.equal(result.google_crawlable, false);
  assert.equal(result.robots_rule, '/article');
  assert.equal(result.noindex, true);
  assert.deepEqual(result.link_rel, ['sponsored']);
  assert.equal(result.can_verify_reason, 'robots_disallowed');
  assert.equal(result.last_verified_at, first);
  assert.deepEqual(result.crawlability_provenance, { robots_observed_at: later, page_observed_at: first,
    link_observed_at: first, robots_observation_id: 'obs_blocked', page_observation_id: 'obs_old', link_observation_id: 'obs_old' });
});

test('robots transport failure stays unknown and never reuses old permission', () => {
  const latest = observed('obs_unknown', later, { state: 'unknown', reason: 'robots_http_429', evidence: { complete: false },
    robotsHistory: [{ googlebot: robot(null) }] });
  const result = projectWatchCrawlability(watch, { latestObservation: latest, lastSuccessfulObservation: observed('obs_old', first) });
  assert.equal(result.google_crawlable, null);
  assert.equal(result.google_crawl_reason, 'robots_http_429');
  assert.equal(result.crawlability_provenance.robots_observation_id, 'obs_unknown');
  assert.equal(result.crawlability_provenance.page_observed_at, first);
});

test('Google permission includes every observed redirect hop, with blocked and unknown facts explicit', () => {
  const latest = observed('obs_redirect', later, { robotsHistory: [{ googlebot: robot(true) }, { googlebot: robot(null) }] });
  assert.equal(projectWatchCrawlability(watch, { latestObservation: latest }).google_crawlable, null);
  latest.result.robotsHistory.push({ googlebot: robot(false) });
  assert.equal(projectWatchCrawlability(watch, { latestObservation: latest }).google_crawlable, false);
});

test('native browser Googlebot facts use the main document chain, not unrelated resource permissions', () => {
  const finalUrl = 'https://publisher.example.com/canonical';
  const latest = observed('obs_native', later, { finalUrl, redirects: [{ from: watch.source_url, to: finalUrl, status: 301 }],
    robotsHistory: undefined, evidence: { complete: true, browser: { robotsHistory: [
      { sourceUrl: watch.source_url, googlebot: robot(true) }, { sourceUrl: finalUrl, googlebot: robot(true) },
      { sourceUrl: 'https://fonts.example.net/file.woff2', googlebot: robot(false) },
    ] } } });
  assert.equal(projectWatchCrawlability(watch, { latestObservation: latest }).google_crawlable, true);
  latest.result.evidence.browser.robotsHistory[1].googlebot = robot(false);
  assert.equal(projectWatchCrawlability(watch, { latestObservation: latest }).google_crawlable, false);
  latest.result.evidence.browser.robotsHistory.splice(1, 1);
  assert.equal(projectWatchCrawlability(watch, { latestObservation: latest }).google_crawlable, null,
    'an unobserved main-document hop is not an allow decision');
});

test('a complete absence clears link rel while a failed/default or unavailable page proves no directives', () => {
  const previous = observed('obs_old', first);
  const absent = observed('obs_absent', later, { state: 'absent', occurrences: [] });
  const result = projectWatchCrawlability(watch, { latestObservation: absent, lastSuccessfulObservation: previous });
  assert.equal(result.link_rel, null);
  assert.equal(result.last_verified_at, later);
  assert.equal(result.crawlability_provenance.link_observed_at, null);
  assert.equal(result.noindex, false);
  const unavailable = observed('obs_gone', later, { state: 'source_unavailable', reason: 'source_http_404', occurrences: [] });
  const gone = projectWatchCrawlability(watch, { latestObservation: unavailable, lastSuccessfulObservation: unavailable });
  assert.equal(gone.noindex, null);
  assert.equal(gone.page_nofollow, null);
  assert.equal(gone.last_verified_at, null);
  assert.equal(gone.can_verify_reason, 'source_http_404');
});

test('truncated or missing rel evidence cannot masquerade as an ordinary link', () => {
  for (const changes of [{ occurrencesTruncated: true }, { occurrences: [{}] }]) {
    assert.equal(projectWatchCrawlability(watch, { latestObservation: observed('obs_partial', later, changes) }).link_rel, null);
  }
  assert.deepEqual(projectWatchCrawlability(watch, { latestObservation: observed('obs_follow', later) }).link_rel, []);
});

test('facts from another source or target are not relabeled as evidence for this watch', () => {
  const sourceMismatch = observed('obs_wrong', later, { sourceUrl: 'https://other.example.com/article' });
  const result = projectWatchCrawlability(watch, { latestObservation: sourceMismatch });
  assert.equal(result.google_crawlable, null);
  assert.equal(result.noindex, null);
  assert.equal(result.can_verify_reason, 'observation_source_mismatch');
  const targetMismatch = observed('obs_target', later, { targetUrl: 'https://example.com/other' });
  const target = projectWatchCrawlability(watch, { latestObservation: targetMismatch });
  assert.equal(target.google_crawlable, true, 'source robots fact is independent of the target');
  assert.equal(target.link_rel, null);
  assert.equal(target.last_verified_at, null);
});

test('targeted meta and mixed X-Robots headers preserve generic facts and apply Google directives correctly', () => {
  assert.equal(pageDirectives([], 'googlebot: noindex, nofollow').noindex, false, 'generic legacy field stays generic');
  assert.deepEqual(pageDirectives([], 'googlebot: noindex, nofollow').googlebot, { noindex: true, nofollow: true });
  assert.deepEqual(pageDirectives([], 'noindex, bingbot: nofollow, googlebot: max-snippet:0, nofollow').googlebot,
    { noindex: true, nofollow: true });
  assert.deepEqual(pageDirectives([{ name: 'bingbot', content: 'none' }], 'bingbot: none').googlebot,
    { noindex: false, nofollow: false });
  assert.deepEqual(pageDirectives([{ name: 'robots', content: 'noindex' }, { name: 'googlebot', content: 'index,nofollow' }], '').googlebot,
    { noindex: true, nofollow: true }, 'restrictive generic and targeted directives both apply');
});

test('a complete parsed JS shell supplies page facts while its link remains unverified', async () => {
  const latest = await httpObservation(shell);
  assert.equal(latest.result.state, 'unknown');
  assert.equal(latest.result.reason, 'possible_render_required');
  assert.equal(latest.result.evidence.complete, false, 'link completeness must remain false');
  assert.equal(latest.result.evidence.capture.body.complete, true, 'the source document itself completed');
  const before = structuredClone(latest);
  const result = projectWatchCrawlability(watch, { latestObservation: latest });
  assert.equal(result.noindex, true);
  assert.equal(result.page_nofollow, true);
  assert.equal(result.google_crawlable, true, 'Google robots permission remains independent of noindex');
  assert.equal(result.can_verify_reason, 'possible_render_required');
  assert.equal(result.link_rel, null);
  assert.equal(result.last_verified_at, null);
  assert.equal(result.crawlability_provenance.page_observed_at, later);
  assert.equal(result.crawlability_provenance.page_observation_id, 'obs_shell');
  assert.equal(result.crawlability_provenance.link_observation_id, null);
  assert.deepEqual(latest, before);
  const withoutDirectives = await httpObservation(shell.replace('<meta name="googlebot" content="noindex,nofollow">', ''));
  const explicitDefaults = projectWatchCrawlability(watch, { latestObservation: withoutDirectives });
  assert.equal(explicitDefaults.noindex, false, 'completed parsing can establish absence of a directive');
  assert.equal(explicitDefaults.page_nofollow, false);
  assert.equal(explicitDefaults.last_verified_at, null);
});

test('new shell page facts retain the historical verified link and its original date', async () => {
  const latest = await httpObservation(shell);
  const previous = observed('obs_old_link', first, { occurrences: [{ rel: ['ugc'] }] });
  const result = projectWatchCrawlability(watch, { latestObservation: latest, lastSuccessfulObservation: previous });
  assert.equal(result.noindex, true);
  assert.equal(result.page_nofollow, true);
  assert.deepEqual(result.link_rel, ['ugc']);
  assert.equal(result.last_verified_at, first);
  assert.equal(result.can_verify_reason, 'possible_render_required');
  assert.equal(result.crawlability_provenance.page_observation_id, 'obs_shell');
  assert.equal(result.crawlability_provenance.page_observed_at, later);
  assert.equal(result.crawlability_provenance.link_observation_id, 'obs_old_link');
  assert.equal(result.crawlability_provenance.link_observed_at, first);
});

test('HTTP errors, access walls, login, empty and unfinished documents never establish page defaults', async () => {
  const cases = [
    { html: shell, options: { status: 404 }, reason: 'source_http_404' },
    { html: shell, options: { status: 403 }, reason: 'source_http_403' },
    { html: shell, options: { status: 500 }, reason: 'source_http_500' },
    { html: shell.replace('<head>', '<head><title>Just a moment...</title>'), reason: 'access_challenge' },
    { html: '<html><head><meta name="googlebot" content="noindex"></head><body><form><input type="password"></form></body></html>', reason: 'possible_login_wall' },
    { html: '  ', reason: 'empty_document' },
    { html: '<html><head><meta name="googlebot" content="noindex"></head><body><a href="', reason: 'incomplete_html' },
    { html: shell, options: { contentType: 'application/json' }, reason: 'unsupported_content_type' },
  ];
  for (const fixture of cases) {
    const latest = await httpObservation(fixture.html, fixture.options);
    assert.equal(latest.result.reason, fixture.reason);
    const projection = projectWatchCrawlability(watch, { latestObservation: latest });
    assert.equal(projection.noindex, null, fixture.reason);
    assert.equal(projection.page_nofollow, null, fixture.reason);
    assert.equal(projection.last_verified_at, null, fixture.reason);
    assert.equal(projection.crawlability_provenance.page_observed_at, null, fixture.reason);
  }
});

test('a shell needs the exact complete qualified source capture and actual parsed directive inputs', async () => {
  const shellObservation = await httpObservation(shell);
  const cases = [
    result => { result.evidence.capture.body.complete = false; },
    result => { result.evidence.capture.body.truncated = true; },
    result => { result.evidence.capture.body.sha256 = 'a'.repeat(64); },
    result => { result.evidence.capture.body.decodedSha256 = 'b'.repeat(64); },
    result => { result.evidence.capture.body.bytes += 1; },
    result => { result.evidence.capture.transport.qualified = false; },
    result => { result.evidence.capture.requestedUrl = 'https://other.example.com/article'; },
    result => { result.evidence.capture.finalUrl = 'https://other.example.com/article'; },
    result => { result.evidence.capture.acquiredAt = first; },
    result => { result.httpStatus = 404; },
    result => { result.evidence.contentType = 'application/json'; },
    result => { result.evidence.readiness.possibleLoginWall = true; },
    result => { delete result.evidence.readiness; },
    result => { result.evidence.method = 'browser_html'; },
    result => { delete result.directives.meta; },
    result => { delete result.directives.xRobotsTag; },
    result => { result.reason = 'html_parse_error'; },
    result => { result.sourceUrl = 'https://other.example.com/article'; },
  ];
  const previous = observed('obs_old', first);
  for (const [index, mutate] of cases.entries()) {
    const latest = structuredClone(shellObservation);
    mutate(latest.result);
    const projection = projectWatchCrawlability(watch, { latestObservation: latest });
    assert.equal(projection.noindex, null, `unsafe shell ${index}`);
    assert.equal(projection.page_nofollow, null, `unsafe shell ${index}`);
    assert.equal(projection.crawlability_provenance.page_observed_at, null, `unsafe shell ${index}`);
    const withHistory = projectWatchCrawlability(watch, { latestObservation: latest, lastSuccessfulObservation: previous });
    assert.equal(withHistory.noindex, false, `historical fact retained ${index}`);
    assert.equal(withHistory.crawlability_provenance.page_observation_id, 'obs_old');
    assert.equal(withHistory.crawlability_provenance.page_observed_at, first);
    assert.equal(withHistory.last_verified_at, first);
  }
});

test('a qualified parsed native DOM keeps page directives without confirming an unobserved link', async () => {
  for (const [verifierOptions, expectedReason] of [
    [nativeOptions({ positiveOnly: true }), 'render_no_positive_evidence'],
    [nativeOptions({ positiveOnly: false, ready: false }), 'render_readiness_unconfirmed'],
    [nativeOptions({ positiveOnly: true, shellOnly: true }), 'possible_render_required'],
  ]) {
    const latest = await httpObservation(shell, { verifierOptions });
    assert.equal(latest.result.state, 'unknown');
    assert.equal(latest.result.reason, expectedReason);
    assert.equal(latest.result.evidence.complete, false);
    assert.equal(latest.result.evidence.capture.representation, 'rendered_dom');
    const result = projectWatchCrawlability(watch, { latestObservation: latest });
    assert.equal(result.noindex, true);
    assert.equal(result.page_nofollow, true);
    assert.equal(result.last_verified_at, null);
    assert.equal(result.link_rel, null);
    assert.equal(result.can_verify_reason, expectedReason);
    assert.equal(result.crawlability_provenance.page_observation_id, latest.id);
    const previous = observed('obs_previous', first, { occurrences: [{ rel: ['sponsored'] }] });
    const historical = projectWatchCrawlability(watch, { latestObservation: latest, lastSuccessfulObservation: previous });
    assert.equal(historical.noindex, true);
    assert.equal(historical.last_verified_at, first);
    assert.deepEqual(historical.link_rel, ['sponsored']);
    assert.equal(historical.crawlability_provenance.page_observed_at, later);
    assert.equal(historical.crawlability_provenance.link_observed_at, first);
    for (const mutate of [
      r => { r.evidence.browser.challenge = true; }, r => { r.evidence.browser.visibleLogin = true; },
      r => { r.evidence.browser.terminationReason = 'request_limit'; }, r => { r.evidence.browser.browserClosed = false; },
      r => { r.evidence.browser.cleanup.cgroupEmpty = false; }, r => { r.evidence.browser.executor.browserEgressEnforced = false; },
      r => { r.evidence.capture.body.truncated = true; }, r => { r.evidence.capture.transport.qualified = false; },
      r => { r.reason = 'incomplete_html'; }, r => { r.reason = 'access_challenge'; }, r => { r.httpStatus = 403; },
      r => { r.sourceUrl = 'https://other.example.com/article'; },
    ]) {
      const invalid = structuredClone(latest); mutate(invalid.result);
      const rejected = projectWatchCrawlability(watch, { latestObservation: invalid });
      assert.equal(rejected.noindex, null);
      assert.equal(rejected.page_nofollow, null);
      assert.equal(rejected.last_verified_at, null);
      assert.equal(rejected.crawlability_provenance.page_observed_at, null);
    }
  }
});

test('a blocked later check retains the latest trustworthy page independently of the older verified link', async () => {
  const page = await httpObservation(shell);
  const previous = observed('obs_verified', first, { occurrences: [{ rel: ['ugc'] }] });
  const blockedAt = '2026-10-11T14:00:00.000Z';
  const latest = observed('obs_blocked', blockedAt, { state: 'unknown', reason: 'source_http_403',
    evidence: { complete: false }, occurrences: [], directives: pageDirectives([], ''),
    robotsHistory: [{ googlebot: robot(false) }] });
  const result = projectWatchCrawlability(watch, { latestObservation: latest, latestPageObservation: page, lastSuccessfulObservation: previous });
  assert.equal(result.noindex, true);
  assert.equal(result.page_nofollow, true);
  assert.equal(result.google_crawlable, false, 'current Google robots facts never come from the historical page');
  assert.equal(result.can_verify_reason, 'source_http_403');
  assert.equal(result.last_verified_at, first);
  assert.deepEqual(result.link_rel, ['ugc']);
  assert.deepEqual(result.crawlability_provenance, { robots_observed_at: blockedAt, page_observed_at: later,
    link_observed_at: first, robots_observation_id: 'obs_blocked', page_observation_id: page.id, link_observation_id: 'obs_verified' });
  for (const mutate of [p => { p.result.sourceUrl = 'https://other.example.com/article'; },
    p => { p.result.evidence.capture.body.truncated = true; }]) {
    const invalid = structuredClone(page); mutate(invalid);
    const rejected = projectWatchCrawlability(watch, { latestObservation: latest, latestPageObservation: invalid, lastSuccessfulObservation: previous });
    assert.equal(rejected.noindex, false);
    assert.equal(rejected.crawlability_provenance.page_observed_at, first);
    assert.equal(rejected.last_verified_at, first);
  }
  const newerVerified = observed('obs_new_verified', blockedAt);
  const newer = projectWatchCrawlability(watch, { latestObservation: newerVerified, latestPageObservation: page, lastSuccessfulObservation: previous });
  assert.equal(newer.noindex, false, 'older fallback facts must not replace a newer verified page');
  assert.equal(newer.crawlability_provenance.page_observed_at, blockedAt);
});
