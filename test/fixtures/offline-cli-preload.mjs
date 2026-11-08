// Test-only preload for spawned CLI processes (node --import <this file> bin/...): the process
// reads no key saved by `agentlinkops connect` and reaches no real cloud, so a suite run on a
// machine where someone has connected never resolves their key or calls production.
//
// - /usr/bin/security (the macOS Keychain) is replaced by a child that exits 44, which is what
//   `security` returns for "no such item". Pair this with a scratch HOME for the Linux store.
// - fetch to anything other than a loopback host fails as a network error before any request.
// Production never imports this file.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const KEYCHAIN = '/usr/bin/security';
const noItem = ['-e', 'process.exit(44)'];
for (const name of ['execFile', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = (...call) => call[0] === KEYCHAIN
    ? original.call(childProcess, process.execPath, noItem, ...call.slice(2))
    : original.apply(childProcess, call);
}
syncBuiltinESMExports();

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!LOOPBACK.has(url.hostname)) {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`offline test preload refused ${url.host}`), { code: 'ENOTFOUND' }) });
  }
  return realFetch(input, init);
};
