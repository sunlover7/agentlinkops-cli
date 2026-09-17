import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFetcher, PRODUCT_TOKEN } from '../src/verifier/fetch.js';

const SOURCE = 'https://publisher.com/profile';
const ORIGIN = 'https://publisher.com/robots.txt';
const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
async function attempt(routes, options = {}) {
  const calls = [], trace = { redirects: [] };
  const fetcher = publicFetcher({ ...options, fetchImpl: async url => {
    calls.push(url);
    assert.ok(routes[url], `Unexpected request ${url}`);
    return routes[url].clone();
  } }, new AbortController().signal);
  let error;
  try { await fetcher.source(SOURCE, trace); } catch (caught) { error = caught; }
  return { trace, error, calls };
}

test('robots denial after a source redirect retains the failing policy and both source hops', async () => {
  const moved = 'https://otherpublisher.com/private/profile';
  const { trace, error, calls } = await attempt({
    [ORIGIN]: text('User-agent: *\nAllow: /'),
    [SOURCE]: text('', 302, { location: moved }),
    'https://otherpublisher.com/robots.txt': text('User-agent: LinktrailBot\nDisallow: /private/\nCrawl-delay: 9'),
  });
  assert.equal(error.reason, 'robots_disallowed');
  assert.equal(trace.robots.sourceUrl, moved);
  assert.equal(trace.robots.robotsUrl, 'https://otherpublisher.com/robots.txt');
  assert.equal(trace.robots.httpStatus, 200);
  assert.equal(trace.robots.productToken, PRODUCT_TOKEN);
  assert.equal(trace.robots.allowed, false);
  assert.equal(trace.robots.matchedRule, '/private/');
  assert.equal(trace.robots.crawlDelaySeconds, 9);
  assert.equal(trace.robotsHistory.length, 2);
  assert.equal(trace.robotsHistory[0].allowed, true);
  assert.ok(!calls.includes(moved));
});

test('crawl-delay refusal retains an allowed policy and scheduler failure reason', async () => {
  const { trace, error, calls } = await attempt({ [ORIGIN]: text('User-agent: *\nCrawl-delay: 3') });
  assert.equal(error.reason, 'robots_crawl_delay_requires_scheduler');
  assert.equal(trace.robots.allowed, true);
  assert.equal(trace.robots.reason, error.reason);
  assert.equal(trace.robots.crawlDelaySeconds, 3);
  assert.equal(trace.robots.fetched, 'robots_fetched');
  assert.deepEqual(calls, [ORIGIN]);
});

for (const status of [429, 503]) {
  test(`robots ${status} preserves delta Retry-After`, async () => {
    const { trace, error } = await attempt({ [ORIGIN]: text('No', status, { 'retry-after': '121' }) });
    assert.equal(error.reason, `robots_http_${status}`);
    assert.equal(error.retryAfterSeconds, 121);
    assert.equal(trace.robots.retryAfterSeconds, 121);
    assert.equal(trace.robots.httpStatus, status);
    assert.equal(trace.robots.allowed, null);
  });
}

test('robots Retry-After HTTP date propagates with an honest relative wait', async () => {
  const deadline = new Date(Date.now() + 120_000).toUTCString();
  const { trace, error } = await attempt({ [ORIGIN]: text('', 503, { 'retry-after': deadline }) });
  assert.ok(error.retryAfterSeconds >= 118 && error.retryAfterSeconds <= 120);
  assert.equal(trace.robots.retryAfterSeconds, error.retryAfterSeconds);
});

test('robots HTML mismatch keeps response provenance without storing the body', async () => {
  const { trace, error } = await attempt({ [ORIGIN]: text('<html>private-debug-marker</html>', 200, { 'content-type': 'text/html' }) });
  assert.equal(error.reason, 'robots_not_plain_text');
  assert.equal(trace.robots.robotsUrl, ORIGIN);
  assert.equal(trace.robots.httpStatus, 200);
  assert.ok(!JSON.stringify(trace).includes('private-debug-marker'));
});

test('source refusal records bounded whitelisted metadata and excludes body, cookies and header parameters', async () => {
  const { trace, error } = await attempt({
    [ORIGIN]: text('', 404),
    [SOURCE]: text('private-debug-marker', 403, { 'content-type': 'text/html; token=private-debug-marker', 'set-cookie': 'secret=private-debug-marker', 'retry-after': '60', 'cf-mitigated': 'challenge' }),
  });
  assert.equal(error.reason, 'access_challenge');
  assert.deepEqual(trace.sourceResponse, { url: SOURCE, httpStatus: 403, contentType: 'text/html', retryAfterSeconds: 60, challenge: true });
  assert.ok(!JSON.stringify(trace).includes('private-debug-marker'));
});

test('robots redirect history is capped and keeps the last attempted endpoint', async () => {
  const routes = {};
  for (let i = 0; i < 6; i++) routes[i ? `https://publisher.com/robots-${i}` : ORIGIN] = text('', 302, { location: `/robots-${i + 1}` });
  const { trace, error } = await attempt(routes);
  assert.equal(error.reason, 'robots_redirect_limit');
  assert.equal(trace.robots.redirects.length, 5);
  assert.equal(trace.robots.robotsUrl, 'https://publisher.com/robots-5');
  assert.equal(trace.robots.httpStatus, 302);
});

test('same-origin source redirects reuse robots bytes but evaluate distinct source policies', async () => {
  const { trace, error } = await attempt({
    [ORIGIN]: text('User-agent: *\nDisallow: /private'),
    [SOURCE]: text('', 301, { location: '/private' }),
  });
  assert.equal(error.reason, 'robots_disallowed');
  assert.equal(trace.robotsHistory[0].allowed, true);
  assert.equal(trace.robotsHistory[1].allowed, false);
  assert.equal(trace.robotsHistory[0].sourceUrl, SOURCE);
  assert.equal(trace.robotsHistory[1].sourceUrl, 'https://publisher.com/private');
});

test('source-hop policy history never exceeds the six attempted pages', async () => {
  const routes = { [ORIGIN]: text('User-agent: *\nAllow: /') };
  for (let i = 0; i < 6; i++) routes[i ? `https://publisher.com/page-${i}` : SOURCE] = text('', 302, { location: `/page-${i + 1}` });
  const { trace, error } = await attempt(routes);
  assert.equal(error.reason, 'redirect_limit');
  assert.equal(trace.robotsHistory.length, 6);
  assert.equal(trace.robots.sourceUrl, 'https://publisher.com/page-5');
});

test('robots redirect transport failure names the unanswered endpoint without stale HTTP status', async () => {
  const trace = { redirects: [] };
  const fetcher = publicFetcher({ fetchImpl: async url => {
    if (url === ORIGIN) return text('', 302, { location: '/policy' });
    throw new Error('private-transport-detail');
  } }, new AbortController().signal);
  await assert.rejects(fetcher.source(SOURCE, trace), error => error.reason === 'network_error');
  assert.equal(trace.robots.robotsUrl, 'https://publisher.com/policy');
  assert.equal(trace.robots.httpStatus, null);
  assert.equal(trace.robots.reason, 'network_error');
  assert.ok(!JSON.stringify(trace).includes('private-transport-detail'));
});
