import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createOAuthCredentialStore} from '../cli/oauth-credentials.js';

const binding = {issuer: 'https://issuer.example', resource: 'https://app.example/mcp', clientId: 'public-client'};
const tokens = {accessToken: 'access-fixture', refreshToken: 'refresh-fixture', expiresAt: 2000000000000, scope: 'projects:read offline_access'};
async function fixture(t, options = {}) {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'oauth-private-')));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  return {home, directory: join(home, '.agentlinkops', 'oauth'), store: createOAuthCredentialStore({home, platform: 'linux', ...options})};
}
const file = (f, ref) => join(f.directory, ref + '.json');

test('opaque credentials bind exact identities and remain outside ledger config in private files', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens);
  assert.match(ref, /^oauth_[a-f0-9]{32}$/);
  assert.equal((await fs.stat(f.directory)).mode & 0o7777, 0o700);
  assert.equal((await fs.stat(file(f, ref))).mode & 0o7777, 0o600);
  const record = await f.store.read(ref, binding);
  assert.deepEqual(record, {version: 1, revision: 1, binding, tokens});
  record.tokens.accessToken = 'mutated';
  assert.equal((await f.store.read(ref, binding)).tokens.accessToken, tokens.accessToken);
  for (const key of Object.keys(binding)) await assert.rejects(f.store.read(ref, {...binding,
    [key]: key === 'issuer' ? 'https://other.example' : key === 'resource' ? 'https://other.example/mcp' : 'other-client'}), {code: 'OAUTH_CREDENTIAL_BINDING_MISMATCH'});
  assert.deepEqual(await fs.readdir(f.directory), [ref + '.json']);
  assert.equal(await f.store.remove(ref, binding), true);
  assert.equal(await f.store.remove(ref, binding), false);
});

test('invalid references, bindings and tokens fail before filesystem creation', async t => {
  const f = await fixture(t);
  for (const ref of ['../secret', '', 'oauth_' + 'a'.repeat(33)]) await assert.rejects(f.store.read(ref, binding), {code: 'OAUTH_CREDENTIAL_REF_INVALID'});
  for (const bad of [{...binding, resource: 'https://app.example/v1'}, {...binding, issuer: 'https://issuer.example/'},
    {...binding, clientId: 'bad\nclient'}, {...binding, extra: true}]) await assert.rejects(f.store.create(bad, tokens), {code: 'OAUTH_CREDENTIAL_BINDING_INVALID'});
  for (const bad of [{...tokens, expiresAt: 0}, {...tokens, expiresAt: 1.5}, {...tokens, accessToken: 'x'.repeat(65537)},
    {...tokens, refreshToken: 'bad token'}, {...tokens, scope: 'projects:read\n'}, {...tokens, extra: true}])
    await assert.rejects(f.store.create(binding, bad), {code: 'OAUTH_CREDENTIAL_TOKENS_INVALID'});
  await assert.rejects(fs.stat(join(f.home, '.agentlinkops')), {code: 'ENOENT'});
});

test('unverified native custody refuses before touching files on macOS, Windows and other platforms', async t => {
  for (const platform of ['darwin', 'win32', 'freebsd']) {
    const f = await fixture(t, {platform});
    await assert.rejects(f.store.checkAvailability(), {code: 'OAUTH_CREDENTIAL_STORAGE_UNSUPPORTED'});
    await assert.rejects(f.store.create(binding, tokens), {code: 'OAUTH_CREDENTIAL_STORAGE_UNSUPPORTED'});
    await assert.rejects(fs.stat(join(f.home, '.agentlinkops')), {code: 'ENOENT'});
  }
});

test('symlink directories/files, hardlinks and weak file modes are refused without target changes', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens), path = file(f, ref);
  const original = await fs.readFile(path, 'utf8'), target = join(f.home, 'untouched');
  await fs.writeFile(target, original, {mode: 0o600});
  await fs.unlink(path); await fs.symlink(target, path);
  await assert.rejects(f.store.read(ref, binding), {code: 'OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED'});
  assert.equal(await fs.readFile(target, 'utf8'), original);
  await fs.unlink(path); await fs.link(target, path);
  await assert.rejects(f.store.read(ref, binding), {code: 'OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED'});
  await fs.unlink(path); await fs.writeFile(path, original, {mode: 0o600}); await fs.chmod(path, 0o644);
  await assert.rejects(f.store.read(ref, binding), {code: 'OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED'});
  await fs.chmod(path, 0o600); await fs.chmod(f.directory, 0o755);
  await assert.rejects(f.store.read(ref, binding), {code: 'OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED'});
  await fs.chmod(f.directory, 0o700);
  const other = await fixture(t); await fs.symlink(f.directory, join(other.home, '.agentlinkops'));
  await assert.rejects(other.store.create(binding, tokens), {code: 'OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED'});
});

test('tampered or oversized records fail with static errors and no token disclosure', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens);
  for (const content of ['{"accessToken":"private-fixture"', 'x'.repeat(300001),
    JSON.stringify({version: 2, revision: 1, binding, tokens}), JSON.stringify({version: 1, revision: 1, binding, tokens, unknown: 'private-fixture'})]) {
    await fs.writeFile(file(f, ref), content);
    await assert.rejects(f.store.read(ref, binding), error => error.code === 'OAUTH_CREDENTIAL_RECORD_INVALID'
      && !error.message.includes('private-fixture') && !error.message.includes(f.home));
  }
});

test('unknown locks are never broken and callback cannot run through them', async t => {
  const f = await fixture(t, {lockTimeoutMs: 0}), ref = await f.store.create(binding, tokens), lock = join(f.directory, ref + '.lock');
  await fs.writeFile(lock, 'unknown-owner', {mode: 0o600});
  let called = false;
  await assert.rejects(f.store.withCredential(ref, binding, async () => { called = true; return {value: null}; }), {code: 'OAUTH_CREDENTIAL_LOCKED'});
  await assert.rejects(f.store.remove(ref, binding), {code: 'OAUTH_CREDENTIAL_LOCKED'});
  assert.equal(called, false); assert.equal(await fs.readFile(lock, 'utf8'), 'unknown-owner');
});

test('nine independent ledger stores serialize refresh rotation and retain every revision', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens);
  let active = 0, peak = 0;
  const revisions = await Promise.all(Array.from({length: 9}, () => createOAuthCredentialStore({home: f.home, platform: 'linux'}).withCredential(ref, binding, async record => {
    active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 5)); active--;
    return {tokens: {...record.tokens, refreshToken: 'refresh-' + record.revision}, value: record.revision};
  })));
  assert.equal(peak, 1); assert.deepEqual(revisions.sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9]);
  assert.equal((await f.store.read(ref, binding)).revision, 10);
  assert.deepEqual(await fs.readdir(f.directory), [ref + '.json']);
});

test('two actual processes serialize credential rotation', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens), module = new URL('../cli/oauth-credentials.js', import.meta.url).href;
  const source = `import {createOAuthCredentialStore} from ${JSON.stringify(module)};
    const store=createOAuthCredentialStore({home:process.env.TEST_OAUTH_HOME,platform:'linux'});
    await store.withCredential(process.env.TEST_OAUTH_REF,${JSON.stringify(binding)},async record=>{
      await new Promise(done=>setTimeout(done,40));
      return {tokens:{...record.tokens,refreshToken:'process-'+record.revision},value:null};
    });`;
  const run = () => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {env: {...process.env, TEST_OAUTH_HOME: f.home, TEST_OAUTH_REF: ref}, stdio: 'ignore'});
    child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(Error('child credential fixture failed')));
  });
  await Promise.all([run(), run()]);
  assert.equal((await f.store.read(ref, binding)).revision, 3);
});

test('callback failure, malformed replacement and concurrent mutation preserve original or detected bytes', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens), original = await fs.readFile(file(f, ref), 'utf8');
  const callbackError = Object.assign(new Error('sanitized-refresh-failure'), {code: 'REFRESH_FAILED'});
  await assert.rejects(f.store.withCredential(ref, binding, async () => { throw callbackError; }), error => error === callbackError);
  await assert.rejects(f.store.withCredential(ref, binding, async () => ({tokens: {accessToken: 'partial'}, value: 'never'})), {code: 'OAUTH_CREDENTIAL_TOKENS_INVALID'});
  assert.equal(await fs.readFile(file(f, ref), 'utf8'), original);
  const modified = JSON.stringify({version: 1, revision: 5, binding, tokens});
  await assert.rejects(f.store.withCredential(ref, binding, async () => {
    await fs.writeFile(file(f, ref), modified); return {tokens, value: 'never'};
  }), {code: 'OAUTH_CREDENTIAL_STORAGE_CHANGED'});
  assert.equal(await fs.readFile(file(f, ref), 'utf8'), modified);
  assert.deepEqual(await fs.readdir(f.directory), [ref + '.json']);
});

async function storeProcess(f, ref, body) {
  const module = new URL('../cli/oauth-credentials.js', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {join} from 'node:path';
    import {createOAuthCredentialStore} from ${JSON.stringify(module)};
    const home=process.env.TEST_OAUTH_HOME, ref=process.env.TEST_OAUTH_REF;
    const directory=join(home,'.agentlinkops','oauth'), path=join(directory,ref+'.lock');
    const binding=${JSON.stringify(binding)};
    const store=createOAuthCredentialStore({home,platform:'linux',lockTimeoutMs:0});
    ${body}`;
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: {...process.env, TEST_OAUTH_HOME: f.home, TEST_OAUTH_REF: ref}, stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? accept() : reject(Error('credential initialization fixture failed')));
  });
}

test('restrictive umask refuses initialization without leaving an owned lock', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens);
  await storeProcess(f, ref, `
    const previous=process.umask(0o777);
    try {
      await assert.rejects(store.withCredential(ref,binding,async()=>({value:null})),
        {code:'OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED'});
    } finally { process.umask(previous); }
    await assert.rejects(fs.lstat(path),{code:'ENOENT'});
    await store.withCredential(ref,binding,async()=>({value:null}));
  `);
  assert.deepEqual(await fs.readdir(f.directory), [ref + '.json']);
});

test('initial stat, partial nonce write and sync faults release only the owned lock', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens);
  for (const method of ['stat', 'writeFile', 'sync']) await storeProcess(f, ref, `
    const probe=await fs.open(join(directory,'probe'),'wx',0o600);
    const prototype=Object.getPrototypeOf(probe), method=${JSON.stringify(method)}, original=prototype[method];
    await probe.close(); await fs.unlink(join(directory,'probe'));
    let injected=false, called=false;
    prototype[method]=async function(...args){
      if(!injected){
        injected=true;
        if(method==='writeFile') await original.call(this,String(args[0]).slice(0,8));
        throw Object.assign(new Error('synthetic filesystem fault'),{code:'EIO'});
      }
      return original.apply(this,args);
    };
    try {
      await assert.rejects(store.withCredential(ref,binding,async()=>{called=true;return {value:null};}),
        {code:'OAUTH_CREDENTIAL_STORAGE_FAILED'});
    } finally { prototype[method]=original; }
    assert.equal(injected,true); assert.equal(called,false);
    await assert.rejects(fs.lstat(path),{code:'ENOENT'});
    await store.withCredential(ref,binding,async()=>({value:null}));
  `);
  assert.equal((await f.store.read(ref, binding)).revision, 1);
  assert.deepEqual(await fs.readdir(f.directory), [ref + '.json']);
});

test('initialization failure never removes a replacement lock', async t => {
  const f = await fixture(t), ref = await f.store.create(binding, tokens);
  await storeProcess(f, ref, `
    const probe=await fs.open(join(directory,'probe'),'wx',0o600);
    const prototype=Object.getPrototypeOf(probe), original=prototype.writeFile;
    await probe.close(); await fs.unlink(join(directory,'probe'));
    let injected=false;
    prototype.writeFile=async function(...args){
      if(!injected){
        injected=true;
        await fs.unlink(path); await fs.writeFile(path,'replacement-owner',{mode:0o600});
        throw Object.assign(new Error('synthetic filesystem fault'),{code:'EIO'});
      }
      return original.apply(this,args);
    };
    try {
      await assert.rejects(store.withCredential(ref,binding,async()=>({value:null})),
        {code:'OAUTH_CREDENTIAL_STORAGE_FAILED'});
    } finally { prototype.writeFile=original; }
    assert.equal(await fs.readFile(path,'utf8'),'replacement-owner');
    await assert.rejects(store.withCredential(ref,binding,async()=>({value:null})),{code:'OAUTH_CREDENTIAL_LOCKED'});
    await fs.unlink(path);
  `);
  assert.deepEqual(await fs.readdir(f.directory), [ref + '.json']);
});
