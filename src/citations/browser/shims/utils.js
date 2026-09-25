// Shim for @oneglanse/utils runtime exports. The selector/timeout constants
// are re-exported except the evidenced anonymous ChatGPT response boundary; logger,
// getDomain and getFaviconUrls are minimal equivalents.
export {
  PROVIDER_NO_OUTPUT_TIMEOUT_MS,
  PROVIDER_FORCE_EXIT_STABLE_MS,
  PROVIDER_SUBMIT_BTN_SELECTORS,
  PROVIDER_RESPONSE_GENERATION_SELECTORS,
  RETRYABLE_ERRORS,
} from '../gen/utils/agent-constants.js';
import { PROVIDER_MODEL_RESPONSE_SELECTORS as vendoredResponseSelectors, PROVIDER_EDITOR_SELECTORS as vendoredEditorSelectors } from '../gen/utils/agent-constants.js';

// Anonymous composer observed 2026-09-25: a plain textarea (#mobile-composer-prompt,
// name="prompt"). None of the vendored ChatGPT selectors match it; without these the engine
// reached it only through the broad shadow-DOM fallback.
export const PROVIDER_EDITOR_SELECTORS = Object.freeze({
  ...vendoredEditorSelectors,
  chatgpt: Object.freeze(['textarea#mobile-composer-prompt', 'textarea[name="prompt"]', ...vendoredEditorSelectors.chatgpt]),
});

// Anonymous surface observed 2026-09-20: conversation LI, distinct from its
// user sibling, with response actions. Never select the conversation itself.
export const CHATGPT_ANONYMOUS_RESPONSE_SELECTOR = 'ol[aria-label="Conversation"] > li:has(> [role="group"][aria-label="Response actions"] button[aria-label="Copy response"]):not(:has(button[aria-label="Copy message"], [data-message-author-role="user"], [data-turn="user"], form, input, textarea, [contenteditable="true"]))';
export const PROVIDER_MODEL_RESPONSE_SELECTORS = Object.freeze({
  ...vendoredResponseSelectors,
  chatgpt: Object.freeze([...vendoredResponseSelectors.chatgpt, CHATGPT_ANONYMOUS_RESPONSE_SELECTOR]),
});

const envQuiet = () => Boolean(process.env.AGENTLINKOPS_BROWSER_QUIET);

export const logger = {
  debug: (...args) => { if (!envQuiet()) console.error('[browser:debug]', ...args); },
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
