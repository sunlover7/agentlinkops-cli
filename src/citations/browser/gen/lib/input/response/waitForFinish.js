import { ExternalServiceError } from "../../../../shims/errors.js";
import {
  logger,
  PROVIDER_FORCE_EXIT_STABLE_MS,
  PROVIDER_NO_OUTPUT_TIMEOUT_MS
} from "../../../../shims/utils.js";
import {
  getGenerationStateSignature,
  getResponseStateSignature,
  hasVisibleGenerationIndicator
} from "./isGenerating.js";
async function sleep(ms) {
  let timer = null;
  try {
    await new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
async function pollUntilCondition(checkFn, pollInterval, maxWait, timeoutError) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (await checkFn()) return;
    await sleep(pollInterval);
  }
  throw timeoutError;
}
async function waitForAssistantToFinish(page, provider) {
  logger.debug(
    provider === "ai-overview" ? "\u23F3 Waiting for AI Overview response container to stabilize\u2026" : "\u23F3 Waiting for assistant to finish\u2026"
  );
  const waitStart = Date.now();
  let lastGenerationState = "";
  let lastResponseState = "";
  let lastChangeAt = Date.now();
  let initialized = false;
  let seenResponse = false;
  await pollUntilCondition(
    async () => {
      const [currentGenerationState, currentResponseState, hasVisibleIndicator] = await Promise.all([
        getGenerationStateSignature(page, provider),
        getResponseStateSignature(page, provider),
        hasVisibleGenerationIndicator(page, provider)
      ]);
      const waitedFor = Date.now() - waitStart;
      const forceExitStableMs = PROVIDER_FORCE_EXIT_STABLE_MS[provider];
      const responseStateChanged = currentResponseState.signature !== lastResponseState;
      const generationStateChanged = currentGenerationState !== lastGenerationState;
      const requiresContainerStabilityOnly = provider === "ai-overview";
      if (!initialized) {
        lastGenerationState = currentGenerationState;
        lastResponseState = currentResponseState.signature;
        seenResponse = currentResponseState.textLength > 0;
        lastChangeAt = Date.now();
        initialized = true;
        return false;
      }
      if (currentResponseState.textLength > 0) {
        seenResponse = true;
      }
      if (responseStateChanged || generationStateChanged) {
        lastGenerationState = currentGenerationState;
        lastResponseState = currentResponseState.signature;
        lastChangeAt = Date.now();
        return false;
      }
      const stableFor = Date.now() - lastChangeAt;
      if (requiresContainerStabilityOnly) {
        if (seenResponse && stableFor >= 2500) {
          logger.debug("\u2705 AI Overview response container stabilized");
          return true;
        }
      }
      if (seenResponse && !hasVisibleIndicator && stableFor >= 1500) {
        logger.debug("\u2705 Assistant finished");
        return true;
      }
      const noOutputTimeoutMs = PROVIDER_NO_OUTPUT_TIMEOUT_MS[provider];
      if (waitedFor >= noOutputTimeoutMs) {
        logger.warn(
          `Generation state did not stabilize within ${Math.round(noOutputTimeoutMs / 1e3)}s`
        );
      }
      if (stableFor >= forceExitStableMs) {
        logger.warn(
          `${hasVisibleIndicator ? "Generation indicator still visible and " : ""}generation state stable for ${Math.round(forceExitStableMs / 1e3)}s \u2014 forcing exit`
        );
        return true;
      }
      return false;
    },
    280 + Math.floor(Math.random() * 60),
    // Poll ~300ms with ±50ms jitter
    5 * 60 * 1e3,
    // 5 min max — if a response hasn't arrived by then, something is wrong
    new ExternalServiceError(provider, "Assistant wait timed out")
  );
}
export {
  waitForAssistantToFinish
};
