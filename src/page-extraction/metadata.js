import { parseDocument } from './html.js';

/** Pure metadata extraction; no requests, supplier calls or judgments. */
export function extractPageMetadata(html, { baseUrl } = {}) {
  if (typeof html !== 'string' || !html) return {
    title: null, h1s: [], meta_description: null, canonical: null,
    link_counts: null, asset_candidate_reasons: null,
  };
  // A private resolution base lets the parser count relative physical links.
  // It must never escape as a claimed publisher canonical URL.
  const resolutionBase = baseUrl ?? 'https://page-metadata.invalid/';
  const parsed = parseDocument(html, resolutionBase, { includeMetadata: true });
  if (parsed.incomplete) throw Object.assign(new Error('incomplete_document'), { reason: 'incomplete_document' });
  if (baseUrl === undefined && parsed.metadata.canonical?.startsWith('https://page-metadata.invalid/')) parsed.metadata.canonical = null;
  return parsed.metadata;
}
