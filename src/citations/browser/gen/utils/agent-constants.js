const PROVIDER_NO_OUTPUT_TIMEOUT_MS = {
  chatgpt: 9e4,
  perplexity: 45e3,
  gemini: 45e3,
  claude: 6e4,
  "ai-overview": 45e3
};
const PROVIDER_FORCE_EXIT_STABLE_MS = {
  chatgpt: 45e3,
  perplexity: 3e4,
  gemini: 45e3,
  claude: 45e3,
  "ai-overview": 3e4
};
const PROVIDER_EDITOR_SELECTORS = {
  chatgpt: [
    "#prompt-textarea",
    'div#prompt-textarea[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Chat with ChatGPT"]'
  ],
  perplexity: [
    "#ask-input",
    'div#ask-input[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]'
  ],
  gemini: [
    'div[aria-label="Enter a prompt for Gemini"]',
    'rich-textarea [contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"][aria-multiline="true"]'
  ],
  claude: [
    '[data-testid="chat-input"]',
    'div[data-testid="chat-input"][contenteditable="true"][role="textbox"]',
    '[data-testid="chat-input"][aria-multiline="true"]'
  ],
  "ai-overview": ['textarea[name="q"][role="combobox"]', 'textarea[role="combobox"][aria-label="Search"]']
};
const PROVIDER_SUBMIT_BTN_SELECTORS = {
  chatgpt: ['button[data-testid="send-button"]'],
  perplexity: ['button[aria-label*="Submit"]'],
  gemini: ['button[aria-label*="Send"]'],
  claude: ['button[aria-label*="Send"]'],
  "ai-overview": []
};
const PROVIDER_MODEL_RESPONSE_SELECTORS = {
  chatgpt: [
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn"][data-turn="assistant"]'
  ],
  perplexity: [
    'div[id^="markdown-content-"]',
    '[id^="markdown-content-"] .prose'
  ],
  gemini: ["message-content .markdown"],
  claude: [
    '[data-is-streaming="false"] .standard-markdown',
    ".standard-markdown"
  ],
  "ai-overview": [
    '[data-container-id="main-col"]'
  ]
};
const PROVIDER_RESPONSE_GENERATION_SELECTORS = {
  chatgpt: ['button[data-testid="stop-button"]', 'button[aria-label*="stop" i]'],
  perplexity: ['button[aria-label*="stop" i]'],
  gemini: ['button[aria-label*="stop" i]'],
  claude: ['button[aria-label*="stop" i]'],
  "ai-overview": []
};
const RETRYABLE_ERRORS = [
  "ERR_SSL_PROTOCOL_ERROR",
  "ERR_CONNECTION",
  "ERR_TIMED_OUT",
  "ERR_PROXY_CONNECTION_FAILED",
  "Timeout"
];
export {
  PROVIDER_EDITOR_SELECTORS,
  PROVIDER_FORCE_EXIT_STABLE_MS,
  PROVIDER_MODEL_RESPONSE_SELECTORS,
  PROVIDER_NO_OUTPUT_TIMEOUT_MS,
  PROVIDER_RESPONSE_GENERATION_SELECTORS,
  PROVIDER_SUBMIT_BTN_SELECTORS,
  RETRYABLE_ERRORS
};
