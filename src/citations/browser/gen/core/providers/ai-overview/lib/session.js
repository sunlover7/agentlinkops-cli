import { ExternalServiceError } from "../../../../../shims/errors.js";
import { logger } from "../../../../../shims/utils.js";
import { navigateWithRetry } from "../../../../lib/browser/navigate.js";
const GOOGLE_CONSENT_SELECTOR = "button#L2AGLb, button#W0wltc, form[action*='consent.google.com'] button";
const SEARCH_RESULTS_WAIT_MS = 8e3;
const warmedPages = /* @__PURE__ */ new WeakSet();
async function dismissGoogleConsentDialog(page) {
  const consentBtn = page.locator(GOOGLE_CONSENT_SELECTOR).first();
  const visible = await consentBtn.isVisible({ timeout: 2500 }).catch(() => false);
  if (!visible) return;
  await consentBtn.click({ timeout: 4e3 }).catch(() => {
  });
  await page.waitForTimeout(1e3);
}
function assertAIOverviewPageNotBlocked(page) {
  const url = page.url();
  if (url.includes("/sorry/")) {
    throw new ExternalServiceError(
      "ai-overview",
      "Google bot detection triggered (sorry page) \u2014 proxy IP blocked",
      429
    );
  }
  if (url.includes("accounts.google.com")) {
    throw new ExternalServiceError(
      "ai-overview",
      "Google redirected to login page \u2014 session cookie missing or expired",
      401
    );
  }
}
async function ensureAIOverviewGoogleSession(page) {
  if (warmedPages.has(page)) return;
  logger.log("[ai-overview] warming up Google cookies");
  await navigateWithRetry(page, "https://www.google.com/", {
    waitUntil: "domcontentloaded",
    timeout: 3e4
  });
  assertAIOverviewPageNotBlocked(page);
  await dismissGoogleConsentDialog(page);
  warmedPages.add(page);
}
async function waitForAIOverviewSearchResults(page) {
  const deadline = Date.now() + SEARCH_RESULTS_WAIT_MS;
  while (Date.now() < deadline) {
    if (page.url().includes("/search?")) {
      return;
    }
    assertAIOverviewPageNotBlocked(page);
    await page.waitForTimeout(150);
  }
  throw new ExternalServiceError(
    "ai-overview",
    `Not on search results page after submission (url: ${page.url()})`
  );
}
export {
  assertAIOverviewPageNotBlocked,
  dismissGoogleConsentDialog,
  ensureAIOverviewGoogleSession,
  waitForAIOverviewSearchResults
};
