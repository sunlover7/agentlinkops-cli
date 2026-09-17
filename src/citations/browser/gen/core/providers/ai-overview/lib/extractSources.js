import { toErrorMessage } from "../../../../../shims/errors.js";
import { logger } from "../../../../../shims/utils.js";
import { buildSources } from "../../_shared/sourceUtils.js";
const AI_OVERVIEW_RAW_SOURCES_DOM_EXTRACTOR = String.raw`(_helpers) => {
	const results = [];
	const rhsCol = document.querySelector('[data-container-id="rhs-col"]');
	if (!rhsCol) {
		return { rawSources: results, containerFound: false };
	}

	for (const card of Array.from(rhsCol.querySelectorAll("div[data-src-id]"))) {
		if (!(card instanceof HTMLElement)) continue;

		const link = card.querySelector('a[href^="http"]');
		if (!(link instanceof HTMLAnchorElement)) continue;

		const title =
			link
				.getAttribute("aria-label")
				?.replace(/\.\s*Opens in new tab\.?$/i, "")
				.trim() || link.href;
		const citedText =
			card.querySelector("[data-crb-snippet-text]")?.textContent?.trim() || "";

		results.push({
			rawHref: link.href,
			title,
			citedText,
		});
	}

	return { rawSources: results, containerFound: true };
}`;
function normalizeAIOverviewTitle(title) {
  return title.replace(/\s*\.?\s*opens in new tab\.?\s*$/i, "").trim();
}
async function extractAIOverviewSources(page) {
  try {
    const { rawSources, containerFound } = await page.runDomOp("raw-sources", {
      provider: "ai-overview"
    });
    if (!containerFound) {
      logger.warn("AI Overview container not found \u2014 no sources extracted");
    }
    const normalizedSources = rawSources.map((source) => ({
      ...source,
      title: normalizeAIOverviewTitle(source.title ?? "") || source.rawHref
    }));
    return buildSources(normalizedSources, { provider: "ai-overview" });
  } catch (err) {
    logger.error(
      `Failed to extract AI Overview sources: ${toErrorMessage(err)}`
    );
    return [];
  }
}
export {
  AI_OVERVIEW_RAW_SOURCES_DOM_EXTRACTOR,
  extractAIOverviewSources
};
