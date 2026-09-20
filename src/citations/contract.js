// The citation contract: one AI citation treated as one placement.
//
// A link is placed by an editor and stays until an editor removes it. A citation is
// re-decided by a model on every ask, so the observable is a rate, not a presence —
// and the 2026 measurement research (IQRush, arXiv 2603.08924) says single readings
// are mostly noise (run-to-run citation-set Jaccard 0.29-0.50). Every rule in this
// file exists to keep that fact structural: fixed-n epochs, honest denominators,
// intervals instead of scores, and an explicit refusal to interpret thin data.
//
// Internal v1 contract only. No route, queue or hosted surface is activated by this
// module; the hosted port (DP-0033) must not weaken anything stated here.
import { z } from 'zod';
import { validatePublicUrl } from '../verifier/url.js';

export const CITATIONS_VERSION = 1;
export const CITATION_PANEL_VERSION = 2;

// Outcome tiers, weakest to strongest. `unknown` is NOT the bottom of a scale: it is
// excluded from every denominator, exactly as a blocked fetch is never a lost link.
// `verified` means we re-fetched the cited URL ourselves; we never take the engine's
// word for its citations (potato's rule, adopted 2026-09-16).
export const CITATION_OUTCOMES = Object.freeze(['verified', 'cited', 'mentioned', 'not_cited', 'unknown']);
const OUTCOME_RANK = Object.freeze({ verified: 4, cited: 3, mentioned: 2, not_cited: 1, unknown: 0 });
export const outcomeRank = (outcome) => OUTCOME_RANK[outcome] ?? 0;

// Domain scope is the default because URL-level matching is strictly more volatile
// (IQRush). URL scope is an explicit precision mode and its intervals are read with
// that caveat attached.
export const CITATION_TARGET_SCOPES = Object.freeze(['domain', 'url']);

// Engines this version knows. `mock` costs nothing, is deterministic per seed, and
// exists so every test and every dry-run proves the pipeline without spending money.
export const CITATION_ENGINES = Object.freeze(['mock', 'perplexity', 'duck', 'google-aio']);

// Token rates used ONLY for the pre-call budget estimate. These are not bills; they
// are the numbers the hard maxUsd cap is enforced against, so they are deliberately
// conservative (rounded up where uncertain). Update with a version bump when prices
// move.
export const ENGINE_RATE_CARD = Object.freeze({
  mock: Object.freeze({ inputPerMTokens: 0, outputPerMTokens: 0, perRequest: 0, currency: 'USD' }),
  perplexity: Object.freeze({ inputPerMTokens: 1.0, outputPerMTokens: 1.0, perRequest: 0.005, currency: 'USD' }),
});

export const CITATION_LIMITS = Object.freeze({
  answerBytes: 256 * 1024,
  timeoutMs: 45_000,
  // Below this the tool refuses to interpret, whatever the numbers look like.
  minSamplesForInterpretation: 10,
  maxCiWidth: 0.5,
  defaultSamples: 30,
  shareGradeSamples: 100,
  defaultMaxUsd: 5.0,
  // Courtesy pacing between runs against the same engine identity. The hosted port
  // owns real fairness; locally this only keeps one panel from hammering an API key.
  delayMs: 250,
});

const httpsUrl = z.string().refine((value) => {
  try { return new URL(value).protocol === 'https:' && validatePublicUrl(value).valid; } catch { return false; }
}, { message: 'a public https URL is required' });

export const citationTargetSchema = z.object({
  domain: z.string().min(3).refine(value => !/[/?#@:]/.test(value) && validatePublicUrl(`https://${value}/`).valid, { message: 'a public hostname is required' }).optional(),
  url: httpsUrl.optional(),
  scope: z.enum(CITATION_TARGET_SCOPES).default('domain'),
  brand: z.string().min(1),
  aliases: z.array(z.string().min(1)).max(12).default([]),
}).refine((t) => (t.scope === 'domain' ? typeof t.domain === 'string' : typeof t.url === 'string'), {
  message: 'domain scope needs a domain; url scope needs a url',
});

export const citationPromptSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  text: z.string().min(1).max(2000),
  intent_cluster: z.string().min(1).max(100).optional(),
  branded: z.boolean().default(false),
  provenance: z.object({ source: z.enum(['gsc', 'paa', 'autocomplete', 'manual']), reference: z.string().min(1).max(1000), observed_at: z.iso.datetime({ offset: true }), basis: z.literal('user_supplied') }).optional(),
});

export const citationEngineSpecSchema = z.object({
  // API engines ('mock', 'perplexity') or browser surfaces ('chatgpt',
  // 'perplexity', 'gemini', 'claude', 'ai-overview' with via:'browser').
  engine: z.string().min(2).max(40),
  via: z.enum(['api', 'browser']).default('api'),
  model: z.string().min(1).max(80).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});

export function migrateCitationPanel(raw) {
  if (!raw || typeof raw !== 'object' || ![1, 2].includes(raw.schema_version)) return raw;
  const targets = Array.isArray(raw.targets) ? [...raw.targets] : raw.targets;
  if (Array.isArray(targets) && Array.isArray(raw.competitors)) {
    for (const competitor of raw.competitors) {
      if (competitor && typeof competitor.domain === 'string' && !targets.some(target => target?.scope !== 'url' && target?.domain?.toLowerCase() === competitor.domain.toLowerCase())) {
        targets.push({ ...competitor, scope: 'domain' });
      }
    }
  }
  return { ...raw, schema_version: CITATION_PANEL_VERSION, targets, country: raw.country ?? (raw.locale ?? 'en-US').split('-').at(-1) };
}
export const citationPanelSchema = z.preprocess(migrateCitationPanel, z.object({
  schema_version: z.literal(CITATION_PANEL_VERSION),
  targets: z.array(citationTargetSchema).min(1).max(50),
  prompts: z.array(citationPromptSchema).min(1).max(500),
  engines: z.array(citationEngineSpecSchema).min(1).max(4),
  samples: z.number().int().min(1).max(500).optional(),
  maxUsd: z.number().positive().max(500).optional(),
  // Mock-engine behavior keyed by prompt text: candidate citations with inclusion
  // weights, mentionText, fanOut, costEstimateUsd. This is how a dry run simulates a
  // real panel (and how a test simulates a collapse) without spending anything.
  mockFixtures: z.record(z.string(), z.any()).optional(),
  // Competitor domains: the panel watches them alongside the primary target,
  // each as its own cell identity (never averaged with the target).
  competitors: z.array(z.object({
    domain: z.string().min(3).max(253),
    brand: z.string().min(1).max(100),
    aliases: z.array(z.string().min(1).max(100)).max(12).default([]),
  })).max(10).default([]),
  // Locale pinning: surfaces vary answers by geography. Default en-US.
  locale: z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/).default('en-US'),
  country: z.string().regex(/^[A-Z]{2}$/).default('US'),
  note: z.string().max(500).optional(),
}));

export function panelLocaleContext(panel, spec) {
  return { locale: panel.locale ?? 'en-US', country: spec.country ?? panel.country ?? 'US',
    mode: spec.engine === 'mock' ? 'fixture' : spec.engine === 'google-aio' ? 'supplier-location' : 'single-locale-unverified' };
}
export function localizedPromptId(promptId, context) {
  // Preserve legacy en-US/US cell identities; other contexts get distinct baselines.
  return context.locale === 'en-US' && context.country === 'US' ? promptId : `${promptId}@${context.locale}:${context.country}`;
}

// The engine identity names HOW a surface was reached, because the same engine two
// ways is two different measurements and is never averaged (limelitgeo/open's rule).
export function engineIdentity(spec) {
  const provider = spec.via === 'browser' ? 'web-own-browser' : spec.engine === 'mock' ? 'builtin' : 'api';
  const parts = [spec.engine, provider];
  if (spec.model) parts.push(spec.model);
  if (spec.country && spec.country !== 'US') parts.push(`country:${spec.country}`);
  return parts.join(':');
}

export function cellId(identity, promptId, targetKey) {
  return `${identity}|${promptId}|${targetKey}`;
}

export function targetKey(target) {
  return target.scope === 'domain' ? `d:${target.domain.toLowerCase()}` : `u:${target.url}`;
}

// What one run leaves behind, immutably, before anyone interprets it.
export const evidenceEnvelopeSchema = z.object({
  schema_version: z.literal(CITATIONS_VERSION),
  epoch_id: z.string().min(1),
  cell_id: z.string().min(1),
  // Two runs can land in the same millisecond; the run index is what makes their
  // evidence snapshots distinct content-addressed objects rather than silent
  // duplicates of each other.
  run_index: z.number().int().nonnegative(),
  // Sibling screenshot of the answer surface, same directory as this envelope;
  // present when the engine captures pixels (browser surfaces always do).
  screenshot_file: z.string().max(120).optional(),
  prompt: z.string().min(1),
  engine_identity: z.string().min(1),
  locale_context: z.object({ locale: z.string(), country: z.string(), mode: z.enum(['fixture', 'supplier-location', 'single-locale-unverified']) }).optional(),
  provider_model_version: z.string().min(1),
  browser_context: z.object({ surface: z.literal('web'), authentication: z.enum(['saved-session', 'anonymous']), account_tier: z.literal('unknown') }).optional(),
  // Adapter provenance is request/response metadata, never supplier credentials.
  provenance: z.object({
    query: z.string().max(700), location_code: z.number().int().positive(), language_code: z.string().max(20),
    device: z.enum(['desktop','mobile']), endpoint: z.string().url(), depth: z.number().int().positive(),
    load_async_ai_overview: z.boolean(), task_id: z.string().nullable().optional(), checked_at: z.string().nullable().optional(),
    check_url: z.string().nullable().optional(), provider_query: z.string().nullable().optional(), provider_device: z.string().nullable().optional(),
  }).optional(),
  failure: z.object({ code: z.string().max(100), message: z.string().max(2000) }).optional(),
  answer: z.string(),
  citations: z.array(z.object({ url: httpsUrl, title: z.string().max(500).optional() })).max(200),
  fan_out: z.array(z.string().max(500)).max(100).default([]),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
  }),
  cost_estimate_usd: z.number().nonnegative(),
  at: z.string().min(1),
});

export const observationRowSchema = z.object({
  schema_version: z.literal(CITATIONS_VERSION),
  epoch_id: z.string().min(1),
  cell_id: z.string().min(1),
  run_index: z.number().int().nonnegative(),
  outcome: z.enum(CITATION_OUTCOMES),
  brand_mentioned: z.boolean().nullable().optional(),
  target_cited: z.boolean().nullable().optional(),
  cited_urls: z.array(z.string().max(2048)).max(50).default([]),
  verify: z.enum(['unverified', 'reachable', 'unreachable', 'unknown']).default('unverified'),
  evidence_sha256: z.string().length(64),
  cost_estimate_usd: z.number().nonnegative(),
  at: z.string().min(1),
});

export const EPOCH_CLASSIFICATIONS = Object.freeze([
  'first_epoch', 'insufficient_data', 'declined', 'grown', 'not_distinguishable',
]);

export const epochRowSchema = z.object({
  schema_version: z.literal(CITATIONS_VERSION),
  epoch_id: z.string().min(1),
  cell_id: z.string().min(1),
  k: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  unknowns: z.number().int().nonnegative(),
  mentioned: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
  ci_low: z.number().min(0).max(1).nullable(),
  ci_high: z.number().min(0).max(1).nullable(),
  classification: z.enum(EPOCH_CLASSIFICATIONS),
  statistics: z.object({
    scope: z.literal('fixed-epoch-supplemental'),
    confidence_sequence: z.record(z.string(), z.unknown()).nullable(),
    epoch_comparison: z.record(z.string(), z.unknown()).nullable(),
    changepoint: z.record(z.string(), z.unknown()),
  }).optional(),
  baseline: z.object({
    epoch_id: z.string().min(1),
    rate: z.number().min(0).max(1),
    ci_low: z.number().min(0).max(1),
    ci_high: z.number().min(0).max(1),
  }).optional(),
  spent_estimate_usd: z.number().nonnegative(),
  at: z.string().min(1),
});
