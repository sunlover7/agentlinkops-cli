import { PROVIDER_MODEL_RESPONSE_SELECTORS } from "../../../../shims/utils.js";
async function getText(page, provider) {
  return await page.runDomOp("response-text", {
    provider,
    selectors: PROVIDER_MODEL_RESPONSE_SELECTORS[provider] || []
  });
}
export {
  getText
};
