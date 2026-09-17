import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../cli/config.js';
import { doctorMain, verifierSelfTest, probeCloud, probeToken } from '../cli/doctor.js';
import { main } from '../cli/main.js';

const TOKEN = `lt_${'a1b2c3d4'.repeat(8)}`;
const entry = { id: 'lk_doctor01', intent: 'expected', source: 'https://example.com/post', target: 'https://example.com/guide' };

// A fetch that answers the two endpoints doctor knows, records every call, and can be told to
// fail. The /healthz handler asserts its own anonymity: no credential may reach the probe.
function cloud({ healthz = { status: 200, body: { status: 'ok' } }, watches = { status: 200, body: { items: [] } }, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (fail) throw new TypeError('fetch failed');
    const route = new URL(url).pathname === '/healthz' ? healthz : watches;
    if (route.throw) throw route.throw;
    return new Response(JSON.stringify(route.body), { status: route.status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function setup(t, { config = {}, ledger = `${JSON.stringify(entry)}\n`, receipts = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.linktrail'));
  await writeFile(join(root, '.linktrail', 'config.json'), JSON.stringify(config));
  if (ledger !== null) await writeFile(join(root, '.linktrail', 'links.jsonl'), ledger);
  if (receipts !== null) await writeFile(join(root, '.linktrail', 'receipts.jsonl'), receipts);
  return { root, config: await loadConfig({ cwd: root }) };
}

const run = async (root, { fetchImpl, env = {}, timeoutMs } = {}) => {
  const lines = [];
  const code = await doctorMain([], { cwd: root, out: line => lines.push(String(line)), err: line => lines.push(String(line)), env, fetchImpl, timeoutMs });
  return { code, text: lines.join('\n'), lines };
};

test('verifier self-test passes against the real verifier exports', () => {
  const result = verifierSelfTest();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.steps, ['url screen', 'parser', 'reducer', 'kind check']);
});

test('healthy repository with a reachable cloud is all green, and the token never appears', async t => {
  const remote = cloud();
  const { root } = await setup(t, { config: { project: { site: ['example.com'] }, cloud: { origin: 'https://api.example.com', workspaceId: 'ws_1' } } });
  const { code, text } = await run(root, { fetchImpl: remote.fetchImpl, env: { LINKTRAIL_TOKEN: TOKEN } });
  assert.equal(code, 0);
  assert.match(text, /ok\s+ledger\s+—\s+1 entry parses/);
  assert.match(text, /skip\s+receipts\s+—\s+none written yet/);
  assert.match(text, /ok\s+verifier\s+—\s+self-test passed/);
  assert.match(text, /ok\s+cloud\s+—\s+https:\/\/api\.example\.com answered 200 in \d+ ms \(recorded in state\.json\)/);
  assert.match(text, /ok\s+token\s+—\s+set in the environment \(LINKTRAIL_TOKEN\); the cloud accepted it/);
  assert.ok(!text.includes(TOKEN), 'the token was printed');

  const state = JSON.parse(await readFile(join(root, '.linktrail', 'state.json'), 'utf8'));
  assert.equal(state.doctor.cloud.ok, true);
  assert.equal(state.doctor.token.ok, true);
  assert.ok(Date.parse(state.doctor.at) > 0);
  const raw = await readFile(join(root, '.linktrail', 'state.json'), 'utf8');
  assert.ok(!raw.includes(TOKEN) && !raw.includes('lt_'), 'key material reached the state file');

  // The reachability probe carries no credential; the token probe carries only the token to
  // the same origin sync would use, with the workspace header the cloud requires.
  const healthz = remote.calls.find(call => call.url.pathname === '/healthz');
  assert.ok(healthz, 'no reachability probe was made');
  assert.equal(healthz.init.headers?.Authorization ?? healthz.init.headers?.get?.('Authorization'), undefined);
  const listed = remote.calls.find(call => call.url.pathname === '/v1/watches');
  assert.ok(listed, 'the token was never verified');
  assert.equal(listed.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(listed.init.headers['X-Workspace-ID'], 'ws_1');
});

test('a missing ledger fails with the init fix, and no cloud means no network at all', async t => {
  const { root } = await setup(t, { ledger: null });
  let called = false;
  const { code, text } = await run(root, { fetchImpl: async () => { called = true; throw new Error('network'); } });
  assert.equal(code, 1);
  assert.match(text, /fail\s+ledger\s+—\s+no ledger at /);
  assert.match(text, /fix\s+— run `agentlinkops init`/);
  assert.match(text, /skip\s+cloud\s+—\s+no cloud configured \(local-only repository\)/);
  assert.match(text, /skip\s+token\s+—\s+no token \(and no cloud configured\)/);
  assert.ok(!called, 'doctor touched the network in a local-only repository');
  assert.ok(!text.includes('state.json'), 'nothing was recorded for a run that probed nothing');
});

test('an unparseable ledger line is named by line number', async t => {
  const { root } = await setup(t, { ledger: 'not json\n' });
  const { code, text } = await run(root);
  assert.equal(code, 1);
  assert.match(text, /fail\s+ledger\s+—\s+1 unreadable line\(s\); first at line 1: /);
});

test('an unparseable receipts file is named without failing the whole run twice', async t => {
  const { root } = await setup(t, { receipts: '{"id":"ar_x"}\n' });
  const { code, text } = await run(root);
  assert.equal(code, 1);
  assert.match(text, /fail\s+receipts\s+—\s+receipts line 1: /);
  assert.match(text, /ok\s+ledger\s+—\s+1 entry parses/);
});

test('an unreachable cloud fails with a fix, and the token is left unverified rather than guessed', async t => {
  const { root } = await setup(t, { config: { cloud: { origin: 'https://api.example.com' } } });
  const { code, text } = await run(root, { fetchImpl: cloud({ fail: true }).fetchImpl, env: { LINKTRAIL_TOKEN: TOKEN } });
  assert.equal(code, 1);
  assert.match(text, /fail\s+cloud\s+—\s+cannot reach https:\/\/api\.example\.com \(network error\)/);
  assert.match(text, /fix\s+— check the network and cloud\.origin in \.linktrail\/config\.json/);
  assert.match(text, /skip\s+token\s+—\s+set in the environment \(LINKTRAIL_TOKEN\); not verified \(cloud unreachable\)/);
  const state = JSON.parse(await readFile(join(root, '.linktrail', 'state.json'), 'utf8'));
  assert.equal(state.doctor.cloud.ok, false);
  assert.equal(state.doctor.cloud.status, null);
  assert.equal(state.doctor.token, undefined);
});

test('the reachability probe is bounded and reports its own timeout', async () => {
  // A fetch that would hang forever; the probe's own AbortSignal.timeout is the only thing
  // that can end it, which is exactly the property under test.
  const hanging = (url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('{}', { status: 200 })), 5000);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      reject(error);
    });
  });
  const result = await probeCloud({ origin: 'https://api.example.com', fetchImpl: hanging, timeoutMs: 25 });
  assert.equal(result.reachable, false);
  assert.equal(result.error, 'timeout');
  assert.equal(result.timedOut, true);
  assert.ok(result.ms < 5000, `the probe waited for the fetch (${result.ms} ms) instead of its own bound`);
});

test('a rejected token fails with the re-issue fix and records only the code', async t => {
  const remote = cloud({ watches: { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired API key.' } } } });
  const { root } = await setup(t, { config: { cloud: { origin: 'https://api.example.com', workspaceId: 'ws_1' } } });
  const { code, text } = await run(root, { fetchImpl: remote.fetchImpl, env: { LINKTRAIL_TOKEN: TOKEN } });
  assert.equal(code, 1);
  assert.match(text, /fail\s+token\s+—\s+the cloud rejected it \(invalid or expired\)/);
  assert.match(text, /fix\s+— issue a fresh key/);
  const state = JSON.parse(await readFile(join(root, '.linktrail', 'state.json'), 'utf8'));
  assert.deepEqual(state.doctor.token, { ok: false, code: 'UNAUTHORIZED' });
});

test('an insufficient-scope token names the missing scope', async () => {
  const remote = cloud({ watches: { status: 403, body: { error: { code: 'INSUFFICIENT_SCOPE', details: { scope: 'watches:read' } } } } });
  const result = await probeToken({ origin: 'https://api.example.com', token: TOKEN, workspaceId: 'ws_1', fetchImpl: remote.fetchImpl });
  assert.equal(result.verified, false);
  assert.equal(result.scope, 'watches:read');
});

test('a malformed token is refused by shape, never echoed, and never sent', async t => {
  const bad = 'lt_short';
  const remote = cloud();
  const { root } = await setup(t, { config: { cloud: { origin: 'https://api.example.com' } } });
  const { code, text } = await run(root, { fetchImpl: remote.fetchImpl, env: { LINKTRAIL_TOKEN: bad } });
  assert.equal(code, 1);
  assert.match(text, /fail\s+token\s+—\s+set in the environment \(LINKTRAIL_TOKEN\) but it does not look like an AgentLinkOps API key/);
  assert.ok(!text.includes(bad), 'the malformed token was printed');
  assert.ok(remote.calls.every(call => call.url.pathname !== '/v1/watches'), 'a malformed token was sent to the cloud');
});

test('a local-only repository with a valid ledger passes with skips, exit 0', async t => {
  const { root } = await setup(t);
  const { code, text } = await run(root);
  assert.equal(code, 0);
  // The citations engine-credential check skips alongside cloud and token in a
  // repository with no live engine configured.
  assert.match(text, /all checks passed \(3 ok, 5 skipped\)/);
});

test('the command runs through main and refuses flags', async t => {
  const { root } = await setup(t);
  const lines = [];
  assert.equal(await main(['doctor'], { cwd: root, out: line => lines.push(String(line)) }), 0);
  assert.match(lines.join('\n'), /ok\s+ledger\s+—\s+1 entry parses/);
  assert.equal(await main(['doctor', '--json'], { cwd: root, out: () => {}, err: () => {} }), 2);
});

test('disagreeing token spellings reach the user as the exit-2 message, not an unhandled rejection', async t => {
  // main() dispatches doctor from inside its ConfigError handler; a promise returned without
  // await would escape it and the process would die with a stack trace (found by the
  // packaged-CLI test that runs the executable as a subprocess).
  const { root } = await setup(t);
  const out = [], err = [];
  const env = { AGENTLINKOPS_TOKEN: TOKEN, LINKTRAIL_TOKEN: `${TOKEN.slice(0, -1)}f` };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; Object.assign(process.env, previous); });
  const code = await main(['doctor'], { cwd: root, out: line => out.push(String(line)), err: line => err.push(String(line)) });
  assert.equal(code, 2);
  assert.ok(err.some(line => /AGENTLINKOPS_TOKEN and LINKTRAIL_TOKEN disagree/u.test(line)), err.join('\n'));
  assert.equal(`${out.join('\n')}${err.join('\n')}`.includes(TOKEN), false, 'no value is printed');
});
