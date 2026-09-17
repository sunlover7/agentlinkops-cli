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

function decodeXml(value) {
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
export function parseSitemap(input, { baseUrl, enforceScope = true, scope = 'path' } = {}) {
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

  const urls = [];
  const skipped = {};
  let truncated = false;
  const pattern = /<\s*loc\s*>([\s\S]*?)<\s*\/\s*loc\s*>/giu;
  for (const match of xml.matchAll(pattern)) {
    if (urls.length >= SEED_LIMITS.urlsPerDocument) { truncated = true; break; }
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
    if (!urls.includes(checked.url)) urls.push(checked.url);
  }
  return { kind, urls, truncated, skipped };
}

/** A sitemap entry must stand on its own as a public absolute URL. */
function absoluteEntry(value) {
  try { new URL(value); } catch { return { valid: false, reason: 'not_absolute' }; }
  return validatePublicUrl(value);
}

/** The protocol's plain-text format: one absolute URL per line, no markup. */
function parseTextSitemap(text, { baseUrl, enforceScope, scope = 'path' }) {
  const urls = [], skipped = {};
  let truncated = false;
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    // Anything with markup is not a text sitemap; do not half-read an unknown document.
    if (value.startsWith('<')) throw new SeedError('not_a_sitemap');
    if (urls.length >= SEED_LIMITS.urlsPerDocument) { truncated = true; break; }
    const checked = absoluteEntry(value);
    if (!checked.valid) { skipped[checked.reason] = (skipped[checked.reason] ?? 0) + 1; continue; }
    if (enforceScope && baseUrl && !withinSitemapScope(checked.url, baseUrl, scope)) {
      skipped.out_of_sitemap_scope = (skipped.out_of_sitemap_scope ?? 0) + 1;
      continue;
    }
    if (!urls.includes(checked.url)) urls.push(checked.url);
  }
  if (!urls.length && !Object.keys(skipped).length) throw new SeedError('not_a_sitemap');
  return { kind: 'urlset', urls, truncated, skipped };
}

/**
 * Walks a sitemap index to its leaf URLs, using a caller-supplied fetch so this module still
 * performs no I/O. `fetchDocument(url)` returns the body text or null when it could not be read.
 *
 * A document we could not read is counted, never treated as a sitemap with no URLs — the same
 * rule extraction follows, for the same reason.
 */
export async function expandSitemaps(roots, fetchDocument, { maxDepth = SEED_LIMITS.indexDepth, maxDocuments = SEED_LIMITS.sitemapDirectives, scope = 'path' } = {}) {
  const urls = [], visited = new Set(), failures = {};
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
    try { parsed = parseSitemap(body, { baseUrl: url, scope }); }
    catch (error) { failures[error.reason] = (failures[error.reason] ?? 0) + 1; continue; }
    if (parsed.truncated) truncated = true;
    if (parsed.kind === 'index') {
      // An index deeper than the limit is a loop or a mistake; stop rather than follow it.
      if (depth >= maxDepth) { failures.index_too_deep = (failures.index_too_deep ?? 0) + 1; continue; }
      for (const child of parsed.urls) queue.push({ url: child, depth: depth + 1 });
      continue;
    }
    for (const found of parsed.urls) if (!urls.includes(found)) urls.push(found);
  }
  return { urls, documents, truncated, failures };
}
