// The epoch runner: a fixed-n batch over a panel, budgeted, evidenced, summarized.
//
// Execution order per run: check the budget, run the engine, write the immutable
// evidence snapshot, tier the outcome, tally. The epoch size is committed before the
// first call and never extended mid-epoch. A budget abort leaves a partial-epoch
// receipt — never a silent overspend, never a silent shortfall — and partial tallies
// below the interpretation minimum classify as insufficient_data, which is the point.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { citationPanelSchema, engineIdentity, cellId, targetKey, panelLocaleContext, localizedPromptId,
  CITATIONS_VERSION, CITATION_LIMITS,
  evidenceEnvelopeSchema, observationRowSchema, epochRowSchema } from './contract.js';
import { classifyOutcome, analyzeRetainedAnswer } from './match.js';
import { wilsonInterval, smoothedRate, classifyEpoch, tallyOutcomes, confidenceSequence, compareEpochs, changepointPosterior } from './stats.js';
import { EngineError } from './adapter.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const nowIso = () => new Date().toISOString();

export const CITATION_FILES = Object.freeze({
  observations: 'citations-observations.jsonl',
  epochs: 'citations-epochs.jsonl',
  evidenceDir: 'citations/evidence',
});

export async function loadPanel(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return citationPanelSchema.parse(raw);
}

async function readPriorEpochs(dir) {
  let text = '';
  try { text = await readFile(join(dir, CITATION_FILES.epochs), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* reported by the reader, not the runner */ }
  }
  return rows;
}

/**
 * Run one epoch. Options:
 *  - engines: Map from engine identity to an adapter instance (tests pass mocks)
 *  - dir: the ledger directory (default `.agentlinkops`)
 *  - verifyFetch: async (url) => true | false | null — upgrades cited to verified
 *  - now: injectable clock, for tests
 * Retriable failures receive one retry; exhausted attempts remain unknown.
 */
export async function runEpoch(panelInput, options = {}) {
  const panel = citationPanelSchema.parse(panelInput);
  const dir = options.dir ?? '.agentlinkops';
  const now = options.now ?? new Date();
  const samples = panel.samples ?? CITATION_LIMITS.defaultSamples;
  const maxUsd = panel.maxUsd ?? CITATION_LIMITS.defaultMaxUsd;
  const delayMs = options.delayMs ?? 0; // mock/tests: 0; live callers pass pacing

  const epochId = `${now.toISOString().slice(0, 10)}-${sha256(JSON.stringify({ panel, at: now.toISOString() })).slice(0, 10)}`;
  const evidenceRoot = join(dir, CITATION_FILES.evidenceDir, epochId);
  await mkdir(evidenceRoot, { recursive: true });

  const cells = [];
  for (const engineSpec of panel.engines) {
    const identity = engineIdentity(engineSpec);
    const engine = options.engines?.get(identity);
    const context = panelLocaleContext(panel, engineSpec);
    if ((context.locale !== 'en-US' || context.country !== 'US') && !['mock', 'google-aio'].includes(engineSpec.engine)) throw new EngineError('this engine has only an unverified en-US/US context; use mock or a configured supplier for locale variants');
    if (!engine) throw new EngineError(`no engine instance provided for ${identity}`);
    for (const prompt of panel.prompts) {
      for (const target of panel.targets) {
        cells.push({ identity, prompt, target, engine, context, id: cellId(identity, localizedPromptId(prompt.id ?? sha256(prompt.text).slice(0, 10), context), targetKey(target)) });
      }
    }
  }

  let spent = 0;
  let aborted = null;
  const observationRows = [];
  const outcomesByCell = new Map(cells.map((c) => [c.id, []]));

  outer:
  for (const cell of cells) {
    for (let runIndex = 0; runIndex < samples; runIndex += 1) {
      const estimate = cell.engine.estimateCostUsd?.() ?? 0;
      if (!Number.isFinite(estimate) || estimate < 0) throw new EngineError('engine cost estimate must be a finite nonnegative number');
      let run = null, lastCause = null, attemptCost = 0;
      for (let attempt = 0; attempt < 2 && !run; attempt += 1) {
        // Reserve each attempt, including retries, before calling a supplier.
        if (spent + estimate > maxUsd) {
          aborted = { reason: 'budget', spent, nextEstimate: estimate, maxUsd };
          break;
        }
        spent += estimate;
        attemptCost += estimate;
        try {
          run = await cell.engine.run({ prompt: cell.prompt.text, runIndex, localeContext: cell.context, maxCostUsd: estimate || maxUsd - spent });
          const actual = run.costEstimateUsd ?? estimate;
          if (!Number.isFinite(actual) || actual < 0) throw new EngineError('engine returned an invalid cost');
          spent += actual - estimate;
          attemptCost += actual - estimate;
          if (spent > maxUsd) aborted = { reason: 'supplier_cost_exceeded', spent, maxUsd };
        } catch (cause) {
          run = null;
          lastCause = cause;
          // Failed or timed-out requests may already be billed. Keep the
          // reservation unless the supplier reports a greater charge.
          const charged = Number.isFinite(cause?.costEstimateUsd) ? Math.max(estimate, cause.costEstimateUsd) : estimate;
          spent += charged - estimate;
          attemptCost += charged - estimate;
          if (spent > maxUsd) aborted = { reason: 'supplier_cost_exceeded', spent, maxUsd };
          if (!(cause instanceof EngineError) || (!cause.retriable && !cause.unknown)) throw cause;
          if (!cause.retriable || aborted) break;
          if (options.err && attempt === 0) options.err(`retrying observation (${cell.id}): ${cause.message}`);
        }
      }
      if (!run) {
        if (!lastCause && aborted) break outer;
        if (options.err) options.err(`unknown observation (${cell.id}): ${lastCause?.message ?? 'unspecified'}`);
        run = { engine: cell.engine.identity?.engine ?? 'unknown', model: cell.engine.identity?.model ?? 'unknown', answer: '', citations: [], unknown: true,
          provenance: lastCause?.provenance, failure: { code: lastCause?.code ?? 'ENGINE_UNAVAILABLE', message: lastCause?.message ?? 'Engine unavailable' } };
      }
      run.costEstimateUsd = attemptCost;

      const envelope = {
        schema_version: CITATIONS_VERSION,
        epoch_id: epochId, cell_id: cell.id, run_index: runIndex, prompt: cell.prompt.text,
        engine_identity: cell.identity,
        locale_context: cell.context,
        provider_model_version: run.providerModelVersion ?? `${run.engine}:${run.model}`,
        answer: run.answer, citations: run.citations, fan_out: run.fanOut ?? [],
        usage: run.usage ?? { input_tokens: 0, output_tokens: 0 },
        cost_estimate_usd: run.costEstimateUsd ?? 0,
        at: nowIso(),
        ...(run.provenance ? { provenance: run.provenance } : {}),
        ...(run.browserContext ? { browser_context: run.browserContext } : {}),
        ...(run.failure ? { failure: run.failure } : {}),
      };
      const digest = sha256(JSON.stringify(envelope));
      // The screenshot is a sibling of the envelope: same content-addressed
      // directory, named by the envelope digest it belongs to. An observation
      // of a rendered surface carries the pixels of that surface.
      if (run.screenshotPng) {
        const shotName = `${digest}.screenshot.png`;
        await writeFile(join(evidenceRoot, shotName), run.screenshotPng);
        envelope.screenshot_file = shotName;
      }
      await writeFile(join(evidenceRoot, `${digest}.json`), JSON.stringify(evidenceEnvelopeSchema.parse(envelope)), 'utf8');

      const tiered = run.unknown ? { outcome: 'unknown', citedUrls: [], verify: 'unknown' } : classifyOutcome(cell.target, run, options.verifyFetch ?? null);
      const analysis = analyzeRetainedAnswer(cell.target, run);
      outcomesByCell.get(cell.id).push(tiered.outcome);
      observationRows.push(observationRowSchema.parse({
        schema_version: CITATIONS_VERSION, epoch_id: epochId, cell_id: cell.id, run_index: runIndex,
        outcome: tiered.outcome, brand_mentioned: analysis.mentioned, target_cited: analysis.cited, cited_urls: tiered.citedUrls, verify: tiered.verify,
        evidence_sha256: digest, cost_estimate_usd: run.costEstimateUsd ?? 0, at: nowIso(),
      }));
      // Duck engines need extra pacing: their anonymous rate limit (~3-4 per exit)
      // benefits from a cooldown between observations even with exit rotation.
      if (aborted) break outer;
      const cellDelay = cell.identity.startsWith('duck') ? Math.max(delayMs, 2000) : delayMs;
      if (cellDelay > 0) await new Promise((r) => setTimeout(r, cellDelay));
    }
  }

  const prior = await readPriorEpochs(dir);
  const epochRows = [];
  for (const cell of cells) {
    const outcomes = outcomesByCell.get(cell.id);
    const { k, n, unknowns, mentioned } = tallyOutcomes(outcomes);
    const ci = wilsonInterval(k, n);
    const baselineRow = prior.filter((r) => r.cell_id === cell.id && r.n >= CITATION_LIMITS.minSamplesForInterpretation).at(-1);
    const baseline = baselineRow ? { k: baselineRow.k, n: baselineRow.n } : null;
    const priorCount = prior.filter(row => row.cell_id === cell.id).length;
    const pairAlpha = priorCount > 0 ? 0.05 / (priorCount * (priorCount + 1)) : 0.05;
    const { run_length_posterior, ...changepoint } = changepointPosterior(outcomes);
    const statistics = { scope: 'fixed-epoch-supplemental',
      confidence_sequence: confidenceSequence(outcomes, { alpha: 0.05, comparisons: cells.length }).at(-1) ?? null,
      epoch_comparison: baseline ? compareEpochs({ k, n }, baseline, { alpha: pairAlpha, comparisons: cells.length }) : null,
      changepoint,
    };
    const row = epochRowSchema.parse({
      schema_version: CITATIONS_VERSION, epoch_id: epochId, cell_id: cell.id,
      k, n, unknowns, mentioned,
      rate: smoothedRate(k, n), ci_low: ci?.[0] ?? null, ci_high: ci?.[1] ?? null,
      classification: classifyEpoch({ k, n }, baseline, CITATION_LIMITS), statistics,
      baseline: baselineRow ? { epoch_id: baselineRow.epoch_id, rate: baselineRow.rate, ci_low: baselineRow.ci_low, ci_high: baselineRow.ci_high } : undefined,
      spent_estimate_usd: Number(spent.toFixed(6)), at: nowIso(),
    });
    epochRows.push(row);
    // Incremental flush: every completed cell's row is on disk immediately, so
    // a killed epoch loses nothing — the lesson of the lost 3x3 tallies.
    await writeFile(join(dir, CITATION_FILES.epochs), JSON.stringify(row) + '\n', { flag: 'a' });
  }

  await writeFile(join(dir, CITATION_FILES.observations), observationRows.map((r) => JSON.stringify(r)).join('\n') + (observationRows.length ? '\n' : ''), { flag: 'a' });

  // Browser engines hold a browser and maybe an Xvfb display for the whole
  // epoch; release both once the tallies are written.
  for (const engine of new Set(cells.map((c) => c.engine))) {
    try { await engine.close?.(); } catch { /* cleanup is best-effort */ }
  }

  return { epochId, cells: epochRows, spentEstimateUsd: Number(spent.toFixed(6)), aborted, samples, maxUsd };
}
