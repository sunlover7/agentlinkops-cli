import { PROVIDER_SUBMIT_BTN_SELECTORS } from "../../../../shims/utils.js";
async function findEnabledSendButton(page, provider) {
  const selectors = PROVIDER_SUBMIT_BTN_SELECTORS[provider] || [];
  for (const selector of selectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      try {
        if (await btn.isVisible() && await btn.isEnabled()) {
          return btn;
        }
      } catch {
      }
    }
  }
  return null;
}
export {
  findEnabledSendButton
};
