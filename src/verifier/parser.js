import { parse, defaultTreeAdapter } from 'parse5';

const INERT = new Set(['script', 'style', 'template', 'noscript']);
const BLOCKS = new Set(['p', 'li', 'article', 'section', 'div', 'td', 'dd', 'dt', 'blockquote']);
// Where a browser puts a visual break. Used to decide whether two runs of text are separate words.
// Everything NOT in here is treated as phrasing content — `span`, `b`, `a`, `em` — because a
// browser renders `<span>Read</span><span>more</span>` as one word and so must we.
const TEXT_BLOCKS = new Set([...BLOCKS, 'body', 'main', 'header', 'footer', 'nav', 'aside',
  'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'table', 'tr',
  'th', 'thead', 'tbody', 'tfoot', 'caption', 'pre', 'form', 'fieldset', 'details', 'summary',
  'address', 'hr', 'option', 'legend']);
const EOF_ERRORS = new Set([
  'eof-before-tag-name', 'eof-in-tag', 'eof-in-comment', 'eof-in-doctype',
  'eof-in-element-that-can-contain-only-text', 'eof-in-script-html-comment-like-text',
]);
const attr = (node, name) => node.attrs?.find((value) => value.name === name)?.value;
const normalize = (text) => text.replace(/\s+/gu, ' ').trim();

function* walk(root, includeInert = false) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeName === '#comment' || (!includeInert && INERT.has(node.tagName))) continue;
    yield node;
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** The nearest ancestor a browser would break a line at, stopping at the subtree we were given. */
function blockAncestor(node, root) {
  let cursor = node.parentNode;
  while (cursor && cursor !== root) {
    if (cursor.tagName && TEXT_BLOCKS.has(cursor.tagName)) return cursor;
    cursor = cursor.parentNode;
  }
  return root;
}

/**
 * Text as a reader sees it, with a word boundary exactly where a browser draws one.
 *
 * **Two runs of text are separate words when they sit in different BLOCKS, not merely in different
 * elements.** Without any separator, `<p>See settledestate.com</p><a>Guide</a>` read as
 * `settledestate.comGuide`, which put a joined string into every occurrence context a customer
 * sees. With a separator at every element boundary, `<a><span>Read</span><span>more</span></a>`
 * read as `Read more` — and a browser renders that as one word, so anchor text and therefore the
 * link signature would have disagreed with the page and emitted spurious change events.
 *
 * `normalize` collapses the runs this adds, so over-separating within a block is free and
 * under-separating across one is not.
 */
function textContent(node, limit = 2048) {
  let text = '';
  let lastBlock = null;
  const emit = (value, item) => {
    const block = blockAncestor(item, node);
    if (lastBlock !== null && block !== lastBlock) text += ' ';
    text += value;
    lastBlock = block;
  };
  for (const item of walk(node)) {
    // A line break is a word boundary wherever it appears, block or not.
    if (item.tagName === 'br') { text += ' '; lastBlock = null; }
    if (item.nodeName === '#text') emit(item.value, item);
    if (item.tagName === 'img') { const alt = attr(item, 'alt'); if (alt) emit(alt, item); }
    if (text.length > limit * 2) break;
  }
  return normalize(text).slice(0, limit);
}

function contextFor(node) {
  let context = node.parentNode ?? node;
  for (let depth = 0; context.parentNode && depth < 4; depth++) {
    if (BLOCKS.has(context.tagName) || context.tagName === 'body') break;
    context = context.parentNode;
  }
  return textContent(context, 640);
}

export function parseDocument(html, pageUrl) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  const errors = [];
  let elements = 0;
  let anchorElements = 0;
  const parserStart = performance.now();
  const treeAdapter = {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      // Bound parser expansion and evidence output independently of body bytes.
      if (++elements > 25_000 || attrs.length > 256 || performance.now() - parserStart > 500) {
        const error = new Error('document_too_complex');
        error.reason = 'document_too_complex';
        throw error;
      }
      if ((tagName === 'a' || tagName === 'area') && ++anchorElements > 1000) {
        const error = new Error('too_many_link_occurrences');
        error.reason = 'too_many_link_occurrences';
        throw error;
      }
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
  };
  const document = parse(html, {
    treeAdapter,
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
    onParseError: ({ code }) => { if (EOF_ERRORS.has(code) && errors.length < 8) errors.push(code); },
  });
  let baseUrl = pageUrl;
  let baseFound = false;
  let canonical = null;
  const links = [];
  const meta = [];
  let title = '';
  let hasScript = false;
  let hasPasswordInput = false;
  let hasChallengeScript = false;
  let visibleText = '';
  const nodes = [...walk(document)];
  for (const node of walk(document, true)) {
    if (node.tagName === 'script') {
      hasScript = true;
      if ((attr(node, 'src') ?? '').includes('/cdn-cgi/challenge-platform/')) hasChallengeScript = true;
    }
  }
  for (const node of nodes) {
    if (node.tagName === 'body') visibleText = textContent(node, 160);
    if (node.tagName === 'input' && (attr(node, 'type') ?? '').toLowerCase() === 'password') hasPasswordInput = true;
    if (node.tagName === 'base' && !baseFound && attr(node, 'href') !== undefined) {
      // Browsers use only the first base element with an href, even if invalid.
      baseFound = true;
      if (attr(node, 'href').length > 8192) {
        const error = new Error('base_url_too_long');
        error.reason = 'base_url_too_long';
        throw error;
      }
      try {
        const base = new URL(attr(node, 'href'), pageUrl);
        if (['http:', 'https:'].includes(base.protocol)) baseUrl = base.href;
      } catch { /* Browser-compatible fallback to the document URL. */ }
    }
    if (node.tagName === 'meta') {
      const name = (attr(node, 'name') ?? '').toLowerCase();
      if ((['robots', 'googlebot', 'bingbot', 'linktrailbot'].includes(name)
        || (attr(node, 'http-equiv') ?? '').toLowerCase() === 'refresh')
        && (attr(node, 'content') ?? '').length > 2048) {
        const error = new Error('page_directive_too_long');
        error.reason = 'page_directive_too_long';
        throw error;
      }
      if (['robots', 'googlebot', 'bingbot', 'linktrailbot'].includes(name)) {
        meta.push({ name, content: (attr(node, 'content') ?? '').slice(0, 2048) });
      }
      if ((attr(node, 'http-equiv') ?? '').toLowerCase() === 'refresh') {
        meta.push({ name: 'refresh', content: (attr(node, 'content') ?? '').slice(0, 2048) });
      }
      if (meta.length > 16) {
        const error = new Error('too_many_page_directives');
        error.reason = 'too_many_page_directives';
        throw error;
      }
    }
    if (node.tagName === 'title' && !title) title = textContent(node, 256);
    // Browsers honour the first canonical link element only.
    if (node.tagName === 'link' && canonical === null
      && (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/u).includes('canonical')) {
      const href = attr(node, 'href') ?? '';
      if (href && href.length <= 8192) {
        try {
          const resolved = new URL(href, baseUrl);
          if (['http:', 'https:'].includes(resolved.protocol)) canonical = resolved.href;
        } catch { /* An unparseable canonical is no canonical, exactly as a browser treats it. */ }
      }
    }
  }
  for (const node of nodes) {
    if (!['a', 'area'].includes(node.tagName)) continue;
    const href = attr(node, 'href');
    if (href === undefined) continue;
    if (href.length > 8192) {
      const error = new Error('link_url_too_long');
      error.reason = 'link_url_too_long';
      throw error;
    }
    let target;
    try { target = new URL(href, baseUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) continue;
    const location = node.sourceCodeLocation;
    links.push({
      href,
      targetUrl: target.href,
      anchor: node.tagName === 'area' ? normalize(attr(node, 'alt') ?? '') : textContent(node, 1024),
      rel: [...new Set((attr(node, 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean))],
      context: contextFor(node),
      locator: location ? { line: location.startLine, column: location.startCol, offset: location.startOffset } : null,
      visibility: 'not_rendered',
    });
  }
  return { links, meta, title, baseUrl, canonical, hasScript, hasPasswordInput, hasChallengeScript, visibleText, incomplete: errors.length > 0, parseErrors: errors };
}

/**
 * The page's text as a READER sees it, reusing the same walk the parser already uses.
 *
 * `walk` already skips `script`, `style`, `template`, `noscript` and comments, which is the
 * property that matters: a brand name inside a JSON payload or an analytics config is not a
 * mention anyone read. `parseDocument` caps its own copy at 160 characters because it only needs
 * to know whether a page is an empty shell; a mention scan needs the whole document, so it asks
 * for it explicitly rather than raising a cap every check would pay for.
 *
 * Takes no base URL, deliberately: text is not resolved against anything, and a parameter that
 * looks like it matters and does not is how a caller comes to believe the output is absolute.
 */
export function pageText(html, limit = 512 * 1024) {
  const document = parse(String(html), { sourceCodeLocationInfo: false, treeAdapter: defaultTreeAdapter });
  for (const node of walk(document)) {
    if (node.tagName === 'body') return textContent(node, limit);
  }
  return textContent(document, limit);
}

/** All HTTP(S) anchor/area occurrences in static HTML; never claims rendered visibility. */
export function parseLinks(html, baseUrl) {
  return parseDocument(html, new URL(baseUrl).href).links;
}

export function pageDirectives(meta, header) {
  const xRobotsTag = header ? [header] : [];
  // Preserve targeted header directives without incorrectly applying them to all bots.
  const genericHeader = header && !/(?:^|,)\s*[\w-]+\s*:/u.test(header) ? header : '';
  const generic = [genericHeader, ...meta.filter((item) => item.name === 'robots').map((item) => item.content)]
    .join(',').toLowerCase().split(/[\s,]+/u);
  return {
    meta,
    xRobotsTag,
    noindex: generic.includes('noindex') || generic.includes('none'),
    nofollow: generic.includes('nofollow') || generic.includes('none'),
    indexingStatus: 'not_checked',
  };
}
