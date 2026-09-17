import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCheck, checkToFile, adoptLocalResult, validateLocalResult } from '../cli/local-result.js';
import { main } from '../cli/main.js';
import { loadConfig } from '../cli/config.js';
import { readLedger } from '../cli/ledger.js';
import { readObservations } from '../cli/mirror.js';
import { readState } from '../cli/state.js';
import { verifyLink } from '../src/verifier/index.js';
import { CASES, TARGET } from './fixtures/verifier-cases.js';

const input = { source: 'https://publisher.example.com/resources', target: 'https://example.com/guide', scope: 'exact' };
const fixture = (body = '<!doctype html><html><body><a href="https://example.com/guide">Guide</a></body></html>', status = 200) => async url =>
  new URL(url).pathname === '/robots.txt' ? new Response('', { status: 404 }) : new Response(body, { status, headers: { 'content-type': 'text/html' } });
const options = { hostDelayMs: 0, verify: (input, options) => verifyLink(input, { ...options, fetchImpl: fixture(), now: '2026-09-10T12:00:00Z' }) };
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'local-result-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const cli = async (cwd, args) => { const out = [], err = []; const code = await main(args, { cwd, out: v => out.push(v), err: v => err.push(v) }); return { code, out, err }; };

test('portable check uses shared verifier cases and preserves raw states without HTML', async () => {
  for (const scenario of CASES) {
    const fetchImpl = fixture(scenario.html);
    const checked = await localCheck({ ...input, target: TARGET, scope: scenario.input?.targetScope ?? 'exact' }, {
      hostDelayMs: 0, verify: (value, options) => verifyLink(value, { ...options, fetchImpl, now: '2026-09-10T12:00:00Z' }),
    });
    const direct = await verifyLink({ sourceUrl: input.source, targetUrl: TARGET, targetScope: scenario.input?.targetScope ?? 'exact' }, { publicFetchSafe: true, includeHtml: false, fetchImpl, now: '2026-09-10T12:00:00Z', beforeFetch: async () => {} });
    assert.deepEqual(checked.observation, direct, scenario.name);
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
  assert.deepEqual(await readdir(cwd), ['result.json']);
});

test('main runs before config/ledger lookup and rejects half inputs and unsafe URLs', async t => {
  const cwd = await directory(t);
  for (const args of [['check','--source',input.source], ['check','--target',input.target], ['check','--source','http://127.0.0.1/','--target',input.target], ['check','--source',input.source,'--target',input.target,'--tag','bad'], ['check','--source',input.source,'--target',input.target,'--out=']]) {
    assert.equal((await cli(cwd, args)).code, 2);
  }
  const old = globalThis.fetch; globalThis.fetch = fixture(); t.after(() => { globalThis.fetch = old; });
  const result = await cli(cwd, ['check', `--source=${input.source}`, `--target=${input.target}`, '--json', '--out=result.json']);
  assert.equal(result.code, 0, result.err.join('\n'));
  const saved = JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'));
  assert.deepEqual(JSON.parse(result.out[0]), saved);
  assert.equal(saved.observation.state, 'present');
  assert.deepEqual(await readdir(cwd), ['result.json'], 'no account, config, ledger or telemetry files');
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
