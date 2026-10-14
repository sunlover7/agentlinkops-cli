// Bounded public site and asset profiles (DP-0017-T03), implemented against the
// [first-party context contract](../../docs/initiatives/DP-0017-first-party-search-context/first-party-context-contract.md).
//
// The profile describes audience, assets and campaign targets from PUBLIC fetches of the
// customer's own site only — no CMS, no credentials, no rendered browser. It inherits every
// existing network and robots limit rather than growing new ones:
//
// - Sitemap parsing and limits are `src/corpus/seeds.js` UNCHANGED (10 MiB per document,
//   50,000 URLs per document, 100 directives, index depth 2, cross-submit scope, gzip
//   detection, and the parser's skipped/truncated/failure counters, preserved verbatim).
// - Page fetching is the verifier's public fetch boundary through `src/corpus/acquire.js`:
//   `publicFetchSafe` transport assertion, robots per hop, 20-second budget, 2 MiB body,
//   5 redirects, plus the CLI courtesy pacing (2 s floor per host, concurrency 6).
//
// One deliberate divergence from the contract's prose, recorded rather than hidden: the
// contract describes the robots posture as "a 401/403 or oversized robots.txt is a refusal".
// Commit 0474a43 (2026-09-11, "Treat an unavailable robots.txt as no restrictions, per RFC
// 9309") changed the shipped verifier to the RFC reading AFTER the DP-0014 measurement the
// contract cites. Inheriting means inheriting what ships: page fetches follow the verifier's
// current behavior whatever it is, and the robots fact row records `unavailable_<status>` so
// the divergence stays visible in the facts. The SITEMAP lane is stricter on our own account:
// when robots.txt cannot be read, no sitemap directives are guessed and the lane is refused —
// an unknown, never "no assets".
//
// Ownership follows the ledger split: `site-facts.jsonl` rows are tool-owned facts (titles,
// h1s, asset candidates, sitemap membership, byte hashes, fetchedAt — never raw HTML);
// `site-profile.md` is the human/agent-owned reading, and every judgment in it cites its fact
// row or manual entry.
import { SEED_LIMITS, parseSitemap, sitemapDirectives, withinSitemapScope } from '../corpus/seeds.js';
import { createAcquisition } from '../corpus/acquire.js';
import { validatePublicUrl } from '../verifier/url.js';
import { createDocumentTransport } from '../page-acquisition/documents.js';
import { extractPageMetadata } from '../page-extraction/metadata.js';
import { readJsonl, appendJsonl, sha256Hex } from './util.js';
import { readManual } from './gsc.js';

export const PROFILE_LIMITS = Object.freeze({
  sitemapDocuments: 3,      // robots + sitemap index + at most 3 sitemap documents
  selectedPages: 10,        // at most 10 selected pages per profile build
  robotsBytes: 512 * 1024,  // the verifier's own robots bound
  pageConcurrency: 6,       // the CLI's courtesy concurrency
  hostDelayMs: 2_000,       // the CLI's courtesy floor per host
});

export class ProfileError extends Error {
  constructor(reason, details = {}) { super(reason); this.name = 'ProfileError'; this.reason = reason; this.details = details; }
}

// ---------------------------------------------------------------------------
// The bounded document transport (robots.txt and sitemap documents). Sitemaps are XML, so the
// verifier's page fetcher — which requires text/html — cannot serve them; this transport keeps
// the same shape: public URL validation, manual redirects (max 5), a bounded body, gzip
// decompression (the acquisition layer's job per seeds.js), and per-host courtesy pacing.
// ---------------------------------------------------------------------------

/** Compatibility entrypoint; byte limits and abortable document reads live in one core. */
export function createSiteTransport(options = {}) {
  return createDocumentTransport({ maxBytes: SEED_LIMITS.documentBytes,
    hostDelayMs: PROFILE_LIMITS.hostDelayMs, ...options });
}

// ---------------------------------------------------------------------------
// Derived page fields. No raw HTML is stored: titles, headings, counts, a byte hash and the
// fetch date, matching the verifier's rule that evidence HTML never lives in a payload.
// ---------------------------------------------------------------------------

/** Asset candidates are NOMINATIONS for judgment, never findings: path conventions the publisher chose plus names the manual declared. */
const ASSET_PATH_PATTERNS = Object.freeze([
  [/\/(tools?|calculators?|templates?|checklists?|guides?)\//iu, 'asset_path_convention'],
  [/\/(studies?|research|data|reports?|whitepapers?|surveys?)\//iu, 'research_asset_path_convention'],
  [/\.(pdf|xlsx?|csv)$/iu, 'downloadable_file'],
]);

export function derivePageFields(html, { baseUrl } = {}) {
  return extractPageMetadata(html, { baseUrl });
}

function assetCandidateReasons(url, derived, manualAssets) {
  const reasons = [];
  for (const [pattern, label] of ASSET_PATH_PATTERNS) if (pattern.test(new URL(url).pathname)) reasons.push(label);
  const haystack = [derived.title, ...derived.h1s].filter(Boolean).join(' ').toLowerCase();
  for (const asset of manualAssets ?? []) {
    const name = String(asset).toLowerCase().trim();
    if (name && haystack.includes(name.split(/\s+/u)[0])) reasons.push('matches_manual_asset_name');
  }
  return [...new Set(reasons)];
}

// ---------------------------------------------------------------------------
// Fact rows and citations.
// ---------------------------------------------------------------------------

export async function readSiteFacts(path) { const { rows, problems, missing } = await readJsonl(path); return { rows, problems, missing }; }

/** Newest fact row per stable id. The id is derived from kind+url, so citations survive rebuilds. */
export async function siteFactRow(kind, url, extra = {}) {
  const id = `f-${(await sha256Hex(`${kind}|${url}`)).slice(0, 10)}`;
  return { id, kind, url, fetched_at: extra.fetched_at ?? new Date().toISOString(), ...extra };
}

export function newestSiteFacts(rows) {
  const byId = new Map();
  for (const row of rows) {
    const held = byId.get(row.id);
    if (!held || String(row.fetched_at ?? '') >= String(held.fetched_at ?? '')) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * The editable, human/agent-owned profile scaffold. Every judgment line cites its source — a
 * fact row id or a manual entry — and editing a judgment never edits a fact: the facts live in
 * a different file with a different owner. Inferences are labeled as such; a recommendation is
 * a DP-0009 brief's job and does not appear here.
 */
export function renderSiteProfile({ facts, manual, origin }) {
  const newest = newestSiteFacts(facts);
  const manualIndex = new Map((manual?.entries ?? []).map((entry, index) => [`${entry.field}|${entry.value}`, index]));
  const manualRef = (field, value) => `[manual:${manualIndex.get(`${field}|${value}`) ?? 0}]`;
  const lines = [
    `# Site profile — ${origin}`, '',
    '<!-- Human/agent-owned. Edit the judgments, keep the citations: every fact: reference',
    '     resolves to a tool-owned row in site-facts.jsonl, and every manual: reference to a',
    '     manual.md entry. The facts never change when you edit this file. -->', '',
  ];
  const sitemapFacts = newest.filter(row => row.kind === 'site.sitemap');
  const pageFacts = newest.filter(row => row.kind === 'site.page');
  const robotsFact = newest.find(row => row.kind === 'site.robots');

  lines.push('## Audience', '');
  if (manual?.site_description) lines.push(`- ${manual.site_description} ${manualRef('site_description', manual.site_description)}`);
  if (robotsFact) lines.push(`- Robots posture observed ${robotsFact.outcome}${robotsFact.reason ? ` (${robotsFact.reason})` : ''}. [fact:${robotsFact.id}]`);
  lines.push("- TODO(judgment): who this site is for, in the operator's own words.", '');

  lines.push('## Assets', '');
  const assetPages = pageFacts.filter(row => Array.isArray(row.asset_candidate_reasons) && row.asset_candidate_reasons.length);
  for (const row of assetPages) lines.push(`- ${row.url} — candidate via ${row.asset_candidate_reasons.join(', ')}; title "${row.title ?? 'unknown'}". [fact:${row.id}]`);
  for (const asset of manual?.assets ?? []) lines.push(`- ${asset} ${manualRef('assets', asset)}`);
  if (!assetPages.length && !(manual?.assets ?? []).length) lines.push('- TODO(judgment): name the assets worth promoting; unreadable pages stay unknown, never "no assets".');
  lines.push('');

  lines.push('## Campaign targets', '');
  for (const row of pageFacts) if (row.selection_reasons?.includes('manual')) lines.push(`- ${row.url} — declared target. [fact:${row.id}]`);
  for (const row of pageFacts) if (row.outcome !== 'fetched') lines.push(`- ${row.url} — MISSING/UNKNOWN (${row.outcome}${row.reason ? `: ${row.reason}` : ''}); explicit, not dropped. [fact:${row.id}]`);
  for (const row of sitemapFacts.slice(0, 3)) lines.push(`- Sitemap ${row.url}: ${row.urls_found ?? 'unknown'} URL(s), counters preserved (truncated ${row.truncated}, skipped ${JSON.stringify(row.skipped ?? {})}). [fact:${row.id}]`);
  lines.push('');
  return lines.join('\n');
}

const CITATION = /\[(fact|manual):([^\]]+)\]/gu;

/**
 * Checks that every citation in an edited profile still resolves. Editing a judgment may never
 * silently orphan the evidence it stands on: an unresolved citation is reported, and facts are
 * only ever read here — nothing in this file writes to site-facts.jsonl except a build.
 */
export function validateProfileCitations({ profileText, facts, manual }) {
  const newest = newestSiteFacts(facts ?? []);
  const byId = new Map(newest.map(row => [row.id, row]));
  const citations = [], unresolved = [];
  for (const match of String(profileText ?? '').matchAll(CITATION)) {
    const [, kind, ref] = match;
    const resolves = kind === 'fact' ? byId.has(`f-${ref.replace(/^f-/u, '')}`) : Boolean(manual?.entries?.[Number(ref)]);
    citations.push({ ref: `${kind}:${ref}`, resolves });
    if (!resolves) unresolved.push(`${kind}:${ref}`);
  }
  return { citations: citations.length, unresolved, facts_read_only: true };
}

// ---------------------------------------------------------------------------
// The bounded profile build.
// ---------------------------------------------------------------------------

function classifySelection(url, manualTargets, homepage, sitemapUrls) {
  const reasons = [];
  if (manualTargets.includes(url)) reasons.push('manual');
  if (homepage && url === homepage) reasons.push('homepage');
  if (sitemapUrls.includes(url)) reasons.push('sitemap');
  return reasons.length ? reasons : ['explicit'];
}

/**
 * Builds the bounded public profile. Bounds, all reported as counts when hit: robots.txt (one
 * document), at most 3 sitemap documents, at most 10 selected pages. A page that could not be
 * read is an explicit unknown row — never dropped, never "no assets".
 */
export async function buildSiteProfile({
  site = null, paths, manual = null, transport = null, acquisition = null,
  recovery = null,
  extraPages = [], now = () => new Date().toISOString(), limits = {},
}) {
  const cap = { ...PROFILE_LIMITS, ...limits };
  const manualInputs = manual ?? (paths?.manual ? await readManual(paths.manual) : { target_pages: [], assets: [] });
  const origin = (() => {
    if (site) { const checked = validatePublicUrl(site.includes('://') ? site : `https://${site}`); return checked.valid ? new URL(checked.url).origin : null; }
    for (const target of manualInputs.target_pages ?? []) {
      const checked = validatePublicUrl(target);
      if (checked.valid) return new URL(checked.url).origin;
    }
    return null;
  })();
  if (!origin) throw new ProfileError('no_site_resolved', { hint: 'pass --site ORIGIN or declare target pages in manual.md' });

  const fetchedAt = now();
  const facts = [];
  const docFetch = transport ?? createSiteTransport({});

  // 1. robots.txt — one bounded document. Unreadable is recorded; the sitemap lane is then
  //    refused rather than guessing at /sitemap.xml, and the page lane proceeds under the
  //    verifier's own current robots posture.
  const robotsUrl = `${origin}/robots.txt`;
  const robotsFetch = await docFetch.fetchText(robotsUrl, { purpose: 'robots' });
  const robotsText = robotsFetch.ok ? robotsFetch.text : '';
  const directives = robotsFetch.ok ? sitemapDirectives(robotsText, { baseUrl: robotsUrl }) : [];
  const robotsFact = await siteFactRow('site.robots', robotsUrl, {
    outcome: robotsFetch.ok ? 'fetched' : 'unreadable',
    reason: robotsFetch.reason ?? null, status: robotsFetch.status ?? null,
    bytes: robotsFetch.bytes ?? null, gzipped: robotsFetch.gzipped ?? false,
    content_sha256: robotsFetch.ok ? await sha256Hex(robotsText) : null,
    sitemap_directives: directives, fetched_at: fetchedAt,
  });
  facts.push(robotsFact);

  // 2. Sitemaps declared BY the publisher, bounded at 3 documents total, parsed by seeds.js
  //    unchanged. The parser's skipped/truncated/failure counters are preserved verbatim.
  const sitemapUrls = [];
  let sitemapFactsWritten = 0;
  const sitemapFailures = {}, sitemapSkipped = {};
  let sitemapDocuments = 0, sitemapTruncated = false, sitemapCapped = false;
  if (!robotsFetch.ok && robotsFetch.reason !== 'not_found') {
    sitemapFailures[`robots_unreadable_${robotsFetch.reason}`] = 1;
  } else {
    // Directives beyond the cap are DROPPED, so the drop is counted, never silent.
    const roots = directives.slice(0, cap.sitemapDocuments);
    if (directives.length > cap.sitemapDocuments) sitemapCapped = true;
    const queue = roots.map(url => ({ url, depth: 0 }));
    const visited = new Set();
    while (queue.length) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      if (sitemapDocuments >= cap.sitemapDocuments) { sitemapCapped = true; break; }
      sitemapDocuments++;
      const fetchAt = now();
      const document = await docFetch.fetchText(url);
      if (!document.ok) { sitemapFailures[document.reason ?? 'unreadable'] = (sitemapFailures[document.reason ?? 'unreadable'] ?? 0) + 1; continue; }
      let parsed;
      try { parsed = parseSitemap(document.text, { baseUrl: url, scope: 'host' }); }
      catch (error) { sitemapFailures[error.reason ?? 'not_a_sitemap'] = (sitemapFailures[error.reason ?? 'not_a_sitemap'] ?? 0) + 1; continue; }
      if (parsed.truncated) sitemapTruncated = true;
      for (const [reason, count] of Object.entries(parsed.skipped ?? {})) sitemapSkipped[reason] = (sitemapSkipped[reason] ?? 0) + count;
      const fact = await siteFactRow('site.sitemap', url, {
        kind_index: parsed.kind, urls: parsed.urls.length, urls_found: parsed.urls.length,
        truncated: parsed.truncated, skipped: parsed.skipped, gzipped: document.gzipped,
        content_sha256: await sha256Hex(document.text), documents: 1, failures: {},
        fetched_at: fetchAt,
      });
      facts.push(fact); sitemapFactsWritten++;
      if (parsed.kind === 'index') {
        if (depth >= SEED_LIMITS.indexDepth) { sitemapFailures.index_too_deep = (sitemapFailures.index_too_deep ?? 0) + 1; continue; }
        for (const child of parsed.urls.slice(0, cap.sitemapDocuments)) {
          if (!visited.has(child) && withinSitemapScope(child, url, 'host')) queue.push({ url: child, depth: depth + 1 });
        }
        continue;
      }
      for (const found of parsed.urls) if (!sitemapUrls.includes(found)) sitemapUrls.push(found);
    }
  }

  // 3. Page selection, hard-capped, every limit reported.
  const homepage = `${origin}/`;
  const wanted = [...new Set([...(manualInputs.target_pages ?? []).filter(u => validatePublicUrl(u).valid), ...extraPages.filter(u => validatePublicUrl(u).valid)])];
  const selected = [...wanted];
  if (!selected.includes(homepage) && selected.length < cap.selectedPages) selected.push(homepage);
  for (const url of sitemapUrls) {
    if (selected.length >= cap.selectedPages) break;
    if (!selected.includes(url)) selected.push(url);
  }
  const pagesCapped = selected.length >= cap.selectedPages;
  const selectedFinal = selected.slice(0, cap.selectedPages);

  // 4. Page fetches on the verifier's public fetch boundary, with the CLI's courtesy pacing.
  // This local producer owns no Worker job or native reservation. Explicit caller
  // adapters may recover a page; omitted privileged routes remain unsupported.
  const pageAcquisition = acquisition ?? createAcquisition({ publicFetchSafe: true,purpose:'research',...(recovery?{recovery}:{}) });
  const pacer = createPacer({ hostDelayMs: cap.hostDelayMs });
  const pageRows = [];
  for (const url of selectedFinal) {
    const fetchAt = now();
    const result = await pageAcquisition.fetchPage(url, { kind: 'direct',purpose:'research', beforeFetch: pacer.beforeFetch,...(recovery?{recovery}:{}) });
    const acquired = result.outcome === 'fetched';
    let outcome = result.outcome, reason = result.reason ?? null;
    let derived = { title: null, h1s: [], meta_description: null, canonical: null, link_counts: null };
    if (acquired) {
      try {
        if (result.body_truncated === true) throw new ProfileError('body_truncated');
        derived = derivePageFields(result.html, { baseUrl: result.final_url ?? url });
      }
      catch (error) {
        // A refused/incomplete parse is an explicit unknown, never an empty page or "no assets".
        outcome = 'unavailable'; reason = error?.reason ?? 'unreadable_document';
      }
    }
    const fetched = outcome === 'fetched';
    derived.asset_candidate_reasons = fetched ? assetCandidateReasons(url, derived, manualInputs.assets) : null;
    const fact = await siteFactRow('site.page', url, {
      outcome, reason, http_status: result.http_status ?? null,
      final_url: result.final_url ?? url, robots: result.robots?.reason ?? null,
      title: derived.title, h1s: derived.h1s, meta_description: derived.meta_description,
      canonical: derived.canonical, link_counts: derived.link_counts,
      asset_candidate_reasons: derived.asset_candidate_reasons,
      in_sitemap: sitemapUrls.includes(url),
      selection_reasons: classifySelection(url, manualInputs.target_pages ?? [], homepage, sitemapUrls),
      bytes: result.bytes ?? null, content_sha256: acquired ? await sha256Hex(result.html ?? '') : null,
      ...(result.acquisition?{acquisition:result.acquisition}:{}),
      fetched_at: fetchAt,
    });
    facts.push(fact); pageRows.push(fact);
  }

  if (paths?.siteFacts) await appendJsonl(paths.siteFacts, facts);

  return {
    state: 'ok',
    origin, built_at: fetchedAt,
    robots: { outcome: robotsFact.outcome, reason: robotsFact.reason, directives: directives.length },
    sitemaps: {
      documents: sitemapDocuments, urls_found: sitemapUrls.length, truncated: sitemapTruncated,
      capped: sitemapCapped, directives_seen: directives.length,
      failures: sitemapFailures, skipped: sitemapSkipped,
    },
    pages: pageRows.map(row => ({ url: row.url, outcome: row.outcome, reason: row.reason, title: row.title, in_sitemap: row.in_sitemap, selection_reasons: row.selection_reasons, asset_candidate_reasons: row.asset_candidate_reasons,
      ...(row.acquisition?{acquisition:row.acquisition}:{}) })),
    limits: { sitemap_documents: cap.sitemapDocuments, selected_pages: cap.selectedPages, pages_capped: pagesCapped, pages_selected: pageRows.length },
    rows_written: facts.length,
    notes: [
      sitemapCapped ? `sitemap document cap (${cap.sitemapDocuments}) reached; counters preserved` : null,
      pagesCapped ? `selected-page cap (${cap.selectedPages}) reached` : null,
      pageRows.some(row => row.outcome !== 'fetched') ? 'one or more pages are unknown/unreadable — explicit outcomes, never "no assets"' : null,
    ].filter(Boolean),
  };
}

/** The CLI's courtesy floor per host (2 s), honouring a publisher's stated crawl delay when longer. */
export function createPacer({ hostDelayMs = PROFILE_LIMITS.hostDelayMs, now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const nextAllowed = new Map();
  return {
    async beforeFetch(url, context = {}) {
      try { var host = new URL(url).hostname; } catch { return; }
      const stated = Number(context.crawlDelaySeconds ?? 0) * 1000;
      const floor = Math.max(hostDelayMs, Number.isFinite(stated) ? stated : 0);
      const allowed = nextAllowed.get(host) ?? 0;
      const delay = allowed - now();
      if (delay > 0) await wait(delay);
      nextAllowed.set(host, now() + floor);
    },
  };
}
