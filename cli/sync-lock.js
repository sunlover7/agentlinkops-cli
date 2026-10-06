import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigError } from './config.js';
import { nativeLock } from './native-lock.js';
const run = promisify(execFile);
const MAX = 4096;
const unknown = () => new ConfigError('Sync lock ownership is unknown; marker preserved. Confirm the original writer has stopped and recover from a copy of the ledger. Do not delete a live lock.');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function markerText(handle) {
  const buffer = Buffer.alloc(MAX + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX) throw unknown();
  return buffer.subarray(0, bytesRead).toString('utf8');
}
const validFile = s => s.isFile() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o022);
async function identity() {
  if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (process.platform === 'darwin') return (await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2000, maxBuffer: MAX })).stdout.trim();
  throw unknown();
}
async function birth() {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  return (await run('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { timeout: 2000, maxBuffer: MAX })).stdout.trim();
}
// Unknown/reused live PIDs remain protected. ESRCH is the only reclaiming probe.
function departed(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw unknown(); }
}
export async function acquireSyncLock(dir, command, { kernel = nativeLock, bootIdentity = identity, processBirth = birth, isDeparted = departed, afterMarkerCreated, markerName = 'sync.lock' } = {}) {
  if (typeof markerName !== 'string' || !markerName || markerName.length > 255 || /[\/\\\x00]/.test(markerName) || ['.', '..'].includes(markerName)) throw unknown();
  const osLock = await kernel(); // Unsupported/native failure precedes filesystem mutation.
  let root;
  try { root = await realpath(dir); }
  catch (error) { if (error.code === 'ENOENT') throw new ConfigError('No ledger here; run agentlinkops init first.'); throw unknown(); }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid() || rootInfo.mode & 0o022) throw unknown();
  const path = join(root, markerName), gatePath = join(root, markerName === 'sync.lock' ? '.sync-gate' : `.${markerName}.gate`);
  const ledgerIdentity = join(root, markerName);
  let gate, marker, owned, acquired = false;
  try {
    gate = await open(gatePath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const gateInfo = await gate.stat();
    if (!validFile(gateInfo) || !same(gateInfo, await lstat(gatePath))) throw unknown();
    if (!osLock.acquire(gate.fd)) throw new ConfigError('Sync writer is active; wait for it to finish. No lock was changed.');
    acquired = true;
    const checkGate = async () => {
      const currentGate = await lstat(gatePath), currentRoot = await lstat(root);
      if (!same(gateInfo, currentGate) || !validFile(currentGate) || !same(rootInfo, currentRoot) || currentRoot.uid !== process.getuid() || currentRoot.mode & 0o022) throw unknown();
    };
    await checkGate();
    const boot = await bootIdentity(), started = await processBirth();
    if (!boot || !started || boot.length > 256 || started.length > 256) throw unknown();
    try { marker = await open(path, constants.O_RDWR | constants.O_NOFOLLOW); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker) {
      const info = await marker.stat();
      if (!validFile(info) || info.size > MAX || !same(info, await lstat(path))) throw unknown();
      let prior;
      try { prior = JSON.parse(await markerText(marker)); } catch { throw unknown(); }
      if (Object.keys(prior).sort().join(',') !== 'boot,command,host,ledger,nonce,pid,started,uid,version'
        || prior.version !== 1 || prior.uid !== process.getuid() || prior.host !== hostname() || prior.boot !== boot
        || prior.ledger !== ledgerIdentity || !Number.isSafeInteger(prior.pid) || prior.pid < 1
        || typeof prior.started !== 'string' || !prior.started || prior.started.length > 256
        || !/^[0-9a-f-]{36}$/.test(prior.nonce) || typeof prior.command !== 'string' || prior.command.length > 64) throw unknown();
      if (!isDeparted(prior.pid)) throw new ConfigError('Sync marker names a live or reused process; marker preserved. Wait for the writer or inspect a ledger copy.');
      await checkGate();
      if (!same(info, await lstat(path))) throw unknown();
      await marker.close(); marker = null;
      await unlink(path);
    }
    await checkGate();
    marker = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await afterMarkerCreated?.();
    owned = { version: 1, nonce: randomUUID(), pid: process.pid, started, boot, uid: process.getuid(), host: hostname(), ledger: ledgerIdentity, command };
    await marker.writeFile(JSON.stringify(owned) + '\n');
    await marker.sync();
    const markerInfo = await marker.stat();
    await checkGate();
    return { path, async release() {
      try {
        await checkGate();
        const current = await lstat(path);
        if (!same(markerInfo, current) || !validFile(current)) throw unknown();
        const text = await markerText(marker);
        if (text !== JSON.stringify(owned) + '\n') throw unknown();
        await unlink(path);
      } finally { await marker.close(); await gate.close(); }
    } };
  } catch (error) {
    // Failed/partial marker initialization is deliberately preserved as unknown.
    await marker?.close(); await gate?.close();
    if (error instanceof ConfigError) throw error;
    if (error.code === 'ENOENT' && !acquired) throw new ConfigError('No ledger here; run agentlinkops init first.');
    throw unknown();
  }
}
