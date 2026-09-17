import { toErrorMessage } from "../../../../../shims/errors.js";
import { logger, PROVIDER_MODEL_RESPONSE_SELECTORS } from "../../../../../shims/utils.js";
import { buildSources } from "../../_shared/sourceUtils.js";
const CLAUDE_RAW_SOURCES_DOM_EXTRACTOR = String.raw`(
	{
		getCachedRawSources,
		setCachedRawSources,
		findLatestResponseElement,
		extractClaudeRawSourcesFromResponseElement,
	},
	selectors,
) => {
	const cached = getCachedRawSources("claude");
	if (cached) return cached;

	const responseEl = findLatestResponseElement(selectors)?.element;
	if (!responseEl) return [];

	const rawSources = extractClaudeRawSourcesFromResponseElement(responseEl);
	setCachedRawSources("claude", rawSources);
	return rawSources;
}`;
async function fetchTitle(url) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const match = html.match(/<title>(.*?)<\/title>/i);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
async function extractSourcesFromClaude(page) {
  try {
    const rawSources = await page.runDomOp("raw-sources", {
      provider: "claude",
      selectors: PROVIDER_MODEL_RESPONSE_SELECTORS.claude || []
    });
    const rawSourcesWithFetchedTitles = await Promise.all(
      rawSources.map(async (source) => ({
        ...source,
        title: await fetchTitle(source.rawHref) || source.title
      }))
    );
    return buildSources(rawSourcesWithFetchedTitles, { provider: "claude" });
  } catch (error) {
    logger.error(`Failed to extract Claude sources: ${toErrorMessage(error)}`);
    return [];
  }
}
export {
  CLAUDE_RAW_SOURCES_DOM_EXTRACTOR,
  extractSourcesFromClaude
};
