import { ExternalServiceError, toErrorMessage } from "../../../shims/errors.js";
import { RETRYABLE_ERRORS, logger } from "../../../shims/utils.js";
function jitter(baseMs, factor = 0.3) {
  const delta = Math.round(baseMs * factor);
  const min = Math.max(0, baseMs - delta);
  const max = baseMs + delta;
  return Math.round(min + Math.random() * (max - min));
}
async function navigateWithRetry(page, url, options = {}, maxRetries = 3, delayMs = 2e3) {
  let referer = options?.referer;
  if (referer === void 0) {
    try {
      const currentUrl = page.url();
      if (currentUrl && currentUrl !== "about:blank") {
        referer = currentUrl;
      }
    } catch {
    }
  }
  const gotoOptions = referer !== void 0 ? { ...options, referer } : options;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, gotoOptions);
      return;
    } catch (err) {
      const message = toErrorMessage(err);
      const isRetryable = RETRYABLE_ERRORS.some((e) => message.includes(e));
      if (!isRetryable || attempt === maxRetries) {
        throw new ExternalServiceError(
          "navigation",
          toErrorMessage(err),
          502,
          { url, attempt },
          err
        );
      }
      logger.warn(
        `navigation failed (attempt ${attempt}/${maxRetries}): ${message} \u2014 retrying in ${Math.round(jitter(delayMs) / 100) / 10}s`
      );
      await page.waitForTimeout(jitter(delayMs));
    }
  }
}
export {
  navigateWithRetry
};
