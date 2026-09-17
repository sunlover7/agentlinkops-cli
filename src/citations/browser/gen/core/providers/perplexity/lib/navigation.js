import { resetProviderPage } from "../../_shared/resetProviderPage.js";
const PERPLEXITY_URL = "https://www.perplexity.ai/";
function isPerplexitySearchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.endsWith("perplexity.ai") && url.pathname.startsWith("/search/") && url.pathname.length > "/search/".length;
  } catch {
    return false;
  }
}
async function waitForPerplexitySearchUrl(page, preSubmitUrl) {
  if (isPerplexitySearchUrl(preSubmitUrl)) {
    return void 0;
  }
  const deadline = Date.now() + 4e3;
  while (Date.now() < deadline) {
    if (isPerplexitySearchUrl(await page.getUrl().catch(() => page.url()))) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}
async function perplexityPostNavigationHook(page) {
  const delay = 1e3 + Math.floor(Math.random() * 1e3);
  await page.waitForTimeout(delay);
}
async function resetPerplexityPage(page) {
  await resetProviderPage(page, "perplexity", PERPLEXITY_URL, {
    postNavigationHook: perplexityPostNavigationHook
  });
}
export {
  PERPLEXITY_URL,
  perplexityPostNavigationHook,
  resetPerplexityPage,
  waitForPerplexitySearchUrl
};
