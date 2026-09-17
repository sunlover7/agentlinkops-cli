import { getDomain, getFaviconUrls } from "../../../shims/utils.js";
const PROVIDER_OWNED_SOURCE_DOMAINS = {
  chatgpt: ["chatgpt.com", "openai.com"],
  perplexity: ["perplexity.ai"],
  gemini: ["gemini.google.com", "google.com"],
  claude: ["claude.ai", "anthropic.com"],
  "ai-overview": ["google.com"]
};
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeSourceTitle(rawTitle, url) {
  const normalized = rawTitle.replace(/\s+/g, " ").trim();
  if (!normalized) return normalized;
  const domain = getDomain(url)?.replace(/^www\./i, "") || "";
  const hostLabel = domain.split(".")[0] || "";
  const prefixes = [domain, hostLabel].filter(Boolean);
  let title = normalized;
  for (const prefix of prefixes) {
    title = title.replace(
      new RegExp(`^${escapeRegExp(prefix)}(?:\\s+|(?=[A-Z]))`, "i"),
      ""
    );
  }
  return title.trim() || normalized;
}
function isProviderOwnedSource(provider, url) {
  if (!provider) return false;
  const hostname = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!hostname) return false;
  return (PROVIDER_OWNED_SOURCE_DOMAINS[provider] || []).some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}
function buildSources(rawSources, options) {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { rawHref, title: rawTitle, citedText } of rawSources) {
    const url = rawHref.replace(/#.*$/, "");
    if (!url) continue;
    if (isProviderOwnedSource(options?.provider, url)) continue;
    const domain = getDomain(url) || null;
    const title = normalizeSourceTitle(rawTitle || "", url) || domain || url;
    const favicon = getFaviconUrls(domain ?? "")?.[0] ?? null;
    const source = { title, cited_text: citedText, url, domain, favicon };
    const dedupeKey = JSON.stringify({
      domain: source.domain ?? null,
      url: source.url,
      title: source.title,
      cited_text: source.cited_text ?? ""
    });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push(source);
  }
  return results;
}
async function clickButtonViaDispatch(_page, button) {
  await button.dispatchClick();
  return true;
}
export {
  buildSources,
  clickButtonViaDispatch
};
