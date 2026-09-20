import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserEngine, BROWSER_PROVIDERS } from '../src/citations/browser/engine.js';
import { OWN_PROVIDER_CONFIGS } from '../src/citations/browser/providers.js';

function harness({ stalledCleanup = false, sourcesFail = false, unavailable = false, answer = 'A retained fixture answer long enough to be interpreted independently.' } = {}) {
  const contexts = []; const launches = []; const resolves = []; const events = []; let closed = 0; let displayClosed = 0;
  const config = { navigateToPrompt: async () => {}, waitForResponse: async () => {}, extractResponse: async page => page.runDomOp('response-text', {}),
    ...(unavailable ? { citationExtraction: 'unsupported' } : {}),
    extractSources: async () => { if (sourcesFail) throw Error('secret-proxy-password'); return [{ url: 'https://example.com' }]; } };
  const browser = { async newContext(options) {
    const context = { options, closed: false, async route() {}, async close() { this.closed = true; if (stalledCleanup) return new Promise(() => {}); },
      async newPage() { return { setDefaultTimeout() {}, screenshot: async () => Buffer.from('fixture-pixels') }; } };
    contexts.push(context); return context;
  }, async close() { closed++; if (stalledCleanup) return new Promise(() => {}); } };
  const runtime = { cleanupTimeoutMs: 5, platform: 'linux', sessionDir: '/fixture/sessions', firefox: { async launch(options) { launches.push(options); return browser; } },
    async loadModule(path) {
      if (path.endsWith('/providers/index.js')) return { PROVIDER_CONFIGS: { chatgpt: config } };
      if (path === './providers.js') return { OWN_PROVIDER_CONFIGS: {} };
      if (path.endsWith('/domOps.js')) return { runPageDomOp: async () => answer };
      if (path.endsWith('/camoufox.js')) return { resolveCamoufoxLaunchOptions: async options => { resolves.push(options); return { executablePath: '/fixture/firefox' }; } };
      if (path.endsWith('/display.js')) return { detectDisplay: () => false, ensureDisplay: async () => ({ display: ':991', cleanup: async () => { displayClosed++; } }) };
      if (path === 'node:fs/promises') return { readFile: async () => JSON.stringify({ cookies: [], origins: [] }) };
      throw Error('Unexpected import ' + path);
    } };
  const engine = createBrowserEngine({ engineName: 'chatgpt', runtime, env: { AGENTLINKOPS_PROXY_URL: 'http://fixture-user:fixture-secret@proxy.example.com:1234' }, onEvent: text => events.push(text) });
  return { engine, contexts, launches, resolves, events, closed: () => closed, displayClosed: () => displayClosed };
}
test('actual browser provider launches BrowserType, propagates display and isolates every sample', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) { const run = await h.engine.run({ prompt: 'fixture' }); assert.deepEqual(run.browserContext, { surface: 'web', authentication: 'saved-session', account_tier: 'unknown' }); assert.equal(run.citations.length, 1); assert.equal(run.citations[0].title, undefined); }
  assert.equal(h.launches.length, 1); assert.equal(h.resolves[0].display, ':991'); assert.equal(h.contexts.length, 2);
  assert.ok(h.contexts.every(context => context.closed)); assert.notEqual(h.contexts[0], h.contexts[1]);
  assert.ok(!h.events.join('').includes('fixture-secret'));
  await h.engine.close(); assert.equal(h.closed(), 1); assert.equal(h.displayClosed(), 1);
});
test('failed or unsupported citation extraction retains evidence as unknown, never a negative', async () => {
  for (const options of [{ sourcesFail: true }, { unavailable: true }]) {
    const h = harness(options); const run = await h.engine.run({ prompt: 'fixture' });
    assert.equal(run.unknown, true); assert.equal(run.failure.code, 'CITATION_EXTRACTION_UNAVAILABLE');
    assert.ok(run.screenshotPng.length); assert.ok(!h.events.join('').includes('secret-proxy-password')); await h.engine.close();
  }
  assert.ok(BROWSER_PROVIDERS.includes('grok')); assert.equal(OWN_PROVIDER_CONFIGS.grok.citationExtraction, 'unsupported');
});
test('empty scoped answer cannot fall back to page chrome; context still closes', async () => {
  const h = harness({ answer: '' });
  await assert.rejects(h.engine.run({ prompt: 'fixture' }), error=>error.code==='BROWSER_RUN_FAILED');
  assert.equal(h.contexts[0].closed, true); await h.engine.close();
});

test('vendored response waiter has the required debug logger', async () => {
  const { logger } = await import('../src/citations/browser/shims/utils.js');
  assert.equal(typeof logger.debug, 'function');
});

test('stalled browser cleanup remains bounded and tears down its display', { timeout: 1000 }, async () => {
  const h = harness({ stalledCleanup: true });
  await assert.rejects(h.engine.run({ prompt: 'fixture' }),error=>error.code==='BROWSER_CLEANUP_UNCONFIRMED');
  await h.engine.close();
  assert.equal(h.displayClosed(), 1);
});
