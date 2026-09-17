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
import { citationPanelSchema, engineIdentity, cellId, targetKey,
  CITATIONS_VERSION, CITATION_LIMITS,
  evidenceEnvelopeSchema, observationRowSchema, epochRowSchema } from './contract.js';
import { classifyOutcome } from './match.js';
import { wilsonInterval, smoothedRate, classifyEpoch, tallyOutcomes } from './stats.js';
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
 * The runner never retries: a failed run is one unknown observation, and retry
 * policy is a hosted concern (DP-0033) where leases exist.
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
    if (!engine) throw new EngineError(`no engine instance provided for ${identity}`);
    for (const prompt of panel.prompts) {
      for (const target of panel.targets) {
        cells.push({ identity, prompt, target, engine, id: cellId(identity, prompt.id ?? sha256(prompt.text).slice(0, 10), targetKey(target)) });
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
      // Budget first: the estimate is checked BEFORE the call, so the cap cannot be
      // exceeded, only approached. The mock engine's estimate makes this testable.
      const estimate = cell.engine.estimateCostUsd?.() ?? null;
      if (estimate !== null && spent + estimate > maxUsd) {
        aborted = { reason: 'budget', spent, nextEstimate: estimate, maxUsd };
        break outer;
      }
      let run;
      try {
        run = await cell.engine.run({ prompt: cell.prompt.text, runIndex });
      } catch (cause) {
        if (cause instanceof EngineError && cause.retriable) {
          outcomesByCell.get(cell.id).push('unknown');
          continue;
        }
        throw cause;
      }
      spent += run.costEstimateUsd ?? 0;

      const envelope = evidenceEnvelopeSchema.parse({
        schema_version: CITATIONS_VERSION,
        epoch_id: epochId, cell_id: cell.id, run_index: runIndex, prompt: cell.prompt.text,
        engine_identity: cell.identity,
        provider_model_version: run.providerModelVersion ?? `${run.engine}:${run.model}`,
        answer: run.answer, citations: run.citations, fan_out: run.fanOut ?? [],
        usage: run.usage ?? { input_tokens: 0, output_tokens: 0 },
        cost_estimate_usd: run.costEstimateUsd ?? 0,
        at: nowIso(),
      });
      const evidenceJson = JSON.stringify(envelope);
      const digest = sha256(evidenceJson);
      await writeFile(join(evidenceRoot, `${digest}.json`), evidenceJson, 'utf8');

      const tiered = classifyOutcome(cell.target, run, options.verifyFetch ?? null);
      outcomesByCell.get(cell.id).push(tiered.outcome);
      observationRows.push(observationRowSchema.parse({
        schema_version: CITATIONS_VERSION, epoch_id: epochId, cell_id: cell.id, run_index: runIndex,
        outcome: tiered.outcome, cited_urls: tiered.citedUrls, verify: tiered.verify,
        evidence_sha256: digest, cost_estimate_usd: run.costEstimateUsd ?? 0, at: nowIso(),
      }));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const prior = await readPriorEpochs(dir);
  const epochRows = [];
  for (const cell of cells) {
    const outcomes = outcomesByCell.get(cell.id);
    const { k, n, unknowns, mentioned } = tallyOutcomes(outcomes);
    const ci = wilsonInterval(k, n) ?? [0, 1];
    const baselineRow = prior.filter((r) => r.cell_id === cell.id && r.n >= CITATION_LIMITS.minSamplesForInterpretation).at(-1);
    const baseline = baselineRow ? { k: baselineRow.k, n: baselineRow.n } : null;
    epochRows.push(epochRowSchema.parse({
      schema_version: CITATIONS_VERSION, epoch_id: epochId, cell_id: cell.id,
      k, n, unknowns, mentioned,
      rate: smoothedRate(k, n) ?? 0, ci_low: ci[0], ci_high: ci[1],
      classification: classifyEpoch({ k, n }, baseline, CITATION_LIMITS),
      baseline: baselineRow ? { epoch_id: baselineRow.epoch_id, rate: baselineRow.rate, ci_low: baselineRow.ci_low, ci_high: baselineRow.ci_high } : undefined,
      spent_estimate_usd: Number(spent.toFixed(6)), at: nowIso(),
    }));
  }

  await writeFile(join(dir, CITATION_FILES.observations), observationRows.map((r) => JSON.stringify(r)).join('\n') + (observationRows.length ? '\n' : ''), { flag: 'a' });
  await writeFile(join(dir, CITATION_FILES.epochs), epochRows.map((r) => JSON.stringify(r)).join('\n') + (epochRows.length ? '\n' : ''), { flag: 'a' });

  return { epochId, cells: epochRows, spentEstimateUsd: Number(spent.toFixed(6)), aborted, samples, maxUsd };
}
