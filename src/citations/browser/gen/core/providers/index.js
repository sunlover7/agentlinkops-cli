import { aiOverviewConfig } from "./ai-overview/index.js";
import { chatgptConfig } from "./chatgpt/index.js";
import { claudeConfig } from "./claude/index.js";
import { geminiConfig } from "./gemini/index.js";
import { perplexityConfig } from "./perplexity/index.js";
const PROVIDER_CONFIGS = {
  gemini: geminiConfig,
  chatgpt: chatgptConfig,
  perplexity: perplexityConfig,
  claude: claudeConfig,
  "ai-overview": aiOverviewConfig
};
export {
  PROVIDER_CONFIGS
};
