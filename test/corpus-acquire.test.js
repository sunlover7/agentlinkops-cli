import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisition, classifyFailure, FETCH_KINDS, OUTCOMES } from '../src/corpus/acquire.js';

const PAGE = 'https://publisher.example.org/roundup';
const at = '2026-09-10T12:00:00.000Z';
const html = '<html><body><a href="https://customer.example.com/g">g</a></body></html>';

const reply = (body, { status = 200, type = 'text/html' } = {}) =>
  new Response(body, { status, headers: { 'content-type': type } });

/** A transport that answers robots.txt permissively and pages from a map. */
function transport(pages, { robots = 'User-agent: *\nAllow: /\n' } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('/robots.txt')) return reply(robots, { type: 'text/plain' });
      const page = pages[url];
      if (page === undefined) return reply('missing', { status: 404 });
      return typeof page === 'function' ? page() : reply(page);
    },
  };
}
const make = (t, extra = {}) => createAcquisition({ publicFetchSafe: true, fetchImpl: t.fetchImpl, now: () => at, ...extra });

test('a direct fetch returns the page with its final URL, status and robots decision', async () => {
  const t = transport({ [PAGE]: html });
  const result = await make(t).fetchPage(PAGE);
  assert.equal(result.outcome, 'fetched');
  assert.equal(result.html, html);
  assert.equal(result.final_url, PAGE);
  assert.equal(result.http_status, 200);
  assert.equal(result.fetched_at, at);
  assert.equal(result.body_truncated, false);
  assert.ok(t.calls.some(url => url.endsWith('/robots.txt')), 'robots is consulted before the page');
});

test('every failure is a recorded outcome, never a thrown error or an empty page', async () => {
  // The corpus must keep attempted outcomes; an attempt that throws would lose the attempt.
  const cases = [
    ['blocked by robots', transport({ [PAGE]: html }, { robots: 'User-agent: *\nDisallow: /\n' }), 'blocked'],
    ['gone', transport({}), 'not_found'],
    ['server error', transport({ [PAGE]: () => reply('boom', { status: 503 }) }), 'unavailable'],
    ['forbidden', transport({ [PAGE]: () => reply('no', { status: 403 }) }), 'blocked'],
    ['not html', transport({ [PAGE]: () => reply('{}', { type: 'application/json' }) }), 'unavailable'],
    ['network down', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }, 'unavailable'],
  ];
  for (const [name, t, expected] of cases) {
    const result = await make(t).fetchPage(PAGE);
    assert.equal(result.outcome, expected, name);
    assert.ok(OUTCOMES.includes(result.outcome), name);
    assert.equal(result.html, null, `${name} carries no body`);
    assert.ok(result.reason || result.outcome === 'not_found', `${name} states a reason`);
  }
});

test('an unasserted public boundary refuses to fetch rather than trusting a hostname', async () => {
  const t = transport({ [PAGE]: html });
  const unsafe = createAcquisition({ fetchImpl: t.fetchImpl, now: () => at });
  const result = await unsafe.fetchPage(PAGE);
  // A misconfiguration, not a transient failure: retrying this page will never help.
  assert.equal(result.outcome, 'not_configured');
  assert.equal(result.reason, 'public_fetch_boundary_not_asserted');
  assert.equal(t.calls.length, 0, 'nothing was requested');
  // Lexically unsafe URLs never reach the transport either.
  for (const url of ['https://10.0.0.1/x', 'https://localhost/x', 'ftp://publisher.example.org/'])
    assert.match((await make(t).fetchPage(url)).reason, /^unsafe_url:/);
  assert.equal(t.calls.length, 0);
});

test('a proxied or rendered runtime must assert its own boundary and never inherits ours', async () => {
  const t = transport({ [PAGE]: html });
  // Declared but absent: an explicit not_configured, the same stance as an unconfigured supplier.
  for (const kind of ['rendered', 'proxied']) {
    const result = await make(t).fetchPage(PAGE, { kind });
    assert.equal(result.outcome, 'not_configured');
    assert.equal(result.reason, `${kind}_runtime_not_configured`);
  }
  // Present but silent about its own safety. A proxy resolves and connects on its own, so
  // the platform boundary that makes direct fetching safe says nothing about it.
  const silent = make(t, { runtimes: { proxied: { fetchPage: async () => ({ html }) } } });
  const refused = await silent.fetchPage(PAGE, { kind: 'proxied' });
  assert.equal(refused.outcome, 'not_configured');
  assert.equal(refused.reason, 'proxied_runtime_boundary_not_asserted');

  // Asserting it explicitly is what allows the fetch, and truncation travels back intact.
  const configured = make(t, { runtimes: { proxied: {
    publicFetchSafe: true,
    fetchPage: async () => ({ outcome: 'fetched', html, httpStatus: 200, bodyTruncated: true, finalUrl: PAGE }),
  } } });
  const ok = await configured.fetchPage(PAGE, { kind: 'proxied' });
  assert.equal(ok.outcome, 'fetched');
  assert.equal(ok.body_truncated, true, 'a runtime cap reaches extraction as doubt, not as absence');
  assert.equal(ok.kind, 'proxied');
});

test('failure classification never invents a not-found and never loses a block', () => {
  assert.equal(classifyFailure('robots_disallowed'), 'blocked');
  assert.equal(classifyFailure('robots_crawl_delay_requires_scheduler'), 'blocked');
  assert.equal(classifyFailure('access_challenge'), 'blocked');
  assert.equal(classifyFailure('source_http_403'), 'blocked');
  assert.equal(classifyFailure('source_http_404'), 'not_found');
  // Anything unrecognised is unavailable. A page we could not reach is not a page that is gone.
  for (const reason of ['timeout', 'network_error', 'body_too_large', 'redirect_loop', 'something_new'])
    assert.equal(classifyFailure(reason), 'unavailable', reason);
  assert.deepEqual(FETCH_KINDS, ['direct', 'rendered', 'proxied']);
});

test('an unknown fetch kind is refused before any request', async () => {
  const t = transport({ [PAGE]: html });
  const result = await make(t).fetchPage(PAGE, { kind: 'telepathy' });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reason, 'unsupported_fetch_kind');
  assert.equal(t.calls.length, 0);
});
