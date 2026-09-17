import { PROVIDER_MODEL_RESPONSE_SELECTORS } from "../../../../shims/utils.js";
import { turndown } from "./converter.js";
async function extractAssistantMarkdown(page, provider) {
  const html = await page.runDomOp("response-html", {
    provider,
    selectors: PROVIDER_MODEL_RESPONSE_SELECTORS[provider] || []
  });
  if (!html) return "";
  const markdown = turndown.turndown(html);
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}
export {
  extractAssistantMarkdown
};
