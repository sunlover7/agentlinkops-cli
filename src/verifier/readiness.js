import { parse, defaultTreeAdapter } from 'parse5';

const INERT = new Set(['script', 'style', 'template', 'noscript']);
const CHROME = new Set(['nav', 'header', 'footer', 'aside', 'head']);
const ROOT_IDS = new Set(['root', 'app', '__next', '__nuxt']);
const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const hidden = (node) => attr(node, 'hidden') !== undefined
  || (node.tagName === 'dialog' && attr(node, 'open') === undefined)
  || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, 'style') ?? '');
const text = (value) => value.replace(/[\u2018\u2019]/gu, "'").replace(/\s+/gu, ' ').trim();
const unfinishedNotice = (value) => /^(?:still loading|we (?:had|are having) trouble loading(?: [^.!?]{1,80})?|(?:this|your) browser is (?:not|no longer) supported)(?:\.{1,3}|…|!)?$/iu.test(text(value));
const editorialArticle = (node) => node.tagName === 'article'
  && (!attr(node, 'itemtype') || /(?:^|\s)https?:\/\/schema\.org\/(?:[a-z]*Article|BlogPosting)(?:\s|$)/iu.test(attr(node, 'itemtype')));

/** A managed challenge needs actual challenge markup, not prose about bot checks. */
export function isAccessChallenge(parsed, { managedClientChallenge = false } = {}) {
  return /^(?:just a moment(?:\.\.\.)?|access denied|attention required!?\s*(?:\|\s*cloudflare)?|verify (?:you are|you're) human)$/iu.test(parsed?.title ?? '')
    || parsed?.hasChallengeScript === true
    || (/^client challenge$/iu.test(parsed?.title ?? '') && managedClientChallenge);
}

/** Internal analysis keeps challenge evidence outside the portable readiness DTO. */
export function analyzeReadiness({ html, parsed, targetUrl }) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  const bounded = () => ({ readiness: { requiresRender: true, reason: 'readiness_limit_exceeded', possibleLoginWall: false }, managedClientChallenge: false });
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
  let targetInHydrationData = false;
  let targetInVisibleText = false;
  let hasUnfinishedNotice = false;
  let hasManagedChallengeScript = false;
  let hasChallengeAlert = false;
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
    if (!INERT.has(node.tagName) && attr(node, 'id') === 'loading-error' && attr(node, 'role') === 'alert') hasChallengeAlert = true;
    const nodeHidden = state.hidden || hidden(node);
    if (node.tagName === 'script') {
      hasScript = true;
      const value = (node.childNodes ?? []).filter((child) => child.nodeName === '#text').map((child) => child.value).join('');
      const scriptContainsTarget = targetUrl && (value.replace(/\\\//gu, '/').includes(targetUrl)
        || value.includes(encodeURIComponent(targetUrl)));
      // Framework payloads may contain a missing link, but are never anchor evidence.
      if (scriptContainsTarget) {
        targetInScript = true;
        if (attr(node, 'type') === 'application/json' || attr(node, 'data-relay-completed-request') === 'true'
          || /\b(?:window|self)\.[\w$]*(?:hydration|state|data)[\w$]*\s*=/iu.test(value)
          || /\b__sveltekit[\w$]*\b/u.test(value)) targetInHydrationData = true;
      }
      if (/\/_fs-ch-[a-z0-9_-]+\/(?:errors|script)\.js(?:[?'"\s]|$)/iu.test(`${attr(node, 'src') ?? ''}\n${value}`)) hasManagedChallengeScript = true;
    }
    if (INERT.has(node.tagName)) continue;
    // Hidden containers suppress their visible content, but do not make an
    // executable script inert. Hydration chunks can live in such containers.
    if (nodeHidden) {
      for (const child of node.childNodes ?? []) stack.push({ ...state, node: child, hidden: true });
      continue;
    }
    const chrome = state.chrome || CHROME.has(node.tagName);
    const form = state.form || node.tagName === 'form';
    const article = state.article || editorialArticle(node);
    let root = state.root;
    const id = (attr(node, 'id') ?? '').toLowerCase();
    const appRoot = ROOT_IDS.has(id) || attr(node, 'data-reactcontainer') === 'true'
      || attr(node, 'data-reactroot') !== undefined || (node.tagName === 'body' && attr(node, 'data-sveltekit-preload-data') !== undefined);
    if (appRoot || ['profile', 'profile-root', 'profile-container'].includes(id)) {
      root = { app: appRoot, content: false, busy: attr(node, 'aria-busy') === 'true', unfinished: false, parent: root };
      roots.push(root);
    }
    if (node.tagName === 'input' && (attr(node, 'type') ?? '').toLowerCase() === 'password') hasVisiblePassword = true;
    if (!chrome && node.nodeName === '#text' && node.value.trim()) {
      for (let ancestor = root; ancestor && !ancestor.content; ancestor = ancestor.parent) ancestor.content = true;
      if (!form) {
        const unfinished = !article && unfinishedNotice(node.value);
        if (unfinished) {
          hasUnfinishedNotice = true;
          for (let ancestor = root; ancestor && !ancestor.unfinished; ancestor = ancestor.parent) ancestor.unfinished = true;
        }
        if (targetUrl && node.value.includes(targetUrl)) targetInVisibleText = true;
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
  const substantiveArticle = text(articleText).length >= 40;
  const possibleLoginWall = hasVisiblePassword && !substantiveContent;
  let reason = null;
  if (hasScript && !substantiveArticle && (roots.some((root) => root.app && (root.busy || root.unfinished))
    || (emptyAppRoot && hasUnfinishedNotice))) {
    reason = 'application_content_unfinished';
  } else if (hasScript && targetInHydrationData && roots.length && !substantiveArticle && !targetInVisibleText) {
    reason = 'application_target_in_hydration_only';
  } else if (hasScript && !substantiveContent) {
    if (emptyAppRoot) reason = 'empty_application_root';
    else if (emptyProfileRoot && targetInScript) reason = 'profile_target_in_script_only';
    else if (!(parsed?.links?.length) && !contentText.trim()) reason = 'empty_script_shell';
  }
  return { readiness: { requiresRender: reason !== null, reason, possibleLoginWall,
    hasVisiblePassword, targetInScript, emptyAppRoot, emptyProfileRoot },
    managedClientChallenge: hasManagedChallengeScript && hasChallengeAlert };
}

/** Static evidence only; preserves the existing portable readiness schema. */
export function assessReadiness(input) {
  return analyzeReadiness(input).readiness;
}
