// `agentlinkops citation` — watch AI citations as placements, locally.
//
// One prompt panel, run against engine APIs with the customer's own key, a hard
// USD cap, and evidence written into the repository ledger. The vocabulary is the
// contract's: rates with intervals and sample sizes, never "removed", and thin data
// reported as insufficient rather than interpreted.
//
// Exit codes follow the link commands: 0 nothing actionable (including
// insufficient_data — an unknown never fails), 1 a cell classified declined with
// complete evidence, 2 usage, configuration or budget-abort errors.
import { resolve } from 'node:path';

import { parseArgs } from './args.js';
import { loadPanel, runEpoch } from '../src/citations/runner.js';
import { engineIdentity } from '../src/citations/contract.js';
import { createMockEngine, createPerplexityEngine, EngineError } from '../src/citations/adapter.js';
import { describeChange } from '../src/citations/stats.js';

const USAGE = `agentlinkops citation — AI citation watches in this repository

  agentlinkops citation run PANEL.json [--dir DIR] [--samples N] [--max-usd USD] [--json]
                                            run one fixed-n epoch over a panel; evidence and
                                            tallies land under .agentlinkops/citations/
  agentlinkops citation run PANEL.json --engine chatgpt:web-own-browser
                                            measure the consumer UI through Camoufox
                                            (dedicated account, personal cadence; evidence
                                            includes a screenshot of every answer)
  agentlinkops citation help                 this help

Panel (JSON): targets (domain or url, brand, aliases), prompts, engines
([{ "engine": "mock" | "perplexity", "model": "…" }]), optional samples and maxUsd.
Live engines need the matching environment credential (PERPLEXITY_API_KEY); the mock
engine runs everything at zero cost. Every run states its estimated spend, and the
cap is checked BEFORE each call, so it can be approached but never exceeded.

Output language: citation RATE with a Wilson interval and n, classified against the
previous epoch as declined, grown or not_distinguishable — never "removed", never
"stable", and insufficient_data when n is too thin to interpret.`;

export async function citationMain(argv = [], { cwd = process.cwd(), out = console.log, err = console.error, env = process.env } = {}) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';
  if (command === 'help' || args.help) { out(USAGE); return 0; }
  if (command !== 'run') { err(`unknown citation command: ${command}`); err(USAGE); return 2; }

  const panelPath = args._[1];
  if (!panelPath) { err('citation run needs a panel file'); return 2; }

  let panel;
  try {
    panel = await loadPanel(resolve(cwd, panelPath));
  } catch (cause) {
    err(`panel could not be read or parsed: ${cause.message}`);
    return 2;
  }

  const dir = resolve(cwd, args.dir ?? '.agentlinkops');
  if (args.samples) panel.samples = Number(args.samples);
  if (args['max-usd']) panel.maxUsd = Number(args['max-usd']);
  // --engine NAME[:PROVIDER] overrides the panel's engine list. The provider
  // suffix picks the surface: chatgpt:web-own-browser measures the consumer
  // UI through Camoufox; chatgpt:api would measure the API. Never averaged.
  if (args.engine) {
    const [engineName, providerTag] = String(args.engine).split(':');
    const via = providerTag === 'web-own-browser' ? 'browser' : 'api';
    panel.engines = [{ engine: engineName, via }];
    err(`engine override: ${engineIdentity(panel.engines[0])}`);
  }
  // Overrides are stated, never silent: a number the panel did not ask for is a
  // configuration decision the operator should see in the receipt.
  if (args.samples || args['max-usd']) {
    err(`overrides: samples=${panel.samples} maxUsd=${panel.maxUsd}`);
  }

  const engines = new Map();
  for (const spec of panel.engines) {
    const identity = engineIdentity(spec);
    if (engines.has(identity)) continue;
    if (spec.via === 'browser') {
      const { createBrowserEngine } = await import('../src/citations/browser/engine.js');
      engines.set(identity, createBrowserEngine({ engineName: spec.engine, env }));
      continue;
    }
    if (spec.engine === 'mock') {
      engines.set(identity, createMockEngine({ fixtures: panel.mockFixtures ?? {} }));
    } else if (spec.engine === 'perplexity') {
      // Presence only, never the value — the same rule doctor applies to tokens.
      if (!env.PERPLEXITY_API_KEY) {
        err(`engine ${identity} needs PERPLEXITY_API_KEY in the environment`);
        return 2;
      }
      engines.set(identity, createPerplexityEngine({ apiKey: env.PERPLEXITY_API_KEY, model: spec.model ?? 'sonar' }));
    } else {
      err(`unknown engine: ${spec.engine}`);
      return 2;
    }
  }

  try {
    const result = await runEpoch(panel, { dir, engines, delayMs: 250 });
    if (args.json) {
      out(JSON.stringify(result, null, 2));
    } else {
      for (const cell of result.cells) {
        const line = describeChange(
          { rate: cell.rate, ci_low: cell.ci_low, ci_high: cell.ci_high, n: cell.n },
          cell.baseline ? { rate: cell.baseline.rate, ci_low: cell.baseline.ci_low, ci_high: cell.baseline.ci_high, n: null } : null,
        );
        out(`${cell.cell_id} — ${line} [${cell.classification}]`);
      }
      out(`epoch ${result.epochId}: estimated spend $${result.spentEstimateUsd.toFixed(4)} of $${result.maxUsd} cap`);
    }
    if (result.aborted) {
      err(`budget abort before the next call (spent $${result.aborted.spent.toFixed(4)}, next estimate $${result.aborted.nextEstimate.toFixed(4)}, cap $${result.aborted.maxUsd}); partial tallies below the interpretation minimum report insufficient_data`);
      return 2;
    }
    const declined = result.cells.filter((c) => c.classification === 'declined');
    if (declined.length > 0) {
      err(`${declined.length} cell${declined.length === 1 ? '' : 's'} declined with complete evidence`);
      return 1;
    }
    return 0;
  } catch (cause) {
    if (cause instanceof EngineError) { err(cause.message); return 2; }
    throw cause;
  }
}
