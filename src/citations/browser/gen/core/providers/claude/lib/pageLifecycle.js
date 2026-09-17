import { resetProviderPage } from "../../_shared/resetProviderPage.js";
const CLAUDE_URL = "https://claude.ai/new";
async function resetClaudePage(page) {
  await resetProviderPage(page, "claude", CLAUDE_URL);
}
export {
  CLAUDE_URL,
  resetClaudePage
};
