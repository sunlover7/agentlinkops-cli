// Column mappings for the exports customers already have.
//
// The architecture matters more than any individual alias list. **A supplier preset is a
// convenience over an explicit mapping, never a requirement**: every import can be driven by
// `--map source=…,target=…`, and a preset only supplies defaults for that. So when a vendor
// renames a column — and they do — the import still works today with one flag rather than
// waiting for a release. Detection failure prints the header row it actually saw and the exact
// `--map` that would fix it.
//
// The alias lists below are best effort, drawn from the exports these tools have written. They
// are matched case-insensitively with spacing and punctuation removed, so "Referring page URL",
// "referring_page_url" and "ReferringPageURL" are one name.
import { normalizeHeader } from './csv.js';

const alias = (...names) => names.map(normalizeHeader);

export const SUPPLIERS = Object.freeze({
  ahrefs: {
    label: 'Ahrefs backlinks export',
    source: alias('Referring page URL', 'Referring Page URL', 'Source url', 'url_from'),
    target: alias('Target URL', 'Link URL', 'url_to'),
    anchor: alias('Anchor', 'Anchor text'),
    first_seen: alias('First seen'), last_seen: alias('Last seen'),
    nofollow: alias('Nofollow'), lost: alias('Lost'),
    link_type: alias('Type', 'Link type'),
  },
  semrush: {
    label: 'Semrush backlinks export',
    source: alias('Source url', 'Source URL', 'Page URL'),
    target: alias('Target url', 'Target URL'),
    anchor: alias('Anchor', 'Anchor text'),
    first_seen: alias('First seen'), last_seen: alias('Last seen'),
    nofollow: alias('Nofollow'), lost: alias('Lost'),
    link_type: alias('Type'),
  },
  majestic: {
    label: 'Majestic backlinks export',
    source: alias('Source URL', 'SourceURL'),
    target: alias('Target URL', 'TargetURL'),
    anchor: alias('Anchor Text', 'AnchorText'),
    first_seen: alias('First Indexed Date', 'FirstIndexedDate', 'Date'),
    last_seen: alias('Last Seen Date', 'LastSeenDate', 'Date'),
    nofollow: alias('FlagNoFollow', 'NoFollow'),
    link_type: alias('LinkType'),
  },
  moz: {
    label: 'Moz Link Explorer export',
    source: alias('Source Page', 'Source URL'),
    target: alias('Target Page', 'Target URL'),
    anchor: alias('Anchor Text'),
    first_seen: alias('First Seen'), last_seen: alias('Last Seen'),
    nofollow: alias('Nofollow'), link_type: alias('Link Type'),
  },
  dataforseo: {
    label: 'DataForSEO backlinks export',
    source: alias('url_from'), target: alias('url_to'),
    anchor: alias('anchor'),
    first_seen: alias('first_seen'), last_seen: alias('last_seen', 'last_visited'),
    dofollow: alias('dofollow'), lost: alias('is_lost'),
    link_type: alias('item_type', 'type'),
  },
  linkody: {
    label: 'Linkody export',
    source: alias('URL', 'Source URL', 'From'),
    target: alias('Link', 'Target URL', 'To'),
    anchor: alias('Anchor', 'Anchor text'),
    first_seen: alias('Date found', 'First seen'), last_seen: alias('Last seen'),
    nofollow: alias('Nofollow', 'Follow'),
  },
  google_search_console: {
    label: 'Google Search Console linking pages export',
    source: alias('Linking page', 'Linking Page', 'Source page'),
    target: alias('Target page', 'Target Page', 'Linked page'),
    last_seen: alias('Last crawled', 'Last crawled date'),
    // GSC's headline exports are COUNTS PER SITE, not placements. Importing one would mean
    // inventing a source page URL for every row, and an invented URL is a link we would then
    // check, fail to find, and report to the customer as lost.
    refuse: [
      { when: alias('Site', 'Incoming links'), because: 'this is the "Top linking sites" export: a count per site, not a list of pages. Open a site in Search Console and export its linking pages instead.' },
      { when: alias('Top linked pages', 'Incoming links'), because: 'this is the "Top linked pages" export: a count per page of yours, not a list of the pages that link to it.' },
    ],
  },
  bing_webmaster_tools: {
    label: 'Bing Webmaster Tools backlinks export',
    source: alias('Source URL', 'SourceUrl', 'Referring page', 'Referring page URL'),
    target: alias('Target URL', 'TargetUrl', 'Target page'),
    anchor: alias('Anchor text', 'AnchorText'),
  },
  csv: { label: 'generic CSV', source: [], target: [] },
});

export const SUPPLIER_NAMES = Object.freeze(Object.keys(SUPPLIERS));

const FIELDS = Object.freeze(['source', 'target', 'anchor', 'first_seen', 'last_seen', 'nofollow', 'dofollow', 'lost', 'link_type', 'supplier_row_id']);

/**
 * Resolves header names to fields for one supplier, plus any explicit overrides.
 *
 * Returns the mapping AND the columns it did not claim, because those are not noise: they are
 * the supplier's own metrics and they travel with every row.
 *
 * `targetProvided` covers the export whose whole file is about ONE target — a curated list, or
 * GSC's per-page view. T06 settled the semantics: a missing target column is a SCOPE problem,
 * not an assumption problem, and the operator naming the target on the command line is the
 * person deciding it. Nothing is assumed silently.
 */
export function resolveMapping(header, { supplier = 'csv', overrides = {}, targetProvided = false } = {}) {
  const spec = SUPPLIERS[supplier];
  if (!spec) return { error: `unknown supplier "${supplier}". Known: ${SUPPLIER_NAMES.join(', ')}` };
  const normalized = header.map(name => ({ name, key: normalizeHeader(name) }));
  const find = names => normalized.find(column => names.includes(column.key))?.name ?? null;

  for (const rule of spec.refuse ?? []) {
    if (rule.when.every(key => normalized.some(column => column.key === key))) return { error: rule.because };
  }
  const mapping = {};
  for (const field of FIELDS) {
    const override = overrides[field];
    if (override) {
      if (!header.includes(override)) return { error: `--map names a column "${override}" that is not in this file` };
      mapping[field] = override;
      continue;
    }
    const found = spec[field] ? find(spec[field]) : null;
    if (found) mapping[field] = found;
  }
  if (!mapping.source || (!mapping.target && !targetProvided)) {
    const missing = [!mapping.source && 'source', !mapping.target && !targetProvided && 'target'].filter(Boolean).join(' and ');
    return {
      error: `could not find the ${missing} column in this file.\n  columns present: ${header.join(' | ')}\n`
        + `  name them explicitly, for example: --map source=<column>,target=<column>`,
    };
  }
  const claimed = new Set(Object.values(mapping));
  return { mapping, unclaimed: header.filter(name => name && !claimed.has(name)) };
}

const TRUE = new Set(['1', 'true', 'yes', 'y', 'nofollow']);
const FALSE = new Set(['0', 'false', 'no', 'n', 'dofollow', '']);
/** A flag column, or `undefined` when the value says nothing we understand. */
export function readFlag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  return undefined;
}

const numeric = value => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text.replace(/,/gu, ''));
  return Number.isFinite(number) ? number : text.slice(0, 256);
};

/** One CSV record as an `ImportRow`, with every unclaimed column kept as a supplier metric. */
export function toImportRow(values, mapping, unclaimed) {
  const at = field => (mapping[field] ? String(values[mapping[field]] ?? '').trim() : '');
  const nofollow = mapping.nofollow ? readFlag(at('nofollow')) : undefined;
  const dofollow = mapping.dofollow ? readFlag(at('dofollow')) : undefined;
  const metrics = {};
  for (const name of unclaimed) {
    const value = numeric(values[name]);
    if (value !== null) metrics[name.slice(0, 64)] = value;
  }
  return {
    source_url: at('source'), target_url: at('target'),
    anchor: at('anchor') || null,
    first_seen: at('first_seen') || null,
    last_seen: at('last_seen') || null,
    // Only a flag we actually understood becomes an answer. A column we could not read leaves
    // the field absent rather than asserting "followed", which is the value a reader trusts.
    dofollow: dofollow !== undefined ? dofollow : (nofollow !== undefined ? !nofollow : undefined),
    rel: nofollow === true ? ['nofollow'] : undefined,
    is_lost: mapping.lost ? readFlag(at('lost')) : undefined,
    link_type: at('link_type') || null,
    supplier_row_id: at('supplier_row_id') || null,
    // 32 is the contract's ceiling; a wide export loses its widest columns rather than the row.
    supplier_metrics: Object.keys(metrics).length ? Object.fromEntries(Object.entries(metrics).slice(0, 32)) : null,
  };
}
