import { resetProviderPage } from "../../_shared/resetProviderPage.js";
import { handleGeminiConsentPage } from "./session.js";
const GEMINI_URL = "https://gemini.google.com/";
async function resetGeminiPage(page) {
  await resetProviderPage(page, "gemini", GEMINI_URL, {
    postNavigationHook: async (currentPage) => {
      await handleGeminiConsentPage(currentPage);
    }
  });
}
export {
  GEMINI_URL,
  resetGeminiPage
};
