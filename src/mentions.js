import {pageQualityReason} from './verifier/page-quality.js';
import { analyzeReadiness } from './verifier/readiness.js';
// Unlinked mentions: a page that names the customer and does not link to them (DP-0009-T03).
//
// The [scope rule](../docs/PRODUCT-DIRECTION-2026-09-10.md) admits anything that fits declare,
// verify, watch, diff, and names reclamation first. This fits exactly, and it is the cheapest new
// observation available because both hard parts already exist: the verifier parses a page into
// per-occurrence links with raw rel tokens, and the corpus holds real pages to test against.
//
// **Everything interesting here is a refusal.** Finding the string is trivial; the work is in the
// four cases where finding it means nothing.
import { extractPage, STATIC_TEXT_LIMIT } from './page-extraction/index.js';
import { matchesTarget, validatePublicUrl, hasRedirectWrapperToTarget } from './verifier/url.js';

export const MENTION_LIMITS = Object.freeze({
  occurrences: 25,
  contextChars: 200,
  brands: 5,
  textChars: STATIC_TEXT_LIMIT,
});

export class MentionError extends Error {
  constructor(code) { super(code); this.name = 'MentionError'; this.code = code; }
}

/** Escapes a literal for use inside a regular expression. */
const literal = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Where a needle appears in text, with bounded context and a character offset.
 *
 * Matching is word-bounded on both sides so `customer.com` does not match inside
 * `notcustomer.community` — the same near-miss the URL layer refuses for links, applied to text.
 */
export function findOccurrences(text, needle, { limit = MENTION_LIMITS.occurrences, contextChars = MENTION_LIMITS.contextChars } = {}) {
  const found = [];
  // Counted past the cap on purpose. `found.length` is how many we KEPT, and reporting that as
  // the number of mentions would turn a storage limit into a measurement — a page naming a brand
  // eighty times would read as naming it twenty-five, and nothing in the output would say so.
  let total = 0;
    // The lookahead refuses a following label too, so `customer.com.evil.com` is not
  // `customer.com` — the same near-miss the URL layer refuses for links. A trailing full stop at
  // the end of a sentence still matches, because `\.?` consumes it and a space follows.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}@._-])${literal(needle)}(?!\\.?[\\p{L}\\p{N}-])`, 'giu');
  for (const match of String(text).matchAll(pattern)) {
    total += 1;
    if (found.length >= limit) continue;
    const start = Math.max(0, match.index - Math.floor(contextChars / 2));
    found.push({
      offset: match.index,
      text: match[0],
      context: String(text).slice(start, start + contextChars).trim(),
    });
  }
  found.total = total;
  found.truncated = total > found.length;
  return found;
}

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return null; } };

/**
 * Scans one fetched page for mentions of a target, and decides whether they are reclaimable.
 *
 * Takes HTML that has already been fetched — by the verifier, the crawler, or a caller holding a
 * corpus page — because a mention scan should cost nothing when we already hold the bytes.
 *
 * @returns {{state: 'mentioned_not_linked'|'mentioned_and_linked'|'not_mentioned'|'unknown'}}
 */
export function scanMentions(html, pageUrl, { targetUrl, targetScope = 'domain', brands = [], receipt = null, bodyTruncated = false, textLimit = MENTION_LIMITS.textChars } = {}) {
  const target = validatePublicUrl(targetUrl);
  if (!target.valid) throw new MentionError(`invalid_target:${target.reason}`);
  const page = validatePublicUrl(pageUrl);
  if (!page.valid) throw new MentionError(`invalid_page:${page.reason}`);

  const result = {
    v: 1, state: 'unknown', reason: 'not_scanned', page_url: page.url, target_url: target.url,
    target_scope: targetScope, occurrences: [], occurrence_count: 0, links_to_target: 0, complete: false,
    provenance: { kind: receipt === null ? 'caller_supplied_html' : 'capture_receipt', qualified: false },
    coverage: { documentComplete: false, textComplete: false, bodyComplete: receipt === null ? null : false },
  };

  if (typeof html !== 'string') { result.reason = 'html_required'; return result; }
  if (bodyTruncated === true) { result.reason = 'incomplete_body'; return result; }
  let parsed, analysis;
  try {
    parsed = extractPage(html, { baseUrl: page.url, receipt, textLimit });
    analysis = analyzeReadiness({ html, parsed, targetUrl: target.url });
  }
  catch (error) { result.reason = error?.reason ?? 'html_parse_error'; return result; }
  result.coverage = parsed.coverage;
  result.provenance.qualified = parsed.coverage.transportQualified;
  if (receipt !== null) result.provenance.representation = parsed.provenance.receipt.representation;

  // The verifier's "cannot conclude absence" rules carry over WHOLE, because the conclusion this
  // tool draws is an absence: no link on this page. On a page we could not read completely, that
  // is not a conclusion, and a reclamation tool that forgot it would generate outreach about
  // links that are already there.
  const qualityReason = pageQualityReason(parsed, analysis);
  if (qualityReason) { result.reason = qualityReason; return result; }
  // The complete link index alone cannot prove an absent mention when text hit its cap.
  if (!parsed.coverage.textComplete) { result.reason = 'text_extraction_truncated'; return result; }

  const linked = parsed.links.filter(link => matchesTarget(link.targetUrl, target.url, targetScope));
  // A physical wrapper may already lead to this target. Complete captured bytes
  // do not resolve that destination; never turn this hint into reclamation.
  // Evaluate each target separately, and retain genuine direct-link precedence.
  if (!linked.length && hasRedirectWrapperToTarget(parsed.links, target.url, targetScope)) {
    result.reason = 'target_in_redirect_parameter';
    return result;
  }
  result.complete = true;
  result.links_to_target = linked.length;

  // Reader-visible text only: a brand name inside a script, a comment or a JSON payload is not a
  // mention anyone read.
  const text = parsed.staticText.text;
  const host = hostOf(target.url);
  const needles = [];
  if (host) needles.push({ kind: 'domain', value: host });
  for (const brand of brands.slice(0, MENTION_LIMITS.brands)) {
    const value = String(typeof brand === 'string' ? brand : brand?.value ?? '').trim();
    const forced = typeof brand === 'object' && brand?.force === true;
    if (!value) continue;
    // **Length cannot tell a brand from an ordinary word.** "Settled" is seven characters,
    // "Notion" and "Stripe" are six, and a customer called any of them cannot be matched on the
    // word without a dictionary we do not have. So the rule is structural rather than a magic
    // number: a SINGLE-TOKEN brand needs the customer to say explicitly that they mean it, and a
    // multi-word one is distinctive enough on its own. The refusal is reported, so a customer
    // whose brand produced nothing can see why.
    if (!forced && !/\s/u.test(value)) {
      result.rejected_brands = [...(result.rejected_brands ?? []),
        { brand: value, reason: 'single_word_brand_needs_force', note: 'A one-word brand cannot be told apart from ordinary use. Pass { value, force: true } to match it anyway.' }];
      continue;
    }
    needles.push({ kind: 'brand', value });
  }
  let total = 0;
  for (const needle of needles) {
    const found = findOccurrences(text, needle.value);
    total += found.total;
    for (const occurrence of found) result.occurrences.push({ kind: needle.kind, matched: needle.value, ...occurrence });
  }
  const kept = result.occurrences.slice(0, MENTION_LIMITS.occurrences);
  // Three separate numbers, because they answer three different questions: how many times the
  // page names the target, how many of those we kept context for, and whether anything was cut.
  result.occurrence_count = total;
  result.occurrences_kept = kept.length;
  result.occurrences_truncated = total > kept.length;
  result.occurrences = kept;

  if (!total) { result.state = 'not_mentioned'; result.reason = 'no_mention_in_complete_page'; return result; }
  // A mention that is already linked is not an opportunity, it is a placement — and telling a
  // customer to go ask for a link they already have is the fastest way to lose a publisher.
  if (linked.length) {
    result.state = 'mentioned_and_linked';
    result.reason = 'mention_and_link_present';
    result.anchors = linked.slice(0, 5).map(link => ({ anchor: link.anchor, rel: link.rel, href: link.href }));
    return result;
  }
  result.state = 'mentioned_not_linked';
  result.reason = 'mention_without_link_in_complete_page';
  return result;
}

/**
 * Scans many already-fetched pages and reports the reclaimable ones.
 *
 * Deliberately takes pages rather than fetching: **a scan over bytes we already hold costs
 * nothing and is not billed**, which is the pricing contract's fourth principle, and a corpus of
 * two thousand pages is the obvious first place to point this.
 */
export function scanPages(pages, { targetUrl, targetScope = 'domain', brands = [] } = {}) {
  const results = [], counts = {};
  for (const page of pages) {
    let scanned;
    try { scanned = scanMentions(page.html, page.url, { targetUrl, targetScope, brands,
      receipt: page.receipt ?? page.capture ?? null, bodyTruncated: page.body_truncated === true || page.bodyTruncated === true }); }
    catch (error) { scanned = { state: 'unknown', reason: error?.code ?? 'scan_failed', page_url: page.url }; }
    counts[scanned.state] = (counts[scanned.state] ?? 0) + 1;
    if (scanned.state !== 'not_mentioned') results.push(scanned);
  }
  const readable = (counts.mentioned_not_linked ?? 0) + (counts.mentioned_and_linked ?? 0) + (counts.not_mentioned ?? 0);
  return {
    v: 1, target_url: targetUrl, target_scope: targetScope,
    pages_scanned: pages.length, counts,
    // Stated because the denominator is the whole question: 12 reclaimable out of 20 readable is
    // a different fact from 12 out of 2,000, and an unknown is neither a yes nor a no.
    coverage: { readable, unreadable: pages.length - readable },
    reclaimable: results.filter(row => row.state === 'mentioned_not_linked'),
    already_linked: results.filter(row => row.state === 'mentioned_and_linked').length,
  };
}
