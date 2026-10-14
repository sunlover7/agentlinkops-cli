// Where `agentlinkops connect` keeps the API key a person pastes, so cloud commands work in any
// folder without environment variables. Never inside a repository:
//
//   macOS  the login Keychain, through /usr/bin/security. `security -i` takes the key on stdin,
//          so it never appears in a process listing.
//   Linux  ~/.agentlinkops/keys/, one file per cloud origin, mode 600 in a mode 700 directory
//          owned by the person; anything looser is ignored rather than trusted.
//   other  nothing is saved; AGENTLINKOPS_API_KEY keeps working everywhere.
//
// One key per cloud origin. Reads are synchronous because cloudConnection() is.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ConfigError } from './config.js';

export const API_KEY_PATTERN = /^lt_[0-9a-f]{64}$/;
// main() attaches the reader to the environment object it hands every command, under this
// symbol: it never reaches a child process, a JSON dump or a test that passes its own env.
export const STORED_KEY = Symbol.for('agentlinkops.storedKey');

const SECURITY = '/usr/bin/security';
const SERVICE = 'agentlinkops-cli';
// An origin is a Keychain account name and a file-name input: canonical https only, no spaces
// or quotes, so it can sit unquoted in a `security -i` command line.
const canonical = origin => {
  try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin && !/[\s"'\\]/.test(origin); }
  catch { return false; }
};

const runSync = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
const run = (file, args, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { encoding: 'utf8', timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin.end(input);
});

function keychainStore({ exec = runSync, execInput = run }) {
  const store = {
    where: 'your macOS Keychain',
    readSync(origin) {
      if (!canonical(origin)) return null;
      try {
        const key = exec(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', origin, '-w']).trim();
        return API_KEY_PATTERN.test(key) ? key : null;
      } catch { return null; } // 44: no such item. Anything else reads as no saved key.
    },
    async save(origin, key) {
      if (!canonical(origin) || !API_KEY_PATTERN.test(key)) throw new ConfigError('Only a complete API key for an https origin can be saved.');
      await execInput(SECURITY, ['-i'], `add-generic-password -U -s ${SERVICE} -a ${origin} -w ${key}\n`).catch(() => {});
      // `security -i` reports per-command failures on its own output, so read the key back.
      if (store.readSync(origin) !== key) throw new ConfigError('The key could not be saved in your macOS Keychain. Set AGENTLINKOPS_API_KEY instead.');
    },
    async remove(origin) {
      if (!canonical(origin)) return false;
      try { exec(SECURITY, ['delete-generic-password', '-s', SERVICE, '-a', origin]); return true; } catch { return false; }
    },
  };
  return store;
}

function fileStore({ home, uid = process.getuid?.() }) {
  const dir = join(home, '.agentlinkops', 'keys');
  const fileFor = origin => join(dir, `${createHash('sha256').update(origin).digest('hex').slice(0, 32)}.json`);
  const own = info => uid !== undefined && info.uid === uid;
  const privateDir = info => info.isDirectory() && own(info) && (info.mode & 0o777) === 0o700;
  const privateFile = info => info.isFile() && info.nlink === 1 && own(info) && (info.mode & 0o777) === 0o600;
  return {
    where: '~/.agentlinkops/keys (readable only by you)',
    readSync(origin) {
      if (!canonical(origin)) return null;
      try {
        if (!privateDir(lstatSync(dir)) || !privateFile(lstatSync(fileFor(origin)))) return null;
        const record = JSON.parse(readFileSync(fileFor(origin), 'utf8'));
        return record?.origin === origin && API_KEY_PATTERN.test(record.key) ? record.key : null;
      } catch { return null; }
    },
    async save(origin, key) {
      if (!canonical(origin) || !API_KEY_PATTERN.test(key)) throw new ConfigError('Only a complete API key for an https origin can be saved.');
      for (const path of [join(home, '.agentlinkops'), dir]) {
        try { await fs.mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!privateDir(await fs.lstat(dir))) throw new ConfigError(`${dir} must be a directory only you can open (mode 700). Fix it, or set AGENTLINKOPS_API_KEY instead.`);
      const path = fileFor(origin), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ origin, key })}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, path);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    },
    async remove(origin) {
      if (!canonical(origin)) return false;
      try { await fs.unlink(fileFor(origin)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
  };
}

const unsupported = {
  where: null,
  readSync: () => null,
  async save() { throw new ConfigError('This platform has no supported place to save a key yet. Set AGENTLINKOPS_API_KEY instead.'); },
  async remove() { return false; },
};

export function createKeyStore({ platform = process.platform, home = homedir(), exec, execInput, uid } = {}) {
  if (platform === 'darwin') return keychainStore({ exec, execInput });
  if (platform === 'linux' && typeof home === 'string' && isAbsolute(home)) return fileStore({ home, uid });
  return unsupported;
}

/** The environment a command sees, plus a reader for keys saved by `agentlinkops connect`. */
export function withStoredKeys(env, store) {
  if (!store) return env;
  return { ...env, [STORED_KEY]: origin => { const key = store.readSync(origin); return key ? { key, where: store.where } : null; } };
}
