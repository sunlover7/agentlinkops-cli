import { main } from '../cli/main.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudConnection, connectMain, DEFAULT_ORIGIN, SYNC_SCOPES } from '../cli/connection.js';
import { withStoredKeys } from '../cli/key-store.js';

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
  assert.equal(code, 2); assert.match(output.join('\n'), /Agent page.*Create API key.*npx -y agentlinkops connect/);
  assert.match(output.join('\n'), /MCP clients manage their own credentials/);
  assert.deepEqual(await f.snapshot(), f.before);
});

test('connect verifies only reads and preserves unrelated config, ledger and cursors without storing key', async t => {
  const original = { custom: { keep: true }, paths: { receipts: 'custom-receipts.jsonl' }, project: { site: ['example.com'] }, cloud: { custom: 'preserve', token: TOKEN } };
  const f = await setup(t, original), remote = cloud(), output = [];
  assert.equal(await connectMain(args, options(f, remote, line => output.push(line))), 0);
  assert.deepEqual(remote.calls.map(c => new URL(c.url).pathname), ['/v1/workspace', '/v1/projects/prj_one']);
  const after = await f.snapshot(), saved = JSON.parse(after['config.json']);
  assert.equal(after['.sync-gate'], '');
  delete after['.sync-gate'];
  assert.deepEqual(saved, { ...original, project: { ...original.project, id: 'prj_one' }, cloud: { custom: 'preserve', origin: args.origin, workspaceId: 'ws_one' } });
  assert.deepEqual({ ...after, 'config.json': f.before['config.json'] }, f.before);
  assert.ok(!JSON.stringify(after).includes(TOKEN)); assert.ok(!output.join('\n').includes(TOKEN));
  assert.equal((await stat(join(f.dir, 'config.json'))).mode & 0o777, 0o600);
  assert.equal(await connectMain(args, options(f, remote)), 0);
  const repeated = await f.snapshot(); delete repeated['.sync-gate']; assert.deepEqual(repeated, after);
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
  await assert.rejects(connectMain(args, options(f, remote)), /ownership is unknown/);
  const after = await f.snapshot(); assert.equal(after['.sync-gate'], ''); delete after['.sync-gate'];
  assert.deepEqual(after, before);
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

test('actual CLI dispatcher honors isolated environment and read-only connection transport', async t => {
  const f=await setup(t), remote=cloud();
  assert.equal(await main(['connect','--workspace','ws_one','--project-id','prj_one','--origin',args.origin],options(f,remote)),0);
  assert.deepEqual(remote.calls.map(c=>new URL(c.url).pathname),['/v1/workspace','/v1/projects/prj_one']);
  assert.equal(JSON.parse((await f.snapshot())['config.json']).project.id,'prj_one');
});

// 2026-10-13 onboarding: `connect` needs no IDs and no environment variables. A pasted key is
// verified, saved outside the folder, and names its own workspace; a ledger maps to its website.
const KEY = `lt_${'cd'.repeat(32)}`;
function memoryKeyStore(saved = {}) {
  const writes = [];
  return { writes, saved, where: 'the test key store', readSync: origin => saved[origin] ?? null,
    async save(origin, key) { writes.push(origin); saved[origin] = key; }, async remove(origin) { delete saved[origin]; } };
}
function keyCloud({ projects = [{ id: 'prj_one', workspace_id: 'ws_one', domain: 'example.com' }], projectIds = null, accepts = [TOKEN, KEY] } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ origin: new URL(url).origin, path, workspace: init.headers['X-Workspace-ID'] ?? null });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    if (!accepts.includes(init.headers.Authorization.slice('Bearer '.length))) return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired API key.' } }, { status: 401 });
    if (path === '/v1/workspace') return Response.json({ workspace: { id: 'ws_one', name: 'Settled Estate' }, access: { role: 'owner', scopes: SYNC_SCOPES, project_ids: projectIds } });
    if (path === '/v1/projects') return Response.json({ items: projects, next_cursor: null });
    const project = projects.find(item => path === `/v1/projects/${item.id}`);
    return project ? Response.json(project) : Response.json({ error: { code: 'PROJECT_NOT_FOUND' } }, { status: 404 });
  } };
}
async function emptyFolder(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlinkops-connect-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('connect with no IDs asks for a key once, saves it outside the folder and names its workspace', async t => {
  const cwd = await emptyFolder(t), store = memoryKeyStore(), remote = keyCloud(), output = [], asked = [];
  const code = await connectMain({}, { cwd, env: {}, out: line => output.push(line), fetchImpl: remote.fetchImpl, keyStore: store,
    ask: async question => { asked.push(question); return `  ${KEY}\n`; } });
  assert.equal(code, 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Paste an API key from https:\/\/app\.agentlinkops\.com\/#\/access \(Create API key\)/);
  assert.deepEqual(store.writes, [DEFAULT_ORIGIN]);
  assert.deepEqual(remote.calls.map(call => `${call.origin}${call.path}`), [`${DEFAULT_ORIGIN}/v1/workspace`]);
  assert.match(output.join('\n'), /Saved the key in the test key store\.\nConnected the CLI to Settled Estate\. .*agentlinkops call list_tasks/);
  assert.ok(!output.join('\n').includes(KEY));
  assert.deepEqual(await readdir(cwd), [], 'nothing is written into the folder');
  // The next command in any folder finds it, for that origin only.
  const env = withStoredKeys({}, store);
  assert.deepEqual({ ...cloudConnection({}, env), tokenSource: undefined }, { origin: DEFAULT_ORIGIN, token: KEY, tokenSource: undefined, storedKey: true, workspaceId: undefined, projectId: undefined });
  assert.equal(cloudConnection({}, env).tokenSource, 'the test key store');
  assert.equal(cloudConnection({ cloud: { origin: 'https://other.example.com' } }, env).token, undefined);
  assert.equal(cloudConnection({}, { ...env, AGENTLINKOPS_API_KEY: TOKEN }).token, TOKEN, 'the environment still wins');
});

test('a pasted value that is not an API key is refused before any request, and nothing is saved', async t => {
  const cwd = await emptyFolder(t), store = memoryKeyStore();
  await assert.rejects(connectMain({}, { cwd, env: {}, out: () => {}, keyStore: store, ask: async () => 'eyJhbGciOiJSUzI1NiJ9.e30.signature',
    fetchImpl: () => assert.fail('a refused key must not be sent') }), { name: 'ConfigError', message: /not an AgentLinkOps API key/ });
  assert.deepEqual(store.writes, []);
  const skipped = [];
  assert.equal(await connectMain({}, { cwd, env: {}, out: line => skipped.push(line), keyStore: store, ask: async () => '', fetchImpl: () => assert.fail('no key, no request') }), 2);
  assert.match(skipped.join('\n'), /Create API key/);
});

test('a saved key that stopped working asks for a new one and replaces it', async t => {
  const cwd = await emptyFolder(t), store = memoryKeyStore({ [DEFAULT_ORIGIN]: TOKEN }), remote = keyCloud({ accepts: [KEY] }), output = [];
  assert.equal(await connectMain({}, { cwd, env: withStoredKeys({}, store), out: line => output.push(line), fetchImpl: remote.fetchImpl, keyStore: store, ask: async () => KEY }), 0);
  assert.match(output.join('\n'), /The saved key no longer works/);
  assert.equal(store.saved[DEFAULT_ORIGIN], KEY);
});

test('with a ledger and one website, connect maps it without IDs', async t => {
  const f = await setup(t), remote = keyCloud(), output = [];
  assert.equal(await connectMain({}, { cwd: f.cwd, env: { AGENTLINKOPS_API_KEY: TOKEN }, out: line => output.push(line), fetchImpl: remote.fetchImpl }), 0);
  assert.deepEqual(remote.calls.map(call => call.path), ['/v1/workspace', '/v1/workspace', '/v1/projects', '/v1/projects/prj_one']);
  assert.deepEqual(remote.calls.map(call => call.workspace), [null, 'ws_one', 'ws_one', 'ws_one']);
  const saved = JSON.parse((await f.snapshot())['config.json']);
  assert.deepEqual(saved.cloud, { origin: DEFAULT_ORIGIN, workspaceId: 'ws_one' });
  assert.equal(saved.project.id, 'prj_one');
  assert.match(output.join('\n'), /Verified workspace ws_one, project prj_one/);
});

test('a key limited to one website maps that website without listing the workspace', async t => {
  const f = await setup(t), remote = keyCloud({ projectIds: ['prj_two'], projects: [{ id: 'prj_two', workspace_id: 'ws_one', domain: 'two.example' }] });
  assert.equal(await connectMain({}, { cwd: f.cwd, env: { AGENTLINKOPS_API_KEY: TOKEN }, out: () => {}, fetchImpl: remote.fetchImpl }), 0);
  assert.ok(!remote.calls.some(call => call.path === '/v1/projects'));
  assert.equal(JSON.parse((await f.snapshot())['config.json']).project.id, 'prj_two');
});

test('several websites: connect prints one copyable command per website and changes nothing', async t => {
  const f = await setup(t), output = [];
  const remote = keyCloud({ projects: [{ id: 'prj_one', workspace_id: 'ws_one', domain: 'one.example' }, { id: 'prj_two', workspace_id: 'ws_one', domain: 'two.example' }] });
  assert.equal(await connectMain({}, { cwd: f.cwd, env: { AGENTLINKOPS_API_KEY: TOKEN }, out: line => output.push(line), fetchImpl: remote.fetchImpl }), 2);
  assert.match(output.join('\n'), /agentlinkops connect --project-id prj_one +# one\.example\n +agentlinkops connect --project-id prj_two +# two\.example/);
  assert.deepEqual(await f.snapshot(), f.before);
});

test('--project-id without a ledger here says how to create one instead of failing on a missing file', async t => {
  const cwd = await emptyFolder(t), remote = keyCloud();
  await assert.rejects(connectMain({ 'project-id': 'prj_one' }, { cwd, env: { AGENTLINKOPS_API_KEY: TOKEN }, out: () => {}, fetchImpl: remote.fetchImpl }),
    { name: 'ConfigError', message: /agentlinkops init/ });
  assert.deepEqual(await readdir(cwd), []);
});
