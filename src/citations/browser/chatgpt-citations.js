import { PROVIDER_MODEL_RESPONSE_SELECTORS } from './shims/utils.js';

// This function is serialized into the browser. Keep all lookups within the
// latest visible, explicitly identified assistant response.
export function readChatgptCitationState(input) {
  const selectors = Array.isArray(input) ? input : input.selectors;
  const visible = element => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const latestResponse = () => {
    const elements = Array.from(document.querySelectorAll(selectors.join(', '))).filter(visible);
    return elements.filter(element => !elements.some(other => other !== element && other.contains(element))).at(-1);
  };
  const root = latestResponse();
  if (!root || root.getAttribute('aria-busy') === 'true' ||
    (root.getAttribute('data-message-id') || '').startsWith('request-placeholder') ||
    (root.innerText || '').trim().length <= 50) return { found: false, groups: 0, unresolved: true, sources: [] };
  if (input.prepareBinding) {
    const text = root.innerText;
    return {isCurrent:() => latestResponse() === root && visible(root) && root.innerText === text &&
      root.getAttribute('aria-busy') !== 'true' && !(root.getAttribute('data-message-id') || '').startsWith('request-placeholder')};
  }
  const groups = Array.from(root.querySelectorAll('[role="group"][aria-label="Sources"]'));
  const concealed = element => {
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return true;
      if (node === root) break;
    }
    return !visible(element);
  };
  const sources = [];
  let unresolved = false;
  const anonymous = root.matches(selectors.at(-1));
  let panelEligible = anonymous && groups.length > 0 && groups.length <= 50;
  const publisherLabels = [];
  if (anonymous) {
    // A new anonymous layout with unrecognized citation controls is not proof
    // of absence. Never use unrelated page-wide links to fill this gap.
    const actions = root.querySelector('[role="group"][aria-label="Response actions"]');
    const unsupported = Array.from(root.querySelectorAll('a[href], button, [role="button"], cite, sup, [data-citation], [data-citation-id]'));
    if (unsupported.some(element => !actions?.contains(element) && !groups.some(group => group.contains(element)))) {
      unresolved = true; panelEligible = false;
    }
  }
  for (const group of groups) {
    if (concealed(group)) { unresolved = true; panelEligible = false; continue; }
    if (anonymous) {
      const buttons = Array.from(group.querySelectorAll('button'));
      if (!buttons.length || buttons.length > 50 || group.querySelector('a[href], [role="button"]:not(button)')) panelEligible = false;
      for (const button of buttons) {
        const label = (button.getAttribute('aria-label') || '').trim();
        if (!label || label.length > 200 || concealed(button)) panelEligible = false;
        else publisherLabels.push(label);
      }
    }
    let resolved = 0;
    for (const anchor of group.querySelectorAll('a[href]')) {
      if (concealed(anchor)) { unresolved = true; continue; }
      try {
        const url = new URL(anchor.href);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error();
        sources.push({ url: url.href, title: (anchor.textContent || '').trim() });
        resolved++;
      } catch { unresolved = true; }
    }
    // Observed anonymous pills are buttons without URLs. Their labels are
    // not URL evidence; a partial anchor list cannot resolve those controls.
    if (!resolved || group.querySelector('button, [role="button"]')) unresolved = true;
  }
  const labels = [...new Set(publisherLabels)];
  panelEligible = panelEligible && labels.length > 0 && labels.length <= 50;
  const state = { found: true, anonymous, groups: groups.length, unresolved, sources, panelEligible };
  if (!input.prepare) return state;
  if (!panelEligible || !unresolved) return {state};
  // Keep the exact assistant and control references in-page. No DOM identities,
  // tokens or control IDs are persisted in observations.
  const footer = root.querySelector(':scope > [role="group"][aria-label="Response actions"]');
  const buttons = Array.from(footer?.querySelectorAll('button') || []).filter(button =>
    !concealed(button) && !button.disabled && Array.from(button.children).some(child =>
      !concealed(child) && child.children.length === 0 && (child.textContent || '').trim() === 'Sources'));
  if (buttons.length !== 1) return {state};
  const button = buttons[0], controlledId = button.getAttribute('aria-controls');
  if (!controlledId || controlledId.length > 256) return {state};
  const before = document.getElementById(controlledId);
  // Only the observed absent/empty target is supported. A populated old panel
  // must not be mistaken for freshly resolved citations from this answer.
  if (before && (visible(before) || (before.textContent || '').trim() || before.querySelector('a'))) return {state};
  const responseText = root.innerText;
  const unavailable = () => ({status:'unavailable'});
  const inspect = () => {
    if (latestResponse() !== root || !root.isConnected || !root.matches(selectors.at(-1)) || concealed(root) ||
      root.innerText !== responseText || root.getAttribute('aria-busy') === 'true' ||
      (root.getAttribute('data-message-id') || '').startsWith('request-placeholder') ||
      !button.isConnected || !footer.contains(button) || !root.contains(footer) || button.getAttribute('aria-controls') !== controlledId) return unavailable();
    const currentState = readChatgptCitationState(selectors);
    if (!currentState.panelEligible || currentState.groups !== state.groups) return unavailable();
    const currentLabels = [...new Set(Array.from(root.querySelectorAll('[role="group"][aria-label="Sources"] button')).map(node => (node.getAttribute('aria-label') || '').trim()))];
    if (currentLabels.length !== labels.length || currentLabels.some(label => !labels.includes(label))) return unavailable();
    const target = document.getElementById(controlledId);
    if (!target || !visible(target)) return {status:'pending'};
    if (target === root || target.contains(root) || ['BODY','MAIN','HTML','NAV'].includes(target.tagName)) return unavailable();
    const articles = (target.matches('article') ? [target] : Array.from(target.querySelectorAll('article'))).filter(visible);
    if (articles.length !== 1) return unavailable();
    const article = articles[0];
    if (concealed(article) || article.querySelector('form,input,textarea,select,[contenteditable="true"],button,[role="button"],[data-message-author-role="user"],[data-turn="user"],[aria-busy="true"],[role="progressbar"]')) return unavailable();
    const headings = article.querySelectorAll('h1,h2,h3,[role="heading"]');
    const header = article.querySelector(':scope > header > h2');
    if (headings.length !== 1 || headings[0] !== header || concealed(header) || (header.textContent || '').trim() !== 'Sources') return unavailable();
    const lists = article.querySelectorAll('ol');
    if (lists.length !== 1 || article.querySelector('ul')) return unavailable();
    const list = lists[0], cards = Array.from(list.children);
    if (concealed(list) || !cards.length || cards.length > 50 || list.querySelectorAll('li').length !== cards.length || article.querySelectorAll('a').length !== cards.length) return unavailable();
    const foundLabels = new Set(), results = [];
    for (const card of cards) {
      if (card.tagName !== 'LI' || concealed(card) || card.children.length !== 1 || card.firstElementChild.tagName !== 'A') return unavailable();
      const anchor = card.firstElementChild, titles = anchor.querySelectorAll('strong');
      if (concealed(anchor) || titles.length !== 1 || concealed(titles[0])) return unavailable();
      const title = (titles[0].textContent || '').trim();
      if (!title || title.length > 1000) return unavailable();
      let url;
      try {
        const raw = anchor.getAttribute('href');
        if (!raw || raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) return unavailable();
        url = new URL(raw);
        if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return unavailable();
      } catch { return unavailable(); }
      // Exact visible publisher labels, not guessed domains or URL derivation.
      const matched = [...new Set(Array.from(anchor.querySelectorAll('span')).filter(node =>
        node.children.length === 0 && !concealed(node)).map(node => (node.textContent || '').trim()).filter(label => labels.includes(label)))];
      if (matched.length !== 1) return unavailable();
      foundLabels.add(matched[0]);
      results.push({url:url.href,title});
    }
    if (foundLabels.size !== labels.length) return unavailable();
    return {status:'resolved',sources:results};
  };
  return {state,button,inspect};
}

const unavailable = () => Object.assign(new Error('ChatGPT citation controls could not be resolved.'), {code:'CITATION_EXTRACTION_UNAVAILABLE'});
const responseBindings = new WeakMap();
const bindingCurrent = binding => binding.evaluate(value => typeof value.isCurrent === 'function' && value.isCurrent());
export async function releaseChatgptResponseBinding(page) {
  const binding = responseBindings.get(page);
  responseBindings.delete(page);
  await binding?.dispose().catch(() => {});
}
export async function extractBoundChatgptResponse(page, legacyExtract) {
  const previous = responseBindings.get(page);
  responseBindings.delete(page);
  if (previous) await previous.dispose().catch(() => {});
  let binding;
  try {
    binding = await page.evaluateHandle(readChatgptCitationState, {selectors:PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt,prepareBinding:true});
    if (!await bindingCurrent(binding)) throw unavailable();
    const answer = await legacyExtract(page);
    if (!await bindingCurrent(binding)) throw unavailable();
    responseBindings.set(page,binding);
    return answer;
  } catch {
    await binding?.dispose().catch(() => {});
    throw unavailable();
  }
}
async function extractControlledPanel(page, binding) {
  let handle, buttonHandle;
  try {
    handle = await page.evaluateHandle(readChatgptCitationState, {selectors:PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt,prepare:true});
    buttonHandle = await handle.getProperty('button');
    const button = buttonHandle.asElement();
    if (!button) throw unavailable();
    await button.click({timeout:3000});
    // Bounded DOM render polling only; never another click/provider invocation.
    let previous = null, stable = 0;
    for (let attempt=0; attempt<12; attempt++) {
      const result = await handle.evaluate((state,guard) => guard && !guard.isCurrent() ? {status:'unavailable'} : state.inspect(),binding || null);
      if (result.status === 'resolved') {
        const signature = JSON.stringify(result.sources);
        stable = signature === previous ? stable + 1 : 1;
        previous = signature;
        // Publisher coverage alone is insufficient while more same-publisher
        // cards may still be rendering. Require three identical valid reads.
        if (stable >= 3) return [...new Map(result.sources.map(source => [source.url,source])).values()];
      } else if (result.status === 'pending') { previous = null; stable = 0; }
      else throw unavailable();
      await page.waitForTimeout(250);
    }
    throw unavailable();
  } catch { throw unavailable(); }
  finally { await Promise.allSettled([buttonHandle?.dispose(),handle?.dispose()]); }
}

export async function extractChatgptSources(page, legacyExtract) {
  const binding = responseBindings.get(page);
  try {
    if (binding && !await bindingCurrent(binding)) throw unavailable();
    const state = await page.evaluate(readChatgptCitationState, PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt);
    let sources;
    if (!state.found || state.unresolved) {
      if (!state.found || !state.panelEligible) throw unavailable();
      sources = await extractControlledPanel(page,binding);
    } else if (state.anonymous || state.groups) sources = [...new Map(state.sources.map(source => [source.url, source])).values()];
    else sources = await legacyExtract(page);
    if (binding && !await bindingCurrent(binding)) throw unavailable();
    return sources;
  } finally {
    responseBindings.delete(page);
    await binding?.dispose().catch(() => {});
  }
}
