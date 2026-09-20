// AgentLinkOps-owned browser provider configs: surfaces the vendored oneglanse
// layer never shipped, written against the same ProviderConfig shape so the
// engine treats them identically. Each config is probe-proven on the real
// surface through Camoufox + US residential (receipts: 2026-09-17/18).
//
// GROK (grok.com): Cloudflare passes from residential exits; anonymous use
// grants one full answer per fresh context, then a signup nudge — which the
// fresh-context-per-sample rule already assumes.
//
// COPILOT (copilot.microsoft.com): anonymous composer behind a sign-in modal
// whose Close control resisted automated dismissal; EXPERIMENTAL until the
// session-login command (T04) lands.
//
// BING (bing.com/search): the generative answer block renders WITH cited
// outbound links, anonymously, no challenge. Pure URL navigation — the prompt
// is the URL. The block is found by content signature, never position.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generic answer wait: poll the body until its text stabilizes (the vendored
// signature-based waiter needs provider constants these surfaces lack).
async function waitForStableBody(page, { stableMs = 2500, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableSince = null;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => (document.body.innerText || '').length).catch(() => 0);
    if (text === last && text > 300) {
      if (stableSince && Date.now() - stableSince >= stableMs) return true;
      if (!stableSince) stableSince = Date.now();
    } else {
      stableSince = null;
      last = text;
    }
    await sleep(800);
  }
  return false;
}

// One page-context collector for bing: find the generative block by signature
// (several sentences of prose plus >=2 distinct outbound citation hosts in one
// container) and return answer text and citation links together. An organic
// result for a different intent can never masquerade as an AI answer, and a
// missing block returns empty — which the engine reports as
// "no AI answer block rendered", an unknown, never a citation verdict.
const bingCollect = () => {
  const findAiBlock = () => {
    // Only result items that are NOT organic cards (b_algo is a plain organic
    // result; the generative block renders under other classes), never the
    // outer wrapper div whose text begins with page chrome.
    const candidates = document.querySelectorAll('#b_results > li:not(.b_algo)');
    for (const el of candidates) {
      const text = (el.innerText || '').trim();
      if (text.length < 300) continue;
      if (/^(skip to|about \d|accessibility)/i.test(text.slice(0, 24))) continue;
      const sentences = text.split(/[.!?]+\s/).filter((x) => x.trim().length > 30).length;
      if (sentences < 3) continue;
      const hosts = new Set();
      for (const a of el.querySelectorAll('a[href^="http"]')) {
        try {
          const u = new URL(a.href);
          if (/bing\.com|microsoft\.com/.test(u.hostname)) continue;
          hosts.add(u.hostname);
        } catch { /* skip malformed */ }
      }
      if (hosts.size >= 3) return el;
    }
    return null;
  };
  const block = findAiBlock();
  if (!block) return { answer: '', sources: [] };
  const seen = new Set();
  const sources = [];
  for (const a of block.querySelectorAll('a[href^="http"]')) {
    try {
      const u = new URL(a.href);
      if (/bing\.com|microsoft\.com/.test(u.hostname)) continue;
      const key = u.hostname + u.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ url: a.href, title: (a.textContent || '').trim().slice(0, 200) || null, domain: u.hostname });
    } catch { /* skip malformed */ }
  }
  return { answer: (block.innerText || '').trim(), sources };
};

// duck.ai in-page chat flow: the surface's own JS solves the VQD challenge,
// so the engine drives fetch() from inside a real duck.ai page — cookies,
// headers and challenge all native. Claude Haiku 4.5 serves anonymously.
const DUCK_MODEL = 'claude-haiku-4-5';

export async function duckChat(page, prompt) {
  const result = await page.evaluate(async ({ model, text }) => {
    const j = async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json().catch(() => ({})); };
    // Status first: same-origin response headers carry the VQD token.
    const statusRes = await fetch('https://duck.ai/duckchat/v1/status', { credentials: 'include' });
    const vqd = statusRes.headers.get('x-vqd-4') || statusRes.headers.get('x-vqd');
    if (!vqd) throw new Error('no vqd token in status response');
    const models = await j(await fetch('https://duck.ai/duckchat/v1/models', { credentials: 'include', headers: { 'x-vqd-4': vqd, 'x-vqd': vqd } }));
    const ids = (models.data ?? []).map((m) => m.id ?? m.model ?? String(m));
    if (!ids.some((id) => String(id).includes('claude'))) {
      throw new Error('no claude model in duck lineup: ' + ids.slice(0, 6).join(','));
    }
    const chatRes = await fetch('https://duck.ai/duckchat/v1/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-vqd-4': vqd, 'x-vqd': vqd },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: true }),
    });
    if (!chatRes.ok) throw new Error('chat HTTP ' + chatRes.status);
    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let message = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          message += obj.message ?? obj.content ?? '';
        } catch { /* partial json across chunks */ }
      }
    }
    return { message, models: ids };
  }, { model: DUCK_MODEL, text: prompt });
  return result;
}

export const OWN_PROVIDER_CONFIGS = {
  grok: {
    url: 'https://grok.com/',
    label: 'Grok',
    experimental: false,
    navigateToPrompt: null, // the engine's grok branch owns the flow
    waitForResponse: (page) => waitForStableBody(page),
    extractResponse: (page) => page.evaluate(() => (document.body.innerText || '').trim()),
    citationExtraction: 'unsupported',
    extractSources: async () => [], // retain unknown until a scoped citation extractor is proven
  },
  copilot: {
    url: 'https://copilot.microsoft.com/',
    label: 'Copilot',
    experimental: true,
    waitForResponse: (page) => waitForStableBody(page),
    extractResponse: (page) => page.evaluate(() => (document.body.innerText || '').trim()),
    citationExtraction: 'unsupported',
    extractSources: async () => [],
  },
  bing: {
    url: 'https://www.bing.com/',
    label: 'Bing AI answers',
    experimental: false,
    waitForResponse: async (page) => {
      await sleep(6000);
      await waitForStableBody(page, { stableMs: 1800, timeoutMs: 30000 });
    },
    extractResponse: async (page) => (await page.evaluate(bingCollect)).answer,
    extractSources: async (page) => (await page.evaluate(bingCollect)).sources,
  },
};
