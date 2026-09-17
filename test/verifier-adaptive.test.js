import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLink, verifyLinks, transitionState } from '../src/verifier/index.js';

const sourceUrl = 'https://publisher.com/profile';
const targetUrl = 'https://customer.com/';
const input = { sourceUrl, targetUrl, targetScope: 'domain' };
const shell = '<!doctype html><html><body><nav><a href="/">Home</a></nav><div id="app"></div><script src="/app.js"></script></body></html>';
const page = (body) => `<!doctype html><html><head><title>Profile</title></head><body>${body}</body></html>`;
const present = page(`<a href="${targetUrl}" rel="nofollow">Customer</a>`);
function options(html = shell, renderHtml = present, extra = {}) {
  return {
    publicFetchSafe: true, includeHtml: false,
    fetchImpl: async (url) => url.endsWith('/robots.txt') ? new Response('', { status: 404 })
      : new Response(html, { headers: { 'content-type': 'text/html' } }),
    renderPage: Object.assign(async () => ({ html: renderHtml, finalUrl: sourceUrl, httpStatus: 200,
      redirects: [], ready: true, bodyTruncated: false, ...extra }), { publicFetchSafe: true, requiresNavigationAuthorization: true }),
  };
}

test('navigation-bearing shell remains unknown without configured rendering and retains private diagnostics', async () => {
  const opts = options(); delete opts.renderPage; opts.includeHtml = true;
  const result = await verifyLink(input, opts);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'possible_render_required');
  assert.equal(result.evidence.readiness.reason, 'empty_application_root');
  assert.equal(result.evidence.html, shell);
  assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.evidence.complete, false);
  assert.equal(result.evidence.checkerVersion, '4');
  assert.equal(transitionState({}, result).lastSuccessfulObservation, null);
});

test('adaptive observation reuses exact matching and preserves rendered directives', async () => {
  const result = await verifyLink({ ...input, expectedRel: ['nofollow'] }, options(shell, present, { xRobotsTag: 'noindex' }));
  assert.equal(result.state, 'present');
  assert.equal(result.expectations.satisfied, true);
  assert.equal(result.directives.noindex, true);
  assert.equal(result.evidence.method, 'browser_html');
  assert.equal(result.evidence.staticObservation.reason, 'possible_render_required');
  assert.equal(result.occurrences[0].visibility, 'rendered_dom_not_visual');
  assert.equal(result.evidence.html, undefined);
});

test('ready absence is distinct from an unfinished DOM and script data is never a link', async () => {
  const html = page('<article>A public biography with no external link.</article>');
  const ready = await verifyLink(input, options(shell, html));
  assert.equal(ready.state, 'absent');
  assert.equal(ready.reason, 'no_matching_link_in_ready_dom');
  const unready = await verifyLink(input, options(shell, html, { ready: false }));
  assert.equal(unready.state, 'unknown');
  assert.equal(unready.reason, 'render_readiness_unconfirmed');
  assert.equal(unready.linkSignature, undefined);
});

test('robots denial and source access walls never automatically escalate', async () => {
  for (const mode of ['robots', '403']) {
    let calls = 0;
    const opts = options(); opts.renderPage = Object.assign(async () => { calls++; }, { publicFetchSafe: true, requiresNavigationAuthorization: true });
    opts.fetchImpl = async (url) => url.endsWith('/robots.txt')
      ? new Response(mode === 'robots' ? 'User-agent: *\nDisallow: /' : '', { status: 200 })
      : new Response('', { status: 403 });
    const result = await verifyLink(input, opts);
    assert.equal(result.state, 'unknown'); assert.equal(calls, 0);
  }
});

test('renderer boundary assertion is mandatory', async () => {
  const opts = options(); opts.renderPage.publicFetchSafe = false;
  const result = await verifyLink(input, opts);
  assert.equal(result.evidence.renderAttempt.attempted, false);
  assert.equal(result.state, 'unknown');
});

test('render timeout aborts provider and never confirms static absence', async () => {
  const opts = options(page('<article>No backlink on this page.</article>'));
  let signal;
  opts.compareRendered = true; opts.renderTimeoutMs = 5;
  opts.renderPage = Object.assign(async (_, context) => { signal = context.signal; return new Promise(() => {}); }, { publicFetchSafe: true, requiresNavigationAuthorization: true });
  const result = await verifyLink(input, opts);
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'render_timeout');
  assert.equal(signal.aborted, true);
});

test('rendered target redirects cannot count destination navigation as placements', async () => {
  const result = await verifyLink(input, options(shell, present, {
    finalUrl: targetUrl, redirects: [{ from: sourceUrl, to: targetUrl, status: 302 }],
  }));
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'source_redirects_to_target');
});

test('malformed, incomplete, unsafe and oversized provider evidence never concludes', async () => {
  for (const extra of [
    { finalUrl: 'http://127.0.0.1/' }, { finalUrl: 'https://other.com/' },
    { redirects: [{ from: 'https://other.com/', to: sourceUrl, status: 302 }] },
    { httpStatus: 403 }, { bodyTruncated: true }, { bodyTruncated: undefined }, { bodyTruncated: "true" }, { ready: undefined },
    { xRobotsTag: "noindex\r\nsecret-marker" },
    { html: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { html: '<!doctype html><script>unfinished' },
  ]) {
    const result = await verifyLink(input, options(shell, present, extra));
    assert.equal(result.state, 'unknown'); assert.equal(result.evidence.complete, false);
  }
});

test('group shares rendered acquisition but not targets, diagnostics or expectations', async () => {
  const opts = options(); let calls = 0; const render = opts.renderPage;
  opts.renderPage = Object.assign(async (...args) => { calls++; return render(...args); }, { publicFetchSafe: true, requiresNavigationAuthorization: true });
  const results = await verifyLinks([input, { ...input, targetUrl: 'https://other.com/' }], opts);
  assert.equal(calls, 1); assert.deepEqual(results.map(r => r.state), ['present', 'absent']);
  results[0].evidence.staticObservation.reason = 'mutated';
  assert.equal(results[1].evidence.staticObservation.reason, 'possible_render_required');
});

test('static positive observation survives browser disagreement', async () => {
  const opts = options(present, page('<p>Empty after hydration.</p>')); opts.compareRendered = true;
  const result = await verifyLink(input, opts);
  assert.equal(result.state, 'present'); assert.equal(result.evidence.method, 'http_html');
  assert.equal(result.evidence.renderAttempt.reason, 'render_disagreement');
});

test('provider metadata is allowlisted and malformed headers preserve a static positive', async () => {
  const redirected = 'https://publisher.com/new-profile';
  const result = await verifyLink(input, options(shell, present, { finalUrl: redirected,
    redirects: [{ from: sourceUrl, to: redirected, status: 301, authorization: 'secret-marker', html: 'raw-marker' }] }));
  assert.equal(result.state, 'present');
  assert.deepEqual(result.redirects, [{ from: sourceUrl, to: redirected, status: 301 }]);
  assert.equal(JSON.stringify(result).includes('secret-marker'), false);
  for (const xRobotsTag of ['noindex\r\nsecret-marker', '\u2603', true]) {
    const opts = options(present, present, { xRobotsTag }); opts.compareRendered = true;
    const observed = await verifyLink(input, opts);
    assert.equal(observed.state, 'present');
    assert.equal(observed.evidence.renderAttempt.reason, 'invalid_render_directives');
  }
});

test('grouped unknowns preserve independent failing robots provenance', async () => {
  const opts = options(); delete opts.renderPage;
  opts.fetchImpl = async () => new Response('User-agent: *\nDisallow: /profile\nCrawl-delay: 5');
  const results = await verifyLinks([input, { ...input, targetUrl: 'https://other.com/' }], opts);
  assert.equal(results[1].robots.allowed, false);
  assert.equal(results[1].robotsHistory[0].matchedRule, '/profile');
  results[0].robotsHistory[0].reason = 'mutated';
  assert.equal(results[1].robotsHistory[0].reason, 'robots_disallowed');
});

test('hidden password widget no longer makes public article an access wall', async () => {
  const opts = options(page('<article>This is a complete public article with readable content and no backlink.</article><div hidden><input type="password"></div>'));
  const result = await verifyLink(input, opts);
  assert.equal(result.state, 'absent'); assert.equal(result.evidence.renderAttempt, undefined);
});
