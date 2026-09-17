import { ExternalServiceError } from "../../../../shims/errors.js";
import { logger } from "../../../../shims/utils.js";
import {
  clickLocatorLikeUser,
  pastePrompt,
  randomBetween
} from "../../browser/humanBehavior.js";
import { clearEditorInput } from "./clearInput.js";
function normalizePromptValue(text) {
  return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "").trim();
}
async function focusEditorTarget(page, input) {
  await input.scrollIntoViewIfNeeded().catch(() => null);
  await clickLocatorLikeUser(page, input, {
    timeout: 3e3,
    delay: randomBetween(25, 80)
  }).catch(() => null);
  await page.waitForTimeout(randomBetween(40, 120));
  await input.focus().catch(() => null);
  await page.waitForTimeout(randomBetween(30, 90));
}
async function prepareEditorForPrompt(page, input, provider) {
  const count = await input.count().catch(() => 0);
  if (count === 0) {
    throw new ExternalServiceError(
      provider,
      `Editor not ready for ${provider}: input locator is missing`
    );
  }
  const state = await input.getEditableState().catch(() => null);
  if (!(state?.connected && state.editable && state.enabled && state.acceptsTextInput)) {
    throw new ExternalServiceError(
      provider,
      `Editor not ready for ${provider}: input is not editable`
    );
  }
  await focusEditorTarget(page, input);
  const existingValue = await input.readInputValue().catch(() => "");
  if (normalizePromptValue(existingValue).length === 0) {
    await focusEditorTarget(page, input);
    return;
  }
  const cleared = await clearEditorInput(page, input, {
    clickTimeoutMs: 3e3,
    waitAfterMs: randomBetween(40, 120)
  });
  if (!cleared) {
    throw new ExternalServiceError(
      provider,
      `Editor not ready for ${provider}: could not clear existing input`
    );
  }
  const remainingValue = await input.readInputValue().catch(() => "");
  if (normalizePromptValue(remainingValue).length > 0) {
    throw new ExternalServiceError(
      provider,
      `Editor not ready for ${provider}: input retained content after clear`
    );
  }
  await focusEditorTarget(page, input);
}
async function insertPromptOnce(page, input, prompt, strategy) {
  if (strategy === "directSet") {
    await input.setInputValue(prompt);
    await page.waitForTimeout(randomBetween(40, 120));
    return;
  }
  await pastePrompt(page, prompt);
}
async function waitForPromptValue(page, input, expectedValue, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = await input.readInputValue().catch(() => "");
  while (Date.now() < deadline) {
    if (normalizePromptValue(lastValue) === expectedValue) {
      return lastValue;
    }
    await page.waitForTimeout(randomBetween(80, 140));
    lastValue = await input.readInputValue().catch(() => "");
  }
  return lastValue;
}
async function insertPromptIntoEditor(page, input, prompt, provider) {
  const expectedValue = normalizePromptValue(prompt);
  const strategies = [
    ...provider === "perplexity" ? [] : ["directSet"],
    "pacedPaste"
  ];
  for (const strategy of strategies) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await prepareEditorForPrompt(page, input, provider);
      await insertPromptOnce(page, input, prompt, strategy);
      const rawValue = await waitForPromptValue(
        page,
        input,
        expectedValue,
        strategy === "directSet" ? attempt === 1 ? 800 : 1400 : attempt === 1 ? 1800 : 2500
      );
      if (normalizePromptValue(rawValue) === expectedValue) {
        return { rawValue, strategy };
      }
      if (attempt === 1) {
        logger.warn(
          `[${provider}] prompt verification mismatch after ${strategy} \u2014 retrying once`
        );
      }
    }
  }
  const finalValue = await input.readInputValue().catch(() => "");
  throw new ExternalServiceError(
    provider,
    `Typing failed: normalized input mismatch after local retry (expected ${expectedValue.length} chars, got ${normalizePromptValue(finalValue).length})`
  );
}
export {
  insertPromptIntoEditor,
  normalizePromptValue
};
