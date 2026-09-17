import { resetProviderPage } from "../../_shared/resetProviderPage.js";
import { dismissChatgptAuthModal } from "./dismissAuthModal.js";
const CHATGPT_URL = "https://chatgpt.com/";
async function resetChatgptPage(page) {
  await resetProviderPage(page, "chatgpt", CHATGPT_URL);
  await dismissChatgptAuthModal(page, { waitForAppearanceMs: 1e3 });
}
export {
  CHATGPT_URL,
  resetChatgptPage
};
