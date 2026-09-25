import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserEngine, BROWSER_PROVIDERS, guardDisplay, ensurePromptEntered, normalizePrompt, readChatgptSubmittedPrompt } from '../src/citations/browser/engine.js';
import { OWN_PROVIDER_CONFIGS } from '../src/citations/browser/providers.js';

let fixtureSequence=0;
function harness({ authPolicy, guard, displayCleanupFails = false, strayKinds, submittedPrompt, bindingValid = () => true, citationState = {found:true,groups:0,unresolved:false,sources:[]}, stalledCleanup = false, sourcesFail = false, unavailable = false, answer = 'A retained fixture answer long enough to be interpreted independently.' } = {}) {
  const contexts = []; const launches = []; const resolves = []; const events = []; let closed = 0; let displayClosed = 0; let stateReads = 0; let bindingsDisposed = 0;
  const config = { navigateToPrompt: async () => {}, waitForResponse: async () => {}, extractResponse: async page => page.runDomOp('response-text', {}),
    ...(unavailable ? { citationExtraction: 'unsupported' } : {}),
    extractSources: async () => { if (strayKinds) throw Object.assign(Error('secret-proxy-password'), { strayKinds }); if (sourcesFail) throw Error('secret-proxy-password'); return [{ url: 'https://example.com' }]; } };
  const browser = { async newContext(options) {
    const context = { options, closed: false, async route() {}, async close() { this.closed = true; if (stalledCleanup) return new Promise(() => {}); },
      async newPage() { return { setDefaultTimeout() {}, evaluate: async fn => (fn === readChatgptSubmittedPrompt && submittedPrompt !== undefined ? submittedPrompt : citationState),
        evaluateHandle: async()=>({evaluate:async fn=>fn({isCurrent:bindingValid}),dispose:async()=>{bindingsDisposed++;}}),
        screenshot: async () => Buffer.from('fixture-pixels') }; } };
    contexts.push(context); return context;
  }, async close() { closed++; if (stalledCleanup) return new Promise(() => {}); } };
  const runtime = { cleanupTimeoutMs: 5, platform: 'linux', sessionDir: '/fixture/sessions', guardDisplay: guard ?? (() => () => {}), firefox: { async launch(options) { launches.push(options); return browser; } },
    async loadModule(path) {
      if (path.endsWith('/providers/index.js')) return { PROVIDER_CONFIGS: { chatgpt: config } };
      if (path === './providers.js') return { OWN_PROVIDER_CONFIGS: {} };
      if (path.endsWith('/domOps.js')) return { runPageDomOp: async () => answer };
      if (path.endsWith('/camoufox.js')) return { resolveCamoufoxLaunchOptions: async options => { resolves.push(options); return { executablePath: '/fixture/firefox' }; } };
      if (path.endsWith('/display.js')) return { detectDisplay: () => false, ensureDisplay: async () => ({ display: ':991', cleanup: async () => { if (displayCleanupFails) throw Error('xvfb stuck'); displayClosed++; } }) };
      if (path === 'node:fs/promises') return { readFile: async () => {stateReads++; return JSON.stringify({ cookies: [{ name: 'account-cookie', value: 'saved-state-secret', domain: '.chatgpt.com', path: '/' }], origins: [] });} };
      throw Error('Unexpected import ' + path);
    } };
  const engine = createBrowserEngine({ engineName: 'chatgpt', runtime, env: { ...(authPolicy === undefined ? {} : {AGENTLINKOPS_BROWSER_AUTH: authPolicy}), AGENTLINKOPS_PROXY_URL: `http://fixture-user-${++fixtureSequence}:fixture-secret@proxy.example.com:1234` }, onEvent: text => events.push(text) });
  return { engine, contexts, launches, resolves, events, closed: () => closed, displayClosed: () => displayClosed, stateReads: () => stateReads, bindingsDisposed:()=>bindingsDisposed };
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
  assert.equal(h.bindingsDisposed(),1,'early empty-answer rejection explicitly releases its response binding');
  assert.equal(h.contexts[0].closed, true); await h.engine.close();
});
test('real ChatGPT citation guard retains answer and screenshot as unknown for unresolved anonymous pills', async () => {
  const h=harness({citationState:{found:true,anonymous:true,groups:3,unresolved:true,sources:[]}});
  const result=await h.engine.run({prompt:'fixture'});
  assert.equal(result.unknown,true);assert.equal(result.failure.code,'CITATION_EXTRACTION_UNAVAILABLE');
  assert.match(result.answer,/retained fixture answer/);assert.ok(result.screenshotPng.length);
  assert.deepEqual(result.citations,[]);assert.equal(h.contexts[0].closed,true);await h.engine.close();
});
test('response binding changes retain the specific unknown code and never pair stale answer with citations',async()=>{
  for(const invalidAt of [2,3]){
    let checks=0;const h=harness({bindingValid:()=>++checks!==invalidAt});
    if(invalidAt===2)await assert.rejects(h.engine.run({prompt:'fixture'}),e=>e.code==='CITATION_EXTRACTION_UNAVAILABLE'&&e.unknown===true&&e.retriable===false&&e.message==='Citation binding or extraction was unavailable.');
    else {const result=await h.engine.run({prompt:'fixture'});assert.equal(result.unknown,true);assert.equal(result.failure.code,'CITATION_EXTRACTION_UNAVAILABLE');assert.deepEqual(result.citations,[]);assert.ok(result.screenshotPng.length);}
    assert.equal(h.contexts[0].closed,true);await h.engine.close();
  }
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

test('display watchdog arms on the Xvfb lock pid and is retired only after a confirmed close', async () => {
  const spawned = [];
  const release = guardDisplay(':604', { parentPid: 4242, readLock: path => { assert.equal(path, '/tmp/.X604-lock'); return '      9876\n'; },
    spawnProcess: (cmd, args, options) => { const child = { killed: 0, unref() { this.unrefd = true; }, kill() { this.killed++; } }; spawned.push({ cmd, args, options, child }); return child; } });
  assert.equal(spawned.length, 1);
  const [{ cmd, args, options, child }] = spawned;
  assert.equal(cmd, '/bin/sh'); assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore'); assert.equal(child.unrefd, true);
  assert.match(args[1], /kill -0 4242/); assert.match(args[1], /\/proc\/9876\/comm/); assert.match(args[1], /= Xvfb \] && kill 9876$/);
  release(); assert.equal(child.killed, 1);
  const none = []; const spawnProcess = () => { none.push(1); return {}; };
  guardDisplay(':604', { spawnProcess, readLock: () => { throw Error('ENOENT'); } });
  guardDisplay(':604', { spawnProcess, readLock: () => '1' });
  guardDisplay(':x', { spawnProcess, readLock: () => '9876' });
  assert.equal(none.length, 0, 'no lock, pid 1 or a malformed display arms nothing');

  const calls = []; const guard = display => { calls.push(display); return () => calls.push('released'); };
  const h = harness({ guard }); await h.engine.run({ prompt: 'fixture' });
  assert.deepEqual(calls, [':991']); await h.engine.close(); assert.deepEqual(calls, [':991', 'released']);
  const armed = []; const stuck = harness({ displayCleanupFails: true, guard: display => { armed.push(display); return () => armed.push('released'); } });
  await stuck.engine.run({ prompt: 'fixture' });
  await assert.rejects(stuck.engine.close(), error => error.code === 'BROWSER_CLEANUP_UNCONFIRMED');
  assert.deepEqual(armed, [':991'], 'an unconfirmed display close keeps the watchdog armed');
});
test('display watchdog ends an orphaned Xvfb after its parent dies (Linux)', { skip: !existsSync('/proc/self/comm') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xvfb-guard-'));
  const fake = join(dir, 'Xvfb'); copyFileSync('/bin/sleep', fake);
  const xvfb = spawn(fake, ['60'], { stdio: 'ignore' }); const parent = spawn('/bin/sleep', ['1'], { stdio: 'ignore' });
  const exited = new Promise(resolve => xvfb.once('exit', (code, signal) => resolve(signal)));
  try {
    guardDisplay(':1', { parentPid: parent.pid, readLock: () => String(xvfb.pid) });
    const signal = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('still-running'), 9000))]);
    assert.equal(signal, 'SIGTERM');
  } finally { xvfb.kill('SIGKILL'); parent.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown extraction names the unrecognized element kinds in its event, never the error text', async () => {
  const h = harness({ strayKinds: { a: 2, sup: 1 } }); const run = await h.engine.run({ prompt: 'fixture' });
  assert.equal(run.unknown, true); assert.equal(run.failure.code, 'CITATION_EXTRACTION_UNAVAILABLE');
  assert.ok(h.events.includes('sources extraction failed; observation retained as unknown (unrecognized: ax2, supx1)'));
  assert.ok(!h.events.join('').includes('secret-proxy-password')); await h.engine.close();
  const plain = harness({ sourcesFail: true }); await plain.engine.run({ prompt: 'fixture' });
  assert.ok(plain.events.includes('sources extraction failed; observation retained as unknown')); await plain.engine.close();
});

test('a ChatGPT failure message becomes a retriable unknown, never a not-cited observation', async () => {
  const h = harness({ answer: '#### ChatGPT said:\n\nSomething went wrong. If this issue persists please contact us through our help center at help.openai.com.' });
  await assert.rejects(h.engine.run({ prompt: 'fixture' }), error => error.code === 'BROWSER_RUN_FAILED' && error.unknown === true && error.retriable === true);
  assert.equal(h.contexts[0].closed, true); await h.engine.close();
});

test('a prompt must be entered whole before submit: one fill recovers, otherwise the sample fails', async () => {
  const run = async (reads, fillWorks = true) => { const seen = [...reads]; let filled = 0;
    const result = await ensurePromptEntered('tools for monitoring lost backlinks', { readComposer: async () => seen.shift(), fill: async () => { filled++; if (!fillWorks) return; } });
    return { result, filled }; };
  assert.deepEqual(await run(['tools for monitoring lost backlinks']), { result: 'typed', filled: 0 });
  assert.deepEqual(await run(['tools for monitoring lost b', ' tools  for monitoring lost backlinks ']), { result: 'filled', filled: 1 });
  await assert.rejects(run(['tools for monitoring lost b', 'tools for monitoring lost b'], false), error => error.retriable === true && /entered completely/.test(error.message));
  assert.equal(normalizePrompt('You said:\n\nwhat is  backlink monitoring'), 'what is backlink monitoring');
});
test('an answer to a different submitted prompt is never an observation', async () => {
  const ok = harness({ submittedPrompt: 'You said:\nfixture' }); const run = await ok.engine.run({ prompt: 'fixture' });
  assert.equal(run.answer.length > 0, true); await ok.engine.close();
  const truncated = harness({ submittedPrompt: 'fixt' });
  await assert.rejects(truncated.engine.run({ prompt: 'fixture' }), error => error.code === 'BROWSER_RUN_FAILED' && error.unknown === true && error.retriable === true);
  assert.equal(truncated.contexts[0].closed, true); await truncated.engine.close();
  const unread = harness(); await unread.engine.run({ prompt: 'fixture' });
  assert.ok(unread.events.includes('submitted prompt could not be read; not verified')); await unread.engine.close();
});
