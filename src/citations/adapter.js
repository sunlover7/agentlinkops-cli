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
