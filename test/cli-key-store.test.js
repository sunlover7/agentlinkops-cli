import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_PATTERN, STORED_KEY, createKeyStore, withStoredKeys } from '../cli/key-store.js';

// Where `agentlinkops connect` keeps a pasted API key: never in the repository, never in a
// process listing, and never trusted from a file someone else could have written.
const ORIGIN = 'https://app.agentlinkops.com', KEY = `lt_${'ab'.repeat(32)}`, OTHER = `lt_${'cd'.repeat(32)}`;

test('Linux keeps one key per origin in a private file and ignores anything looser', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'agentlinkops-keys-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createKeyStore({ platform: 'linux', home });
  assert.equal(store.readSync(ORIGIN), null);
  await store.save(ORIGIN, KEY);
  assert.equal(store.readSync(ORIGIN), KEY);
  assert.equal(store.readSync('https://staging.agentlinkops.com'), null, 'a key never travels to another origin');
  const dir = join(home, '.agentlinkops', 'keys'), [file] = await readdir(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
  assert.ok(!file.includes('agentlinkops.com'), 'the file name does not spell out the origin');
  await store.save(ORIGIN, OTHER);
  assert.equal(store.readSync(ORIGIN), OTHER, 'saving again replaces the key');
  assert.deepEqual(await readdir(dir), [file], 'and leaves no temporary file behind');
  await chmod(join(dir, file), 0o644);
  assert.equal(store.readSync(ORIGIN), null, 'a key file others can read is not used');
  await chmod(join(dir, file), 0o600);
  await writeFile(join(dir, file), JSON.stringify({ origin: 'https://attacker.example', key: OTHER }), { mode: 0o600 });
  assert.equal(store.readSync(ORIGIN), null, 'a record for another origin is not used');
  await chmod(dir, 0o755);
  await assert.rejects(store.save(ORIGIN, KEY), { name: 'ConfigError', message: /mode 700/ });
  await chmod(dir, 0o700);
  for (const [origin, key] of [['http://app.agentlinkops.com', KEY], [ORIGIN, 'lt_short'], ['https://app.agentlinkops.com/path', KEY]])
    await assert.rejects(store.save(origin, key), { name: 'ConfigError' });
  assert.equal(await store.remove(ORIGIN), true);
  assert.equal(store.readSync(ORIGIN), null);
});

test('macOS uses the login Keychain and passes the key on stdin, never in the arguments', async () => {
  const calls = [], items = new Map();
  const exec = (file, args) => {
    calls.push({ file, args });
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'find-generic-password') { if (!items.has(account)) throw Object.assign(new Error('not found'), { status: 44 }); return `${items.get(account)}\n`; }
    if (args[0] === 'delete-generic-password') { if (!items.delete(account)) throw new Error('not found'); return ''; }
    throw new Error(`unexpected ${args[0]}`);
  };
  const execInput = async (file, args, input) => {
    calls.push({ file, args, input });
    const [, , , service, , account, , key] = input.trim().split(' ');
    assert.equal(service, 'agentlinkops-cli');
    items.set(account, key);
    return '';
  };
  const store = createKeyStore({ platform: 'darwin', exec, execInput });
  assert.equal(store.where, 'your macOS Keychain');
  assert.equal(store.readSync(ORIGIN), null);
  await store.save(ORIGIN, KEY);
  assert.equal(store.readSync(ORIGIN), KEY);
  assert.ok(calls.every(call => call.file === '/usr/bin/security'));
  assert.ok(calls.every(call => !call.args.some(arg => arg.includes(KEY))), 'the key never appears in process arguments');
  assert.deepEqual(calls.find(call => call.input).args, ['-i']);
  items.set(ORIGIN, 'not-a-key');
  assert.equal(store.readSync(ORIGIN), null, 'whatever is stored must still look like an API key');
  const broken = createKeyStore({ platform: 'darwin', exec: () => { throw new Error('denied'); }, execInput: async () => '' });
  await assert.rejects(broken.save(ORIGIN, KEY), { name: 'ConfigError', message: /AGENTLINKOPS_API_KEY/ });
  assert.equal(await store.remove('https://evil.example "-w x'), false);
});

test('other platforms save nothing and point at the environment variable', async () => {
  const store = createKeyStore({ platform: 'win32', home: 'C:\\Users\\someone' });
  assert.equal(store.readSync(ORIGIN), null);
  await assert.rejects(store.save(ORIGIN, KEY), { name: 'ConfigError', message: /AGENTLINKOPS_API_KEY/ });
});

test('the reader rides on the environment object without reaching child processes or JSON', () => {
  const env = withStoredKeys({ PATH: '/usr/bin' }, { where: 'a store', readSync: origin => (origin === ORIGIN ? KEY : null) });
  assert.deepEqual(env[STORED_KEY](ORIGIN), { key: KEY, where: 'a store' });
  assert.equal(env[STORED_KEY]('https://other.example'), null);
  assert.deepEqual(Object.keys(env), ['PATH']);
  assert.equal(JSON.stringify(env), '{"PATH":"/usr/bin"}');
  const plain = { PATH: '/usr/bin' };
  assert.equal(withStoredKeys(plain, null), plain, 'no store, no change');
  assert.ok(API_KEY_PATTERN.test(KEY) && !API_KEY_PATTERN.test(`${KEY}\n`));
});
