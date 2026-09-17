import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../cli/main.js';
import { loadConfig } from '../cli/config.js';
import { readLedger } from '../cli/ledger.js';
import { readObservations } from '../cli/mirror.js';
import { readState } from '../cli/state.js';
import { verifyLink } from '../src/verifier/index.js';
import { localCheck, checkToFile, validateLocalResult, adoptLocalResult } from '../cli/local-result.js';

const input = { source: 'https://publisher.example.com/article', target: 'https://customer.example.com/guide', scope: 'exact' };
const captured = '2026-09-13T12:00:00.000Z';
const fetchPage = async url => new URL(url).pathname === '/robots.txt'
  ? new Response('', { status: 404 })
  : new Response(`<html><body><p>Read our <a href="${input.target}">guide</a>.</p></body></html>`, { headers: { 'content-type': 'text/html' } });
const portable = () => localCheck(input, { hostDelayMs: 0,
  verify: (args, options) => verifyLink(args, { ...options, fetchImpl: fetchPage, now: captured }) });
const resign = result => { result.result_id = `lr_${createHash('sha256').update(JSON.stringify({ input: result.input, observation: result.observation })).digest('hex')}`; return result; };
async function run(cwd, args) {
  const out = [], err = [];
  const code = await main(args, { cwd, out: value => out.push(String(value)), err: value => err.push(String(value)) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
async function setup(t, initialize = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlinkops-portable-adversarial-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (initialize) assert.equal((await run(cwd, ['init'])).code, 0);
  return { cwd, config: await loadConfig({ root: cwd }) };
}

test('portable input with a recomputed checksum cannot smuggle HTML or contradictory presence evidence', async () => {
  const original = await portable();
  assert.equal(validateLocalResult(original).observation.state, 'present');
  const edits = [
    value => { value.observation.evidence.html = '<html>PRIVATE</html>'; },
    value => { value.observation.evidence.credentials = { access_token: 'private-token' }; },
    value => { value.observation.occurrences[0].metadata = { secret: 'private-token' }; },
    value => { value.observation.occurrences[0].rel = [{ token: 'private-token' }]; },
    value => { value.observation.occurrences[0].anchor = { token: 'private-token' }; },
    value => { value.observation.evidence.complete = false; value.observation.state = 'absent'; },
    value => { value.observation.occurrences = []; },
    value => { value.observation.targetUrl = 'https://other.example.com/'; },
    value => { value.observation.checkedAt = value.checked_at = '2026-02-30T12:00:00Z'; },
  ];
  for (const edit of edits) {
    const supplied = structuredClone(original); edit(supplied); resign(supplied);
    assert.throws(() => validateLocalResult(supplied), undefined, edit.toString());
  }
});

test('adoption replays after each multi-file crash without duplicate history or activity', async t => {
  for (const stage of ['ledger', 'observations', 'state']) {
    const { config } = await setup(t), result = await portable();
    let injected = false;
    await assert.rejects(adoptLocalResult(config, result, { afterWrite: async path => {
      if (path === config.paths[stage] && !injected) { injected = true; throw new Error(`crash after ${stage}`); }
    } }), /crash after/);
    assert.equal(injected, true, stage);
    await adoptLocalResult(config, result);
    const ledger = await readLedger(config.paths.ledger), observations = await readObservations(config.paths.observations);
    assert.equal(ledger.entries.length, 1, stage);
    assert.equal(observations.rows.length, 1, stage);
    const state = await readState(config.paths.state);
    assert.equal(state.entries[ledger.entries[0].id].checks, 1, stage);
    await adoptLocalResult(config, result);
    assert.equal((await readState(config.paths.state)).entries[ledger.entries[0].id].checks, 1, stage);
  }
});

test('journal recovery preserves manual changes and portable replay cannot claim a retargeted ledger entry', async t => {
  const { config } = await setup(t), result = await portable();
  await assert.rejects(adoptLocalResult(config, result, { afterWrite: async path => {
    if (path === config.paths.ledger) throw new Error('crash');
  } }), /crash/);
  const held = await readFile(config.paths.ledger, 'utf8');
  const edited = held + '// Human note added during recovery\n';
  await writeFile(config.paths.ledger, edited);
  await assert.rejects(adoptLocalResult(config, result), /recovery conflict/);
  assert.equal(await readFile(config.paths.ledger, 'utf8'), edited);
  await writeFile(config.paths.ledger, held);
  await adoptLocalResult(config, result);
  const { entries } = await readLedger(config.paths.ledger);
  entries[0].target = 'https://customer.example.com/changed';
  const retargeted = JSON.stringify(entries[0]) + '\n';
  await writeFile(config.paths.ledger, retargeted);
  await assert.rejects(adoptLocalResult(config, result), /current ledger placement/);
  assert.equal(await readFile(config.paths.ledger, 'utf8'), retargeted);
});

test('real CLI direct check requires no repository and adoption preserves existing cloud configuration', async t => {
  const { cwd } = await setup(t, false);
  const fetchMock = t.mock.method(globalThis, 'fetch', fetchPage);
  const direct = await run(cwd, ['check', '--source', input.source, '--target', input.target, '--json']);
  assert.equal(direct.code, 0, direct.err);
  const result = JSON.parse(direct.out);
  assert.equal(result.observation.state, 'present');
  assert.deepEqual(await readdir(cwd), [], 'direct result creates no repo state');
  const checkCalls = fetchMock.mock.callCount();
  assert.equal((await run(cwd, ['init'])).code, 0);
  const configPath = join(cwd, '.agentlinkops/config.json');
  const configured = JSON.stringify({ project: { id: 'project-kept' }, cloud: { origin: 'https://cloud.example.com', workspaceId: 'workspace-kept' }, paths: {}, defaults: { custom: true } }) + '\n';
  await writeFile(configPath, configured);
  const path = join(cwd, 'portable.json'); await writeFile(path, JSON.stringify(result));
  const adopted = await run(cwd, ['adopt-result', path]);
  assert.equal(adopted.code, 0, adopted.err);
  assert.equal(await readFile(configPath, 'utf8'), configured);
  assert.equal(fetchMock.mock.callCount(), checkCalls, 'initialization and adoption make no hosted or page requests');
});

test('existing portable output is refused before any verifier call', async t => {
  const { cwd } = await setup(t, false), path = join(cwd, 'existing.json');
  await writeFile(path, 'do not overwrite');
  let calls = 0;
  await assert.rejects(checkToFile(input, path, { verify: () => { calls++; throw new Error('must not fetch'); } }), /EEXIST/);
  assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), 'do not overwrite');
});

test('CLI adoption respects both history and ledger writer locks and releases its own lock on refusal', async t => {
  const { cwd, config } = await setup(t), result = await portable();
  const path = join(cwd, 'portable.json'); await writeFile(path, JSON.stringify(result));
  const historyLock = join(config.dir, 'sync.lock'), ledgerLock = `${config.paths.ledger}.lock`;
  await writeFile(historyLock, 'other history writer');
  assert.equal((await run(cwd, ['adopt-result', path])).code, 2);
  assert.equal(await readFile(historyLock, 'utf8'), 'other history writer');
  assert.equal((await readLedger(config.paths.ledger)).entries.length, 0);
  await rm(historyLock);
  await writeFile(ledgerLock, 'other ledger writer');
  assert.equal((await run(cwd, ['adopt-result', path])).code, 2);
  assert.equal(await readFile(ledgerLock, 'utf8'), 'other ledger writer');
  await assert.rejects(readFile(historyLock), /ENOENT/, 'own history lock is released despite inner ledger contention');
  assert.equal((await readObservations(config.paths.observations)).rows.length, 0);
  await rm(ledgerLock);
  assert.equal((await run(cwd, ['adopt-result', path])).code, 0);
});
