import { clickButtonViaDispatch } from "../../extraction/sourceUtils.js";
async function openSourcesPanel(page, btn) {
  const clicked = await btn.scrollIntoViewIfNeeded().then(() => btn.click({ timeout: 3e3 })).then(() => true).catch(() => false);
  if (!clicked) {
    if (!await clickButtonViaDispatch(page, btn)) return;
  }
  await page.waitForTimeout(500);
}
export {
  openSourcesPanel
};
