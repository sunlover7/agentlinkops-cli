import { ExternalServiceError } from "../../../../shims/errors.js";
async function detectBotPage(page, provider) {
  const state = await page.runDomOp("detect-bot-page").catch(() => ({ botDetected: false, reason: null }));
  if (state.botDetected) {
    throw new ExternalServiceError(
      provider,
      state.reason ?? "bot detection page detected"
    );
  }
}
export {
  detectBotPage
};
