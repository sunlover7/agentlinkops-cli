import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

// DP-0026-T03: the CLI gains the deferred `linktrail context` dispatch (DP-0017 T02/T03's
// recorded follow-up: "one USAGE line plus one dispatch arm"). The arm must work without a
// ledger (context owns its config), must pass flags through positionally, and must not change
// any other command's behavior.

const manual = ['# Target pages', '', '- https://example.com/guide', '', '# Site description', '', 'A probate guide site.', ''].join('\n');
const window = { start: '2026-08-15', end: '2026-09-11', days: 28 };
const gscRow = {
  kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', window,
  type: 'web', aggregationType: 'byPage', dataState: 'final', clicks: 12, impressions: 340,
  position: 8.4, rows_returned: 1, truncated: false, retrieved_by: 'customer-harness',
  captured_at: '2026-09-10T18:22:00Z', fetched_at: '2026-09-12T10:04:00Z',
};

async function repo(t, { ledger = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-cli-ctx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.linktrail', 'context'), { recursive: true });
  if (ledger) await writeFile(join(dir, '.linktrail', 'links.jsonl'), '', 'utf8');
  await writeFile(join(dir, '.linktrail', 'config.json'), JSON.stringify({ project: { id: 'p_ctx', domain: 'example.com' } }), 'utf8');
  await writeFile(join(dir, '.linktrail', 'context', 'manual.md'), manual, 'utf8');
  await writeFile(join(dir, '.linktrail', 'context', 'gsc.jsonl'), `${JSON.stringify(gscRow)}\n`, 'utf8');
  return dir;
}

const run = (dir, argv, { signal } = {}) => {
  const lines = [];
  const errors = [];
  const main = import('../cli/main.js').then(m => m.main);
  return main.then(m => m(argv, { cwd: dir, signal, out: line => lines.push(String(line)), err: line => errors.push(String(line)) })
    .then(code => ({ code, lines, errors })));
};

test('`linktrail context …` dispatches through main, with no ledger required', async t => {
  const dir = await repo(t, { ledger: false });
  const status = await run(dir, ['context', 'status']);
  assert.equal(status.code, 0);
  assert.ok(status.lines.some(line => line.includes('connection grant: none')));
  assert.ok(status.lines.some(line => line.includes('gsc rows: 1')));
});

test('the dispatch passes the subcommand surface through intact, flags before or after the command word', async t => {
  const dir = await repo(t);
  const page = await run(dir, ['context', 'gsc', 'page', 'https://example.com/guide', '--start', '2026-08-15', '--end', '2026-09-11']);
  assert.equal(page.code, 0);
  assert.ok(page.lines.some(line => line.includes('state: ok')));
  assert.ok(page.lines.some(line => line.includes('clicks 12')));
  // Flags after the subcommand pass through to contextMain's own parser. (A flag directly
  // before a bare word eats it as its value in BOTH parsers — `--json status` parses as
  // json="status" — which is the pre-existing CLI convention, not something the context arm
  // changes.)
  const flagged = await run(dir, ['context', 'status', '--json']);
  assert.equal(flagged.code, 0);
  assert.ok(flagged.lines.some(line => line.includes('"gsc_rows": 1')));
});

test('USAGE advertises the context surface and the usage contract is unchanged elsewhere', async t => {
  const dir = await repo(t);
  const help = await run(dir, ['help']);
  assert.equal(help.code, 0);
  assert.ok(help.lines.some(line => line.includes('agentlinkops context')));
  const contextHelp = await run(dir, ['context']);
  assert.equal(contextHelp.code, 0);
  assert.ok(contextHelp.lines.some(line => line.includes('agentlinkops context gsc refresh')));
  const unknown = await run(dir, ['context', 'no-such-area']);
  assert.equal(unknown.code, 2);
  const stillUnknown = await run(dir, ['no-such-command']);
  assert.equal(stillUnknown.code, 2);
  assert.ok(stillUnknown.errors.some(line => line.includes('unknown command')));
});

test('default profile dispatch qualifies Node documents and pages, keeping gzip, robots, pacing and safe facts', { timeout: 25_000 }, async t => {
  // Only the physical DNS/socket boundary is synthetic. Dispatch, document
  // reading, gzip, robots, sitemap selection and page extraction are real.
  const dir = await repo(t, { ledger: false });
  const address = '93.184.215.14', seen = [];
  const origin = 'https://example.com';
  const page = title => `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>A detailed public guide to probate, estate administration and practical records that families need during settlement.</p><a href="https://nolo.com/guide">Probate guide</a></body></html>`;
  const robots = `User-agent: *\nDisallow: /blocked\nSitemap: ${origin}/sitemap.xml\n`;
  const routes = new Map([
    [`${origin}/robots.txt`, { body: robots, type: 'text/plain' }],
    [`${origin}/sitemap.xml`, { status: 302, headers: { location: '/map.xml.gz' } }],
    [`${origin}/map.xml.gz`, { body: gzipSync(Buffer.from(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/guide</loc></url></urlset>`)), type: 'application/gzip' }],
    [`${origin}/guide`, { body: page('Probate guide'), type: 'text/html; charset=utf-8' }],
    [`${origin}/`, { body: page('Estate home'), type: 'text/html; charset=utf-8' }],
  ]);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('profile must use the qualified Node connector'));
  t.mock.method(dns, 'lookup', async (host, options) => {
    assert.equal(host, 'example.com'); assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address, family: 4 }];
  });
  const request = (options, callback) => {
    assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false);
    assert.equal(options.servername, 'example.com'); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.equal(options.headers.Cookie, undefined);
    options.lookup(options.hostname, {}, (error, pinned, family) => {
      assert.equal(error, null); assert.equal(pinned, address); assert.equal(family, 4);
    });
    const outgoing = new EventEmitter();
    outgoing.destroy = () => { outgoing.destroyed = true; };
    outgoing.end = () => queueMicrotask(() => {
      if (outgoing.destroyed) return;
      const socket = new EventEmitter(); socket.remoteAddress = address;
      outgoing.emit('socket', socket); socket.emit('connect');
      if (outgoing.destroyed) return;
      const url = `${options.protocol}//${options.hostname}${options.path}`;
      seen.push({ url, at: Date.now() });
      const route = routes.get(url);
      if (!route) { outgoing.emit('error', new Error('Unexpected fixture destination')); return; }
      const body = Readable.from([Buffer.from(route.body ?? '')]);
      Object.assign(body, { statusCode: route.status ?? 200, headers: { 'content-type': route.type ?? 'text/plain', ...route.headers }, complete: true, socket });
      callback(body);
    });
    return outgoing;
  };
  t.mock.method(http, 'request', request); t.mock.method(https, 'request', request);
  const result = await run(dir, ['context', 'profile', 'build', '--page', `${origin}/blocked`, '--json']);
  assert.equal(result.code, 0, result.errors.join('\n'));
  const profile = JSON.parse(result.lines.join('\n'));
  assert.equal(profile.robots.outcome, 'fetched');
  assert.equal(profile.sitemaps.documents, 1); assert.equal(profile.sitemaps.urls_found, 1);
  assert.deepEqual(profile.sitemaps.failures, {});
  assert.equal(profile.limits.sitemap_documents, 3); assert.equal(profile.limits.selected_pages, 10);
  assert.equal(profile.pages.find(row => row.url === `${origin}/guide`).title, 'Probate guide');
  assert.equal(profile.pages.find(row => row.url === `${origin}/guide`).in_sitemap, true);
  const blocked = profile.pages.find(row => row.url === `${origin}/blocked`);
  assert.equal(blocked.outcome, 'blocked'); assert.equal(blocked.reason, 'robots_disallowed');
  assert.equal(seen.some(row => row.url.endsWith('/blocked')), false);
  assert.ok(seen[1].at - seen[0].at >= 1_800, 'document courtesy floor remains in force');
  assert.ok(seen[2].at - seen[1].at >= 1_800, 'a sitemap redirect also consumes the courtesy floor');
  assert.equal(seen.filter(row => row.url.endsWith('/robots.txt')).length, 4, 'each page keeps the canonical robots check');
  const facts = (await readFile(join(dir, '.linktrail/context/site-facts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(facts.find(row => row.kind === 'site.sitemap').gzipped, true);
  assert.equal(facts.find(row => row.url === `${origin}/guide` && row.kind === 'site.page').link_counts.total, 1);
  assert.equal(facts.some(row => Object.hasOwn(row, 'html') || Object.hasOwn(row, 'body')), false);
  assert.equal((await readFile(join(dir, '.linktrail/context/site-facts.jsonl'), 'utf8')).includes('<html>'), false);
  for (const row of profile.pages) {
    assert.equal(row.acquisition.purpose, 'research');
    assert.equal(row.acquisition.selectedMethod, 'node_http');
    assert.equal(row.acquisition.attempts[0].method, 'node_http');
    assert.equal(row.acquisition.attempts.length, 1);
    assert.equal(row.acquisition.routes.some(route => route.method === 'workers_http'), false);
    assert.ok(row.acquisition.routes.filter(route => route.method === 'node_browser' || route.method === 'proxy_http').every(route => route.admitted === false));
  }
});

test('packaged main forwards profile cancellation through DNS and prevents later document or page requests', { timeout: 1_500 }, async t => {
  const dir = await repo(t, { ledger: false }), owner = new AbortController();
  let started, lookups = 0;
  const dnsStarted = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('profile cannot use global fetch'));
  t.mock.method(http, 'request', () => assert.fail('cancelled DNS cannot open an HTTP socket'));
  t.mock.method(https, 'request', () => assert.fail('cancelled DNS cannot open an HTTPS socket'));
  t.mock.method(dns, 'lookup', (host, options) => {
    assert.equal(host, 'example.com'); assert.deepEqual(options, { all: true, verbatim: true });
    lookups++; started(); return new Promise(() => {});
  });
  const pending = run(dir, ['context', 'profile', 'build', '--json'], { signal: owner.signal });
  await dnsStarted; owner.abort();
  const dispatched = await pending;
  assert.equal(dispatched.code, 0, dispatched.errors.join('\n'));
  const profile = JSON.parse(dispatched.lines.join('\n'));
  assert.equal(profile.robots.outcome, 'unreadable'); assert.equal(profile.robots.reason, 'timeout');
  assert.equal(profile.sitemaps.documents, 0); assert.equal(lookups, 1);
  assert.equal(profile.pages.length, 2);
  assert.ok(profile.pages.every(page => page.outcome === 'unavailable' && page.reason === 'timeout' && page.title === null));
});
