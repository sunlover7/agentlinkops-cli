import { parseDocument, pageDirectives } from './html.js';
import { validateCaptureReceipt, PageAcquisitionError } from '../page-acquisition/contracts.js';

export { parseDocument, parseLinks, pageText, pageDirectives } from './html.js';
export { extractPageMetadata } from './metadata.js';
export const STATIC_TEXT_LIMIT = 512 * 1024;

/**
 * Extract from an already acquired document. A receipt is checked when supplied;
 * legacy HTML remains caller-supplied evidence, without invented fetch provenance.
 * Static text is not a claim about CSS visibility, iframes or shadow DOM.
 */
export function extractPage(html, { baseUrl, receipt = null, textLimit = STATIC_TEXT_LIMIT, xRobotsTag = null } = {}) {
  const capture = receipt === null ? null : validateCaptureReceipt(receipt, { finalUrl: baseUrl });
  if (capture && (!['raw_html', 'rendered_dom'].includes(capture.representation) || capture.httpStatus < 200 || capture.httpStatus >= 300)) throw new PageAcquisitionError('capture_invalid');
  const parsed = parseDocument(html, baseUrl, { includeMetadata: true, textLimit });
  return {
    ...parsed,
    directives: pageDirectives(parsed.meta, xRobotsTag),
    coverage: {
      documentComplete: !parsed.incomplete,
      textComplete: !parsed.staticText.truncated,
      bodyComplete: capture?.body.complete ?? null,
      transportQualified: capture?.transport.qualified ?? false,
      mainDocument: true, iframes: false, shadowRoots: false,
    },
    provenance: capture ? { kind: 'capture_receipt', receipt: capture }
      : { kind: 'caller_supplied_html', acquiredAt: null, httpStatus: null },
  };
}
