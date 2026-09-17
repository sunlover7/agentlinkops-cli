import { PROVIDER_RAW_SOURCES_DOM_EXTRACTORS } from "../../core/providers/_shared/rawSourcesDom.js";
async function runPageDomOp(page, operation, params) {
  const nextParams = { ...params ?? {} };
  if (operation === "raw-sources") {
    const provider = String(nextParams.provider || "");
    nextParams.providerRawSourcesExtractor = PROVIDER_RAW_SOURCES_DOM_EXTRACTORS[provider] ?? "";
  }
  return await page.evaluate(
    ({ operation: currentOperation, params: currentParams }) => {
      function splitTopLevelSelectors(selector) {
        const parts = [];
        let current = "";
        let parenDepth = 0;
        let bracketDepth = 0;
        let quote = null;
        for (const char of selector) {
          if (quote) {
            current += char;
            if (char === quote) {
              quote = null;
            }
            continue;
          }
          if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
          }
          if (char === "(") parenDepth += 1;
          if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
          if (char === "[") bracketDepth += 1;
          if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
          if (char === "," && parenDepth === 0 && bracketDepth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = "";
            continue;
          }
          current += char;
        }
        if (current.trim()) parts.push(current.trim());
        return parts;
      }
      function parseHasTextSelector(selector) {
        const textFilters = [];
        let baseSelector = selector;
        const regex = /:has-text\((["'])(.*?)\1\)/g;
        baseSelector = baseSelector.replace(
          regex,
          (_full, _quote, value) => {
            textFilters.push(value);
            return "";
          }
        );
        baseSelector = baseSelector.trim() || "*";
        return { baseSelector, textFilters };
      }
      function elementText(element) {
        if (element instanceof HTMLElement) {
          return (element.innerText || element.textContent || "").trim();
        }
        return (element.textContent || "").trim();
      }
      function isVisible(element) {
        if (!(element instanceof HTMLElement)) return false;
        if (!element.isConnected) return false;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function dedupeElements(elements) {
        return Array.from(new Set(elements));
      }
      function resolveSelectorWithin(root, selector) {
        const elements = [];
        for (const part of splitTopLevelSelectors(selector)) {
          const { baseSelector, textFilters } = parseHasTextSelector(part);
          const matches = Array.from(
            root.querySelectorAll(baseSelector)
          ).filter(
            (el) => textFilters.every(
              (filter) => elementText(el).toLowerCase().includes(filter.toLowerCase())
            )
          );
          elements.push(...matches);
        }
        return dedupeElements(elements);
      }
      function isResponsePlaceholder(element) {
        return element.getAttribute("aria-busy") === "true" || (element.getAttribute("data-message-id") || "").startsWith(
          "request-placeholder"
        );
      }
      function findLatestResponseElement(selectors) {
        const selector = (selectors || []).join(", ");
        if (!selector.trim()) return null;
        const element = Array.from(document.querySelectorAll(selector)).filter(
          (el) => el instanceof HTMLElement && isVisible(el) && !isResponsePlaceholder(el) && el.innerText.trim().length > 50
        ).pop() ?? null;
        return element ? { selector, element } : null;
      }
      function getCachedRawSources(key) {
        const cache = window.__oneglanseRawSourcesCache;
        return cache?.[key] ?? null;
      }
      function setCachedRawSources(key, rawSources) {
        const state = window;
        state.__oneglanseRawSourcesCache ||= {};
        state.__oneglanseRawSourcesCache[key] = rawSources;
      }
      function extractClaudeRawSourcesFromResponseElement(responseEl) {
        const normalize = (text) => text.replace(/\s+/g, " ").trim();
        const getTextBeforeAnchor = (anchor) => {
          let text = "";
          let node = anchor;
          while (node) {
            if (node.previousSibling) {
              node = node.previousSibling;
              while (node && node.lastChild) {
                node = node.lastChild;
              }
            } else {
              node = node.parentNode;
            }
            if (!node) break;
            if (node.nodeType === Node.TEXT_NODE) {
              const content = node.textContent || "";
              text = `${content} ${text}`;
              if (/[.!?]\s*$/.test(content)) break;
            }
          }
          return normalize(text);
        };
        return Array.from(responseEl.querySelectorAll('a[href^="http"]')).map((anchor) => {
          const link = anchor;
          const anchorElement = anchor instanceof HTMLElement ? anchor : null;
          return {
            rawHref: link.href,
            title: (anchor.textContent || "").trim() || link.href,
            citedText: anchorElement ? getTextBeforeAnchor(anchorElement) : ""
          };
        }).filter((source) => source.rawHref);
      }
      function runProviderRawSourcesExtractor(extractorSource, selectors) {
        if (!extractorSource.trim()) return [];
        const extractor = Function(
          `return (${extractorSource});`
        )();
        return extractor(
          {
            getCachedRawSources,
            setCachedRawSources,
            findLatestResponseElement,
            extractClaudeRawSourcesFromResponseElement
          },
          selectors
        );
      }
      function readResponseText(_provider, selectors) {
        return findLatestResponseElement(selectors)?.element.innerText.trim() || "";
      }
      function isCitationAnchor(anchor) {
        const text = anchor.textContent?.trim() || "";
        if (!text || text.length > 40) return false;
        if (/^\+?\d+$/.test(text)) return true;
        if (/^[a-z0-9.\-+]+$/i.test(text) && text.includes(".") && text.length < 40) return true;
        return false;
      }
      function formatCitationAnchors(root) {
        const cleanCitationText = (text) => text.replace(/\+\d+$/, "").trim();
        for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
          if (!(anchor instanceof HTMLAnchorElement)) continue;
          if (!isCitationAnchor(anchor)) continue;
          const rawText = anchor.textContent?.trim();
          if (!rawText) continue;
          const cleaned = cleanCitationText(rawText);
          if (!cleaned) {
            anchor.remove();
            continue;
          }
          const strong = document.createElement("strong");
          strong.textContent = `[${cleaned}]`;
          anchor.replaceWith(
            document.createTextNode(" "),
            strong,
            document.createTextNode(" ")
          );
        }
      }
      function readResponseHtml(provider, selectors) {
        if (provider === "ai-overview") {
          const root = document.querySelector('[data-container-id="main-col"]');
          if (!root) return "";
          const clone2 = root.cloneNode(true);
          formatCitationAnchors(clone2);
          clone2.querySelectorAll(
            '[data-src-id], button, [role="button"], svg, img, style, script'
          ).forEach((el) => el.remove());
          return clone2.innerHTML.trim();
        }
        const latestResponse = findLatestResponseElement(selectors);
        if (!latestResponse) return "";
        if (provider === "claude") {
          setCachedRawSources(
            "claude",
            extractClaudeRawSourcesFromResponseElement(latestResponse.element)
          );
        }
        const clone = latestResponse.element.cloneNode(true);
        formatCitationAnchors(clone);
        const noiseSelectors = [
          "button",
          "[role='button']",
          "svg",
          "script",
          "style",
          "noscript",
          "iframe",
          "sup",
          "[aria-live]",
          "[data-testid='copy-turn-action-button']",
          "[data-testid='voice-play-turn-action-button']",
          "[data-testid='thumbs-up-button']",
          "[data-testid='thumbs-down-button']",
          "[aria-hidden='true']"
        ];
        for (const sel of noiseSelectors) {
          for (const el of Array.from(clone.querySelectorAll(sel))) {
            el.remove();
          }
        }
        return clone.innerHTML.trim();
      }
      function captureVisibleHtml(selectors, fallbackSelectors) {
        const latestResponse = findLatestResponseElement(selectors);
        if (latestResponse) {
          const html = latestResponse.element.outerHTML.trim();
          if (html) return { selector: latestResponse.selector, html };
        }
        for (const selector of fallbackSelectors || []) {
          const element = resolveSelectorWithin(document, selector)[0] ?? null;
          if (!isVisible(element)) continue;
          const html = element.outerHTML.trim();
          if (html) return { selector, html };
        }
        return { selector: "none", html: "" };
      }
      function detectBotPageState() {
        const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const title = (document.title || "").trim();
        const url = window.location.href;
        const signals = [
          {
            matched: /sorry/i.test(url) || /our systems have detected unusual traffic/i.test(bodyText),
            reason: "bot detection: unusual traffic / sorry page"
          },
          {
            matched: /captcha|recaptcha|turnstile|verify you are human/i.test(
              bodyText
            ),
            reason: "bot detection: captcha or human verification challenge"
          },
          {
            matched: Boolean(
              document.querySelector(
                'form#captcha-form, iframe[src*="recaptcha"]'
              )
            ) || /challenge/i.test(title),
            reason: "bot detection: challenge UI present"
          },
          {
            matched: /\/login|\/log-in|\/signin|\/sign-in|\/sign-up|\/signup|\/auth(?:\/|$)|accounts\.google\.com|auth\.openai\.com/.test(
              url
            ),
            reason: "session expired: redirected to login page"
          },
          {
            matched: /sign in to continue|you('ve| have) been signed out|create a free account|log in to continue|sign in to (?:chat|use|access)|please (?:sign|log) in/i.test(
              bodyText
            ),
            reason: "session expired: login wall detected"
          }
        ];
        const hit = signals.find((signal) => signal.matched);
        return {
          botDetected: Boolean(hit),
          reason: hit?.reason ?? null
        };
      }
      function getPlatformName() {
        const uaDataPlatform = navigator.userAgentData?.platform || "";
        return String(uaDataPlatform || navigator.platform || "").toLowerCase();
      }
      switch (currentOperation) {
        case "ping":
          return true;
        case "window-metrics":
          return {
            outerHeight: window.outerHeight,
            innerHeight: window.innerHeight,
            outerWidth: window.outerWidth,
            innerWidth: window.innerWidth
          };
        case "detect-bot-page":
          return detectBotPageState();
        case "platform-name":
          return getPlatformName();
        case "response-text":
          return readResponseText(
            String(currentParams?.provider || ""),
            currentParams?.selectors || []
          );
        case "response-html":
          return readResponseHtml(
            String(currentParams?.provider || ""),
            currentParams?.selectors || []
          );
        case "capture-visible-html":
          return captureVisibleHtml(
            currentParams?.selectors || [],
            currentParams?.fallbackSelectors || []
          );
        case "raw-sources":
          return runProviderRawSourcesExtractor(
            String(currentParams?.providerRawSourcesExtractor || ""),
            currentParams?.selectors || []
          );
        default:
          throw new Error(`unknown page operation: ${currentOperation}`);
      }
    },
    { operation, params: nextParams }
  );
}
export {
  runPageDomOp
};
