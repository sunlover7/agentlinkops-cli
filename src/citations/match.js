// Target matching: did THIS run's answer reference THIS target?
//
// Two doors, in cost order: a citation match against the provider's citation list
// (cheap, exact), then a word-boundary mention match against the answer text (for the
// mentioned tier). URL normalization is deliberately conservative — the pilot's own
// domains are simple — and carries a documented limitation: the registrable-domain
// table below is a common-case subset of the public suffix list, not the PSL. It is
// sufficient for owned-site panels and wrong for exotic ccTLD composites, which is
// why hardening it (tldts or a vendored PSL) is a named task before general release.
import { CITATION_OUTCOMES, outcomeRank } from './contract.js';

const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.uy',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.in', 'net.in', 'org.in', 'co.za', 'com.sg', 'com.my', 'com.tr',
  'com.cn', 'com.hk', 'com.tw', 'co.kr',
]);

export function normalizeHost(rawHost) {
  if (typeof rawHost !== 'string') return null;
  let host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host || null;
}

/** Best-effort registrable domain. See the module comment for the PSL caveat. */
export function registrableDomain(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host || !host.includes('.')) return host ?? null;
  const labels = host.split('.');
  if (labels.length < 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

/** URL-scope comparison key: scheme- and query-agnostic, trailing-slash-insensitive. */
export function urlMatchKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    let path = url.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function hostOf(rawUrl) {
  try { return normalizeHost(new URL(rawUrl).hostname); } catch { return null; }
}

/**
 * Citation matching against a provider citation list.
 * domain scope: registrable domains equal. url scope: normalized URL keys equal.
 * Returns the matched citation URLs (possibly several).
 */
export function matchCitations(target, citations) {
  if (!Array.isArray(citations)) return [];
  if (target.scope === 'url') {
    const want = urlMatchKey(target.url);
    if (!want) return [];
    return citations.filter((c) => urlMatchKey(c.url) === want).map((c) => c.url);
  }
  const wantDomain = registrableDomain(target.domain);
  if (!wantDomain) return [];
  const hits = [];
  for (const c of citations) {
    const host = hostOf(c.url);
    if (host && registrableDomain(host) === wantDomain) hits.push(c.url);
  }
  return hits;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Word-boundary mention match. "acme" must not match "acmeshop" (mcp-geo's false
 * positive). Unicode lookarounds instead of \b, because \b is ASCII-only and brand
 * names are not.
 */
export function matchMention(target, answerText) {
  if (typeof answerText !== 'string' || answerText.length === 0) return false;
  const names = [target.brand, ...(target.aliases ?? [])].filter((n) => typeof n === 'string' && n.trim().length > 0);
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(answerText)) return true;
  }
  return false;
}

/**
 * Tier one observation for one target. Citations outrank mentions; a successful
 * re-fetch of the cited URL upgrades cited to verified. A failed re-fetch NEVER
 * downgrades the citation: the engine cited it, and our fetch problems are ours
 * (verify: 'unknown'), which is the link verifier's blocked-fetch rule transplanted.
 */
export function classifyOutcome(target, run, verifyFetch) {
  const citedUrls = matchCitations(target, run.citations ?? []);
  if (citedUrls.length > 0) {
    let outcome = 'cited';
    let verify = 'unverified';
    if (typeof verifyFetch === 'function') {
      const reachable = verifyFetch(citedUrls[0]);
      if (reachable === true) { outcome = 'verified'; verify = 'reachable'; }
      else if (reachable === false) { verify = 'unreachable'; }
      else { verify = 'unknown'; }
    }
    return { outcome, citedUrls, verify };
  }
  if (matchMention(target, run.answer ?? '')) return { outcome: 'mentioned', citedUrls: [], verify: 'unverified' };
  return { outcome: 'not_cited', citedUrls: [], verify: 'unverified' };
}

export { CITATION_OUTCOMES, outcomeRank };
