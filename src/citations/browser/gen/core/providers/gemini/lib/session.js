import { ExternalServiceError } from "../../../../../shims/errors.js";
import { clickLocatorLikeUser } from "../../../../lib/browser/humanBehavior.js";
const GEMINI_CONSENT_SELECTOR = "button#L2AGLb, button#W0wltc, form[action*='consent.google.com'] button";
async function handleGeminiConsentPage(page) {
  const url = page.url();
  if (!url.includes("consent.google.com")) return;
  const consentBtn = page.locator(GEMINI_CONSENT_SELECTOR).first();
  const visible = await consentBtn.isVisible({ timeout: 3e3 }).catch(() => false);
  if (visible) {
    await clickLocatorLikeUser(page, consentBtn, { timeout: 4e3 }).catch(() => {
    });
    await page.waitForTimeout(1e3);
    if (!page.url().includes("consent.google.com")) return;
  }
  throw new ExternalServiceError(
    "gemini",
    "Google consent page not dismissible \u2014 proxy IP requires Google consent",
    429
  );
}
function isGeminiAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "gemini.google.com" && url.pathname.startsWith("/app/") && url.pathname.length > "/app/".length;
  } catch {
    return false;
  }
}
async function waitForGeminiConversationUrl(page, preSubmitUrl) {
  if (isGeminiAppUrl(preSubmitUrl)) {
    return void 0;
  }
  const deadline = Date.now() + 4e3;
  while (Date.now() < deadline) {
    if (isGeminiAppUrl(await page.getUrl().catch(() => page.url()))) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}
export {
  handleGeminiConsentPage,
  waitForGeminiConversationUrl
};
