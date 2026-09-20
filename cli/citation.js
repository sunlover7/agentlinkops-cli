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
import { resolve, join } from 'node:path';

import { parseArgs } from './args.js';
import { loadPanel, runEpoch } from '../src/citations/runner.js';
import { engineIdentity, panelLocaleContext } from '../src/citations/contract.js';
import { createMockEngine, createPerplexityEngine, EngineError } from '../src/citations/adapter.js';
import { describeChange } from '../src/citations/stats.js';

const USAGE = `agentlinkops citation — AI citation watches in this repository

  agentlinkops citation panel --domain HOST --brand NAME [--topic TOPIC]
                                            [--prompt QUESTION | --research FILE --limit N] [--competitors FILE]
                                            [--engine mock|chatgpt:web-own-browser|google-aio]
                                            [--locale en-US] [--country US] [--out PANEL.json]
                                            write editable prompt suggestions; mock is the default
  agentlinkops citation run PANEL.json [--dir DIR] [--samples N] [--max-usd USD] [--json]
                                            run one fixed-n epoch over a panel; evidence and
                                            tallies land under .agentlinkops/citations/
  agentlinkops citation run PANEL.json --engine chatgpt:web-own-browser
                                            measure the consumer UI through Camoufox
                                            (dedicated account, personal cadence; evidence
                                            includes a screenshot of every answer)
  agentlinkops citation sweep PANEL.json --max-usd USD --out INVENTORY.json [--dir DIR]
                                            run a bounded epoch and freeze its retained evidence
  agentlinkops citation inventory PANEL.json --out INVENTORY.json [--epoch ID] [--dir DIR]
                                            freeze an existing panel epoch without new calls
  agentlinkops citation gap INVENTORY.json --out GAP.json
                                            compare mentions and citations within this dataset
  agentlinkops citation export-sources INVENTORY.json --niche ID --niche-label TEXT
                                            --consent-ref REF --attest-owned --out SOURCES.json
                                            export held library candidates; no publication
  agentlinkops citation report PANEL.json [--out FILE] [--dir DIR] [--last N]
                                            render the latest epoch as a self-contained
                                            HTML report: trends, screenshots inline,
                                            Wilson intervals, honest classifications
  agentlinkops citation watch PANEL.json --cadence weekly|daily|hourly|monthly
                                            [--webhook URL] [--out REPORT.html]
                                            register a cron entry that runs the epoch
                                            and generates the report on schedule
  agentlinkops citation watch --list         list registered citation watches
  agentlinkops citation watch --remove NAME  remove a registered watch
  agentlinkops citation alert PANEL.json [--webhook URL --report REPORT.html]
                                            check the latest epoch for declines;
                                            logs an alert line if any cell declined
  agentlinkops citation login ENGINE         open a browser, log in once, save the session
                                            (the engine adapter uses it on every run)
  agentlinkops citation logout ENGINE        remove a saved session
  agentlinkops citation sessions            list saved engine sessions
  agentlinkops citation sync [--dir DIR] [--evidence]  push local epoch rows to the hosted
                                            API (requires agentlinkops connect first)
                                            --evidence also uploads retained answer text;
                                            screenshot bytes remain local
  agentlinkops citation doctor               check local installation and browser dependencies
  agentlinkops citation help                 this help

Panel (JSON): targets (domain or url, brand, aliases), prompts, engines
([{ "engine": "mock" | "perplexity", "model": "…" }]), optional samples and maxUsd.
Live engines need the matching environment credential (PERPLEXITY_API_KEY); the mock
engine runs everything at zero cost. Every run states its estimated spend, and the
cap reserves estimated cost before each call. A supplier charge above that estimate
is recorded as an overrun and stops subsequent calls.

Output language: citation RATE with a Wilson interval and n, classified against the
previous epoch as declined, grown or not_distinguishable — never "removed", never
"stable", and insufficient_data when n is too thin to interpret.`;

export async function citationMain(argv = [], { cwd = process.cwd(), out = console.log, err = console.error, env = process.env } = {}) {
  const args = parseArgs(argv, ['prompt', 'alias']);
  const command = args._[0] ?? 'help';
  if (command === 'help' || args.help) { out(USAGE); return 0; }
  if (command === 'doctor') {
    const { doctorMain } = await import('./doctor.js');
    return doctorMain(args._.slice(1), { cwd, out, err, env });
  }
  if (command === 'panel') {
    const { buildStarterPanel, selectResearchPrompts } = await import('../src/citations/panel-builder.js');
    const { readFile, writeFile } = await import('node:fs/promises');
    try {
      if (args.research && args.prompt) throw new Error('Use either --research or --prompt');
      const researched = args.research ? selectResearchPrompts(JSON.parse(await readFile(resolve(cwd, args.research), 'utf8')), { limit: args.limit === undefined ? 50 : Number(args.limit) }) : undefined;
      const competitors = args.competitors ? JSON.parse(await readFile(resolve(cwd, args.competitors), 'utf8')) : [];
      const selected = args.engine ?? 'mock';
      const [engine, via] = selected.split(':');
      if (!['mock', 'chatgpt', 'grok', 'duck', 'google-aio'].includes(engine) || (via && via !== 'web-own-browser')) throw new Error('unsupported panel engine');
      if (['chatgpt', 'grok'].includes(engine) && via !== 'web-own-browser') throw new Error('browser engines require :web-own-browser');
      const panel = buildStarterPanel({ domain: args.domain, brand: args.brand, topic: args.topic, aliases: args.alias ?? [],
        competitors, engines: [{ engine, via: via ? 'browser' : 'api' }], locale: args.locale ?? 'en-US', country: args.country,
        samples: args.samples === undefined ? 10 : Number(args.samples), maxUsd: args['max-usd'] === undefined ? 1 : Number(args['max-usd']),
        prompts: researched ?? args.prompt?.map((text, index) => ({ id: `p${index + 1}`, text })),
      });
      const json = JSON.stringify(panel, null, 2) + '\n';
      if (args.out) { await writeFile(resolve(cwd, args.out), json, { flag: 'wx' }); out(`panel written: ${args.out}`); }
      else out(json);
      err('Prompts are editable suggestions, not observed search demand. Review them before using a live engine.');
      return 0;
    } catch (cause) { err(cause.code === 'EEXIST' ? 'panel output already exists; choose another path' : cause.message); return 2; }
  }
  if (['sweep', 'inventory', 'gap', 'export-sources'].includes(command)) {
    const { readFile, open, unlink } = await import('node:fs/promises');
    const { freezeCitationInventory, citationGap, exportCitationSources } = await import('../src/citations/inventory.js');
    let output;
    try {
      if (!args._[1] || typeof args.out !== 'string') throw new Error(`${command} requires an input file and --out FILE`);
      if (command === 'sweep' && (args['max-usd'] === undefined || !Number.isFinite(Number(args['max-usd'])) || Number(args['max-usd']) <= 0)) throw new Error('sweep requires an explicit positive --max-usd ceiling');
      // Reserve an exclusive output before a sweep can incur any measurement cost.
      output = await open(resolve(cwd, args.out), 'wx', 0o600);
      let result; let code = 0;
      if (command === 'gap' || command === 'export-sources') {
        const inventory = JSON.parse(await readFile(resolve(cwd, args._[1]), 'utf8'));
        result = command === 'gap' ? citationGap(inventory) : await exportCitationSources(inventory, {
          niche: { id: args.niche, label: args['niche-label'] }, consentRef: args['consent-ref'], excludedInputsAttested: args['attest-owned'] === true,
        });
      } else {
        const panel = await loadPanel(resolve(cwd, args._[1]));
        let epochId = args.epoch;
        if (command === 'sweep') {
          panel.maxUsd = Number(args['max-usd']);
          let run;
          code = await citationMain(['run', args._[1], '--dir', args.dir ?? '.agentlinkops', '--max-usd', String(args['max-usd']), '--json'], { cwd, env, err, out: value => { run = JSON.parse(value); } });
          if (!run?.epochId) throw new Error('Sweep did not produce an epoch');
          epochId = run.epochId;
        }
        result = await freezeCitationInventory({ dir: resolve(cwd, args.dir ?? '.agentlinkops'), panel, epochId });
      }
      await output.writeFile(JSON.stringify(result, null, 2) + '\n'); await output.close(); output = null;
      out(`${command} written: ${args.out}`); return code;
    } catch (cause) {
      if (output) { await output.close(); await unlink(resolve(cwd, args.out)).catch(() => {}); }
      err(cause.code === 'EEXIST' ? 'Output already exists; choose another path' : cause.message); return 2;
    }
  }
  if (command === 'alert') {
    const panelPath = args._[1];
    if (!panelPath) { err('citation alert needs a panel file'); return 2; }
    const { readFile } = await import('node:fs/promises');
    const dir = resolve(cwd, args.dir ?? '.agentlinkops');
    const { latestPanelEpoch } = await import('../src/citations/report.js');
    const panel = await loadPanel(resolve(cwd, panelPath));
    const cells = await latestPanelEpoch({ dir, panel });
    if (!cells) { out('no epochs to check for this panel'); return 0; }
    const { shouldAlert } = await import('../src/citations/alert.js');
    if (shouldAlert(cells)) {
      const declined = cells.filter((c) => c.classification === 'declined');
      err(`ALERT: ${declined.length} cell${declined.length === 1 ? '' : 's'} declined:`);
      for (const c of declined) err(`  ${c.cell_id}: rate ${c.rate?.toFixed(2) ?? 'unknown'} (was ${c.baseline?.rate?.toFixed(2) ?? 'n/a'})`);
      if (args.webhook) {
        const { sendAlertWebhook } = await import('../src/citations/alert.js');
        try {
          const htmlPath = resolve(cwd, args.report ?? join(dir, 'citations', 'report.html'));
          await sendAlertWebhook({ endpoint: args.webhook, epochId: cells[0].epoch_id, cells, htmlPath });
          out('citation decline report delivered');
        } catch { err('citation webhook delivery failed'); return 2; }
      }
      return 1; // exit 1 = actionable, same convention as link checks
    }
    out('no declines detected');
    return 0;
  }
  if (command === 'watch') {
    const { registerWatch, listWatches, removeWatch } = await import('../src/citations/watch.js');
    if (args.list) {
      const watches = await listWatches();
      if (watches.length === 0) { out('no citation watches registered'); return 0; }
      for (const w of watches) out(`${w.panel}  ${w.cron}`);
      return 0;
    }
    if (args.remove) {
      const result = await removeWatch(args.remove);
      out(`removed watch: ${result.removed}`);
      return 0;
    }
    const panelPath = args._[1];
    if (!panelPath) { err('citation watch needs a panel file (or --list / --remove)'); return 2; }
    const cadence = args.cadence ?? 'weekly';
    try {
      const result = await registerWatch({ panelPath: resolve(cwd, panelPath), cadence, dir: resolve(cwd, args.dir ?? '.agentlinkops'), out: args.out ? resolve(cwd, args.out) : undefined, webhook: args.webhook });
      out(`citation watch registered: ${result.panelPath}`);
      out(`cadence: ${result.cadence} (${result.next})`);
      out(`cron: ${result.cronSpec}`);
      return 0;
    } catch (cause) {
      err(cause.message);
      return 2;
    }
  }
  if (command === 'login') {
    const engineName = args._[1];
    if (!engineName) { err('citation login needs an engine name (e.g. chatgpt)'); return 2; }
    const { loginEngine } = await import('../src/citations/login.js');
    try {
      const result = await loginEngine({ engineName });
      out(`session saved: ${result.sessionPath}`);
      out(`cookies: ${result.cookies}, origins: ${result.origins}, login detected: ${result.loggedIn}`);
      return 0;
    } catch (cause) { err(cause.message); return 2; }
  }
  if (command === 'logout') {
    const engineName = args._[1];
    if (!engineName) { err('citation logout needs an engine name'); return 2; }
    const { logoutEngine } = await import('../src/citations/login.js');
    const result = await logoutEngine({ engineName });
    out(result.removed ? `session removed: ${engineName}` : `no session found for ${engineName}`);
    return 0;
  }
  if (command === 'sessions') {
    const { listSessions } = await import('../src/citations/login.js');
    const sessions = await listSessions();
    if (sessions.length === 0) { out('no saved sessions'); return 0; }
    for (const s of sessions) out(s);
    return 0;
  }
  if (command === 'sync') {
    const dir = resolve(cwd, args.dir ?? '.agentlinkops');
    const { createClient } = await import('./client.js');
    const { cloudConnection } = await import('./connection.js');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      const { loadConfig } = await import('./config.js');
      const config = await loadConfig({ cwd });
      const connection = cloudConnection(config, env);
      if (!connection.token) { err('citation sync needs a cloud connection (run agentlinkops connect)'); return 2; }
      const { syncEpochs } = await import('../src/citations/sync.js');
      const client = createClient(connection);
      const result = await syncEpochs({
        dir,
        api: async (path, init) => client.callCommand(path.replace('/v1/commands/', ''), init.body),
        workspaceId: connection.workspaceId,
        projectId: connection.projectId,
      });
      out(`synced: ${result.synced}/${result.total} epoch rows${result.errors ? `, ${result.errors} errors` : ''}`);
      if (result.normalized_rates) out(`${result.normalized_rates} legacy rates normalized: ${result.normalization}`);
      if (args.evidence) {
        const { syncEvidence } = await import('../src/citations/sync.js');
        const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        const evidence = await syncEvidence({ dir, projectId: connection.projectId, cliVersion: manifest.version,
          api: async (path, init) => client.callCommand(path.replace('/v1/commands/', ''), init.body) });
        out(`evidence synced: ${evidence.synced}/${evidence.total}, ${evidence.skipped} skipped, ${evidence.errors} errors; screenshot bytes remain local`);
        for (const [reason, count] of Object.entries(evidence.reasons)) out(`${reason}: ${count}`);
        if (evidence.errors || evidence.skipped) return 2;
      }
      return result.errors ? 1 : 0;
    } catch (cause) { err(cause.message); return 2; }
  }
  if (command === 'report') {
    const panelPath = args._[1];
    if (!panelPath) { err('citation report needs a panel file'); return 2; }
    const dir = resolve(cwd, args.dir ?? '.agentlinkops');
    const { generateReport } = await import('../src/citations/report.js');
    const { readFile, writeFile: wf } = await import('node:fs/promises');
    const panel = await loadPanel(resolve(cwd, panelPath));
    const last = args.last === undefined ? 1 : Number(args.last);
    if (args.last === true || !Number.isSafeInteger(last) || last < 1 || last > 30) {
      err('citation report --last must be an integer from 1 to 30'); return 2;
    }
    const { panelEpochs } = await import('../src/citations/report.js');
    const history = (await panelEpochs({ dir, panel })).slice(0, last);
    if (!history.length) { err('no epochs found for this panel — run an epoch first'); return 2; }
    const latestEpochId = history[0][0].epoch_id;
    const html = await generateReport({ dir, epochId: latestEpochId, panel, history });
    const outPath = args.out ? resolve(cwd, args.out) : join(dir, 'citations', `report-${latestEpochId.slice(0, 15)}.html`);
    const { dirname, join: j } = await import('node:path');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(outPath), { recursive: true });
    await wf(outPath, html, 'utf8');
    out(`report written: ${outPath} (${Math.round(html.length / 1024)} KB, self-contained)`);
    return 0;
  }
  if (!['run', 'report', 'watch', 'alert', 'login', 'logout', 'sessions', 'sync'].includes(command)) { err(`unknown citation command: ${command}`); err(USAGE); return 2; }

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
    } else if (spec.engine === 'google-aio') {
      // Live observations require explicit provider configuration; offline runs use mock.
      const { createGoogleAioEngine } = await import('../src/citations/adapter.js');
      const creds = env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD
        ? { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }
        : null;
      if (!creds) { err('google-aio requires DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD; select mock for offline runs'); return 2; }
      const context = panelLocaleContext(panel, spec);
      engines.set(identity, createGoogleAioEngine({ credentials: creds, country: context.country, languageCode: context.locale.split('-')[0] }));
    } else if (spec.engine === 'duck') {
      // Self-hosted Duck2api on the VPS: the whole Claude family plus GPT-5.6
      // anonymously through duck.ai. Localhost endpoint, no key.
      const { createOpenAiCompatibleEngine } = await import('../src/citations/adapter.js');
      engines.set(identity, createOpenAiCompatibleEngine({
        baseUrl: env.DUCK2API_URL ?? 'http://127.0.0.1:8090/v1',
        model: spec.model ?? 'claude-haiku-4-5',
        providerLabel: 'duck-anon',
      }));
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
    const result = await runEpoch(panel, { dir, engines, delayMs: 250, err });
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
