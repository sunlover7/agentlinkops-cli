import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserEngine, BROWSER_PROVIDERS } from '../src/citations/browser/engine.js';
import { OWN_PROVIDER_CONFIGS } from '../src/citations/browser/providers.js';

let fixtureSequence=0;
function harness({ authPolicy, stalledCleanup = false, sourcesFail = false, unavailable = false, answer = 'A retained fixture answer long enough to be interpreted independently.' } = {}) {
  const contexts = []; const launches = []; const resolves = []; const events = []; let closed = 0; let displayClosed = 0; let stateReads = 0;
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
      if (path === 'node:fs/promises') return { readFile: async () => {stateReads++; return JSON.stringify({ cookies: [{ name: 'account-cookie', value: 'saved-state-secret', domain: '.chatgpt.com', path: '/' }], origins: [] });} };
      throw Error('Unexpected import ' + path);
    } };
  const engine = createBrowserEngine({ engineName: 'chatgpt', runtime, env: { ...(authPolicy === undefined ? {} : {AGENTLINKOPS_BROWSER_AUTH: authPolicy}), AGENTLINKOPS_PROXY_URL: `http://fixture-user-${++fixtureSequence}:fixture-secret@proxy.example.com:1234` }, onEvent: text => events.push(text) });
  return { engine, contexts, launches, resolves, events, closed: () => closed, displayClosed: () => displayClosed, stateReads: () => stateReads };
}
test('actual browser provider launches BrowserType, propagates display and isolates every sample', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) { const run = await h.engine.run({ prompt: 'fixture' }); assert.deepEqual(run.browserContext, { surface: 'web', authentication: 'anonymous', account_tier: 'unknown' }); assert.equal(run.citations.length, 1); assert.equal(run.citations[0].title, undefined); }
  assert.equal(h.stateReads(),0); assert.ok(h.contexts.every(context=>context.options.storageState===undefined));
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


test('explicit accountless policy ignores saved state; legacy use requires explicit opt-in',async()=>{
  const anonymous=harness({authPolicy:'accountless'});
  const run=await anonymous.engine.run({prompt:'fixture'});assert.equal(run.browserContext.authentication,'anonymous');assert.equal(anonymous.stateReads(),0);assert.equal(anonymous.contexts[0].options.storageState,undefined);await anonymous.engine.close();
  const legacy=harness({authPolicy:'saved-session'});const saved=await legacy.engine.run({prompt:'fixture'});assert.equal(legacy.stateReads(),1);assert.equal(saved.browserContext.authentication,'saved-session');assert.equal(legacy.contexts[0].options.storageState.cookies[0].value,'saved-state-secret');assert.ok(!JSON.stringify(saved).includes('saved-state-secret'));await legacy.engine.close();
});

test('invalid authentication policy fails before any module, saved-state read, lease or browser launch',()=>{
  for(const value of ['', 'automatic', '../sessions', 'accountless\n', 'secret-policy-value']){
    let touched=0;assert.throws(()=>createBrowserEngine({engineName:'chatgpt',env:{AGENTLINKOPS_BROWSER_AUTH:value},runtime:{loadModule:()=>{touched++;},firefox:{launch:()=>{touched++;}},proxySupplier:{acquire:()=>{touched++;}}}}),error=>error.code==='BROWSER_AUTH_POLICY_INVALID'&&(!value||!error.message.includes(value)));assert.equal(touched,0);
  }
});


test('accountless policy rejects ambient profile and extension overrides without exposing values',()=>{
  for(const key of ['CAMOUFOX_EXTRA_LAUNCH_JSON','CAMOUFOX_ENV_JSON','CAMOUFOX_ADDONS','CAMOUFOX_ARGS','CAMOUFOX_FIREFOX_USER_PREFS_JSON']){
    const secret='profile-secret-sentinel';
    assert.throws(()=>createBrowserEngine({engineName:'chatgpt',env:{[key]:secret}}),e=>e.code==='BROWSER_AUTH_POLICY_INVALID'&&!String(e).includes(secret));
    const previous=process.env[key];process.env[key]=secret;
    try {assert.throws(()=>createBrowserEngine({engineName:'chatgpt',env:{}}),e=>e.code==='BROWSER_AUTH_POLICY_INVALID'&&!String(e).includes(secret));}
    finally {if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
  }
});


test('late ambient profile override is refused before launch or session access',async()=>{
  const h=harness(),key='CAMOUFOX_ARGS',previous=process.env[key];
  process.env[key]='["-profile","/fixture/secret-profile"]';
  try{await assert.rejects(h.engine.run({prompt:'fixture'}),e=>e.code==='BROWSER_AUTH_POLICY_INVALID'&&!String(e).includes('secret-profile'));assert.equal(h.launches.length,0);assert.equal(h.stateReads(),0);assert.equal(h.contexts.length,0);}
  finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;await h.engine.close();}
});
