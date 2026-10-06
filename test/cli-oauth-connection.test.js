import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectMain, cloudConnection, SYNC_SCOPES} from '../cli/connection.js';

const binding = {issuer: 'https://issuer.example.com', resource: 'https://api.example.com/mcp', clientId: 'public-client'};
const auth = {kind: 'oauth', ...binding, credentialRef: `oauth_${'a'.repeat(32)}`};
const args = {oauth: true, origin: 'https://api.example.com', workspace: 'ws_one', 'project-id': 'prj_one', issuer: binding.issuer, 'client-id': binding.clientId};
async function fixture(t, config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'alo-oauth-connect-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  await mkdir(join(cwd, '.agentlinkops'));
  const file = join(cwd, '.agentlinkops/config.json');
  await writeFile(file, JSON.stringify(config));
  return {cwd, file};
}
function dependencies(extra = {}) {
  const calls = [], removed = [], output = [];
  const tokens = {accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: Date.now() + 3600000, scope: [...SYNC_SCOPES, 'offline_access'].join(' ')};
  return {calls, removed, output, options: {
    env: {}, out: line => output.push(line),
    credentialStore: {
      create: async (b, value) => { assert.deepEqual(b, binding); assert.deepEqual(value, tokens); return auth.credentialRef; },
      read: async (ref, b) => { assert.equal(ref, auth.credentialRef); assert.deepEqual(b, binding); return {tokens}; },
      remove: async (ref, b) => { removed.push(ref); assert.deepEqual(b, binding); },
    },
    oauth: {
      discoverOAuth: async input => { calls.push('discover'); assert.deepEqual(input.scopes, [...SYNC_SCOPES, 'offline_access']); return {}; },
      receiveOAuthConsent: async () => { calls.push('consent'); return {}; },
      exchangeOAuthCode: async () => tokens,
    },
    clientFactory: input => { assert.deepEqual(input.auth, auth); assert.equal(input.token, undefined); return {
      getWorkspace: async () => { calls.push('workspace'); return {workspace: {id: 'ws_one'}}; },
      getProject: async () => { calls.push('project'); return {id: 'prj_one', workspace_id: 'ws_one'}; },
    }; }, ...extra,
  }};
}

test('OAuth connection persists only a bound reference and does not claim write permission', async t => {
  const f = await fixture(t), d = dependencies();
  assert.equal(await connectMain(args, {...d.options, cwd: f.cwd}), 0);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(saved.cloud.auth, auth);
  assert.deepEqual(d.calls, ['discover', 'consent', 'workspace', 'project']);
  assert.match(d.output.join('\n'), /write permission remains unverified/);
  assert.doesNotMatch(JSON.stringify(saved) + d.output.join('\n'), /secret-access|secret-refresh/);
  assert.deepEqual(cloudConnection(saved, {}).auth, auth);
});

test('nine ledgers reuse one reference without renewed consent or copying tokens', async t => {
  for (let n = 0; n < 9; n++) {
    const f = await fixture(t), d = dependencies();
    assert.equal(await connectMain({...args, 'credential-ref': auth.credentialRef}, {...d.options, cwd: f.cwd}), 0);
    assert.deepEqual(d.calls, ['workspace', 'project']);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).cloud.auth, auth);
  }
});

test('failed probe removes only a new credential and leaves config unchanged', async t => {
  const f = await fixture(t, {custom: true});
  const d = dependencies({clientFactory: () => ({getWorkspace: async () => ({workspace: {id: 'wrong'}})})});
  await assert.rejects(connectMain(args, {...d.options, cwd: f.cwd}), {name: 'ConfigError'});
  assert.deepEqual(d.removed, [auth.credentialRef]);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), {custom: true});
  d.removed.length = 0;
  await assert.rejects(connectMain({...args, 'credential-ref': auth.credentialRef}, {...d.options, cwd: f.cwd}), {name: 'ConfigError'});
  assert.deepEqual(d.removed, []);
});

test('OAuth and API-key or altered resource bindings fail closed', () => {
  const config = {cloud: {origin: args.origin, auth}};
  assert.throws(() => cloudConnection(config, {AGENTLINKOPS_TOKEN: 'private-key'}), {name: 'ConfigError'});
  assert.throws(() => cloudConnection({cloud: {origin: args.origin, auth: {...auth, resource: 'https://other.example.com/mcp'}}}, {}), {name: 'ConfigError'});
});

test('a committed credential survives an output failure', async t => {
  const f = await fixture(t), d = dependencies({out: () => {throw new Error('output unavailable');}});
  await assert.rejects(connectMain(args, {...d.options, cwd: f.cwd}), /output unavailable/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).cloud.auth, auth);
  assert.deepEqual(d.removed, []);
});

test('unsupported credential custody refuses before issuer discovery or consent', async t => {
  const f = await fixture(t), d = dependencies();
  d.options.credentialStore.checkAvailability = async () => {throw Object.assign(new Error('OAUTH_CREDENTIAL_STORAGE_UNSUPPORTED'), {code: 'OAUTH_CREDENTIAL_STORAGE_UNSUPPORTED'});};
  await assert.rejects(connectMain(args, {...d.options, cwd: f.cwd}), {code: 'OAUTH_CREDENTIAL_STORAGE_UNSUPPORTED'});
  assert.deepEqual(d.calls, []);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), {});
});

test('a concurrently saved OAuth binding cannot be overwritten after verification', async t => {
  const f = await fixture(t);
  const changed = {...auth, clientId: 'other-client'};
  const d = dependencies({clientFactory: () => ({
    getWorkspace: async () => {
      await writeFile(f.file, JSON.stringify({cloud: {origin: args.origin, auth: changed}}));
      return {workspace: {id: 'ws_one'}};
    },
    getProject: async () => ({id: 'prj_one', workspace_id: 'ws_one'}),
  })});
  await assert.rejects(connectMain(args, {...d.options, cwd: f.cwd}), /changed during verification/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).cloud.auth, changed);
  assert.deepEqual(d.removed, [auth.credentialRef]);
});
