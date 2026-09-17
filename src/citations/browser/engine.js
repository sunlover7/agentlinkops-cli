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
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineError } from '../adapter.js';

const lazy = async (path) => import(path);

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

export const BROWSER_PROVIDERS = Object.freeze(['chatgpt', 'perplexity', 'gemini', 'claude', 'ai-overview']);

// Nominal per-answer estimate: ~0.3 MB through a residential proxy at ~$7/GB,
// plus slack for the page itself. Checked BEFORE the run by the budget cap.
const NOMINAL_COST_USD = 0.004;

function parseProxyUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    throw new EngineError(`AGENTLINKOPS_PROXY_URL is not a valid proxy URL (length ${raw.length}, value never printed)`);
  }
}

export function createBrowserEngine({ engineName, env = process.env, onEvent = () => {} } = {}) {
  if (!BROWSER_PROVIDERS.includes(engineName)) {
    throw new EngineError(`unknown browser engine: ${engineName} (known: ${BROWSER_PROVIDERS.join(', ')})`);
  }
  const identity = { engine: engineName, provider: 'web-own-browser', model: engineName };
  const sessionDir = join(homedir(), '.agentlinkops', 'citations', 'sessions');

  let browserHandle = null;   // { browser, cleanup } for the whole epoch
  let displayHandle = null;
  let providerConfig = null;

  async function ensureProviderConfig() {
    if (providerConfig) return providerConfig;
    const { PROVIDER_CONFIGS } = await lazy('./gen/core/providers/index.js');
    providerConfig = PROVIDER_CONFIGS[engineName];
    if (!providerConfig) throw new EngineError(`no provider config for ${engineName}`);
    return providerConfig;
  }

  async function ensureBrowser() {
    if (browserHandle) return browserHandle;
    const [{ resolveCamoufoxLaunchOptions }, display, { firefox: launchFirefox }] = [
      await lazy('./gen/lib/browser/camoufox.js'),
      await lazy('./gen/lib/browser/display.js'),
      { firefox: await firefox() },
    ];

    // Linux without a display gets the vendored self-bootstrapped Xvfb — the
    // engines that block headless render headfully inside a virtual display.
    if (process.platform === 'linux' && !display.detectDisplay()) {
      displayHandle = await display.ensureDisplay({ allowExistingDisplay: false });
      onEvent(`display: ${displayHandle.display}`);
    }

    const proxy = parseProxyUrl(env.AGENTLINKOPS_PROXY_URL);
    if (proxy) onEvent(`proxy: ${proxy.server}`);

    const options = await resolveCamoufoxLaunchOptions({
      provider: engineName,
      proxy: proxy ?? undefined,
      // "virtual" on Linux = headful Firefox inside Xvfb; true headless is the
      // detection magnet the research warned about.
      headlessMode: process.platform === 'linux' ? 'virtual' : 'headful',
    });
    const browser = await launchFirefox({ ...options, executablePath: options.executablePath, proxy });

    browserHandle = {
      browser,
      cleanup: async () => {
        await browser.close().catch(() => null);
        await displayHandle?.cleanup?.().catch(() => null);
        displayHandle = null;
      },
    };
    return browserHandle;
  }

  async function loadStorageState() {
    try {
      const { readFile } = await lazy('node:fs/promises');
      return JSON.parse(await readFile(join(sessionDir, `${engineName}.json`), 'utf8'));
    } catch {
      return undefined; // anonymous session: several surfaces work logged-out
    }
  }

  return {
    identity,
    estimateCostUsd: () => NOMINAL_COST_USD,

    async run({ prompt }) {
      const config = await ensureProviderConfig();
      const { browser, cleanup } = await ensureBrowser();
      const context = await browser.newContext({
        storageState: await loadStorageState(),
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(45_000);

        if (config.navigateToPrompt) {
          await config.navigateToPrompt(page, prompt);
        } else {
          await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await config.postNavigationHook?.(page);
          await config.beforePromptHook?.(page);

          const { findActiveEditorCandidate } = await lazy('./gen/lib/input/editor/findEditor.js');
          const { PROVIDER_EDITOR_SELECTORS } = await lazy('./shims/utils.js');
          const editor = await findActiveEditorCandidate(page, PROVIDER_EDITOR_SELECTORS[engineName]);
          if (!editor) throw new EngineError(`${engineName}: no prompt editor found (surface may be gated or changed)`);

          const { insertPromptIntoEditor } = await lazy('./gen/lib/input/editor/promptInput.js');
          await insertPromptIntoEditor(page, editor.locator, prompt, engineName);
          await config.afterTypingHook?.(page);
          await config.beforeSubmitHook?.(page);

          const { findEnabledSendButton } = await lazy('./gen/lib/input/editor/findSendButton.js');
          const { PROVIDER_SUBMIT_BTN_SELECTORS } = await lazy('./shims/utils.js');
          const send = await findEnabledSendButton(page, PROVIDER_SUBMIT_BTN_SELECTORS[engineName]);
          if (send) { await send.click(); }
          else { await editor.locator.press('Enter'); }
        }
        await config.afterSubmitHook?.(page);

        await config.waitForResponse(page);
        const answer = await config.extractResponse(page);
        if (!answer || answer.trim().length === 0) {
          throw new EngineError(`${engineName}: answer extracted empty`, { retriable: true });
        }
        const sources = await config.extractSources(page);
        const screenshotPng = await page.screenshot({ fullPage: false }).catch(() => null);

        return {
          engine: engineName,
          provider: 'web-own-browser',
          model: engineName,
          providerModelVersion: `${engineName}-web`,
          answer,
          citations: (sources ?? []).map((s) => ({ url: s.url, title: s.title ?? s.cited_text ?? null })).filter((c) => typeof c.url === 'string' && c.url.length > 0),
          fanOut: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          costEstimateUsd: NOMINAL_COST_USD,
          screenshotPng,
        };
      } catch (cause) {
        if (cause instanceof EngineError) throw cause;
        const msg = String(cause?.message ?? cause);
        const retriable = /timeout|timed out|ERR_|net::|closed|Target closed/i.test(msg);
        throw new EngineError(`${engineName}: browser run failed: ${msg}`, { retriable, cause });
      } finally {
        await context.close().catch(() => null);
      }
    },

    // Called by the runner at epoch end.
    async close() {
      await browserHandle?.cleanup?.();
      browserHandle = null;
    },
  };
}
