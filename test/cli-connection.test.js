import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudConnection, connectMain, SYNC_SCOPES } from '../cli/connection.js';

const TOKEN = `lt_${'ab'.repeat(32)}`;
const args = { origin: 'https://api.example.com', workspace: 'ws_one', 'project-id': 'prj_one' };
async function setup(t, config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'linktrail-connect-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, '.linktrail'); await mkdir(dir);
  for (const [name, value] of Object.entries({ 'config.json': JSON.stringify(config, null, 2) + '\n', 'links.jsonl': '{"local":"ledger"}\n', 'observations.jsonl': '{"local":"observation"}\n', 'state.json': '{"cursor":"saved"}\n' })) await writeFile(join(dir, name), value);
  const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async name => [name, await readFile(join(dir, name), 'utf8')])));
  return { cwd, dir, snapshot, before: await snapshot() };
}
function cloud({ account = { workspace: { id: 'ws_one' }, access: { scopes: SYNC_SCOPES } }, project = { id: 'prj_one', workspace_id: 'ws_one' } } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers['X-Workspace-ID'], 'ws_one');
    return Response.json(new URL(url).pathname === '/v1/workspace' ? account : project);
  } };
}
const options = (f, remote, out = () => {}) => ({ cwd: f.cwd, env: { LINKTRAIL_API_KEY: TOKEN }, fetchImpl: remote.fetchImpl, out });

test('credential aliases agree or fail explicitly without exposing their values', () => {
  const config = { cloud: { origin: args.origin, workspaceId: args.workspace, projectId: args['project-id'] } };
  assert.equal(cloudConnection(config, { LINKTRAIL_API_KEY: TOKEN }).token, TOKEN);
  assert.equal(cloudConnection(config, { LINKTRAIL_TOKEN: TOKEN }).token, TOKEN);
  assert.equal(cloudConnection(config, { LINKTRAIL_TOKEN: TOKEN, LINKTRAIL_API_KEY: TOKEN }).token, TOKEN);
  assert.throws(() => cloudConnection(config, { LINKTRAIL_TOKEN: TOKEN, LINKTRAIL_API_KEY: 'different-secret' }), error => error.name === 'ConfigError' && /disagree/.test(error.message) && !error.message.includes(TOKEN) && !error.message.includes('different-secret'));
  // DP-0029: the AgentLinkOps spellings are primary and follow the same rule.
  assert.equal(cloudConnection(config, { AGENTLINKOPS_API_KEY: TOKEN }).token, TOKEN);
  assert.equal(cloudConnection(config, { AGENTLINKOPS_TOKEN: TOKEN }).token, TOKEN);
  assert.equal(cloudConnection(config, { AGENTLINKOPS_TOKEN: TOKEN, LINKTRAIL_TOKEN: TOKEN }).token, TOKEN);
  assert.throws(() => cloudConnection(config, { AGENTLINKOPS_TOKEN: TOKEN, AGENTLINKOPS_API_KEY: 'different-secret' }), error => error.name === 'ConfigError' && /AGENTLINKOPS_TOKEN and AGENTLINKOPS_API_KEY disagree/.test(error.message) && !error.message.includes('different-secret'));
  assert.throws(() => cloudConnection(config, { AGENTLINKOPS_TOKEN: TOKEN, LINKTRAIL_TOKEN: 'different-secret' }), error => error.name === 'ConfigError' && /AGENTLINKOPS_TOKEN and LINKTRAIL_TOKEN disagree/.test(error.message) && !error.message.includes('different-secret'));
});

test('missing key gives customer setup instructions without network or local changes', async t => {
  const f = await setup(t), output = [];
  const code = await connectMain(args, { cwd: f.cwd, env: {}, out: line => output.push(line), fetchImpl: () => assert.fail('no key must not fetch') });
  assert.equal(code, 2); assert.match(output.join('\n'), /Agent access.*Create API key/);
  assert.match(output.join('\n'), /MCP OAuth credentials remain in the MCP client/);
  assert.deepEqual(await f.snapshot(), f.before);
});

test('connect verifies only reads and preserves unrelated config, ledger and cursors without storing key', async t => {
  const original = { custom: { keep: true }, paths: { receipts: 'custom-receipts.jsonl' }, project: { site: ['example.com'] }, cloud: { custom: 'preserve', token: TOKEN } };
  const f = await setup(t, original), remote = cloud(), output = [];
  assert.equal(await connectMain(args, options(f, remote, line => output.push(line))), 0);
  assert.deepEqual(remote.calls.map(c => new URL(c.url).pathname), ['/v1/workspace', '/v1/projects/prj_one']);
  const after = await f.snapshot(), saved = JSON.parse(after['config.json']);
  assert.deepEqual(saved, { ...original, project: { ...original.project, id: 'prj_one' }, cloud: { custom: 'preserve', origin: args.origin, workspaceId: 'ws_one' } });
  assert.deepEqual({ ...after, 'config.json': f.before['config.json'] }, f.before);
  assert.ok(!JSON.stringify(after).includes(TOKEN)); assert.ok(!output.join('\n').includes(TOKEN));
  assert.equal((await stat(join(f.dir, 'config.json'))).mode & 0o777, 0o600);
  assert.equal(await connectMain(args, options(f, remote)), 0);
  assert.deepEqual(await f.snapshot(), after);
});

test('wrong workspace, insufficient scopes and wrong project cannot modify the ledger', async t => {
  for (const failure of [
    { account: { workspace: { id: 'ws_wrong' }, access: { scopes: SYNC_SCOPES } } },
    { account: { workspace: { id: 'ws_one' }, access: { scopes: ['projects:read'] } } },
    { project: { id: 'prj_wrong', workspace_id: 'ws_one' } },
    { project: { id: 'prj_one', workspace_id: 'ws_wrong' } },
  ]) {
    const f = await setup(t), remote = cloud(failure);
    await assert.rejects(connectMain(args, options(f, remote)), { name: 'ConfigError' });
    assert.deepEqual(await f.snapshot(), f.before);
  }
});

test('reconnect across origin, workspace or project is rejected before disclosing credentials', async t => {
  for (const config of [
    { cloud: { origin: 'https://other.example.com' } },
    { cloud: { workspaceId: 'ws_other' } },
    { cloud: { projectId: 'prj_other' } },
    { project: { id: 'prj_other' } },
  ]) {
    const f = await setup(t, config), remote = cloud();
    await assert.rejects(connectMain(args, options(f, remote)), { name: 'ConfigError' });
    assert.equal(remote.calls.length, 0);
    assert.deepEqual(await f.snapshot(), f.before);
  }
});

test('an existing sync lock is preserved and connection config remains untouched', async t => {
  const f = await setup(t), remote = cloud();
  await writeFile(join(f.dir, 'sync.lock'), 'other process');
  const before = await f.snapshot();
  await assert.rejects(connectMain(args, options(f, remote)), { code: 'EEXIST' });
  assert.deepEqual(await f.snapshot(), before);
});

test('invalid credentials or unsafe origin fail before any request or config mutation', async t => {
  const f = await setup(t);
  for (const [input, env] of [
    [args, { LINKTRAIL_API_KEY: 'truncated' }],
    [args, { LINKTRAIL_API_KEY: TOKEN, LINKTRAIL_TOKEN: `lt_${'cd'.repeat(32)}` }],
    [{ ...args, origin: 'http://api.example.com' }, { LINKTRAIL_API_KEY: TOKEN }],
    [{ ...args, origin: 'https://user:secret@api.example.com' }, { LINKTRAIL_API_KEY: TOKEN }],
    [{ ...args, origin: 'https://api.example.com/path' }, { LINKTRAIL_API_KEY: TOKEN }],
    [{ ...args, origin: 'https://api.example.com/?token=secret' }, { LINKTRAIL_API_KEY: TOKEN }],
  ]) {
    await assert.rejects(connectMain(input, { cwd: f.cwd, env, out: () => assert.fail('must not print a credential'), fetchImpl: () => assert.fail('invalid input must not fetch') }), { name: 'ConfigError' });
    assert.deepEqual(await f.snapshot(), f.before);
  }
});

test('remote authentication rejection preserves all files and prints no credentials', async t => {
  const f = await setup(t);
  await assert.rejects(connectMain(args, { cwd: f.cwd, env: { LINKTRAIL_API_KEY: TOKEN }, out: () => assert.fail('must not report connected'), fetchImpl: async () => Response.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 }) }), { code: 'INVALID_TOKEN', status: 401 });
  assert.deepEqual(await f.snapshot(), f.before);
});

test('customer onboarding snake-case identity is honored and conflicting identity fields fail',async t=>{
 const config={cloud:{workspace_id:'ws_one',project_id:'prj_one'}};
 assert.equal(cloudConnection(config,{}).workspaceId,'ws_one');assert.equal(cloudConnection(config,{}).projectId,'prj_one');
 assert.throws(()=>cloudConnection({...config,project:{id:'prj_other'}},{}),{name:'ConfigError'});
 const f=await setup(t,config), remote=cloud();
 await assert.rejects(connectMain({...args,workspace:'ws_other'},options(f,remote)),{name:'ConfigError'});assert.equal(remote.calls.length,0);
 assert.equal(await connectMain(args,options(f,remote)),0);
});

test('explicit mapping selection saves only known local IDs without cloud writes',async t=>{
 const f=await setup(t),remote=cloud();
 await writeFile(join(f.dir,'links.jsonl'),JSON.stringify({v:1,id:'lk_aaaaaaaa',intent:'expected',source:'https://source.example/',target:'https://target.example/',scope:'domain'})+'\n');
 await writeFile(join(f.cwd,'mapping.json'),JSON.stringify({entries:[{local_id:'lk_aaaaaaaa'},{local_id:'lk_aaaaaaaa'}]}));
 assert.equal(await connectMain({...args,selection:'mapping.json'},options(f,remote)),0);
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'config.json'),'utf8')).cloud.ledgerIds,['lk_aaaaaaaa']);
 const before=await f.snapshot();await writeFile(join(f.cwd,'bad.json'),JSON.stringify(['lk_missing']));remote.calls.length=0;
 await assert.rejects(connectMain({...args,selection:'bad.json'},options(f,remote)),{name:'ConfigError'});assert.equal(remote.calls.length,0);assert.deepEqual(await f.snapshot(),before);
});
