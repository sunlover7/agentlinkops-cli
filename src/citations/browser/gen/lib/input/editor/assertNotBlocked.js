import { ExternalServiceError } from "../../../../shims/errors.js";
async function detectEditorBlocker(page, input) {
  const box = await input.boundingBox().catch(() => null);
  if (!box || box.width < 8 || box.height < 8) {
    return { blocked: false, reason: null };
  }
  const insetX = Math.max(6, Math.min(24, box.width * 0.12));
  const insetY = Math.max(6, Math.min(18, box.height * 0.2));
  const points = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + insetX, y: box.y + insetY },
    { x: box.x + box.width - insetX, y: box.y + insetY }
  ];
  return await page.evaluate((samples) => {
    const isEditorLike = (element) => Boolean(
      element?.closest(
        '[contenteditable="true"], textarea, input, [role="textbox"], [role="combobox"]'
      )
    );
    for (const sample of samples) {
      const top = document.elementFromPoint(sample.x, sample.y);
      if (!top) continue;
      if (isEditorLike(top)) continue;
      const blocker = top.closest(
        '[role="dialog"], [aria-modal="true"], [popover], [data-state="open"]'
      ) || top;
      if (!(blocker instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(blocker);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
        continue;
      }
      const rect = blocker.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 40) continue;
      const text = (blocker.textContent || "").replace(/\s+/g, " ").trim();
      const label = blocker.getAttribute("aria-label") || blocker.getAttribute("role") || blocker.tagName.toLowerCase();
      return {
        blocked: true,
        reason: `${label}:${text.slice(0, 120)}`
      };
    }
    return { blocked: false, reason: null };
  }, points);
}
async function ensureEditorNotBlocked(page, input, provider) {
  const result = await detectEditorBlocker(page, input);
  if (!result.blocked) return;
  throw new ExternalServiceError(
    provider,
    `Editor blocked by overlay: ${result.reason ?? "unknown blocker"}`
  );
}
export {
  ensureEditorNotBlocked
};
