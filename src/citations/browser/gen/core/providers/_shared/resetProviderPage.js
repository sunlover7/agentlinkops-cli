import { logger } from "../../../../shims/utils.js";
import { preInteractionIdle, randomBetween } from "../../../lib/browser/humanBehavior.js";
import { navigateWithRetry } from "../../../lib/browser/navigate.js";
import { detectBotPage } from "../../../lib/input/response/detectBotPage.js";
async function resetProviderPage(page, provider, url, options = {}) {
  logger.log(`[${provider}] resetting page for next prompt`);
  await preInteractionIdle(page).catch(() => {
  });
  await page.waitForTimeout(randomBetween(600, 1400));
  await navigateWithRetry(page, url, {
    waitUntil: "domcontentloaded",
    timeout: 3e4
  });
  logger.log(`[${provider}] redirected back to provider page: ${page.url()}`);
  await detectBotPage(page, provider);
  await options.postNavigationHook?.(page);
  await page.waitForTimeout(randomBetween(1200, 2600));
  logger.log(`[${provider}] page reset ready: ${page.url()}`);
}
export {
  resetProviderPage
};
