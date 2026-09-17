// DP-0020-T02: the internal/external observation kind, and the verifier semantics a receipt
// depends on. The wave-1 contract (docs/initiatives/DP-0020-completed-action-observation/
// action-receipts-contract.md) fixes the record; these tests pin the two things T02 owns —
// the write-time kind check, and the fact that an internal placement is verified by the SAME
// verifier and the SAME confirmed-loss rules as an external one, with no privileged path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkObservationKind, normalizeDeclaredSite, withinDeclaredSite, verifyLink, transitionState,
} from '../src/verifier/index.js';

const html = (body, options = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });

function fixtureFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (handler === undefined && new URL(url).pathname === '/robots.txt') return new Response('', { status: 404 });
    assert.notEqual(handler, undefined, `Unexpected network request: ${url}`);
    return typeof handler === 'function' ? handler(url, init) : handler.clone();
  };
  return { fetchImpl, calls };
}

// The declared site, the way project identity would state it: apex, www and the blog host,
// each named. Nothing is inferred from the registrable domain.
const SITE = ['customer.com', 'www.customer.com', 'blog.customer.com'];
const INTERNAL_SOURCE = 'https://customer.com/blog/internal-links';
const INTERNAL_TARGET = 'https://customer.com/guides/outreach';

test('an internal receipt whose source and target are both declared verifies with the shared verifier', async () => {
  const check = checkObservationKind({ kind: 'internal', sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET }, SITE);
  assert.deepEqual(check, {
    valid: true, kind: 'internal', sourceInSite: true, targetInSite: true,
    declaredSite: ['blog.customer.com', 'customer.com', 'www.customer.com'],
  });
  // And the check is a real check of a real public page: robots, then the source. Two fetches,
  // metered like any other; internal placements get no privileged path.
  const fixture = fixtureFetch({
    [INTERNAL_SOURCE]: html(`<p>Planning outreach? Read the <a href="${INTERNAL_TARGET}">outreach guide</a>.</p>`),
  });
  const result = await verifyLink(
    { sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact', expectedAnchor: 'outreach guide' },
    { fetchImpl: fixture.fetchImpl, publicFetchSafe: true, now: '2026-09-12T12:00:00.000Z' },
  );
  assert.equal(result.state, 'present');
  assert.equal(result.occurrences.length, 1);
  assert.equal(result.expectations.satisfied, true);
  assert.equal(fixture.calls.length, 2);
});

test('an internal receipt outside the declared site is refused naming the host', () => {
  const source = checkObservationKind({ kind: 'internal', sourceUrl: 'https://publisher.com/article', targetUrl: INTERNAL_TARGET }, SITE);
  assert.equal(source.valid, false);
  assert.equal(source.reason, 'internal_source_outside_declared_site:publisher.com');
  const target = checkObservationKind({ kind: 'internal', sourceUrl: INTERNAL_SOURCE, targetUrl: 'https://publisher.com/guide' }, SITE);
  assert.equal(target.valid, false);
  assert.equal(target.reason, 'internal_target_outside_declared_site:publisher.com');
});

test('an external receipt whose source is the declared site is refused naming the host', () => {
  const check = checkObservationKind({ kind: 'external', sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET }, SITE);
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'external_source_on_declared_site:customer.com');
  // The honest label for that placement is internal; the actor does not get to pick the kind
  // that publisher-delay semantics would forgive.
  const honest = checkObservationKind({ kind: 'external', sourceUrl: 'https://publisher.com/article', targetUrl: INTERNAL_TARGET }, SITE);
  assert.equal(honest.valid, true);
  assert.equal(honest.kind, 'external');
  assert.deepEqual([honest.sourceInSite, honest.targetInSite], [false, true]);
});

test('a staging or preview host is refused at write time, never checked into an unknown', () => {
  // Undeclared subdomain of a declared site: not part of the public site, so not internal.
  const staging = checkObservationKind({ kind: 'internal', sourceUrl: 'https://staging.customer.com/blog/post', targetUrl: INTERNAL_TARGET }, SITE);
  assert.equal(staging.valid, false);
  assert.equal(staging.reason, 'internal_source_outside_declared_site:staging.customer.com');
  // And spellings the public fetch boundary itself refuses are refused HERE, with the
  // boundary's own reason, rather than minting a receipt every future check answers `unknown`.
  for (const [url, reason] of [
    ['https://blog.internal/post', 'non_public_hostname'],
    ['http://localhost/blog/post', 'non_public_hostname'],
    ['https://192.168.1.10/blog/post', 'ip_literal_not_supported'],
  ]) {
    const check = checkObservationKind({ kind: 'internal', sourceUrl: url, targetUrl: INTERNAL_TARGET }, SITE);
    assert.equal(check.valid, false, url);
    assert.equal(check.reason, `invalid_source:${reason}`, url);
  }
});

test('membership is declared, not inferred: an undeclared www is outside the site', () => {
  const apexOnly = normalizeDeclaredSite('customer.com');
  assert.deepEqual(apexOnly, { valid: true, hosts: ['customer.com'] });
  assert.equal(withinDeclaredSite('https://customer.com/blog/post', apexOnly.hosts), true);
  assert.equal(withinDeclaredSite('https://www.customer.com/blog/post', apexOnly.hosts), false);
  const check = checkObservationKind({ kind: 'internal', sourceUrl: 'https://www.customer.com/blog/post', targetUrl: 'https://customer.com/guides/outreach' }, 'customer.com');
  assert.equal(check.reason, 'internal_source_outside_declared_site:www.customer.com');
});

test('declared-site normalization accepts origins and hosts, and rejects junk once', () => {
  assert.deepEqual(normalizeDeclaredSite(['HTTPS://Customer.COM/', 'customer.com', 'https://blog.customer.com/posts']), {
    valid: true, hosts: ['blog.customer.com', 'customer.com'],
  });
  for (const bad of ['', [], null, ['intranet'], [''], ['http://192.168.0.1/'], [42], ['not a host'], ['https://user:pass@customer.com/']]) {
    const site = normalizeDeclaredSite(bad);
    assert.equal(site.valid, false, JSON.stringify(bad));
    assert.equal(site.reason, bad === '' || bad === null || (Array.isArray(bad) && bad.length === 0) ? 'no_declared_site' : 'invalid_declared_site_entry');
  }
  // With no declared site there is no fact of ownership, so no kind is accepted: the actor's
  // label alone must never decide the observation type.
  const noSite = checkObservationKind({ kind: 'external', sourceUrl: 'https://publisher.com/a', targetUrl: INTERNAL_TARGET }, null);
  assert.equal(noSite.reason, 'no_declared_site');
});

test('an unknown kind is refused before anything else about the placement is read', () => {
  for (const kind of ['Internal', 'EXTERNAL', 'inline', undefined, null, 1]) {
    const check = checkObservationKind({ kind, sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET }, SITE);
    assert.equal(check.valid, false, String(kind));
    assert.equal(check.reason.startsWith('unknown_kind:'), true);
  }
});

test('delayed publication: absence is the truthful internal alarm, and landing is dated by observation', async () => {
  // The receipt claims the edit was done at 11:55. The deploy has not shipped at noon.
  const actedAt = '2026-09-12T11:55:00.000Z';
  let document = '<html><body><p>An article about campaign planning, with its usual editorial text and nothing else yet.</p></body></html>';
  const routes = { [INTERNAL_SOURCE]: () => html(document) };
  const run = async (now) => verifyLink(
    { sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact' },
    { fetchImpl: fixtureFetch(routes).fetchImpl, publicFetchSafe: true, now, includeHtml: false },
  );

  // Noon: the public page does not carry the link. Absent — the alarm, but a suspected one.
  let state = transitionState(null, await run('2026-09-12T12:00:00.000Z'));
  assert.equal(state.state, 'suspected_missing');
  assert.equal(state.absentCount, 1);
  assert.equal(state.event, null, 'a first absence never confirms loss');
  assert.equal(state.nextCheckAt, '2026-09-12T12:30:00.000Z');
  assert.equal(state.wasEverPresent, false);

  // 12:05: the CDN in front of the customer's own site serves a challenge. Unknown, never
  // absent — the loss clock does not advance on a page we could not read.
  document = '<html><head><title>Just a moment...</title></head><body>Checking your browser.</body></html>';
  state = transitionState(state, await run('2026-09-12T12:05:00.000Z'));
  assert.equal(state.state, 'suspected_missing');
  assert.equal(state.absentCount, 1);
  assert.equal(state.uncertain, true);

  // 12:40: the deploy lands. Present, acquired, dated by the OBSERVATION, not the claim.
  document = `<html><body><p>Planning outreach? Read the <a href="${INTERNAL_TARGET}">outreach guide</a>.</p></body></html>`;
  state = transitionState(state, await run('2026-09-12T12:40:00.000Z'));
  assert.equal(state.state, 'present');
  assert.equal(state.event.type, 'placement_acquired');
  assert.equal(state.event.after.checkedAt, '2026-09-12T12:40:00.000Z');
  assert.notEqual(state.event.after.checkedAt, actedAt);
  assert.equal(state.firstAbsentAt, null);
});

test('a nofollow added during a republish is a change event, never a loss', async () => {
  const anchor = (rel) => `<html><body><p>Planning outreach? Read the <a href="${INTERNAL_TARGET}"${rel}>outreach guide</a>.</p></body></html>`;
  const run = async (document, now) => verifyLink(
    { sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact', expectedRel: [] },
    { fetchImpl: fixtureFetch({ [INTERNAL_SOURCE]: () => html(document) }).fetchImpl, publicFetchSafe: true, now },
  );
  let state = transitionState(null, await run(anchor(''), '2026-09-12T12:00:00.000Z'));
  assert.equal(state.state, 'present');
  const changed = transitionState(state, await run(anchor(' rel="nofollow sponsored"'), '2026-09-12T12:31:00.000Z'));
  assert.equal(changed.state, 'present');
  assert.equal(changed.event.type, 'placement_changed');
  assert.deepEqual([...changed.lastSuccessfulObservation.occurrences[0].rel].sort(), ['nofollow', 'sponsored']);
  // Expectations are evaluated separately from presence: the link stopped satisfying the
  // expected rel without any of that reading as removal.
  const observation = await run(anchor(' rel="nofollow"'), '2026-09-12T12:32:00.000Z');
  assert.equal(observation.state, 'present');
  assert.equal(observation.expectations.relMatches, false);
});

test('a blocked page after a verified internal placement preserves the last successful observation', async () => {
  const run = async (document, now) => verifyLink(
    { sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact' },
    { fetchImpl: fixtureFetch({ [INTERNAL_SOURCE]: () => html(document) }).fetchImpl, publicFetchSafe: true, now },
  );
  const live = transitionState(null, await run(`<p>Read the <a href="${INTERNAL_TARGET}">outreach guide</a>.</p>`, '2026-09-12T12:00:00.000Z'));
  const blocked = transitionState(live, await run('<html><body><form><input type="password" name="pw"></form><p>Sign in to continue.</p></body></html>', '2026-09-12T12:50:00.000Z'));
  assert.equal(blocked.state, 'present');
  assert.equal(blocked.latestAttempt.state, 'unknown');
  assert.equal(blocked.latestAttempt.reason, 'possible_login_wall');
  assert.equal(blocked.lastSuccessfulObservation.state, 'present');
  assert.equal(blocked.event, null);
});

test('an internal redirect onto a different page in scope is not a placement carried by that page', async () => {
  // The blog post's URL now bounces to the guide itself. Following it and parsing the guide
  // would count the guide's own navigation — the 120-occurrence defect, now reachable inside
  // the customer's own site. It stays `unknown`, naming the redirect.
  const fixture = fixtureFetch({
    'https://blog.customer.com/post': new Response(null, { status: 301, headers: { location: 'https://customer.com/guide' } }),
    'https://customer.com/guide': html('<nav><a href="/guide">Guide home</a> <a href="/guide/step">Step one</a></nav>'),
  });
  const result = await verifyLink(
    { sourceUrl: 'https://blog.customer.com/post', targetUrl: 'https://customer.com/guide', targetScope: 'domain' },
    { fetchImpl: fixture.fetchImpl, publicFetchSafe: true, now: '2026-09-12T12:00:00.000Z' },
  );
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'source_redirects_to_target');
  assert.equal(result.occurrences.length, 0);
  assert.deepEqual(result.redirects, [{ from: 'https://blog.customer.com/post', to: 'https://customer.com/guide', status: 301 }]);
});

test('same-page canonicalization inside the declared site is still an internal link check', async () => {
  // Trailing-slash canonicalization of the SAME page: the destination's links are the source
  // page's links, so the check proceeds. (Preserved exactly from the pre-existing behaviour.)
  const slash = fixtureFetch({
    'https://customer.com/blog/post': new Response(null, { status: 301, headers: { location: 'https://customer.com/blog/post/' } }),
    'https://customer.com/blog/post/': html('<p>Read the <a href="https://customer.com/guide">guide</a>.</p>'),
  });
  const trailing = await verifyLink(
    { sourceUrl: 'https://customer.com/blog/post', targetUrl: 'https://customer.com/guide', targetScope: 'domain' },
    { fetchImpl: slash.fetchImpl, publicFetchSafe: true },
  );
  assert.equal(trailing.state, 'present');
  assert.equal(trailing.occurrences.length, 1);

  // Apex canonicalization with the path preserved: a parent/child host of the same site.
  const apex = fixtureFetch({
    'https://blog.customer.com/post': new Response(null, { status: 301, headers: { location: 'https://customer.com/post' } }),
    'https://customer.com/post': html('<p>Read the <a href="https://customer.com/guide">guide</a>.</p>'),
  });
  const moved = await verifyLink(
    { sourceUrl: 'https://blog.customer.com/post', targetUrl: 'https://customer.com/guide', targetScope: 'domain' },
    { fetchImpl: apex.fetchImpl, publicFetchSafe: true },
  );
  assert.equal(moved.state, 'present');
});

test('a same-path redirect from an unrelated host is a handoff, not canonicalization', async () => {
  // The carve-out must not open the original defect back up: a third-party URL whose path
  // happens to equal the target's, redirecting onto the target, is refused exactly as before.
  const fixture = fixtureFetch({
    'https://publisher.com/guide': new Response(null, { status: 302, headers: { location: 'https://customer.com/guide' } }),
    'https://customer.com/guide': html('<a href="https://customer.com/guide">Permalink to self</a>'),
  });
  const result = await verifyLink(
    { sourceUrl: 'https://publisher.com/guide', targetUrl: 'https://customer.com/guide', targetScope: 'exact' },
    { fetchImpl: fixture.fetchImpl, publicFetchSafe: true },
  );
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'source_redirects_to_target');
});

test('a successful handoff establishes nothing: a 200 without a readable document is not a placement', async () => {
  // The Blogr-shaped failure: a webhook answers 200, a CMS says "accepted", a form confirms.
  // The only fact that matters is the served HTML, and each of these is not one.
  for (const [response, reason] of [
    [new Response('', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), 'empty_document'],
    [new Response('{"accepted":true}', { status: 200, headers: { 'content-type': 'application/json' } }), 'unsupported_content_type'],
    [new Response('<div id="root"></div><script src="/app.js"></script>', { status: 200, headers: { 'content-type': 'text/html' } }), 'possible_render_required'],
  ]) {
    const fixture = fixtureFetch({ [INTERNAL_SOURCE]: response });
    const result = await verifyLink(
      { sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact' },
      { fetchImpl: fixture.fetchImpl, publicFetchSafe: true },
    );
    assert.equal(result.state, 'unknown', reason);
    assert.equal(result.reason, reason);
    assert.equal(result.evidence.complete, false);
  }
});

test('an out-of-band claim of presence is never accepted as an observation without complete evidence', () => {
  // A receipt, a webhook 200 and a repository edit all arrive as claims. The only shape the
  // reducer accepts as fact is an observation whose evidence says the document was read
  // completely — which only the fetch path produces. Everything else keeps the entry unknown.
  const claim = {
    state: 'present', reason: 'webhook_accepted', checkedAt: '2026-09-12T12:00:00.000Z',
    sourceUrl: INTERNAL_SOURCE, finalUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact',
    occurrences: [{ targetUrl: INTERNAL_TARGET, anchor: 'outreach guide', rel: [] }],
    evidence: { complete: false, method: 'webhook', checkerVersion: '1' },
  };
  const state = transitionState(null, claim);
  assert.equal(state.state, 'unknown');
  assert.equal(state.event, null, 'no placement_acquired can be manufactured without a fetched document');
  assert.equal(state.uncertain, true);
  assert.equal(state.wasEverPresent, false);

  // And the same for the "I committed the anchor to the site source" form: a repository edit
  // is intent with a hash. Until the built page is fetched and parsed, no placement exists.
  const commit = { ...claim, reason: 'repository_edit', evidence: { complete: false, method: 'git', checkerVersion: '1' } };
  const committed = transitionState(null, commit);
  assert.equal(committed.state, 'unknown');
  assert.equal(committed.event, null);
});

test('the verifier still refuses every network call until the public fetch boundary is configured', async () => {
  let called = false;
  const result = await verifyLink(
    { sourceUrl: INTERNAL_SOURCE, targetUrl: INTERNAL_TARGET, targetScope: 'exact' },
    { fetchImpl() { called = true; } },
  );
  assert.equal(result.reason, 'public_fetch_not_configured');
  assert.equal(called, false);
});
