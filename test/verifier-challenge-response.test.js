import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFetcher } from '../src/verifier/fetch.js';
import { verifyLink } from '../src/verifier/index.js';

const sourceUrl = 'https://publisher.com/profile';
const robotsUrl = 'https://publisher.com/robots.txt';
const targetUrl = 'https://example.com/';
const secret = 'private-challenge-body-and-cookie';
const statuses = [200, 302, 403, 404, 410, 429, 503];

function fixture(kind, status, retry = '73') {
  const calls = [];
  let cancelled = false;
  const fetchImpl = async url => {
    calls.push(url);
    if (kind === 'source' && url === robotsUrl) return new Response('', { status: 404 });
    assert.equal(url, kind === 'source' ? sourceUrl : robotsUrl, 'challenge must prevent further requests');
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(secret)); },
      cancel() { cancelled = true; },
    });
    return new Response(body, { status, headers: {
      'cf-mitigated': 'challenge', 'content-type': `text/html; private=${secret}`,
      'set-cookie': `session=${secret}`, location: `https://otherpublisher.com/${secret}`,
      'retry-after': retry,
    } });
  };
  return { fetchImpl, calls, cancelled: () => cancelled };
}

for (const kind of ['source', 'robots']) {
  for (const status of statuses) {
    test(`${kind} challenge ${status} fails closed before status/redirect/body processing`, async () => {
      const f = fixture(kind, status);
      const trace = { redirects: [] };
      const fetcher = publicFetcher({ fetchImpl: f.fetchImpl }, new AbortController().signal);
      await assert.rejects(fetcher.source(sourceUrl, trace), error => {
        assert.equal(error.reason, kind === 'source' ? 'access_challenge' : 'robots_access_challenge');
        assert.equal(error.retryAfterSeconds, 73);
        assert.ok(!JSON.stringify(error).includes(secret));
        return true;
      });
      assert.equal(f.cancelled(), true, 'challenge body must be cancelled without reading');
      assert.deepEqual(f.calls, kind === 'source' ? [robotsUrl, sourceUrl] : [robotsUrl]);
      assert.deepEqual(trace.redirects, []);
      if (kind === 'source') {
        assert.equal(trace.httpStatus, status);
        assert.deepEqual(trace.sourceResponse, { url: sourceUrl, httpStatus: status,
          contentType: 'text/html', retryAfterSeconds: 73, challenge: true });
      } else {
        assert.equal(trace.robots.httpStatus, status);
        assert.equal(trace.robots.reason, 'robots_access_challenge');
        assert.equal(trace.robots.retryAfterSeconds, 73);
        assert.equal(trace.robots.allowed, null);
        assert.deepEqual(trace.robots.redirects, []);
      }
      assert.ok(!JSON.stringify(trace).includes(secret));
    });
  }
  test(`${kind} challenge remains unknown through public verifier without HTML or private headers`, async () => {
    const f = fixture(kind, 404);
    const result = await verifyLink({ sourceUrl, targetUrl }, { fetchImpl: f.fetchImpl, publicFetchSafe: true });
    assert.equal(result.state, 'unknown');
    assert.equal(result.reason, kind === 'source' ? 'access_challenge' : 'robots_access_challenge');
    assert.equal(result.retryAfterSeconds, 73);
    assert.equal(result.evidence.html, undefined);
    assert.ok(!JSON.stringify(result).includes(secret));
  });
  test(`${kind} challenge retains date Retry-After and omits malformed retry`, async () => {
    for (const retry of [new Date(Date.now() + 120_000).toUTCString(), 'nonsense']) {
      const f = fixture(kind, 503, retry);
      const trace = { redirects: [] };
      await assert.rejects(publicFetcher({ fetchImpl: f.fetchImpl }, new AbortController().signal).source(sourceUrl, trace), error => {
        if (retry === 'nonsense') assert.equal(error.retryAfterSeconds, undefined);
        else assert.ok(error.retryAfterSeconds >= 118 && error.retryAfterSeconds <= 120);
        return true;
      });
    }
  });
}

for (const status of [403, 404, 410]) {
  test(`genuine source ${status} retains its prior classification`, async () => {
    const result = await verifyLink({ sourceUrl, targetUrl }, { publicFetchSafe: true,
      fetchImpl: async url => new Response('', { status: url === robotsUrl ? 404 : status }),
    });
    assert.equal(result.state, status === 403 ? 'unknown' : 'source_unavailable');
    assert.equal(result.reason, `source_http_${status}`);
  });
  test(`genuine robots ${status} permits source acquisition`, async () => {
    const calls = [];
    const trace = { redirects: [] };
    const result = await publicFetcher({ fetchImpl: async url => {
      calls.push(url);
      return url === robotsUrl ? new Response('', { status }) : new Response('<html>Profile</html>', { headers: { 'content-type': 'text/html' } });
    } }, new AbortController().signal).source(sourceUrl, trace);
    assert.deepEqual(calls, [robotsUrl, sourceUrl]);
    assert.equal(result.body.text, '<html>Profile</html>');
  });
}
