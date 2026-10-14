import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReadiness } from '../src/verifier/readiness.js';
import { parseDocument } from '../src/verifier/parser.js';
import { hasRedirectWrapperToTarget } from '../src/verifier/url.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkToFile, validateLocalResult } from '../cli/local-result.js';
import { main } from '../cli/main.js';
import { loadConfig } from '../cli/config.js';
import { readObservations } from '../cli/mirror.js';

const targetUrl = 'https://customer.com/';
const assess = (html) => assessReadiness({ html, parsed: parseDocument(html, 'https://example.org/profile'), targetUrl });

test('navigation does not make an empty hydrated application conclusive', () => {
  const result = assess('<head><script src="/app.js"></script></head><body><nav><a href="/">Home</a></nav><div id="__next"></div></body>');
  assert.equal(result.requiresRender, true);
  assert.equal(result.reason, 'empty_application_root');
});

test('profile data in script and an empty profile container require rendering', () => {
  const html = `<nav><a href="/">Home</a></nav><div id="profile"></div><script>window.profile={website:"${targetUrl}"};</script>`;
  const result = assess(html);
  assert.equal(result.reason, 'profile_target_in_script_only');
  assert.equal(parseDocument(html, 'https://example.org/').links.some((link) => link.targetUrl === targetUrl), false);
});

test('an inline URL example does not invalidate a static article', () => {
  const result = assess(`<article>This is a complete public article with readable content and no backlink.</article><script>const example="${targetUrl}";</script>`);
  assert.equal(result.targetInScript, true);
  assert.equal(result.requiresRender, false);
});

test('populated SSR application roots remain conclusive', () => {
  const result = assess('<div id="root"><main><h1>My profile</h1><p>Writer and photographer.</p></main></div><script src="/hydrate.js"></script>');
  assert.equal(result.requiresRender, false);
});

test('a root containing only navigation still requires rendering', () => {
  assert.equal(assess('<div id="app"><nav><a href="/">Home</a></nav></div><script src="/app.js"></script>').requiresRender, true);
});

test('populated nested roots contribute content to their containing application', () => {
  assert.equal(assess('<div id="app"><div id="profile">My biography</div></div><script src="/app.js"></script>').requiresRender, false);
});

test('an empty optional app widget beside substantive content is not a page shell', () => {
  assert.equal(assess('<article>This is a complete public article with readable content and no backlink.</article><div id="app"></div><script src="/widget.js"></script>').requiresRender, false);
});

test('explicitly hidden password widgets do not establish a login wall', () => {
  for (const attributes of ['hidden', 'style="display: none !important"', 'style="visibility:hidden"']) {
    const result = assess(`<div ${attributes}><input type="password"></div>`);
    assert.equal(result.hasVisiblePassword, false);
    assert.equal(result.possibleLoginWall, false);
  }
  assert.equal(assess('<dialog><input type="password"></dialog>').possibleLoginWall, false);
});

test('visible password form gating the page remains a possible login wall', () => {
  assert.equal(assess('<h1>Sign in</h1><form><label>Password<input type="password"></label><button>Log in</button></form>').possibleLoginWall, true);
});

test('visible optional login widget does not gate a substantive public article', () => {
  assert.equal(assess('<article>This is a complete public article with readable content and no backlink.</article><form><input type="password"></form>').possibleLoginWall, false);
});

test('template password fields are inert, ARIA alone does not establish visual hiding', () => {
  assert.equal(assess('<template><input type="password"></template>').possibleLoginWall, false);
  assert.equal(assess('<div aria-hidden="true"><input type="password"></div>').possibleLoginWall, true);
});

test('ordinary script-bearing static HTML is conclusive', () => {
  assert.equal(assess('<p>A short static message.</p><script src="/analytics.js"></script>').requiresRender, false);
});

test('size and parser complexity limits return an inconclusive readiness result', () => {
  assert.deepEqual(assessReadiness({ html: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    { requiresRender: true, reason: 'readiness_limit_exceeded', possibleLoginWall: false });
  assert.equal(assessReadiness({ html: '<div></div>'.repeat(25_001) }).reason, 'readiness_limit_exceeded');
});

test('a populated profile cannot prove absence when its target exists only in hydration data', () => {
  const html = `<div id="profile"><h1>Publisher profile</h1><p>${'Public biography and unrelated navigation text. '.repeat(4)}</p></div>
    <script type="application/json">{"profile":{"website":"${targetUrl}"}}</script>`;
  const result = assess(html);
  assert.equal(result.reason, 'application_target_in_hydration_only');
  assert.equal(result.requiresRender, true);
  assert.equal(result.targetInScript, true);
  assert.equal(Object.hasOwn(result, 'targetInHydrationData'), false);
  assert.equal(parseDocument(html, 'https://publisher.com/profile').links.length, 0);
});

test('relay and Svelte hydration hints survive unrelated shell text and encoded payloads', () => {
  for (const html of [
    `<div data-reactcontainer="true"><main>${'Log in or create an account to continue. '.repeat(4)}</main></div>
      <script data-relay-completed-request="true">register(${JSON.stringify(encodeURIComponent(JSON.stringify({ website: targetUrl })))})</script>`,
    `<div data-reactcontainer="true"><main>${'Log in or create an account to continue. '.repeat(4)}</main></div>
      <div hidden><script data-relay-completed-request="true">register(${JSON.stringify(encodeURIComponent(JSON.stringify({ website: targetUrl })))})</script></div>`,
    `<body data-sveltekit-preload-data="hover"><div>${'Created with this application. '.repeat(4)}</div>
      <script>const __sveltekit_fixture={data:{website:${JSON.stringify(targetUrl)}}};</script></body>`,
  ]) {
    const result = assess(html);
    assert.equal(result.reason, 'application_target_in_hydration_only');
    assert.equal(result.requiresRender, true);
  }
});

test('a structured profile wrapper is not substantive editorial evidence of a finished page', () => {
  const html = `<div id="app"><article itemtype="https://schema.org/MusicGroup">
    ${'Your browser is not supported. Please update it and try again. '.repeat(3)}</article></div>
    <script>window.__profile_hydration=[{website:${JSON.stringify(targetUrl)}}];</script>`;
  assert.equal(assess(html).reason, 'application_target_in_hydration_only');
});

test('an empty application with a failed-loading fallback remains unfinished despite long fallback copy', () => {
  const html = `<div id="app"></div><div><h1>Still loading...</h1><p>We had trouble loading this board.</p>
    <p>${'Reload this page or check your network connection. '.repeat(4)}</p></div><script src="/application.js"></script>`;
  assert.equal(assess(html).reason, 'application_content_unfinished');
  assert.equal(assess(html).requiresRender, true);
});

test('failed-loading fallback inside an application is unfinished regardless of help-copy length', () => {
  const html = `<div id="app"><h1>Still loading...</h1><p>We had trouble loading this board.</p>
    <p>${'Reload this page or check your network connection. '.repeat(4)}</p></div><script src="/application.js"></script>`;
  assert.equal(assess(html).reason, 'application_content_unfinished');
  assert.equal(assess(html).requiresRender, true);
});

test('an explicitly busy application is unfinished even with a populated shell', () => {
  const html = `<div id="app" aria-busy="true">${'Profile header and unrelated controls. '.repeat(4)}</div><script src="/application.js"></script>`;
  assert.equal(assess(html).reason, 'application_content_unfinished');
});

test('static articles, metadata, visible plain URLs and inline examples remain conclusive', () => {
  for (const html of [
    `<div id="app"><article itemtype="https://schema.org/BlogPosting">${'A complete editorial explanation with useful reader-facing prose. '.repeat(3)}</article></div>
      <script type="application/json">{"example":${JSON.stringify(targetUrl)}}</script>`,
    `<div id="app"><p>${'A populated public profile without an external website field. '.repeat(3)}</p></div>
      <script type="application/ld+json">{"url":${JSON.stringify(targetUrl)}}</script>`,
    `<div id="profile"><p>Website: ${targetUrl}</p></div><script type="application/json">{"website":${JSON.stringify(targetUrl)}}</script>`,
    `<div id="app"><p>${'An ordinary populated SSR profile. '.repeat(4)}</p></div><script>const example=${JSON.stringify(targetUrl)};</script>`,
    '<article>A useful tutorial explains why a failed request might show Still loading...</article><div id="app"></div><script src="/optional-widget.js"></script>',
  ]) assert.equal(assess(html).requiresRender, false);
});

test('hidden loading notices and inert hydration payloads do not make populated SSR unfinished', () => {
  const html = `<div id="app"><p>${'A finished public profile with substantive content. '.repeat(3)}</p>
    <div hidden>Still loading...</div><template><script type="application/json">{"website":${JSON.stringify(targetUrl)}}</script></template></div>
    <script src="/analytics.js"></script>`;
  assert.equal(assess(html).requiresRender, false);
});

const physicalLinks = html => parseDocument(html, 'https://publisher.com/profile').links;
const wrapper = (value, key = 'url') => `https://gate.sc/?${key}=${encodeURIComponent(value)}&token=WRAPPER-TEST-MARKER`;
const wrapperAnchor = (value, key = 'url') => `<a href="${wrapper(value, key).replace(/&/gu, '&amp;')}" rel="me nofollow ugc">Website</a>`;

test('redirect wrapper hint accepts only recognized once-decoded full public URL parameters', () => {
  for (const key of ['url', 'redirect_url', 'redirect_uri', 'destination', 'target']) {
    assert.equal(hasRedirectWrapperToTarget(physicalLinks(wrapperAnchor(targetUrl, key)), targetUrl, 'exact'), true, key);
  }
  for (const [key, value] of [
    ['q', targetUrl], ['to', targetUrl], ['URL', targetUrl],
    ['url', encodeURIComponent(targetUrl)], ['url', `Look at ${targetUrl}`],
    ['url', wrapper(targetUrl)], ['url', `https://customer.com.evil.com/`],
    ['url', 'https://user:pass@customer.com/'], ['url', 'http://127.0.0.1/'],
    ['url', 'https://customer.local/'], ['url', 'https://customer.com:8080/'],
    ['url', '//customer.com/'], ['url', '/customer.com/'], ['url', 'javascript:alert(1)'],
  ]) assert.equal(hasRedirectWrapperToTarget(physicalLinks(wrapperAnchor(value, key)), targetUrl, 'exact'), false, key);
  assert.equal(hasRedirectWrapperToTarget([{ targetUrl: `http://127.0.0.1/?url=${encodeURIComponent(targetUrl)}` }], targetUrl), false);
  assert.equal(hasRedirectWrapperToTarget([{ targetUrl: `https://gate.sc/?url=${encodeURIComponent(targetUrl)}&x=${'x'.repeat(8192)}` }], targetUrl), false);
  assert.equal(hasRedirectWrapperToTarget([], targetUrl), false);
  assert.equal(hasRedirectWrapperToTarget(physicalLinks(wrapperAnchor(targetUrl)), 'http://127.0.0.1/'), false);
});

test('redirect wrapper hint reuses declared scope, including path boundaries and exact queries', () => {
  const wanted = 'https://customer.com/guide?kind=1';
  for (const [scope, destination, matches] of [
    ['exact', `${wanted}#part`, true], ['exact', 'https://customer.com/guide?kind=2', false],
    ['exact', 'http://customer.com/guide?kind=1', false],
    ['domain', 'https://blog.customer.com/other', true], ['domain', 'https://customer.com.evil.com/guide', false],
    ['subdomain', 'https://customer.com/other', true], ['subdomain', 'https://blog.customer.com/guide', false],
    ['path', 'https://customer.com/guide/child?kind=1', true], ['path', 'https://customer.com/guidebook?kind=1', false],
    ['path', 'https://customer.com/guide/child?kind=2', false], ['path', 'http://customer.com/guide/child?kind=1', false],
  ]) assert.equal(hasRedirectWrapperToTarget(physicalLinks(wrapperAnchor(destination)), wanted, scope), matches, scope);
});

test('redirect wrapper hint scans duplicate and late parameters without reading inert or text payloads', () => {
  const duplicated = `<a href="https://gate.sc/?url=https%3A%2F%2Felsewhere.com%2F&amp;url=${encodeURIComponent(targetUrl)}">Website</a>`;
  assert.equal(hasRedirectWrapperToTarget(physicalLinks(duplicated), targetUrl), true);
  const late = `<a href="https://gate.sc/?${'x=1&amp;'.repeat(500)}url=${encodeURIComponent(targetUrl)}">Website</a>`;
  assert.equal(hasRedirectWrapperToTarget(physicalLinks(late), targetUrl), true, 'no first-N parameter cutoff within the valid URL bound');
  const escapedName = `<a href="https://gate.sc/?%75rl=${encodeURIComponent(targetUrl)}">Website</a>`;
  assert.equal(hasRedirectWrapperToTarget(physicalLinks(escapedName), targetUrl), true);
  const ordinary = `<article><p>${wrapper(targetUrl)}</p></article><script type="application/json">{"href":"${wrapper(targetUrl)}"}</script>
    <template>${wrapperAnchor(targetUrl)}</template><a href="https://elsewhere.com/" data-url="${targetUrl}">Other</a>`;
  assert.equal(hasRedirectWrapperToTarget(physicalLinks(ordinary), targetUrl), false);
});

test('default Node wrapper check preserves unknown through output, validation and idempotent adoption without tokens or extra requests', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'alo-wrapper-result-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const address = '93.184.215.14', source = 'https://publisher.com/profile', requested = [];
  const html = `<!doctype html><html><body><article><p>A complete public profile describes its work and supplies a website through a third-party redirect service.</p>${wrapperAnchor(targetUrl)}</article></body></html>`;
  t.mock.method(globalThis, 'fetch', async () => assert.fail('portable check must use the Node connector'));
  t.mock.method(http, 'request', () => assert.fail('unexpected plain HTTP request'));
  t.mock.method(dns, 'lookup', async (host, options) => {
    assert.equal(host, 'publisher.com', 'the wrapper and destination are never resolved');
    assert.deepEqual(options, { all: true, verbatim: true }); return [{ address, family: 4 }];
  });
  t.mock.method(https, 'request', (options, callback) => {
    assert.equal(options.hostname, 'publisher.com'); assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, 'publisher.com');
    options.lookup(options.hostname, {}, (error, pinned, family) => {
      assert.equal(error, null); assert.equal(pinned, address); assert.equal(family, 4);
    });
    const request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const socket = new EventEmitter(); socket.remoteAddress = address;
      request.emit('socket', socket); socket.emit('connect');
      if (request.destroyed) return;
      requested.push(options.path); const robots = options.path === '/robots.txt';
      assert.ok(robots || options.path === '/profile');
      const response = Readable.from([Buffer.from(robots ? '' : html)]);
      Object.assign(response, { statusCode: robots ? 404 : 200, headers: { 'content-type': robots ? 'text/plain' : 'text/html; charset=utf-8' }, complete: true, socket });
      callback(response);
    });
    return request;
  });
  const path = join(cwd, 'wrapper.json');
  const result = await checkToFile({ source, target: targetUrl, scope: 'exact' }, path, { hostDelayMs: 0 });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved, JSON.parse(JSON.stringify(result))); assert.equal(validateLocalResult(saved).result_id, result.result_id);
  assert.equal(saved.observation.state, 'unknown'); assert.equal(saved.observation.reason, 'target_in_redirect_parameter');
  assert.equal(saved.observation.evidence.complete, false); assert.deepEqual(saved.observation.occurrences, []);
  assert.equal(saved.observation.evidence.capture.body.complete, true, 'reading a complete body does not prove a complete link check');
  assert.equal(saved.observation.evidence.capture.transport.id, 'local_node_http');
  assert.equal(saved.observation.evidence.html, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /WRAPPER-TEST-MARKER|gate\.sc|token=|sampleText/);
  const invoke = args => main(args, { cwd, out: () => {}, err: line => assert.fail(line) });
  assert.equal(await invoke(['init']), 0);
  assert.equal(await invoke(['adopt-result', 'wrapper.json']), 0);
  assert.equal(await invoke(['adopt-result', 'wrapper.json']), 0);
  const config = await loadConfig({ cwd }), rows = await readObservations(config.paths.observations);
  assert.equal(rows.problems.length, 0); assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].state, 'unknown'); assert.equal(rows.rows[0].result.evidence.complete, false);
  assert.equal(rows.rows[0].result.reason, 'target_in_redirect_parameter');
  assert.deepEqual(requested, ['/robots.txt', '/profile'], 'readback and adoption never follow a wrapper or fetch again');
});
