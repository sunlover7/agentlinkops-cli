import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join, parse, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';

const MAX_BYTES = 300000;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function bindingOf(value) {
  if (!exact(value, ['issuer', 'resource', 'clientId'])) fail('OAUTH_CREDENTIAL_BINDING_INVALID');
  for (const key of ['issuer', 'resource']) {
    let url; try { url = new URL(value[key]); } catch { fail('OAUTH_CREDENTIAL_BINDING_INVALID'); }
    if (typeof value[key] !== 'string' || value[key].length > 4096 || url.protocol !== 'https:'
      || url.username || url.password || url.search || url.hash
      || (key === 'issuer' ? url.origin !== value[key] : url.href !== value[key] || url.pathname !== '/mcp'))
      fail('OAUTH_CREDENTIAL_BINDING_INVALID');
  }
  if (typeof value.clientId !== 'string' || !value.clientId || value.clientId.length > 2048
    || /[\s\x00-\x1f\x7f]/.test(value.clientId)) fail('OAUTH_CREDENTIAL_BINDING_INVALID');
  return {...value};
}
function tokensOf(value) {
  if (!exact(value, ['accessToken', 'refreshToken', 'expiresAt', 'scope'])) fail('OAUTH_CREDENTIAL_TOKENS_INVALID');
  for (const key of ['accessToken', 'refreshToken']) if (typeof value[key] !== 'string' || !value[key]
    || Buffer.byteLength(value[key]) > 65536 || /[\x00-\x20\x7f]/.test(value[key])) fail('OAUTH_CREDENTIAL_TOKENS_INVALID');
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || typeof value.scope !== 'string'
    || !value.scope || Buffer.byteLength(value.scope) > 4096 || !/^[A-Za-z0-9:._/-]+(?: [A-Za-z0-9:._/-]+)*$/.test(value.scope))
    fail('OAUTH_CREDENTIAL_TOKENS_INVALID');
  return {...value};
}
const reference = ref => { if (typeof ref !== 'string' || !/^oauth_[a-f0-9]{32}$/.test(ref)) fail('OAUTH_CREDENTIAL_REF_INVALID'); return ref; };
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameBinding = (a, b) => ['issuer', 'resource', 'clientId'].every(key => a[key] === b[key]);
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function createOAuthCredentialStore({home = homedir(), platform = process.platform, now = Date.now, lockTimeoutMs = 2000} = {}) {
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('\0')) fail('OAUTH_CREDENTIAL_HOME_INVALID');
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 10000) fail('OAUTH_CREDENTIAL_LOCK_BOUND_INVALID');
  const root = resolve(home), directory = join(root, '.agentlinkops', 'oauth');
  const uid = process.getuid?.();
  const privateStat = (info, mode) => info.uid === uid && (info.mode & 0o7777) === mode;
  async function directories() {
    // Darwin ACLs can grant access independently of these POSIX mode checks.
    // Other platforms require separately verified native credential custody.
    if (platform !== 'linux' || uid === undefined) fail('OAUTH_CREDENTIAL_STORAGE_UNSUPPORTED');
    let path = parse(root).root;
    for (const part of root.slice(path.length).split('/').filter(Boolean)) {
      path = join(path, part);
      const info = await fs.lstat(path);
      if (!info.isDirectory()) fail('OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED');
    }
    const homeInfo = await fs.lstat(root);
    if (homeInfo.uid !== uid) fail('OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED');
    for (const path of [join(root, '.agentlinkops'), directory]) {
      try { await fs.mkdir(path, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = await fs.lstat(path);
      if (!info.isDirectory() || !privateStat(info, 0o700)) fail('OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED');
    }
    return fs.lstat(directory);
  }
  async function unchangedDirectory(original) {
    if (!sameIdentity(original, await directories())) fail('OAUTH_CREDENTIAL_STORAGE_CHANGED');
  }
  async function syncDirectory() {
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  async function bytes(path, missing = false) {
    let handle;
    try {
      const info = await fs.lstat(path);
      if (!info.isFile() || info.nlink !== 1 || !privateStat(info, 0o600)) fail('OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED');
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (!sameIdentity(info, actual) || !actual.isFile() || actual.nlink !== 1 || !privateStat(actual, 0o600)) fail('OAUTH_CREDENTIAL_STORAGE_CHANGED');
      if (actual.size > MAX_BYTES) fail('OAUTH_CREDENTIAL_RECORD_INVALID');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > MAX_BYTES) fail('OAUTH_CREDENTIAL_RECORD_INVALID');
      return buffer.subarray(0, offset).toString('utf8');
    } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  function recordOf(text, binding) {
    let record; try { record = JSON.parse(text); } catch { fail('OAUTH_CREDENTIAL_RECORD_INVALID'); }
    if (!exact(record, ['version', 'revision', 'binding', 'tokens']) || record.version !== 1
      || !Number.isSafeInteger(record.revision) || record.revision < 1) fail('OAUTH_CREDENTIAL_RECORD_INVALID');
    const stored = bindingOf(record.binding), tokens = tokensOf(record.tokens);
    if (!sameBinding(stored, binding)) fail('OAUTH_CREDENTIAL_BINDING_MISMATCH');
    return {version: 1, revision: record.revision, binding: stored, tokens};
  }
  async function atomic(ref, record, before, original) {
    const path = join(directory, ref + '.json'), temporary = join(directory, '.' + ref + '.' + randomBytes(16).toString('hex') + '.tmp');
    let handle, owned = false;
    try {
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > MAX_BYTES) fail('OAUTH_CREDENTIAL_RECORD_INVALID');
      handle = await fs.open(temporary, 'wx', 0o600); owned = true;
      if (!privateStat(await handle.stat(), 0o600)) fail('OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED');
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = undefined;
      await unchangedDirectory(original);
      if (await bytes(path, true) !== before) fail('OAUTH_CREDENTIAL_STORAGE_CHANGED');
      if (before === null) { await fs.link(temporary, path); await fs.unlink(temporary); }
      else await fs.rename(temporary, path);
      owned = false;
      await syncDirectory();
    } finally { await handle?.close(); if (owned) await fs.unlink(temporary).catch(() => {}); }
  }
  async function locked(ref, work) {
    const original = await directories(), path = join(directory, ref + '.lock'), nonce = randomBytes(16).toString('hex');
    const deadline = Date.now() + lockTimeoutMs;
    let lock;
    while (!lock) {
      try { lock = await fs.open(path, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) fail('OAUTH_CREDENTIAL_LOCKED');
        await sleep(20);
      }
    }
    let identity, initialized = false;
    try {
      identity = await lock.stat();
      if (!privateStat(identity, 0o600)) fail('OAUTH_CREDENTIAL_PRIVATE_STORAGE_REQUIRED');
      await lock.writeFile(nonce); await lock.sync();
      initialized = true;
      return await work(original);
    } finally {
      try {
        // Before initialization, the open inode proves ownership even if the nonce write failed.
        identity ??= await lock.stat().catch(() => null);
        const current = await fs.lstat(path).catch(() => null);
        if (identity && current && sameIdentity(identity, current)
          && (!initialized || await bytes(path) === nonce)) await fs.unlink(path);
      } finally { await lock.close(); }
    }
  }
  async function safe(work) {
    try { return await work(); }
    catch (error) { if (typeof error.code === 'string' && error.code.startsWith('OAUTH_CREDENTIAL_')) throw error; fail('OAUTH_CREDENTIAL_STORAGE_FAILED'); }
  }
  return {
    async checkAvailability() { return safe(async () => { await directories(); }); },
    async create(binding, tokens) {
      binding = bindingOf(binding); tokens = tokensOf(tokens);
      return safe(async () => {
        const ref = 'oauth_' + randomBytes(16).toString('hex');
        await locked(ref, original => atomic(ref, {version: 1, revision: 1, binding, tokens}, null, original));
        return ref;
      });
    },
    async read(ref, binding) {
      reference(ref); binding = bindingOf(binding);
      return safe(async () => { const original = await directories(); const text = await bytes(join(directory, ref + '.json'), true);
        if (text === null) fail('OAUTH_CREDENTIAL_NOT_FOUND');
        const record = recordOf(text, binding); await unchangedDirectory(original); return record; });
    },
    async withCredential(ref, binding, callback) {
      reference(ref); binding = bindingOf(binding);
      if (typeof callback !== 'function') fail('OAUTH_CREDENTIAL_CALLBACK_INVALID');
      let callbackError, callbackFailed = false;
      try { return await safe(() => locked(ref, async original => {
        const path = join(directory, ref + '.json'), before = await bytes(path, true);
        if (before === null) fail('OAUTH_CREDENTIAL_NOT_FOUND');
        const record = recordOf(before, binding);
        let result; try { result = await callback(structuredClone(record)); } catch (error) { callbackFailed = true; callbackError = error; throw error; }
        if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'value')
          || Object.keys(result).some(key => !['tokens', 'value'].includes(key))) fail('OAUTH_CREDENTIAL_CALLBACK_INVALID');
        await unchangedDirectory(original);
        if (await bytes(path) !== before) fail('OAUTH_CREDENTIAL_STORAGE_CHANGED');
        if (result.tokens !== undefined) {
          if (record.revision === Number.MAX_SAFE_INTEGER) fail('OAUTH_CREDENTIAL_RECORD_INVALID');
          await atomic(ref, {...record, revision: record.revision + 1, tokens: tokensOf(result.tokens)}, before, original);
        }
        return result.value;
      })); } catch (error) { if (callbackFailed) throw callbackError; throw error; }
    },
    async remove(ref, binding) {
      reference(ref); binding = bindingOf(binding);
      return safe(() => locked(ref, async original => {
        const path = join(directory, ref + '.json'), before = await bytes(path, true);
        if (before === null) return false;
        recordOf(before, binding); await unchangedDirectory(original);
        if (await bytes(path) !== before) fail('OAUTH_CREDENTIAL_STORAGE_CHANGED');
        await fs.unlink(path); await syncDirectory(); return true;
      }));
    },
  };
}
