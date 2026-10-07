import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginEngine, logoutEngine } from '../src/citations/login.js';

function fixture(sessionDir, { launchFails = false } = {}) {
  let closed = 0, displayClosed = 0;
  const page = { goto: async () => {} };
  const runtime = { sessionDir, platform: 'linux', log: () => {},
    display: { detectDisplay: () => false, ensureDisplay: async () => ({ display: ':990', cleanup: async () => { displayClosed++; } }) },
    camoufox: { resolveCamoufoxLaunchOptions: async options => { assert.equal(options.display, ':990'); return {}; } },
    playwright: { firefox: { launch: async () => {
      if (launchFails) throw Error('fixture launch failed');
      return { close: async () => { closed++; }, newContext: async () => ({ newPage: async () => page, storageState: async () => ({ cookies: [{ name: 'fixture-only', value: 'not-a-real-cookie' }], origins: [] }) }) };
    } } },
  };
  return { runtime, closed: () => closed, displayClosed: () => displayClosed };
}
test('login dry run persists private partial session and cleans browser/display', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-login-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture(join(dir, 'sessions'));
  const result = await loginEngine({ engineName: 'chatgpt', timeoutMs: 0, runtime: f.runtime });
  assert.equal(result.loggedIn, 'saved-partial-state'); assert.equal(result.cookies, 1);
  assert.equal((await stat(result.sessionPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(result.sessionPath, 'utf8')).cookies[0].name, 'fixture-only');
  assert.equal(f.closed(), 1); assert.equal(f.displayClosed(), 1);
});
test('launch failures clean the virtual display and invalid engine paths are refused', async () => {
  const f = fixture('/unused', { launchFails: true });
  await assert.rejects(loginEngine({ engineName: 'chatgpt', runtime: f.runtime }), /fixture launch failed/);
  assert.equal(f.displayClosed(), 1);
  await assert.rejects(loginEngine({ engineName: '../../elsewhere', runtime: f.runtime }), /unknown engine/);
  await assert.rejects(logoutEngine({ engineName: '../../elsewhere' }), /unknown engine/);
});

async function savedFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'citation-private-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionDir = join(dir, 'sessions');
  await fs.mkdir(sessionDir, { mode: 0o700 });
  const sessionPath = join(sessionDir, 'chatgpt.json');
  return { dir, sessionDir, sessionPath, ...fixture(sessionDir) };
}
const login = f => loginEngine({ engineName: 'chatgpt', timeoutMs: 0, runtime: f.runtime });
const cleaned = f => { assert.equal(f.closed(), 1); assert.equal(f.displayClosed(), 1); };

test('successful login atomically replaces an existing private session', async t => {
  const f = await savedFixture(t);
  await fs.writeFile(f.sessionPath, 'previous session', { mode: 0o600 });
  await login(f);
  assert.equal(JSON.parse(await readFile(f.sessionPath, 'utf8')).cookies[0].name, 'fixture-only');
  assert.equal((await stat(f.sessionPath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.sessionDir)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(f.sessionDir), ['chatgpt.json']);
  cleaned(f);
});

test('session symlink is refused without changing its target', async t => {
  const f = await savedFixture(t), target = join(f.dir, 'owner.json');
  await fs.writeFile(target, 'owner bytes', { mode: 0o600 });
  await fs.symlink(target, f.sessionPath);
  await assert.rejects(login(f), { code: 'PRIVATE_STORAGE_REQUIRED' });
  assert.equal(await readFile(target, 'utf8'), 'owner bytes');
  assert.ok((await fs.lstat(f.sessionPath)).isSymbolicLink()); cleaned(f);
});

for (const unsafe of ['directory-mode', 'directory-symlink', 'file-mode', 'file-directory']) {
  test(`refuses ${unsafe} before saving credentials`, async t => {
    const f = await savedFixture(t);
    if (unsafe === 'directory-mode') await fs.chmod(f.sessionDir, 0o755);
    if (unsafe === 'directory-symlink') {
      const target = join(f.dir, 'actual'); await fs.rename(f.sessionDir, target); await fs.symlink(target, f.sessionDir);
    }
    if (unsafe === 'file-mode') {
      await fs.writeFile(f.sessionPath, 'previous session', { mode: 0o644 });
      // Creation mode is masked by the caller's umask; make the unsafe fixture real.
      await fs.chmod(f.sessionPath, 0o644);
      assert.equal((await fs.lstat(f.sessionPath)).mode & 0o7777, 0o644);
    }
    if (unsafe === 'file-directory') await fs.mkdir(f.sessionPath);
    await assert.rejects(login(f), { code: 'PRIVATE_STORAGE_REQUIRED' });
    if (unsafe === 'file-mode') assert.equal(await readFile(f.sessionPath, 'utf8'), 'previous session');
    assert.ok(!(await fs.readdir(f.sessionDir)).some(name => name.endsWith('.tmp'))); cleaned(f);
  });
}

for (const failure of ['mode', 'write', 'sync', 'close', 'rename', 'concurrent']) {
  test(`${failure} failure preserves previous session and cleans temporary state`, async t => {
    const f = await savedFixture(t); let writes = 0;
    await fs.writeFile(f.sessionPath, 'previous session', { mode: 0o600 });
    f.runtime.sessionFs = { ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        return {
          stat: async () => { const info = await handle.stat(); return failure === 'mode' ? { isFile: () => true, mode: 0o100700 } : info; },
          writeFile: async value => { writes++; await handle.writeFile(failure === 'write' ? value.slice(0, 4) : value); if (failure === 'write') throw Error('fixture write failure'); },
          sync: () => { if (failure === 'sync') throw Error('fixture sync failure'); return handle.sync(); },
          close: async () => { await handle.close(); if (failure === 'close') throw Error('fixture close failure'); if (failure === 'concurrent') await fs.writeFile(f.sessionPath, 'new owner state'); },
        };
      },
      rename: async (...args) => { if (failure === 'rename') throw Error('fixture rename failure'); return fs.rename(...args); },
    };
    await assert.rejects(login(f), failure === 'mode' ? { code: 'PRIVATE_STORAGE_REQUIRED' } : failure === 'concurrent' ? { code: 'SESSION_CHANGED' } : /fixture/);
    assert.equal(await readFile(f.sessionPath, 'utf8'), failure === 'concurrent' ? 'new owner state' : 'previous session');
    if (failure === 'mode') assert.equal(writes, 0);
    assert.deepEqual(await fs.readdir(f.sessionDir), ['chatgpt.json']); cleaned(f);
  });
}
