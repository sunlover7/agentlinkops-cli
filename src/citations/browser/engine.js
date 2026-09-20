// The browser engine provider: one AI surface, measured through a real
// Camoufox-driven Firefox at consumer URLs, as our citation adapter contract.
//
// Everything here follows the DP-0031 contract's posture rules: a fresh
// browser context per sample (session history can never contaminate the
// panel), the vendored oneglanse per-engine configs for wait/extract/citations
// (MIT, attributed), our proxy from AGENTLINKOPS_PROXY_URL, and a screenshot
// captured into evidence on every run so an observation is never just a claim.
//
// This module imports playwright-core lazily: a CLI install without the
// browser tooling still runs every non-browser engine, and `citation doctor`
// reports the gap instead of the whole CLI failing to load.
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineError } from '../adapter.js';
import {createProxyAdmission,proxyFailureReason} from './proxy-admission.js';

const MODULE_LOADERS = {
  'playwright-core': () => import('playwright-core'),
  'node:fs/promises': () => import('node:fs/promises'),
  './gen/core/providers/index.js': () => import('./gen/core/providers/index.js'),
  './providers.js': () => import('./providers.js'),
  './gen/lib/browser/camoufox.js': () => import('./gen/lib/browser/camoufox.js'),
  './gen/lib/browser/display.js': () => import('./gen/lib/browser/display.js'),
  './shims/utils.js': () => import('./shims/utils.js'),
  './gen/lib/browser/domOps.js': () => import('./gen/lib/browser/domOps.js'),
};
const lazy = async path => {
  if (!MODULE_LOADERS[path]) throw new Error('Unsupported browser module');
  return MODULE_LOADERS[path]();
};

let playwrightFirefox = null;
async function firefox() {
  if (!playwrightFirefox) {
    try {
      playwrightFirefox = (await lazy('playwright-core')).firefox;
    } catch (cause) {
      throw new EngineError('playwright-core is not installed; browser engines need it (npm install playwright-core)', { cause });
    }
  }
  return playwrightFirefox;
}

export const BROWSER_PROVIDERS = Object.freeze(['chatgpt', 'perplexity', 'gemini', 'claude', 'ai-overview', 'grok', 'copilot', 'bing', 'duckai']);

// Per-engine nominal estimates for the pre-call budget check. Measured from
// actual proxy burn during the 2026-09-17/18 sessions: browser engines burn
// 3-8 MB per observation (full page + assets) while the duck HTTP lane uses
// kilobytes. These are the estimates the cap enforces against, checked BEFORE
// each call. These are estimates, not metered bandwidth or a hard invoice cap.
const ENGINE_NOMINAL_COST = Object.freeze({
  chatgpt: 0.03, 'ai-overview': 0.03, copilot: 0.03, grok: 0.03,
  gemini: 0.03, claude: 0.03, perplexity: 0.02, bing: 0.02,
  duckai: 0.001,
});
const DEFAULT_NOMINAL_COST = 0.03;

export function createBrowserEngine({ engineName, env = process.env, onEvent = () => {}, runtime = {} } = {}) {
  if (!BROWSER_PROVIDERS.includes(engineName)) {
    throw new EngineError(`unknown browser engine: ${engineName} (known: ${BROWSER_PROVIDERS.join(', ')})`);
  }
  const authentication = env.AGENTLINKOPS_BROWSER_AUTH ?? 'accountless';
  if (!['accountless', 'saved-session'].includes(authentication)) {
    throw Object.assign(new EngineError('Unsupported browser authentication policy.'), { code: 'BROWSER_AUTH_POLICY_INVALID' });
  }
  // The vendored resolver reads process.env directly; arbitrary launch/profile
  // and extension overrides must not reintroduce ambient identity.
  const assertAccountlessLaunch = () => {
    if (authentication === 'accountless' && ['CAMOUFOX_EXTRA_LAUNCH_JSON', 'CAMOUFOX_ENV_JSON', 'CAMOUFOX_ADDONS', 'CAMOUFOX_ARGS', 'CAMOUFOX_FIREFOX_USER_PREFS_JSON'].some(key => env[key] || process.env[key])) {
      throw Object.assign(new EngineError('Accountless measurement does not accept custom browser launch or extension overrides.'), { code: 'BROWSER_AUTH_POLICY_INVALID' });
    }
  };
  assertAccountlessLaunch();
  const identity = { engine: engineName, provider: 'web-own-browser', model: engineName };
  const sessionDir = runtime.sessionDir ?? join(homedir(), '.agentlinkops', 'citations', 'sessions');
  const load = runtime.loadModule ?? lazy;
  const platform = runtime.platform ?? process.platform;
  const event=async text=>{
    let timer;
    try{await Promise.race([Promise.resolve().then(()=>onEvent(text)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error()),runtime.supplierTimeoutMs??5000);})]);}
    catch{throw new EngineError('Browser event reporting failed.');}
    finally{clearTimeout(timer);}
  };

  const admission=createProxyAdmission({engine:engineName,env,supplier:runtime.proxySupplier,now:runtime.now,onReceipt:runtime.onEgressReceipt,timeoutMs:runtime.supplierTimeoutMs});
  let running=false,contextCleanupFailed=false;
  let browserHandle = null;   // { browser, cleanup } for the whole epoch
  let displayHandle = null;
  let providerConfig = null;
  async function closeQuietly(action) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(action).then(() => true, () => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), runtime.cleanupTimeoutMs ?? 5000); })]); }
    finally { clearTimeout(timer); }
  }

  async function ensureProviderConfig() {
    if (providerConfig) return providerConfig;
    const { PROVIDER_CONFIGS } = await load('./gen/core/providers/index.js');
    const { OWN_PROVIDER_CONFIGS } = await load('./providers.js');
    providerConfig = OWN_PROVIDER_CONFIGS[engineName] ?? PROVIDER_CONFIGS[engineName];
    if (!providerConfig) throw new EngineError(`no provider config for ${engineName}`);
    return providerConfig;
  }

  async function ensureBrowser() {
    if (browserHandle) return browserHandle;
    const [{ resolveCamoufoxLaunchOptions }, display, fw] = [
      await load('./gen/lib/browser/camoufox.js'),
      await load('./gen/lib/browser/display.js'),
      runtime.firefox ?? await firefox(),
    ];

    // Linux without a display gets the vendored self-bootstrapped Xvfb — the
    // engines that block headless render headfully inside a virtual display.
    if (platform === 'linux' && !display.detectDisplay()) {
      displayHandle = await display.ensureDisplay({ allowExistingDisplay: false });
      await event(`display: ${displayHandle.display}`);
    }

    const proxy = admission.proxy;
    await event(proxy?'egress: proxy-required':'egress: direct-diagnostic');

    assertAccountlessLaunch();
    const options = await resolveCamoufoxLaunchOptions({
      provider: engineName,
      proxy: proxy ?? undefined,
      // The virtual display handle must travel into the launch payload: the
      // resolver exports DISPLAY for the browser process it configures.
      display: displayHandle?.display,
      // "virtual" on Linux = headful Firefox inside Xvfb; true headless is the
      // detection magnet the research warned about.
      headlessMode: platform === 'linux' ? 'virtual' : 'headful',
    });
    const launchOpts = { ...options, executablePath: options.executablePath };
    if (proxy) launchOpts.proxy = proxy;
    admission.assertReady();
    assertAccountlessLaunch();
    const browser = await fw.launch(launchOpts);

    browserHandle = {
      browser,
      cleanup: async () => {
        const browserClosed=await closeQuietly(() => browser.close());
        const displayClosed=await closeQuietly(() => displayHandle?.cleanup?.());
        displayHandle = null;
        if(browserClosed)contextCleanupFailed=false;
        return browserClosed&&displayClosed;
      },
    };
    return browserHandle;
  }

  async function loadStorageState() {
    // Accountless measurement never opens session files, even when they exist.
    if (authentication === 'accountless') return undefined;
    try {
      const { readFile } = await load('node:fs/promises');
      return JSON.parse(await readFile(join(sessionDir, `${engineName}.json`), 'utf8'));
    } catch {
      return undefined; // anonymous session: several surfaces work logged-out
    }
  }

  // Stock playwright-core editor finder. The vendored finder checks
  // Locator.getEditableState(), a patchright-only API that silently nulls on
  // stock playwright and rejects every candidate; this version expresses the
  // same intent (visible, sized, editable, enabled) with portable calls.
  // Pierces shadow DOM because some surfaces nest their composer inside one.
  async function findEditor(page, selectors) {
    for (const selector of selectors) {
      const nodes = page.locator(selector);
      const count = await nodes.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const el = nodes.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.width < 8 || box.height < 8) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        if (!(await el.isEditable().catch(() => false))) continue;
        if (!(await el.isEnabled().catch(() => false))) continue;
        return { locator: el, selector };
      }
    }
    // Shadow DOM fallback: pierce roots for composer elements not reachable
    // through the document-level selectors above.
    const shadowSpot = await page.evaluate(() => {
      const all = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')) all.push(el);
        for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); }
      };
      walk(document);
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width > 60 && r.height > 10) return { found: true, tag: el.tagName };
      }
      return { found: false };
    }).catch(() => ({ found: false }));
    if (shadowSpot.found) {
      // A composer exists in shadow DOM but our selectors can't reach it.
      // Fall through to the generic locator on the broadest selector.
      const broad = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
      if (await broad.isVisible().catch(() => false)) return { locator: broad, selector: 'shadow-dom-fallback' };
    }
    return null;
  }

  const engine = {
    identity,
    estimateCostUsd: () => ENGINE_NOMINAL_COST[engineName] ?? DEFAULT_NOMINAL_COST,

    async run({ prompt }) {
      const config = await ensureProviderConfig();
      const { browser } = await ensureBrowser();
      admission.assertReady();
      const storageState = await loadStorageState();
      const context = await browser.newContext({
        storageState,
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });
      try {
      // Route-level asset stripping (opt out with AGENTLINKOPS_BROWSER_KEEP_ASSETS=1):
      // images and media are the bulk of the 3-8 MB measured per observation.
      // Fonts stay — font metrics are part of the fingerprint surface.
      if (env.AGENTLINKOPS_BROWSER_KEEP_ASSETS !== '1') {
        await context.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (type === 'image' || type === 'media') return route.abort();
          return route.continue();
        });
      }
        const page = await context.newPage();
        const { runPageDomOp } = await load('./gen/lib/browser/domOps.js');
        page.runDomOp = (operation, params = {}) => runPageDomOp(page, operation, params);
        let answer = '';
        page.setDefaultTimeout(45_000);

        if (config.navigateToPrompt) {
          await config.navigateToPrompt(page, prompt);
        } else if (engineName === 'grok') {
          // Probe-proven grok flow: the composer's position moves with each
          // randomized fingerprint, so its live rect is located in-page and
          // clicked at the computed center — never a fixed coordinate.
          await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForTimeout(12_000);
          let spot = null;
          for (let attempt = 0; attempt < 3 && !spot; attempt += 1) {
            spot = await page.evaluate(() => {
              // Pierce shadow DOM: grok's composer may live inside a shadow root.
              const els = [];
              const walk = (root) => {
                for (const el of root.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')) els.push(el);
                for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); }
              };
              walk(document);
              for (const el of els) {
                const r = el.getBoundingClientRect();
                if (r.width > 60 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(Math.max(r.height / 2, 12), 40)) };
              }
              return null;
            });
            if (!spot) await page.waitForTimeout(7000);
          }
          if (!spot) throw new EngineError('grok: no composer found after settle retries (surface may be gated or changed)', { retriable: true });
          await page.mouse.click(spot.x, spot.y);
          await page.waitForTimeout(1000);
          await page.keyboard.type(prompt, { delay: 90 });
          await page.waitForTimeout(1200);
          await page.keyboard.press('Enter');
        } else if (engineName === 'duckai') {
          // The page's own JS solves the VQD challenge; the chat call runs
          // in-page with native cookies and headers. Claude Haiku, anonymous.
          await page.waitForTimeout(6000);
          const { duckChat } = await load('./providers.js');
          const chat = await duckChat(page, prompt);
          if (!chat.message || chat.message.trim().length < 40) {
            throw new EngineError(`duckai: empty chat response (models seen: ${(chat.models ?? []).slice(0, 5).join(',')})`, { retriable: true });
          }
          answer = chat.message;
        } else if (engineName === 'bing') {
          // Pure navigation: the prompt IS the URL. No editor, no typing, no
          // modal — the generative answer block renders with its citations.
          await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(prompt)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await config.waitForResponse(page);
        } else {
          await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await config.postNavigationHook?.(page);

          // Hydration retry: first paint is not hydration. Poll for a real editor.
          const { PROVIDER_EDITOR_SELECTORS } = await load('./shims/utils.js');
          let editor = null;
          const editorDeadline = Date.now() + 50_000;
          while (!editor && Date.now() < editorDeadline) {
            await config.beforePromptHook?.(page).catch(() => {});
            editor = await findEditor(page, PROVIDER_EDITOR_SELECTORS[engineName]);
            if (!editor) await page.waitForTimeout(3000);
          }
          if (!editor) throw new EngineError(`${engineName}: no prompt editor found after hydration retries (surface may be gated or changed)`, { retriable: true });

          // Humanized typing: instant fill is a bot tell. Real keystrokes with
          // jittered cadence; fill stays as the recovery path when typing fails.
          await editor.locator.click().catch(() => {});
          await page.waitForTimeout(400);
          const typeDelay = 70 + Math.floor(Math.random() * 110);
          await editor.locator.pressSequentially(prompt, { delay: typeDelay }).catch(async () => {
            await editor.locator.fill(prompt);
          });
          await page.waitForTimeout(600);
          const typedCheck = await editor.locator.inputValue().catch(() => '');
          if (typedCheck.trim().length === 0) {
            await editor.locator.fill(prompt).catch(() => {});
          }
          await config.afterTypingHook?.(page);
          await config.beforeSubmitHook?.(page);

          // Submit: the surface's own send button when it exposes one; Enter fallback.
          // Submission is verified: the composer clears or a user turn appears.
          const send = await page.locator('button[aria-label="Send message"], button[data-testid="send-button"], button[aria-label*="Submit" i], button[aria-label*="Send" i]').first();
          if (await send.isVisible().catch(() => false)) { await send.click(); }
          else { await editor.locator.press('Enter'); }
          await page.waitForTimeout(2500);
        }
        await config.afterSubmitHook?.(page);

        await config.waitForResponse(page);
        if (!answer) answer = await config.extractResponse(page);
        if (!answer || answer.trim().length < 40) {
          const reason = engineName === 'bing'
            ? 'bing: no AI answer block rendered for this prompt (organic results only — never a citation verdict)'
            : `${engineName}: answer extracted empty`;
          throw new EngineError(reason, { retriable: true });        }
        let extractionFailed = config.citationExtraction === 'unsupported';
        const sources = await config.extractSources(page).catch(async () => {
          extractionFailed = true;
          await event('sources extraction failed; observation retained as unknown');
          return [];
        });
        const screenshotPng = await page.screenshot({ fullPage: false }).catch(() => null);

        return {
          engine: engineName,
          provider: 'web-own-browser',
          model: engineName,
          providerModelVersion: `${engineName}-web`,
          browserContext: { surface: 'web', authentication: storageState ? 'saved-session' : 'anonymous', account_tier: 'unknown' },
          answer,
          ...(extractionFailed ? { unknown: true, failure: { code: 'CITATION_EXTRACTION_UNAVAILABLE', message: 'Citation extraction was unavailable; this is not a confirmed absence' } } : {}),
          citations: (sources ?? []).map((s) => ({ url: s.url, ...(s.title || s.cited_text ? { title: s.title ?? s.cited_text } : {}) })).filter((c) => typeof c.url === 'string' && c.url.length > 0),
          fanOut: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          costEstimateUsd: ENGINE_NOMINAL_COST[engineName] ?? DEFAULT_NOMINAL_COST,
          screenshotPng,
        };
      } catch (cause) {
        if (cause instanceof EngineError) throw cause;
        const msg = String(cause?.message ?? cause);
        const retriable = /timeout|timed out|ERR_|net::|closed|Target closed/i.test(msg);
        const error = new EngineError(`${engineName}: browser run failed (${cause?.name === 'TypeError' ? 'compatibility error' : retriable ? 'timeout or connection error' : 'surface error'})`, { retriable, cause });
        error.unknown = true;
        throw error;
      } finally {
        if(!await closeQuietly(() => context.close()))contextCleanupFailed=true;
      }
    },

    // Called by the runner at epoch end.
    async close() {
      let confirmed=true;
      try{if(browserHandle)confirmed=await browserHandle.cleanup();}
      finally{
        const displayClosed=await closeQuietly(() => displayHandle?.cleanup?.());
        confirmed=confirmed&&displayClosed;displayHandle=null;browserHandle=null;
      }
      return confirmed;
    },
  };
  const sample=engine.run.bind(engine),closeBrowser=engine.close.bind(engine);
  const policyCodes=new Set(['BROWSER_AUTH_POLICY_INVALID','PROXY_REQUIRED','PROXY_POLICY_INVALID','PROXY_POLICY_CONFLICT','PROXY_CONFIGURATION_INVALID','PROXY_ACQUIRE_FAILED','PROXY_SUPPLIER_INVALID','PROXY_LEASE_INVALID','PROXY_LEASE_EXPIRED','PROXY_QUARANTINE_FAILED','PROXY_RELEASE_FAILED','PROXY_RECEIPT_FAILED','PROXY_CUSTODY_UNAVAILABLE','BROWSER_CLEANUP_UNCONFIRMED','BROWSER_RUN_IN_PROGRESS']);
  const safeError=cause=>{
    const code=policyCodes.has(cause?.code)?cause.code:'BROWSER_RUN_FAILED';
    const error=Object.assign(new EngineError(code==='BROWSER_RUN_FAILED'?'Browser sample failed.':'Browser admission or cleanup failed.',{retriable:code==='BROWSER_RUN_FAILED'&&cause?.retriable===true}),{code});
    if(code==='BROWSER_RUN_FAILED'||cause?.unknown===true)error.unknown=true;
    return error;
  };
  async function retire(phase,reason=null){
    const hadResources=Boolean(browserHandle||displayHandle||admission.proxy);let error,confirmed=false;
    try{
      try{confirmed=await closeBrowser();}catch{confirmed=false;}
      if(!confirmed)reason='cleanup_unconfirmed';
      try{if(hadResources)await admission.record({outcome:confirmed?'closed':'cleanup_unconfirmed',phase,reason});}catch(cause){error=cause;}
      try{if(reason)await admission.quarantine(reason);}catch(cause){error??=cause;}
      if(!confirmed)error??=Object.assign(new EngineError('Browser cleanup could not be confirmed.'),{code:'BROWSER_CLEANUP_UNCONFIRMED'});
    }finally{try{await admission.release();}catch(cause){error??=cause;}}
    if(error)throw safeError(error);
  }
  engine.run=async input=>{
    if(running)throw Object.assign(new EngineError('A browser sample is already running.'),{code:'BROWSER_RUN_IN_PROGRESS'});
    running=true;let result,error,reason=null,admitted=false;
    try{
      assertAccountlessLaunch();
      if(admission.expired)await retire('lease_expiry');
      await admission.begin();admitted=true;
      result=await sample(input);
      if(contextCleanupFailed)throw Object.assign(new EngineError('Browser cleanup could not be confirmed.'),{code:'BROWSER_CLEANUP_UNCONFIRMED'});
    }catch(cause){reason=proxyFailureReason(cause);error=safeError(cause);}
    try{
      if(admitted){
        try{const receipt=await admission.record({outcome:error?'failed':result?.unknown?'unknown':'observed',reason});if(result)result.egressReceipt=receipt;}
        catch(cause){error=safeError(cause);}
        if(error){try{await retire('failure_cleanup',reason);}catch(cause){error=safeError(cause);}}
      }
    }finally{running=false;}
    if(error)throw error;
    return result;
  };
  engine.close=async()=>{
    if(running)throw Object.assign(new EngineError('A browser sample is already running.'),{code:'BROWSER_RUN_IN_PROGRESS'});
    running=true;
    try{await retire('cleanup');}finally{running=false;}
  };
  engine.getEgressReceipts=admission.receipts;
  return engine;
}
