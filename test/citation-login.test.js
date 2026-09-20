import test from 'node:test';
import assert from 'node:assert/strict';
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
