// Shim for @oneglanse/utils runtime exports. The selector/timeout constants
// are re-exported from the vendored agent-constants module unchanged; logger,
// getDomain and getFaviconUrls are minimal equivalents.
export {
  PROVIDER_NO_OUTPUT_TIMEOUT_MS,
  PROVIDER_FORCE_EXIT_STABLE_MS,
  PROVIDER_EDITOR_SELECTORS,
  PROVIDER_SUBMIT_BTN_SELECTORS,
  PROVIDER_MODEL_RESPONSE_SELECTORS,
  PROVIDER_RESPONSE_GENERATION_SELECTORS,
  RETRYABLE_ERRORS,
} from '../gen/utils/agent-constants.js';

const envQuiet = () => Boolean(process.env.AGENTLINKOPS_BROWSER_QUIET);

export const logger = {
  log: (...args) => { if (!envQuiet()) console.error('[browser]', ...args); },
  warn: (...args) => { if (!envQuiet()) console.error('[browser:warn]', ...args); },
  error: (...args) => { console.error('[browser:error]', ...args); },
};

export function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

export function getFaviconUrls(url) {
  try {
    const u = new URL(url);
    return [`https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`];
  } catch { return []; }
}
