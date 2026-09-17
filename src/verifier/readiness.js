import { parse, defaultTreeAdapter } from 'parse5';

const INERT = new Set(['script', 'style', 'template', 'noscript']);
const CHROME = new Set(['nav', 'header', 'footer', 'aside', 'head']);
const ROOT_IDS = new Set(['root', 'app', '__next', '__nuxt']);
const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const hidden = (node) => attr(node, 'hidden') !== undefined
  || (node.tagName === 'dialog' && attr(node, 'open') === undefined)
  || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, 'style') ?? '');

/** Static evidence only: this does not claim computed CSS visibility or browser readiness. */
export function assessReadiness({ html, parsed, targetUrl }) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  const bounded = () => ({ requiresRender: true, reason: 'readiness_limit_exceeded', possibleLoginWall: false });
  if (html.length > 2 * 1024 * 1024) return bounded();
  let elements = 0;
  const started = performance.now();
  let document;
  try {
    document = parse(html, { treeAdapter: {
      ...defaultTreeAdapter,
      createElement(...args) {
        if (++elements > 25_000 || args[2].length > 256 || performance.now() - started > 500) {
          throw new RangeError('readiness_limit_exceeded');
        }
        return defaultTreeAdapter.createElement(...args);
      },
    } });
  } catch (error) {
    if (error instanceof RangeError && error.message === 'readiness_limit_exceeded') return bounded();
    throw error;
  }
  let hasScript = false;
  let targetInScript = false;
  let hasVisiblePassword = false;
  let contentText = '';
  let articleText = '';
  let emptyAppRoot = false;
  let emptyProfileRoot = false;
  const roots = [];
  const stack = [{ node: document, chrome: false, form: false, article: false, root: null }];
  while (stack.length) {
    const state = stack.pop();
    const { node } = state;
    if (hidden(node)) continue;
    if (node.tagName === 'script') {
      hasScript = true;
      // Script data is a rendering hint, never a link occurrence. Keep this exact and narrow.
      if (targetUrl && node.childNodes?.some((child) => child.nodeName === '#text'
        && child.value.replace(/\\\//gu, '/').includes(targetUrl))) targetInScript = true;
    }
    if (INERT.has(node.tagName)) continue;
    const chrome = state.chrome || CHROME.has(node.tagName);
    const form = state.form || node.tagName === 'form';
    const article = state.article || node.tagName === 'article';
    let root = state.root;
    const id = (attr(node, 'id') ?? '').toLowerCase();
    if (ROOT_IDS.has(id) || ['profile', 'profile-root', 'profile-container'].includes(id)) {
      root = { app: ROOT_IDS.has(id), content: false, parent: root };
      roots.push(root);
    }
    if (node.tagName === 'input' && (attr(node, 'type') ?? '').toLowerCase() === 'password') hasVisiblePassword = true;
    if (!chrome && node.nodeName === '#text' && node.value.trim()) {
      for (let ancestor = root; ancestor && !ancestor.content; ancestor = ancestor.parent) ancestor.content = true;
      if (!form) {
        contentText += node.value.slice(0, 256 - contentText.length);
        if (article) articleText += node.value.slice(0, 256 - articleText.length);
      }
    }
    if (!chrome && ['img', 'video', 'audio', 'iframe', 'canvas', 'input', 'textarea'].includes(node.tagName)) {
      for (let ancestor = root; ancestor && !ancestor.content; ancestor = ancestor.parent) ancestor.content = true;
    }
    for (const child of node.childNodes ?? []) stack.push({ node: child, chrome, form, article, root });
  }
  for (const root of roots) {
    if (!root.content && root.app) emptyAppRoot = true;
    if (!root.content && !root.app) emptyProfileRoot = true;
  }
  const substantiveContent = contentText.replace(/\s+/gu, ' ').trim().length >= 80
    || articleText.replace(/\s+/gu, ' ').trim().length >= 40;
  const possibleLoginWall = hasVisiblePassword && !substantiveContent;
  let reason = null;
  if (hasScript && !substantiveContent) {
    if (emptyAppRoot) reason = 'empty_application_root';
    else if (emptyProfileRoot && targetInScript) reason = 'profile_target_in_script_only';
    else if (!(parsed?.links?.length) && !contentText.trim()) reason = 'empty_script_shell';
  }
  return { requiresRender: reason !== null, reason, possibleLoginWall,
    hasVisiblePassword, targetInScript, emptyAppRoot, emptyProfileRoot };
}
