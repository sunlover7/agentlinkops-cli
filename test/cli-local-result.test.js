import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { localCheck, checkToFile, adoptLocalResult, validateLocalResult } from '../cli/local-result.js';
import { main } from '../cli/main.js';
import { loadConfig } from '../cli/config.js';
import { readLedger } from '../cli/ledger.js';
import { readObservations } from '../cli/mirror.js';
import { readState } from '../cli/state.js';
import { verifyLink } from '../src/verifier/index.js';
import { CASES, TARGET } from './fixtures/verifier-cases.js';
import { portableCheckObservation } from '../cli/check.js';

const input = { source: 'https://publisher.example.com/resources', target: 'https://example.com/guide', scope: 'exact' };
const fixture = (body = '<!doctype html><html><body><a href="https://example.com/guide">Guide</a></body></html>', status = 200) => async url =>
  new URL(url).pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response(body, { status, headers: { 'content-type': 'text/html' } });
const options = { hostDelayMs: 0, verify: (input, options) => verifyLink(input, { ...options, fetchImpl: fixture(), now: '2026-09-10T12:00:00Z' }) };
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'local-result-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const cli = async (cwd, args) => { const out = [], err = []; const code = await main(args, { cwd, out: v => out.push(v), err: v => err.push(v) }); return { code, out, err }; };
function mockPublicPage(t, body = '<html><body><a href="https://example.com/guide">Guide</a></body></html>') {
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.215.14', family: 4 }]);
  return t.mock.method(https, 'request', (options, callback) => {
    const request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const socket = new EventEmitter(); socket.remoteAddress = '93.184.215.14';
      request.emit('socket', socket); socket.emit('connect');
      if (request.destroyed) return;
      const robots = options.path === '/robots.txt';
      const response = Readable.from([Buffer.from(robots ? '<html>PRIVATE-ROBOTS-PREFIX</html>' : body)]);
      Object.assign(response, { statusCode: robots ? 404 : 200, headers: { 'content-type': 'text/html' }, complete: true, socket });
      callback(response);
    });
    return request;
  });
}

test('portable check uses shared verifier cases and preserves raw states without HTML', async () => {
  for (const scenario of CASES) {
    const fetchImpl = fixture(scenario.html);
    const checked = await localCheck({ ...input, target: TARGET, scope: scenario.input?.targetScope ?? 'exact' }, {
      hostDelayMs: 0, verify: (value, options) => verifyLink(value, { ...options, fetchImpl, now: '2026-09-10T12:00:00Z' }),
    });
    const direct = await verifyLink({ sourceUrl: input.source, targetUrl: TARGET, targetScope: scenario.input?.targetScope ?? 'exact' }, { publicFetchSafe: true, includeHtml: false, fetchImpl, now: '2026-09-10T12:00:00Z', beforeFetch: async () => {} });
    assert.deepEqual(checked.observation, portableCheckObservation(direct), scenario.name);
    assert.equal(validateLocalResult(checked).result_id, checked.result_id);
    assert.equal(checked.checked_at, direct.checkedAt);
    assert.match(checked.result_id, /^lr_[a-f0-9]{64}$/);
    assert.equal(checked.observation.evidence.html, undefined);
  }
});

test('source404 and blocked responses keep source_unavailable and unknown', async () => {
  for (const [status, expected] of [[404, 'source_unavailable'], [403, 'unknown']]) {
    const result = await localCheck(input, { hostDelayMs: 0, verify: (value, options) => verifyLink(value, { ...options, fetchImpl: fixture('', status) }) });
    assert.equal(result.observation.state, expected);
  }
});

test('exclusive output refuses an existing file before fetch; failed validation leaves no placeholder', async t => {
  const cwd = await directory(t), path = join(cwd, 'result.json');
  await writeFile(path, 'owner bytes');
  let fetched = false;
  await assert.rejects(checkToFile(input, path, { verify: async () => { fetched = true; } }), /EEXIST/);
  assert.equal(fetched, false); assert.equal(await readFile(path, 'utf8'), 'owner bytes');
  await assert.rejects(checkToFile({ ...input, source: 'http://127.0.0.1/' }, join(cwd, 'invalid.json')), /invalid source/);
  assert.deepEqual((await readdir(cwd)).filter(name => !name.startsWith('._')), ['result.json']);
});

test('main runs before config/ledger lookup and rejects half inputs and unsafe URLs', async t => {
  const cwd = await directory(t);
  for (const args of [['check','--source',input.source], ['check','--target',input.target], ['check','--source','http://127.0.0.1/','--target',input.target], ['check','--source',input.source,'--target',input.target,'--tag','bad'], ['check','--source',input.source,'--target',input.target,'--out=']]) {
    assert.equal((await cli(cwd, args)).code, 2);
  }
  mockPublicPage(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('the actual CLI uses its public Node connector'));
  const result = await cli(cwd, ['check', `--source=${input.source}`, `--target=${input.target}`, '--json', '--out=result.json']);
  assert.equal(result.code, 0, result.err.join('\n'));
  const saved = JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'));
  assert.deepEqual(JSON.parse(result.out[0]), saved);
  assert.equal(saved.observation.state, 'present');
  assert.equal(saved.observation.evidence.capture.transport.id, 'local_node_http');
  assert.equal(validateLocalResult(saved).result_id, saved.result_id);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-ROBOTS-PREFIX|sampleText|bodyBase64|workers_http/);
  assert.deepEqual((await readdir(cwd)).filter(name => !name.startsWith('._')), ['result.json'], 'no account, config, ledger or telemetry files');
});

test('complete local captures and independent Googlebot facts survive a real output/read/adopt round trip', async t => {
  const cwd = await directory(t);
  const requests = mockPublicPage(t, '<html><head><meta name="googlebot" content="noindex,nofollow"></head><body><a href="https://example.com/guide">Guide</a></body></html>');
  const checked = await cli(cwd, ['check', '--source', input.source, '--target', input.target, '--json', '--out=portable.json']);
  assert.equal(checked.code, 0, checked.err.join('\n'));
  const saved = JSON.parse(await readFile(join(cwd, 'portable.json'), 'utf8'));
  const capture = saved.observation.evidence.capture;
  assert.equal(capture.body.sha256, saved.observation.evidence.sha256);
  assert.equal(capture.body.decodedSha256, saved.observation.evidence.decodedSha256);
  assert.equal(capture.requestedUrl, input.source); assert.equal(capture.finalUrl, saved.observation.finalUrl);
  assert.equal(capture.body.bytes, saved.observation.evidence.bytes);
  assert.deepEqual(saved.observation.directives.googlebot, { noindex: true, nofollow: true });
  assert.equal(saved.observation.robots.googlebot.allowed, true, 'crawl permission is independent of noindex');
  const before = requests.mock.callCount();
  assert.equal((await cli(cwd, ['init'])).code, 0);
  assert.equal((await cli(cwd, ['adopt-result', 'portable.json'])).code, 0);
  assert.equal(requests.mock.callCount(), before, 'read/adopt does not fetch or run a model');
  const config = await loadConfig({ cwd });
  const rows = await readObservations(config.paths.observations);
  assert.deepEqual(rows.rows[0].result.evidence.capture, capture);
  assert.equal(rows.rows[0].source, 'local');
  assert.equal((await cli(cwd, ['adopt-result', 'portable.json'])).code, 0);
  assert.equal((await readObservations(config.paths.observations)).rows.length, 1);
});

for (const [name, body, reason] of [
  ['application shell', '<html><body><nav><a href="/help">Help</a></nav><div id="app"></div><script src="/application.js"></script></body></html>', 'possible_render_required'],
  ['client navigation', '<html><head><meta http-equiv="refresh" content="0;url=/continue"></head><body><p>Continue to the public page.</p></body></html>', 'navigation_requires_browser'],
]) test(`${name} survives the real local check, file read and adoption as unknown without render authority`, async t => {
  const cwd = await directory(t), path = join(cwd, 'unknown.json');
  const requests = mockPublicPage(t, body);
  t.mock.method(globalThis, 'fetch', () => assert.fail('the local check must use its pinned Node connector'));
  const checked = await checkToFile(input, path, { hostDelayMs: 0 });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved, checked);
  assert.equal(saved.observation.state, 'unknown');
  assert.equal(saved.observation.reason, reason);
  assert.equal(saved.observation.evidence.complete, false);
  assert.equal(saved.observation.evidence.renderEligibility, 'required');
  assert.deepEqual(saved.observation.evidence.renderAttempt, { attempted: false, reason: 'render_not_configured' });
  assert.equal(saved.observation.occurrences.length, 0);
  const capture = saved.observation.evidence.capture;
  assert.equal(capture.transport.id, 'local_node_http');
  assert.equal(capture.representation, 'raw_html');
  assert.equal(capture.body.complete, true, 'body completeness does not establish a complete link check');
  assert.equal(capture.body.sha256, saved.observation.evidence.sha256);
  assert.equal(capture.body.decodedSha256, saved.observation.evidence.decodedSha256);
  assert.equal(validateLocalResult(saved).result_id, saved.result_id);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-ROBOTS-PREFIX|sampleText|bodyBase64/);

  // A recomputed local checksum cannot grant rendering or exempt an unknown
  // observation from the same capture-to-observation binding as a present link.
  for (const change of [
    value => { value.observation.evidence.renderAttempt.attempted = true; },
    value => { value.observation.evidence.renderAttempt.reason = 'render_failed'; },
    value => { value.observation.evidence.renderAttempt.sessionId = 'invented-provider-session'; },
    value => { value.observation.evidence.renderEligibility = 'comparison'; },
    value => { value.observation.evidence.capture.body.sha256 = 'f'.repeat(64); },
    value => { value.observation.evidence.capture.finalUrl = 'http://127.0.0.1/'; },
    value => { value.observation.evidence.capture.representation = 'rendered_dom'; },
  ]) {
    const supplied = structuredClone(saved); change(supplied);
    supplied.result_id = `lr_${createHash('sha256').update(JSON.stringify({ input: supplied.input, observation: supplied.observation })).digest('hex')}`;
    assert.throws(() => validateLocalResult(supplied), undefined, change.toString());
  }

  const before = requests.mock.callCount();
  assert.equal((await cli(cwd, ['init'])).code, 0);
  assert.equal((await cli(cwd, ['adopt-result', 'unknown.json'])).code, 0);
  assert.equal(requests.mock.callCount(), before, 'adoption neither refetches nor launches rendering');
  const config = await loadConfig({ cwd }), rows = await readObservations(config.paths.observations);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].state, 'unknown');
  assert.equal(rows.rows[0].complete, false);
  assert.deepEqual(rows.rows[0].result, saved.observation);
  assert.equal((await cli(cwd, ['adopt-result', 'unknown.json'])).code, 0);
  assert.equal((await readObservations(config.paths.observations)).rows.length, 1);
});

test('adoption creates local intent and original observation once and preserves newer activity', async t => {
  const cwd = await directory(t); assert.equal((await cli(cwd, ['init'])).code, 0);
  const config = await loadConfig({ cwd }), result = await localCheck(input, options);
  const first = await adoptLocalResult(config, result, { intent: 'expected' });
  assert.equal(first.created, true);
  const rows = await readObservations(config.paths.observations);
  assert.equal(rows.rows.length, 1); assert.deepEqual(rows.rows[0].result, result.observation);
  assert.equal((await readState(config.paths.state)).entries[first.ledger_id].last_checked, result.checked_at);
  assert.equal((await adoptLocalResult(config, result)).observation_added, false);
  assert.equal((await readLedger(config.paths.ledger)).entries[0].intent, 'expected');
  const newer = await readState(config.paths.state); newer.entries[first.ledger_id].last_checked = '2026-09-12T12:00:00Z';
  await writeFile(config.paths.state, JSON.stringify(newer));
  const older = await localCheck(input, { ...options, verify: (value, options) => verifyLink(value, { ...options, fetchImpl: fixture(), now: '2026-09-09T12:00:00Z' }) });
  await adoptLocalResult(config, older);
  assert.deepEqual(await readState(config.paths.state), newer);
});

test('actual adopt-result command preserves matching ledger bytes and config; requires explicit adoption', async t => {
  const cwd = await directory(t); await cli(cwd, ['init']); const config = await loadConfig({ cwd });
  const custom = JSON.stringify({ project: { site: ['example.com'] }, cloud: { origin: 'https://private.example.com' }, paths: {}, defaults: { hostDelayMs: 3500 } });
  await writeFile(join(config.dir, 'config.json'), custom);
  const original = '// human note\n'+JSON.stringify({ id: 'lk_aaaa', intent: 'wanted', ...input, note: 'preserve my decision' })+'\n';
  await writeFile(config.paths.ledger, original);
  await writeFile(join(cwd, 'result.json'), JSON.stringify(await localCheck(input, options)));
  const result = await cli(cwd, ['adopt-result', 'result.json', '--intent=expected']);
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.equal(await readFile(config.paths.ledger, 'utf8'), original);
  assert.equal(await readFile(join(config.dir, 'config.json'), 'utf8'), custom);
  assert.equal(JSON.parse(result.out[0]).ledger_id, 'lk_aaaa');
  assert.equal((await cli(cwd, ['adopt-result', 'result.json'])).code, 0);
  assert.equal((await readObservations(config.paths.observations)).rows.length, 1);
});
