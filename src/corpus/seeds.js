import { validatePublicUrl } from '../verifier/url.js';

// Turns a publisher's own declarations into crawl seeds. Pure: parsing only, no fetching.
//
// Sitemap discovery lives here rather than in the verifier's robots parser because it is a
// crawl concern. `robotsDecision` answers "may I fetch this URL"; a Sitemap directive is a
// non-group line that answers a different question and must not change that verdict.
export const SEED_LIMITS = Object.freeze({
  documentBytes: 10 * 1024 * 1024, // sitemap protocol caps an uncompressed file at 50 MB; we read far less
  urlsPerDocument: 50_000,         // the protocol's own per-file URL cap
  sitemapDirectives: 100,
  indexDepth: 2,                   // an index of indexes is legal; deeper is a loop or a mistake
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export class SeedError extends Error {
  constructor(reason) { super(reason); this.name = 'SeedError'; this.reason = reason; }
}

// The seed-composition cap (DP-0049-T01 Fix 2). The birding corpus took 32.3% of its pages
// from six .edu library-guide seed hosts and the citation graph followed the seeds: 59 of 100
// shortlist rows were library infrastructure. The cap keeps one seed CLASS from dominating a
// corpus no matter how large its sitemaps are, without touching the per-host cap that keeps
// one large publisher from doing the same.
export const SEED_COMPOSITION = Object.freeze({ maxShare: 1 / 3 });

/**
 * Parses a seeds file into ordered `{ host, class }` records. Every comment line opens a
 * class for the host lines that follow it, so the class headers the earlier seed files
 * already carried de facto ("--- surfaced by Q1 ... ---") became the explicit unit the
 * composition cap enforces. A bare `#` with nothing after it resets to `unclassified`.
 */
export function parseSeedHosts(text) {
  if (typeof text !== 'string') throw new SeedError('seeds_not_text');
  const hosts = [];
  let klass = 'unclassified';
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const label = trimmed.replace(/^#+\s*/u, '').trim();
      klass = label || 'unclassified';
      continue;
    }
    hosts.push({ host: trimmed.toLowerCase(), class: klass });
  }
  return hosts;
}

/**
 * Caps each class's seed-URL contribution. `classHosts` is one record per class in file
 * order: `{ class, hosts: [[url, ...], ...] }` — the per-host URL lists AFTER the per-host
 * cap, in admission order. A class over the cap is down-sampled round-robin across its
 * hosts so the cut lands on every host evenly instead of beheading the last few; the share
 * is computed against the PRE-CAP total and nothing is redistributed to other classes, so
 * the rule is deterministic and auditable. A single-class run is never cut: one class cannot
 * dominate itself.
 *
 * @returns The kept URLs in class order, and the per-class accounting the run report carries.
 */
export function capSeedComposition(classHosts, { maxShare = SEED_COMPOSITION.maxShare } = {}) {
  if (!Array.isArray(classHosts) || classHosts.some(entry => !entry || !Array.isArray(entry.hosts))) {
    throw new SeedError('seed_classes_malformed');
  }
  const total = classHosts.reduce((sum, entry) => sum + entry.hosts.reduce((n, urls) => n + urls.length, 0), 0);
  const cap = Math.max(1, Math.floor(maxShare * total));
  const multiClass = classHosts.filter(entry => entry.hosts.some(urls => urls.length)).length > 1;
  const kept = [], perClass = [];
  for (const entry of classHosts) {
    const offered = entry.hosts.reduce((n, urls) => n + urls.length, 0);
    let keptUrls = [];
    if (multiClass && offered > cap) {
      // Round-robin one URL per host per turn, hosts in file order, until the cap is hit.
      const cursors = entry.hosts.map(() => 0);
      while (keptUrls.length < cap) {
        let advanced = false;
        for (let h = 0; h < entry.hosts.length && keptUrls.length < cap; h++) {
          if (cursors[h] < entry.hosts[h].length) {
            keptUrls.push(entry.hosts[h][cursors[h]++]);
            advanced = true;
          }
        }
        if (!advanced) break;
      }
    } else {
      keptUrls = entry.hosts.flat();
    }
    kept.push(...keptUrls);
    perClass.push({ class: entry.class, offered, kept: keptUrls.length, cut: offered - keptUrls.length });
  }
  return { kept, cap, applied: multiClass && perClass.some(entry => entry.cut > 0), perClass };
}

export function decodeXml(value) {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/giu, (whole, dec, hex, name) => {
    if (dec || hex) {
      const code = Number.parseInt(dec ?? hex, dec ? 10 : 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Absolute, public sitemap URLs declared in a robots.txt body. A `Sitemap:` line is
 * position-independent and belongs to no user-agent group, so it is read from the whole file.
 */
export function sitemapDirectives(robotsText, { baseUrl } = {}) {
  if (typeof robotsText !== 'string') return [];
  const found = [];
  for (const line of robotsText.replace(/^﻿/u, '').split(/\r?\n/u)) {
    const stripped = line.split('#', 1)[0].trim();
    const colon = stripped.indexOf(':');
    if (colon < 0 || stripped.slice(0, colon).trim().toLowerCase() !== 'sitemap') continue;
    const value = stripped.slice(colon + 1).trim();
    if (!value) continue;
    let absolute;
    try { absolute = baseUrl ? new URL(value, baseUrl).href : value; } catch { continue; }
    const checked = validatePublicUrl(absolute);
    // A sitemap on another host is legal but is a scope decision for the caller, not a
    // silent expansion here, so it is returned with its host intact and judged upstream.
    if (checked.valid && !found.includes(checked.url)) found.push(checked.url);
    if (found.length >= SEED_LIMITS.sitemapDirectives) break;
  }
  return found;
}

/**
 * A sitemap may only declare URLs at or below its own path. This is the "cross-submit" rule
 * from the sitemap protocol, and it is a scope control, not a formality: without it a sitemap
 * at `anyone.example/sitemap.xml` could inject URLs for a host we never chose to crawl, and a
 * sitemap at `/blog/sitemap.xml` could claim the whole site. The reference implementation
 * (crawler-commons) enforces exactly this, with a lenient mode; we have no lenient mode.
 */
export function withinSitemapScope(candidate, sitemapUrl, scope = 'path') {
  let url, base;
  try { url = new URL(candidate); base = new URL(sitemapUrl); } catch { return false; }
  if (url.hostname !== base.hostname) return false;
  // A sitemap NAMED IN robots.txt is authorised for the whole host, because robots.txt sits
  // at the root and is itself the authorisation. Only a sitemap found some other way is
  // confined to its own directory. Without this, a perfectly ordinary site that keeps its
  // sitemap at /sitemaps/example.com/sitemap.xml has every one of its URLs rejected —
  // measured against nolo.com, which is exactly that shape.
  if (scope === 'host') return true;
  const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  return url.pathname.startsWith(directory);
}

/**
 * Reads a sitemap or sitemap index.
 *
 * Deliberately a bounded scan for `<loc>` values rather than a full XML parse: we consume
 * exactly one element type from a document written by a third party, and a scanner cannot be
 * driven into entity expansion or deep-nesting attacks by hostile markup. The tradeoff is
 * recorded rather than hidden — this does not validate the document, and a `<loc>` inside an
 * unexpected element would still be read.
 *
 * @throws SeedError when the document is too large or is not a sitemap at all.
 */
export function parseSitemapEntries(input, { baseUrl, enforceScope = true, scope = 'path' } = {}) {
  if (typeof input !== 'string') throw new SeedError('sitemap_not_text');
  if (input.length > SEED_LIMITS.documentBytes) throw new SeedError('sitemap_too_large');
  // A byte-order mark before the root element defeats every subsequent match.
  const xml = input.replace(/^\uFEFF/u, '').replace(/^\s+/u, '');
  // Gzipped sitemaps are extremely common and are the acquisition layer's job to decompress.
  // Say so rather than reporting a valid .xml.gz as "not a sitemap".
  if (xml.charCodeAt(0) === 0x1f && xml.charCodeAt(1) === 0x8b) throw new SeedError('sitemap_is_gzipped');
  const indexAt = xml.search(/<\s*sitemapindex[\s>]/iu);
  const setAt = xml.search(/<\s*urlset[\s>]/iu);
  // A plain-text sitemap is one URL per line and is part of the protocol.
  if (indexAt < 0 && setAt < 0) return parseTextSitemap(xml, { baseUrl, enforceScope, scope });
  const kind = indexAt >= 0 && (setAt < 0 || indexAt < setAt) ? 'index' : 'urlset';

  const entries = [];
  const seen = new Set();
  const skipped = {};
  let truncated = false;
  // Collected rather than iterated lazily because each entry's lastmod is searched in the
  // region up to the NEXT `<loc>`, which needs lookahead. Collection stops one past the cap:
  // a document with more `<loc>` blocks than the cap is knowably truncated without reading
  // all of them, which is the same signal the lazy scan's early break used to produce.
  const pattern = /<\s*loc\s*>([\s\S]*?)<\s*\/\s*loc\s*>/giu;
  const matches = [];
  for (const match of xml.matchAll(pattern)) {
    matches.push(match);
    if (matches.length > SEED_LIMITS.urlsPerDocument) break;
  }
  const lastmodPattern = /<\s*lastmod\s*>([\s\S]*?)<\s*\/\s*lastmod\s*>/iu;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (entries.length >= SEED_LIMITS.urlsPerDocument) { truncated = true; break; }
    let raw = decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')).trim();
    if (!raw) continue;
    // The protocol requires an absolute URL here. Resolving a relative value against the
    // sitemap would turn any stray text into a crawlable path on the publisher's host.
    const checked = absoluteEntry(raw);
    if (!checked.valid) { skipped[checked.reason] = (skipped[checked.reason] ?? 0) + 1; continue; }
    if (enforceScope && baseUrl && !withinSitemapScope(checked.url, baseUrl, scope)) {
      skipped.out_of_sitemap_scope = (skipped.out_of_sitemap_scope ?? 0) + 1;
      continue;
    }
    if (seen.has(checked.url)) continue;
    seen.add(checked.url);
    // A lastmod belongs to the `<url>` (or `<sitemap>`) block its `<loc>` opens; the region
    // ends where the next entry begins. Captured RAW: this is the publisher's declared change
    // time, parsed where it is spent (`parseTimestamp` in freshness.js), and an unparsable
    // claim is counted there rather than silently dropped here.
    const region = xml.slice(match.index + match[0].length, matches[index + 1]?.index ?? xml.length);
    const lastmodRaw = lastmodPattern.exec(region)?.[1]?.trim() ?? null;
    entries.push({ loc: checked.url, lastmod: lastmodRaw });
  }
  // The loop can fill the cap on the LAST collected match, with nothing left to iterate and
  // trip the in-loop break. Collection stopping at cap+1 is itself the proof that more
  // `<loc>` blocks existed, which is exactly what truncated means.
  if (!truncated && entries.length >= SEED_LIMITS.urlsPerDocument && matches.length > SEED_LIMITS.urlsPerDocument) truncated = true;
  return { kind, entries, truncated, skipped };
}

/** The URL-only view of a sitemap, for callers that do not diff by lastmod. */
export function parseSitemap(input, options = {}) {
  const { kind, entries, truncated, skipped } = parseSitemapEntries(input, options);
  return { kind, urls: entries.map(entry => entry.loc), truncated, skipped };
}

/** A sitemap entry must stand on its own as a public absolute URL. */
function absoluteEntry(value) {
  try { new URL(value); } catch { return { valid: false, reason: 'not_absolute' }; }
  return validatePublicUrl(value);
}

/** The protocol's plain-text format: one absolute URL per line, no markup. No lastmod. */
function parseTextSitemap(text, { baseUrl, enforceScope, scope = 'path' }) {
  const entries = [], seen = new Set(), skipped = {};
  let truncated = false;
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    // Anything with markup is not a text sitemap; do not half-read an unknown document.
    if (value.startsWith('<')) throw new SeedError('not_a_sitemap');
    if (entries.length >= SEED_LIMITS.urlsPerDocument) { truncated = true; break; }
    const checked = absoluteEntry(value);
    if (!checked.valid) { skipped[checked.reason] = (skipped[checked.reason] ?? 0) + 1; continue; }
    if (enforceScope && baseUrl && !withinSitemapScope(checked.url, baseUrl, scope)) {
      skipped.out_of_sitemap_scope = (skipped.out_of_sitemap_scope ?? 0) + 1;
      continue;
    }
    if (seen.has(checked.url)) continue;
    seen.add(checked.url);
    entries.push({ loc: checked.url, lastmod: null });
  }
  if (!entries.length && !Object.keys(skipped).length) throw new SeedError('not_a_sitemap');
  return { kind: 'urlset', entries, truncated, skipped };
}

/**
 * Walks a sitemap index to its leaf entries, using a caller-supplied fetch so this module
 * still performs no I/O. `fetchDocument(url)` returns the body text or null when it could not
 * be read. Leaf entries carry their declared lastmod; an index child carries the index's own
 * lastmod, which describes the FILE rather than the URLs inside it, and so is not attached to
 * anything downstream.
 *
 * A document we could not read is counted, never treated as a sitemap with no URLs — the same
 * rule extraction follows, for the same reason.
 */
export async function expandSitemaps(roots, fetchDocument, { maxDepth = SEED_LIMITS.indexDepth, maxDocuments = SEED_LIMITS.sitemapDirectives, scope = 'path' } = {}) {
  const entries = [], seenLocs = new Set(), visited = new Set(), failures = {};
  let documents = 0, truncated = false;
  const queue = roots.map(url => ({ url, depth: 0 }));
  while (queue.length) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    if (documents >= maxDocuments) { truncated = true; break; }
    documents++;
    const body = await fetchDocument(url);
    if (body === null || body === undefined) { failures.unreadable = (failures.unreadable ?? 0) + 1; continue; }
    let parsed;
    try { parsed = parseSitemapEntries(body, { baseUrl: url, scope }); }
    catch (error) { failures[error.reason] = (failures[error.reason] ?? 0) + 1; continue; }
    if (parsed.truncated) truncated = true;
    if (parsed.kind === 'index') {
      // An index deeper than the limit is a loop or a mistake; stop rather than follow it.
      if (depth >= maxDepth) { failures.index_too_deep = (failures.index_too_deep ?? 0) + 1; continue; }
      for (const child of parsed.entries) queue.push({ url: child.loc, depth: depth + 1 });
      continue;
    }
    for (const found of parsed.entries) {
      if (seenLocs.has(found.loc)) continue;
      seenLocs.add(found.loc);
      entries.push(found);
    }
  }
  return { urls: entries.map(entry => entry.loc), entries, documents, truncated, failures };
}
