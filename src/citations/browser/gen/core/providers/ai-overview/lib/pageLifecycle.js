import { resetProviderPage } from "../../_shared/resetProviderPage.js";
import {
  assertAIOverviewPageNotBlocked,
  dismissGoogleConsentDialog
} from "./session.js";
const AI_OVERVIEW_URL = "https://www.google.com/";
async function resetAIOverviewPage(page) {
  await resetProviderPage(page, "ai-overview", AI_OVERVIEW_URL, {
    postNavigationHook: async (currentPage) => {
      assertAIOverviewPageNotBlocked(currentPage);
      await dismissGoogleConsentDialog(currentPage);
    }
  });
}
export {
  AI_OVERVIEW_URL,
  resetAIOverviewPage
};
