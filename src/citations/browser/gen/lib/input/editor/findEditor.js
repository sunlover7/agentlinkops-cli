import { NotFoundError } from "../../../../shims/errors.js";
import { PROVIDER_EDITOR_SELECTORS } from "../../../../shims/utils.js";
async function findActiveEditorCandidateFromSelectors(page, selectors) {
  for (const selector of selectors) {
    const nodes = page.locator(selector);
    const count = await nodes.count();
    for (let i = 0; i < count; i++) {
      const el = nodes.nth(i);
      try {
        const visible = await el.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.width < 8 || box.height < 8) {
          continue;
        }
        await el.scrollIntoViewIfNeeded().catch(() => {
        });
        await el.focus().catch(() => {
        });
        const state = await el.getEditableState().catch(() => null);
        if (!(state?.connected && state.visible && state.editable && state.enabled)) {
          continue;
        }
        return { locator: el, selector };
      } catch (_error) {
      }
    }
  }
  throw new NotFoundError("active prompt editor");
}
async function findActiveEditorFromSelectors(page, selectors) {
  const candidate = await findActiveEditorCandidateFromSelectors(
    page,
    selectors
  );
  return candidate.locator;
}
async function findActiveEditor(page, provider) {
  const candidate = await findActiveEditorCandidate(page, provider);
  return candidate.locator;
}
async function findActiveEditorCandidate(page, provider) {
  const fallbackSelectors = [
    ...new Set(Object.values(PROVIDER_EDITOR_SELECTORS).flat())
  ];
  const selectors = provider ? PROVIDER_EDITOR_SELECTORS[provider] || fallbackSelectors : fallbackSelectors;
  return findActiveEditorCandidateFromSelectors(page, selectors);
}
export {
  findActiveEditorCandidate,
  findActiveEditorCandidateFromSelectors
};
