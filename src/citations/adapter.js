// Engine adapters: one run of one prompt against one engine identity.
//
// An adapter returns answer text, a normalized provider citation list, any search
// fan-out the API exposes, token usage, and a cost estimate for the budget cap. It
// never interprets the answer (matching does that) and never decides outcomes. The
// Perplexity field map follows LiteLLM's normalization (MIT; used as a spec, not
// vendored): citations live on the response object as URLs, sometimes objects.
import { ENGINE_RATE_CARD, CITATION_LIMITS } from './contract.js';

export class EngineError extends Error {
  constructor(message, { retriable = false, cause } = {}) {
    super(message);
    this.name = 'EngineError';
    this.retriable = retriable;
    if (cause) this.cause = cause;
  }
}

// Deterministic per (seed, prompt, runIndex): tests and dry-runs must cost $0 AND
// reproduce exactly, or the statistics tests would be testing the RNG, not the tool.
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/**
 * The mock engine. Fixtures map prompt text to candidate citations with inclusion
 * weights, so a panel can simulate any citation behavior — including a collapse
 * between epochs — without a network call or a cent.
 */
export function createMockEngine({ seed = 'mock', fixtures = {}, costEstimateUsd = 0.002 } = {}) {
  return {
    identity: { engine: 'mock', provider: 'builtin', model: 'mock-1' },
    // The nominal per-run estimate the budget cap is enforced against, checked
    // BEFORE a call so the cap can be approached but never exceeded.
    estimateCostUsd: () => costEstimateUsd,
    async run({ prompt, runIndex = 0 }) {
      const fixture = fixtures[prompt] ?? {};
      const rng = mulberry32(hashString(`${seed}|${prompt}|${runIndex}`));
      const candidates = fixture.citations ?? [];
      const citations = candidates
        .filter((c) => typeof c.weight !== 'number' || rng() < c.weight)
        .map((c) => ({ url: c.url, title: c.title }));
      let answer = fixture.answerText ?? `Mock answer for: ${prompt}`;
      for (const c of citations) answer += `\nSource: ${c.url}`;
      if (fixture.mentionText) answer += `\n${fixture.mentionText}`;
      return {
        engine: 'mock', provider: 'builtin', model: 'mock-1', providerModelVersion: 'mock-1.0',
        answer, citations, fanOut: fixture.fanOut ?? [],
        usage: { input_tokens: 40, output_tokens: 400 },
        // The run reports its actual estimate; the engine-level value is the nominal
        // one the budget pre-check uses, so both must come from the same dial.
        costEstimateUsd: fixture.costEstimateUsd ?? costEstimateUsd,
      };
    },
  };
}

function estimatePerplexityCost(usage) {
  const rates = ENGINE_RATE_CARD.perplexity;
  const input = ((usage.input_tokens ?? 0) / 1e6) * rates.inputPerMTokens;
  const output = ((usage.output_tokens ?? 0) / 1e6) * rates.outputPerMTokens;
  return Number((input + output + rates.perRequest).toFixed(6));
}

/**
 * The Perplexity adapter. First live engine because Sonar's citations are native and
 * its base tier is the cheapest per-answer surface (~$0.005-0.01). The key is read
 * by the caller (env or fleet) and never stored or printed here.
 */
export function createPerplexityEngine({
  apiKey, model = 'sonar', baseUrl = 'https://api.perplexity.ai', fetchImpl,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new EngineError('a Perplexity API key is required');
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== 'function') throw new EngineError('no fetch implementation available');
  return {
    identity: { engine: 'perplexity', provider: 'api', model },
    // Nominal per-run estimate for the pre-call cap check (search fee plus a
    // conservative token assumption); the post-run estimate uses actual usage.
    estimateCostUsd: () => Number((ENGINE_RATE_CARD.perplexity.perRequest
      + (800 / 1e6) * ENGINE_RATE_CARD.perplexity.inputPerMTokens
      + (600 / 1e6) * ENGINE_RATE_CARD.perplexity.outputPerMTokens).toFixed(6)),
    async run({ prompt }) {
      let response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(CITATION_LIMITS.timeoutMs),
        });
      } catch (cause) {
        throw new EngineError(`perplexity request failed: ${cause.message}`, { retriable: true, cause });
      }
      if (!response.ok) {
        const retriable = response.status === 429 || response.status >= 500;
        throw new EngineError(`perplexity responded ${response.status}`, { retriable });
      }
      let body;
      try { body = await response.json(); }
      catch (cause) { throw new EngineError('perplexity response was not JSON', { cause }); }
      const message = body?.choices?.[0]?.message;
      const answer = typeof message?.content === 'string' ? message.content : '';
      if (answer.length === 0) throw new EngineError('perplexity returned an empty answer');
      if (answer.length > CITATION_LIMITS.answerBytes) {
        throw new EngineError('perplexity answer exceeded the size limit');
      }
      // LiteLLM's map: citations are URL strings, or objects carrying a url/link.
      const citations = (body?.citations ?? message?.citations ?? [])
        .map((c) => (typeof c === 'string' ? { url: c } : { url: c?.url ?? c?.link, title: c?.title }))
        .filter((c) => typeof c.url === 'string' && c.url.length > 0);
      const usage = {
        input_tokens: body?.usage?.prompt_tokens ?? 0,
        output_tokens: body?.usage?.completion_tokens ?? 0,
      };
      return {
        engine: 'perplexity', provider: 'api', model,
        providerModelVersion: body?.model ?? model,
        answer, citations, fanOut: [],
        usage,
        costEstimateUsd: estimatePerplexityCost(usage),
      };
    },
  };
}

export function createEngine(spec, options = {}) {
  if (spec.engine === 'mock') return createMockEngine(options.mock ?? {});
  if (spec.engine === 'perplexity') return createPerplexityEngine({ model: spec.model ?? 'sonar', ...(options.perplexity ?? {}) });
  throw new EngineError(`unknown engine: ${spec.engine}`);
}

// duck.ai anonymous engine: DuckDuckGo's AI chat serves Claude Haiku 4.5
// without an account. The VQD handshake follows Duck2api (MIT): the status
// call returns a token; when it returns a JS hash challenge instead, the
// documented fallback payload is accepted. Pure HTTP through the proxy —
// cheaper than a browser, and the surface has no bot wall at personal cadence.
const DUCK_BASE = 'https://duck.ai';
const DUCK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const DUCK_ORIGIN = 'https://duck.ai';
const DUCK_STACK = 'Error\n    at l (https://duck.ai/dist/duckai-dist/entry.duckai.c0a8c794abcbc8ee2d3c.js:2:1446307)\n    at async https://duck.ai/dist/duckai-dist/entry.duckai.c0a8c794abcbc8ee2d3c.js:2:1294181';

async function duckDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  const { ProxyAgent } = await import('undici');
  return new ProxyAgent(proxyUrl);
}

export function createDuckAiEngine({ model = 'claude-haiku-4-5', proxyUrl } = {}) {
  let dispatcher = null;
  const getDispatcher = async () => dispatcher ?? (dispatcher = await duckDispatcher(proxyUrl));

  const duckFetch = async (path, init = {}) => {
    const d = await getDispatcher();
    return fetch(`${DUCK_BASE}${path}`, {
      ...init,
      headers: { 'user-agent': DUCK_UA, origin: DUCK_ORIGIN, referer: `${DUCK_BASE}/`, ...init.headers },
      ...(d ? { dispatcher: d } : {}),
    });
  };

  const vqdFallback = (challengeB64) => {
    const decoded = Buffer.from(challengeB64, 'base64').toString('utf8');
    const payload = `${decoded}::no-exec::${DUCK_STACK}::${DUCK_ORIGIN}`;
    return Buffer.from(payload).toString('base64');
  };

  return {
    identity: { engine: 'duckai', provider: 'anon-api', model },
    estimateCostUsd: () => 0.0002,
    async run({ prompt }) {
      const status = await duckFetch('/duckchat/v1/status', { headers: { accept: '*/*' } });
      if (!status.ok) throw new EngineError(`duckai status HTTP ${status.status}`, { retriable: true });
      let vqd = status.headers.get('x-vqd-4') ?? status.headers.get('x-vqd');
      const hashChallenge = status.headers.get('x-vqd-hash-1');
      const headers = { accept: 'text/event-stream', 'content-type': 'application/json' };
      if (!vqd && hashChallenge) {
        vqd = vqdFallback(hashChallenge);
        headers['x-vqd-hash-1'] = vqd;
      }
      if (!vqd) throw new EngineError('duckai: no vqd token or challenge in status response', { retriable: true });
      headers['x-vqd-4'] = vqd;
      if (vqd !== headers['x-vqd-hash-1']) headers['x-vqd'] = vqd;

      const chat = await duckFetch('/duckchat/v1/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
      });
      if (!chat.ok) throw new EngineError(`duckai chat HTTP ${chat.status}`, { retriable: true });
      const body = await chat.text();
      let message = '';
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:') || t.includes('[DONE]')) continue;
        try { message += (JSON.parse(t.slice(5).trim()).message ?? ''); } catch { /* chunk */ }
      }
      if (message.trim().length < 20) throw new EngineError('duckai: empty chat message', { retriable: true });
      return {
        engine: 'duckai', provider: 'anon-api', model,
        providerModelVersion: `duck:${model}`,
        answer: message, citations: [], fanOut: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        costEstimateUsd: 0.0002,
      };
    },
  };
}

// OpenAI-compatible engine: any endpoint speaking /v1/chat/completions —
// including self-hosted Duck2api on the VPS, which serves the whole Claude
// family (haiku/sonnet/opus) plus GPT-5.6 anonymously through duck.ai.
// The engine identity names the model explicitly; never averaged with others.
export function createOpenAiCompatibleEngine({ baseUrl, model, apiKey, fetchImpl, costEstimateUsd = 0.0002, providerLabel = 'openai-compatible' } = {}) {
  if (!baseUrl || !model) throw new EngineError('openai-compatible engine needs baseUrl and model');
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return {
    identity: { engine: model.split(':')[0] ?? model, provider: providerLabel, model },
    estimateCostUsd: () => costEstimateUsd,
    async run({ prompt }) {
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(CITATION_LIMITS.timeoutMs * 2),
      }).catch((cause) => { throw new EngineError(`openai-compatible request failed: ${cause.message}`, { retriable: true, cause }); });
      if (!response.ok) throw new EngineError(`openai-compatible responded ${response.status}`, { retriable: response.status >= 500 || [429, 418, 408, 425].includes(response.status) });
      const body = await response.json().catch(() => { throw new EngineError('openai-compatible response was not JSON'); });
      const answer = body?.choices?.[0]?.message?.content ?? '';
      if (answer.trim().length < 20) throw new EngineError('openai-compatible returned an empty answer', { retriable: true });
      return {
        engine: model.split(':')[0] ?? model, provider: providerLabel, model,
        providerModelVersion: `${providerLabel}:${model}`,
        answer, citations: [], fanOut: [],
        usage: { input_tokens: body?.usage?.prompt_tokens ?? 0, output_tokens: body?.usage?.completion_tokens ?? 0 },
        costEstimateUsd,
      };
    },
  };
}

// Google AI Overview engine via DataForSEO SERP API (fixture-first, DP-0044).
// AIO is a SERP feature, not a chat: the engine sends a search query and reads
// the ai_overview block from the returned items. Cited sources are domains the
// overview linked to — the citation equivalent of a chat engine's source list.
// The fixture below proves the parser against the documented response shape;
// the live adapter activates with credentials in fleet, never before.
export function createGoogleAioEngine({ fetchImpl, credentials, costEstimateUsd = 0.0012, locationCode = 2840, country, languageCode = 'en', device = 'desktop', timeoutMs = CITATION_LIMITS.timeoutMs, maxResponseBytes = CITATION_LIMITS.answerBytes } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const error = (code, message, details = {}) => Object.assign(new EngineError(message), { code, ...details });
  if (country !== undefined) {
    const countryLocations = { US: 2840, GB: 2826 };
    if (!Object.hasOwn(countryLocations, country)) throw error('AIO_CONFIGURATION', 'google-aio country must be US or GB in this version');
    locationCode = countryLocations[country];
  }
  if (![credentials?.login, credentials?.password].every(value => typeof value === 'string' && value.trim().length))
    throw error('AIO_CONFIGURATION', 'google-aio requires DataForSEO credentials; select the mock engine for offline runs');
  if (!Number.isFinite(costEstimateUsd) || costEstimateUsd <= 0 || !Number.isSafeInteger(locationCode) || locationCode <= 0 ||
      !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(languageCode) || !['desktop','mobile'].includes(device) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1048576)
    throw error('AIO_CONFIGURATION', 'google-aio requires a positive cost estimate and valid locale, device and response limits');
  const endpoint = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';
  return {
    identity: { engine: 'google-aio', provider: 'dataforseo-serp', model: 'ai-overview' },
    estimateCostUsd: () => costEstimateUsd,
    async run({ prompt, signal, maxCostUsd = costEstimateUsd }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 700)
        throw error('AIO_INVALID_QUERY', 'google-aio requires a nonempty query of at most 700 characters');
      // Search operators trigger a different supplier tariff. Keep them out of
      // this baseline-priced path rather than under-reserving their cost.
      if (/\b(?:allinanchor|allintext|allintitle|allinurl|cache|define|definition|filetype|id|inanchor|info|intext|intitle|inurl|link|site):/i.test(prompt))
        throw error('AIO_UNPRICED_QUERY', 'google-aio search operators require a separately reviewed supplier cost estimate');
      if (!Number.isFinite(maxCostUsd) || maxCostUsd < costEstimateUsd)
        throw error('AIO_BUDGET', 'google-aio estimated request cost exceeds the supplied budget');
      const requestProvenance = { query: prompt, location_code: locationCode, language_code: languageCode, device, endpoint, depth: 10, load_async_ai_overview: false };
      if (signal?.aborted) throw error('AIO_ABORTED', 'google-aio request was cancelled before admission', { provenance: requestProvenance });
      const controller = new AbortController();
      let timedOut = false, rejectAbort;
      const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
      const onAbort = () => { controller.abort(); rejectAbort(error(timedOut ? 'AIO_TIMEOUT' : 'AIO_ABORTED', timedOut ? 'google-aio request timed out' : 'google-aio request was cancelled', { costEstimateUsd, provenance: requestProvenance })); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
      let reader;
      try {
        const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64');
        const response = await Promise.race([doFetch(endpoint, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
          body: JSON.stringify([{ keyword: prompt.replaceAll('%','%25').replaceAll('+','%2B'), location_code: locationCode, language_code: languageCode, device, depth: 10, load_async_ai_overview: false }]),
          signal: controller.signal,
        }), interrupted]);
        if (!response.ok) throw error('AIO_HTTP_ERROR', `dataforseo responded ${response.status}`, { httpStatus: response.status });
        if (Number(response.headers.get('content-length')) > maxResponseBytes) {
          void response.body?.cancel().catch(() => {}); throw error('AIO_RESPONSE_TOO_LARGE', 'dataforseo response exceeded the byte limit');
        }
        if (!response.body) throw error('AIO_MALFORMED_RESPONSE', 'dataforseo response had no body');
        reader = response.body.getReader();
        const decoder = new TextDecoder(), chunks = []; let bytes = 0;
        while (true) {
          const { done, value } = await Promise.race([reader.read(), interrupted]);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) throw error('AIO_RESPONSE_TOO_LARGE', 'dataforseo response exceeded the byte limit');
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        let body;
        try { body = JSON.parse(chunks.join('')); } catch { throw error('AIO_MALFORMED_RESPONSE', 'dataforseo response was not JSON'); }
        if (body?.status_code !== 20000) throw error('AIO_SUPPLIER_ERROR', 'dataforseo did not accept the request', { supplierStatus: body?.status_code ?? null });
        if (!Array.isArray(body.tasks) || body.tasks.length !== 1) throw error('AIO_MALFORMED_RESPONSE', 'dataforseo response must contain exactly one task');
        const task = body.tasks[0];
        if (task?.status_code !== 20000) throw error('AIO_TASK_ERROR', 'dataforseo task did not complete successfully', { supplierStatus: task?.status_code ?? null });
        if (!Array.isArray(task.result) || task.result.length !== 1 || !Array.isArray(task.result[0]?.items))
          throw error('AIO_MALFORMED_RESPONSE', 'dataforseo task did not contain a complete SERP result');
        const result = task.result[0];
        for (const [key, expected] of [['keyword',prompt],['location_code',locationCode],['language_code',languageCode],['device',device]]) {
          if (result[key] !== undefined && result[key] !== expected) throw error('AIO_PROVENANCE_MISMATCH', `dataforseo returned a different ${key}`);
        }
        const provenance = { ...requestProvenance, task_id: task.id ?? null, checked_at: result.datetime ?? null, check_url: result.check_url ?? null, provider_query: result.keyword ?? null, provider_device: result.device ?? task.data?.device ?? null };
        const charged = typeof body.cost === 'number' ? body.cost : typeof task.cost === 'number' ? task.cost : costEstimateUsd;
        if (!Number.isFinite(charged) || charged < 0) throw error('AIO_MALFORMED_RESPONSE', 'dataforseo returned an invalid cost');
        if (charged > maxCostUsd) throw error('AIO_COST_EXCEEDED', 'dataforseo reported a cost above the admitted estimate; stop further calls', { costEstimateUsd: charged, provenance });
        const blocks = result.items.filter(item => item?.type === 'ai_overview');
        if (!blocks.length) throw error('AIO_NOT_RENDERED', 'google-aio: no AI Overview block rendered for this query', { unknown: true, costEstimateUsd: charged, provenance });
        if (blocks.length !== 1) throw error('AIO_MALFORMED_RESPONSE', 'dataforseo returned multiple overview blocks');
        const block = blocks[0];
        if ((block.items != null && !Array.isArray(block.items)) || (block.references != null && !Array.isArray(block.references)))
          throw error('AIO_MALFORMED_RESPONSE', 'dataforseo overview collections were malformed');
        const elements = block.items ?? [];
        if (elements.some(item => !item || typeof item !== 'object' || (item.references != null && !Array.isArray(item.references))))
          throw error('AIO_MALFORMED_RESPONSE', 'dataforseo overview element references were malformed');
        const answer = typeof block.text === 'string' ? block.text : typeof block.markdown === 'string' ? block.markdown : elements.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n');
        if (answer.trim().length < 40) throw error('AIO_INCOMPLETE_OVERVIEW', 'google-aio: AI Overview text too short to interpret', { unknown: true });
        const sources = [...(block.references ?? []), ...elements.flatMap(item => [...(Array.isArray(item?.references) ? item.references : []), ...(typeof item?.url === 'string' ? [item] : [])])];
        const citations = [], seen = new Set();
        for (const source of sources) {
          let url;
          try { url = new URL(source?.url); } catch { throw error('AIO_MALFORMED_RESPONSE', 'dataforseo overview reference had no valid URL'); }
          if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw error('AIO_MALFORMED_RESPONSE', 'dataforseo overview reference used an unsupported URL');
          if (!seen.has(url.href)) { seen.add(url.href); citations.push({url:url.href,...(typeof source.title==='string'?{title:source.title.slice(0,500)}:{})}); }
        }
        if (citations.length > 200) throw error('AIO_MALFORMED_RESPONSE', 'dataforseo overview exceeded the citation limit');
        const parsed = parseAioResponse({ ...body, cost: charged, tasks: [{ result: [{ items: [{ type: 'ai_overview', text: answer, items: citations }] }] }] }, prompt);
        return { ...parsed, citations, provenance };
      } catch (cause) {
        if (cause instanceof EngineError) { cause.unknown = true; cause.costEstimateUsd ??= costEstimateUsd; cause.provenance ??= requestProvenance; throw cause; }
        // A supplier call may already be billed even when its response fails.
        // Never silently retry a paid request or include supplier messages/secrets.
        throw error('AIO_TRANSPORT_ERROR', 'dataforseo request failed', { unknown: true, costEstimateUsd, provenance: requestProvenance });
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
        if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* cancellation is best effort */ } }
      }
    },
  };
}

function parseAioResponse(body, prompt) {
  const result = body?.tasks?.[0]?.result?.[0];
  if (!result) throw new EngineError('google-aio: no result in response', { retriable: true });
  const aioBlock = (result.items ?? []).find((item) => item.type === 'ai_overview');
  if (!aioBlock) {
    // An honest absence: the SERP rendered without an AI Overview block.
    throw new EngineError('google-aio: no AI Overview block rendered for this query', { retriable: true });
  }
  const answer = aioBlock.text ?? '';
  if (answer.trim().length < 40) {
    throw new EngineError('google-aio: AI Overview text too short to interpret', { retriable: true });
  }
  const citations = (aioBlock.items ?? [])
    .filter((src) => typeof src.url === 'string' && src.url.length > 0)
    .map((src) => ({ url: src.url, title: src.title ?? null }));
  return {
    engine: 'google-aio',
    provider: 'dataforseo-serp',
    model: 'ai-overview',
    providerModelVersion: 'google-aio-serp-v1',
    answer,
    citations,
    fanOut: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    costEstimateUsd: body?.cost ?? 0.0012,
  };
}
