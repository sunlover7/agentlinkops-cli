import { AI_OVERVIEW_RAW_SOURCES_DOM_EXTRACTOR } from "../ai-overview/lib/extractSources.js";
import { CHATGPT_RAW_SOURCES_DOM_EXTRACTOR } from "../chatgpt/lib/extractSources.js";
import { CLAUDE_RAW_SOURCES_DOM_EXTRACTOR } from "../claude/lib/extractSources.js";
import { GEMINI_RAW_SOURCES_DOM_EXTRACTOR } from "../gemini/lib/extractSources.js";
import { PERPLEXITY_RAW_SOURCES_DOM_EXTRACTOR } from "../perplexity/lib/extractSources.js";
const PROVIDER_RAW_SOURCES_DOM_EXTRACTORS = {
  chatgpt: CHATGPT_RAW_SOURCES_DOM_EXTRACTOR,
  perplexity: PERPLEXITY_RAW_SOURCES_DOM_EXTRACTOR,
  gemini: GEMINI_RAW_SOURCES_DOM_EXTRACTOR,
  claude: CLAUDE_RAW_SOURCES_DOM_EXTRACTOR,
  "ai-overview": AI_OVERVIEW_RAW_SOURCES_DOM_EXTRACTOR
};
export {
  PROVIDER_RAW_SOURCES_DOM_EXTRACTORS
};
