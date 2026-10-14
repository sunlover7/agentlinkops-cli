import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import * as legacy from '../src/verifier/fetch.js';
import * as shared from '../src/page-acquisition/http.js';
import { readBoundedBytes, inflateGzipBounded } from '../src/page-acquisition/bytes.js';
import { createDocumentTransport } from '../src/page-acquisition/documents.js';

const URL = 'https://publisher.com/sitemap.xml';
const xml = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'application/xml', ...headers } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('legacy verifier exports share the HTTP policy, reader and error identity', () => {
  for (const name of ['publicFetcher', 'readBounded', 'VerificationError', 'retryAfterSeconds', 'PRODUCT_TOKEN', 'MAX_RETRY_AFTER_SECONDS']) {
    assert.equal(legacy[name], shared[name], name);
  }
  assert.equal(new shared.VerificationError('fixture') instanceof legacy.VerificationError, true);
});

test('navigation authorization aborts a non-cooperative pacing hook', { timeout: 1500 }, async () => {
  const owner = new AbortController();
  const fetcher = legacy.publicFetcher({
    fetchImpl: async () => new Response(null, { status: 404 }),
    beforeFetch: (_url, context) => {
      if (context.kind === 'source') {
        setTimeout(() => owner.abort(), 20);
        return new Promise(() => {});
      }
    },
  }, owner.signal);
  await assert.rejects(fetcher.authorizeNavigation(URL), { reason: 'timeout' });
});

test('legacy HTTP cancels late bodies from a transport that ignored owner cancellation', { timeout: 1500 }, async () => {
  const owner = new AbortController();
  let release, dispatched, cancelled = false;
  const started = new Promise(resolve => { dispatched = resolve; });
  const fetcher = legacy.publicFetcher({ fetchImpl: () => {
    dispatched();
    return new Promise(resolve => { release = resolve; });
  } }, owner.signal);
  const pending = fetcher.source(URL, { redirects: [] });
  await started;
  owner.abort();
  await assert.rejects(pending, { reason: 'timeout' });
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await wait(0);
  assert.equal(cancelled, true);
});

test('raw reader preserves bytes without interpreting binary gzip as text', async () => {
  const data = gzipSync(Buffer.from('<urlset/>'));
  const result = await readBoundedBytes(xml(data), 1024, new AbortController().signal);
  assert.deepEqual(result.data, new Uint8Array(data));
  assert.equal(result.bytes, data.length);
});

test('legacy decoded reader keeps charset decoding and original consumed bytes', async () => {
  const data = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  const result = await legacy.readBounded(xml(data, { 'content-type': 'text/html; charset=iso-8859-1' }), 100, new AbortController().signal);
  assert.equal(result.text, 'café');
  assert.deepEqual(result.data, data);
  assert.equal(result.bytes, 4);
  await assert.rejects(legacy.readBounded(xml(data), 100, new AbortController().signal),
    error => error instanceof legacy.VerificationError && error.reason === 'unsupported_or_invalid_encoding');
});

test('raw reader refuses advertised oversize and incomplete unencoded body', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readBoundedBytes(xml('x', { 'content-length': '11' }), 10, signal), { reason: 'body_too_large' });
  await assert.rejects(readBoundedBytes(xml('x', { 'content-length': '2' }), 10, signal), { reason: 'incomplete_body' });
});

test('raw reader does not compare compressed wire length to transport-decoded bytes', async () => {
  const result = await readBoundedBytes(xml('decoded', { 'content-length': '50', 'content-encoding': 'gzip' }), 10, new AbortController().signal);
  assert.equal(result.bytes, 7);
});

test('a header-complete document with a stalled body times out and cancels its stream', { timeout: 1500 }, async () => {
  let cancelled = false;
  const transport = createDocumentTransport({ timeoutMs: 80, hostDelayMs: 0,
    fetchImpl: async () => xml(new ReadableStream({ cancel() { cancelled = true; } })) });
  const result = await transport.fetchText(URL);
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(result.reason, 'timeout');
  assert.equal(cancelled, true);
});

test('the document timeout is shared by redirects and late responses are disposed', { timeout: 1500 }, async () => {
  const calls = [];
  let lateCancelled = false;
  const transport = createDocumentTransport({ timeoutMs: 80, hostDelayMs: 0, fetchImpl: async url => {
    calls.push(url);
    await wait(50); // Deliberately non-cooperative fixture transport.
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/next.xml' } });
    return xml(new ReadableStream({ cancel() { lateCancelled = true; } }));
  } });
  const result = await transport.fetchText(URL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(calls, [URL, 'https://publisher.com/next.xml']);
  await wait(70);
  assert.equal(lateCancelled, true);
});

test('courtesy pacing is in the deadline and cannot dispatch after an abort', { timeout: 1500 }, async () => {
  let calls = 0;
  const transport = createDocumentTransport({ timeoutMs: 80, hostDelayMs: 500,
    fetchImpl: async () => { calls++; return xml('<urlset/>'); } });
  assert.equal((await transport.fetchText(URL)).ok, true);
  const result = await transport.fetchText('https://publisher.com/other.xml');
  assert.equal(result.reason, 'timeout');
  assert.equal(calls, 1);
});

test('a caller cancellation covers body consumption rather than only response headers', { timeout: 1500 }, async () => {
  let cancelled = false;
  const owner = new AbortController();
  const transport = createDocumentTransport({ hostDelayMs: 0, fetchImpl: async () => {
    setTimeout(() => owner.abort(), 20);
    return xml(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  const result = await transport.fetchText(URL, { signal: owner.signal });
  assert.equal(result.reason, 'timeout');
  assert.equal(cancelled, true);
});

test('an expired owner deadline or already-cancelled signal dispatches nothing', async () => {
  let calls = 0;
  const transport = createDocumentTransport({ hostDelayMs: 0, fetchImpl: async () => { calls++; return xml(''); } });
  const owner = new AbortController(); owner.abort();
  assert.equal((await transport.fetchText(URL, { signal: owner.signal })).reason, 'timeout');
  assert.equal((await transport.fetchText(URL, { deadlineAt: Date.now() - 1 })).reason, 'timeout');
  assert.equal(calls, 0);
});

test('document transports must return actual manual-hop status and URL', async () => {
  let cancelled = false;
  const response = xml(new ReadableStream({ cancel() { cancelled = true; } }));
  Object.defineProperty(response, 'url', { value: 'https://other-publisher.com/private' });
  const result = await createDocumentTransport({ hostDelayMs: 0, fetchImpl: async () => response }).fetchText(URL);
  assert.equal(result.reason, 'transport_followed_redirect');
  assert.equal(cancelled, true);
});

test('malformed or unsafe redirect locations remain an explicit refusal', async () => {
  for (const location of ['http://[invalid', 'http://127.0.0.1/private']) {
    const result = await createDocumentTransport({ hostDelayMs: 0,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }).fetchText(URL);
    assert.equal(result.reason, 'unsafe_or_missing_redirect');
  }
});

test('a challenge is not accepted as a sitemap, even with a success status', async () => {
  const result = await createDocumentTransport({ hostDelayMs: 0,
    fetchImpl: async () => xml('<urlset/>', { 'cf-mitigated': 'challenge' }) }).fetchText(URL);
  assert.equal(result.reason, 'access_challenge');
});

test('gzip decompression has a bounded expanded stream and retains legacy failure reasons', async () => {
  const inflated = '<urlset>' + 'x'.repeat(100_000) + '</urlset>';
  const compressed = gzipSync(Buffer.from(inflated));
  assert.ok(compressed.length < 1024);
  const result = await createDocumentTransport({ maxBytes: 1024, hostDelayMs: 0,
    fetchImpl: async () => xml(compressed) }).fetchText(URL);
  assert.equal(result.reason, 'sitemap_too_large');
  await assert.rejects(inflateGzipBounded(compressed, 1024, new AbortController().signal), { reason: 'body_too_large' });
  const damaged = compressed.subarray(0, compressed.length - 4);
  const invalid = await createDocumentTransport({ hostDelayMs: 0,
    fetchImpl: async () => xml(damaged) }).fetchText(URL);
  assert.equal(invalid.reason, 'sitemap_gunzip_failed');
});

test('a complete gzip document reports consumed bytes and UTF-8 validation independently', async () => {
  const body = '<urlset/>', compressed = gzipSync(Buffer.from(body));
  const transport = createDocumentTransport({ hostDelayMs: 0, fetchImpl: async () => xml(compressed) });
  const result = await transport.fetchText(URL);
  assert.equal(result.ok, true);
  assert.equal(result.text, body);
  assert.equal(result.bytes, compressed.length);
  assert.equal(result.gzipped, true);
  const invalid = await createDocumentTransport({ hostDelayMs: 0,
    fetchImpl: async () => xml(gzipSync(new Uint8Array([0xff]))) }).fetchText(URL);
  assert.equal(invalid.reason, 'unsupported_or_invalid_encoding');
});

test('robots bootstrap applies its smaller cap without recursively fetching robots', async () => {
  const calls = [];
  const transport = createDocumentTransport({ hostDelayMs: 0, fetchImpl: async url => {
    calls.push(url);
    return new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'text/plain' } });
  } });
  const result = await transport.fetchText('https://publisher.com/robots.txt', { purpose: 'robots' });
  assert.equal(result.reason, 'body_too_large');
  assert.deepEqual(calls, ['https://publisher.com/robots.txt']);
});

test('robots bootstrap refuses an HTML replacement', async () => {
  const result = await createDocumentTransport({ hostDelayMs: 0,
    fetchImpl: async () => new Response('<html>Challenge</html>', { headers: { 'content-type': 'text/html' } }) })
    .fetchText('https://publisher.com/robots.txt', { purpose: 'robots' });
  assert.equal(result.reason, 'robots_not_plain_text');
});
