import { commandsMain } from './commands.js';
import { agentMain } from './agent-setup.js';
import { setupPlanMain } from './setup-plan.js';
import {parseArgs as parseArguments} from './args.js';
// The `agentlinkops` command surface (`linktrail` remains an alias for the pilot compatibility
// window). Local commands need no account and no network beyond the
// pages being checked.
import { readFile, writeFile, mkdir, appendFile, open, unlink, rename, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, ConfigError, DEFAULTS, LEGACY_DIR, findRoot, resolveDirName, setNoticeSink } from './config.js';
import { readEnv } from './env.js';
import { readLedger, mutateLedger, normalizeEntry, newId, serializeLedger } from './ledger.js';
import { readObservations, appendObservations, writeObservations, compactionPlan, dedupeObservations } from './mirror.js';
import { readState, writeState, lastCheckedMap, selectChanged, applyRun } from './state.js';
import { runCheck, selectEntries, dueEntries, summarize } from './check.js';
import { checkToFile, adoptLocalResult } from './local-result.js';
import { disagreements, transitions } from './status.js';
import { readImport, parseMap } from './import.js';
import { freezeDataset, renderReport, datasetDigest } from './report.js';
import { createClient, CloudError } from './client.js';
import { cloudConnection, connectMain, keySetup } from './connection.js';
import { syncPlan, pushExpectations, pullEvents, cloudObservationRows, watchIndex, pullTargetEvents } from './sync.js';
import { SUPPLIER_NAMES } from './adapters/suppliers.js';
import { fleetSummary, renderFleet } from './fleet.js';
import { platformAggregate, classifyObservation, renderPlatforms, attachToCandidates, PLATFORM_CLASSES } from './platforms.js';
import { contextMain } from './context.js';
import { verifyDelivery, persistPulledHistory } from './delivery.js';
import { writeReceipt, readReceipts, receiptHistory } from './receipts.js';
import { attachReceiptPerformance } from './receipt-performance.js';
import { contextPaths, loadContextConfig, readGscRows } from '../src/context/gsc.js';
import { readGa4Rows } from '../src/context/ga4.js';
import { mixMain } from './mix.js';
import { doctorMain } from './doctor.js';
import { gscLinksMain } from './gsc-browser.js';
import { skillMain, NUDGE } from './skill.js';
import { citationMain } from './citation.js';

const USAGE = `agentlinkops — a backlink ledger that lives in your repository

  agentlinkops skill [--url]            print the agent reference; read it in full once per session
                                            before the first AgentLinkOps call
  agentlinkops init                   create .agentlinkops/ here
  agentlinkops migrate                rename an existing .linktrail/ to .agentlinkops/ (receipt; never merges)
  agentlinkops setup --plan --goal verify-links|prepare-campaign|build-content
                [--mode local|hosted|external]  read-only setup plan; no account required
  agentlinkops add --source URL --target URL [--intent wanted|expected] [--scope …]
                [--anchor TEXT] [--rel a,b] [--ref TEXT] [--tag t --tag t] [--note TEXT]
  agentlinkops import FILE --target DOMAIN [--from SUPPLIER] [--map source=COL,target=COL]
                [--exact-url] [--no-subdomains] [--generated-at ISO] [--json]
  agentlinkops adopt CRM.sqlite [--scope exact|domain] [--write]
  agentlinkops fleet --project NAME=LEDGER [--project …] [--observations-of NAME=FILE] [--json]
  agentlinkops platforms [HOST] [--observations FILE]… [--benchmark FILE]… [--seed FILE]…
                [--for-candidates FILE] [--json]
  agentlinkops context COMMAND…               first-party search context and site profile
                                            (status/manual/focus/gsc/profile; no account needed —
                                            run "agentlinkops context help" for every subcommand)
  agentlinkops gsc-links --property PROPERTY --session SESSION --out FILE.csv
                                            export GSC links through your signed-in browser
  agentlinkops mix [--lane-file FILE]… [--save FILE] [--against FILE] [--json]
                                            referring-domain mix over this ledger (no account)
  agentlinkops citation run PANEL.json [--dir DIR] [--samples N] [--max-usd USD] [--json]
                                            one fixed-n AI-citation epoch; evidence under
                                            .agentlinkops/citations/; live engines need
                                            PERPLEXITY_API_KEY, the mock engine costs nothing
  agentlinkops receive --body FILE --headers FILE   signed notification; authenticated pull
  agentlinkops connect --workspace ID --project-id ID [--origin URL] [--selection FILE]
  agentlinkops tools [TOOLSET] [--json] [--refresh]   cloud commands by toolset (offline snapshot;
                                            --refresh reads the live catalog)
  agentlinkops describe NAME [--examples] [--output-schema] [--json]  one command's exact schema
  agentlinkops call NAME [--args JSON | --file FILE | --set PATH=VALUE ...] [--dry-run] [-y]
                                            run a cloud command (retired names still resolve)
  agentlinkops agent setup [--client ID ...] [--scope project|user] [--origin URL] [--dry-run]
                                            install the skill pack and the right MCP view for each
                                            detected agent client (Claude Code, Codex, Cursor,
                                            Gemini CLI, Hermes); stores no credential
  agentlinkops agent status                 what is installed where
  agentlinkops sync [--push-only] [--pull-only] [--dry-run] [--include-wanted]
                                            AGENTLINKOPS_TOKEN or AGENTLINKOPS_API_KEY
  agentlinkops check [--filter TEXT] [--all] [--json] [--fail-on-unknown]
  agentlinkops doctor                       verify ledger, verifier, cloud reachability, token
  agentlinkops check --source URL --target URL [--scope exact] [--json] [--out FILE]
                                            one local result; no ledger or account
  agentlinkops adopt-result FILE [--intent wanted|expected]  save result to local ledger
  agentlinkops receipt add --file CLAIM.json   project.site declares public site hosts
  agentlinkops receipt history [--performance FILE.json]  claims, history and optional dated context
  agentlinkops status [--json]
  agentlinkops diff [--json]
  agentlinkops report [--out FILE] [--title T] [--brand B] [--as-of ISO]
                [--include-notes] [--include-retired] [--digest-only]
  agentlinkops fmt
  agentlinkops compact [--apply]

Suppliers: ${SUPPLIER_NAMES.join(', ')}
A preset is a convenience over --map, never a requirement.

Exit codes: 0 every expected link present · 1 an expected link observed absent with complete
evidence · 2 usage, configuration or ledger error. An unknown never fails.

Names: \`linktrail\` still runs this CLI, LINKTRAIL_* variables are still read, and an existing
.linktrail/ directory is still used, each with a one-line notice, until the DP-0029 cutover.`;

const parseArgs = argv => parseArguments(argv,["tag", "project", "observations-of", "observations", "benchmark", "seed"],{tag:[]});

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const readJsonl = async path => (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

function reportProblems(problems, what, out) {
  if (!problems.length) return;
  out(`\n${problems.length} ${what} could not be read, and none of them was dropped silently:`);
  for (const problem of problems.slice(0, 20)) out(`  line ${problem.line}${problem.id ? ` (${problem.id})` : ''}: ${problem.reason}`);
  if (problems.length > 20) out(`  … and ${problems.length - 20} more`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  if (argv[0] === 'gsc-links') return await gscLinksMain(argv, { cwd, out });
  // Citation watches keep their own files under .agentlinkops/citations/ and never
  // touch the link ledger, so they dispatch before its requirement like context does.
  if (argv[0] === 'citation') return await citationMain(argv.slice(1), { cwd, out, err });
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';
  if (command === 'help' || args.help) { out(USAGE); return 0; }
  // Compatibility notices (old variable names, old directory name) share the error stream, so a
  // `--json` reader on stdout never sees them.
  setNoticeSink(err);

  let syncLock = null;
  try {
    if (command === 'setup') return await setupPlanMain(argv, { cwd, out });
    if (command === 'tools' || command === 'describe' || command === 'call') return await commandsMain(argv, { cwd, out, err });
    if (command === 'skill') return await skillMain(argv, { out });
    if (command === 'agent') return await agentMain(argv, { cwd, out, err });
    if (command === 'connect') {
      if (args._.length !== 1 || args.tag.length || Object.keys(args).some(key => !['_', 'tag', 'origin', 'workspace', 'project-id', 'selection'].includes(key))) throw new ConfigError('connect --workspace ID --project-id ID [--origin URL] [--selection FILE]');
      return await connectMain(args, { cwd, out });
    }
    if (command === 'check' && (args.source !== undefined || args.target !== undefined)) {
      if (typeof args.source !== 'string' || typeof args.target !== 'string') throw new ConfigError('check requires both --source URL and --target URL');
      const allowed = new Set(['_', 'source', 'target', 'scope', 'json', 'out']);
      if (Object.keys(args).some(key => key !== 'tag' && !allowed.has(key)) || args.tag.length || args._.length !== 1) throw new ConfigError('unsupported option for a single local check');
      if (args.out !== undefined && (typeof args.out !== 'string' || !args.out.trim())) throw new ConfigError('--out requires a file path');
      const result = await checkToFile({ source: args.source, target: args.target, scope: args.scope }, args.out ? resolve(cwd, args.out) : null);
      out(args.json ? JSON.stringify(result, null, 2) : `${result.observation.state}  ${result.observation.reason}  ${result.checked_at}${args.out ? `  saved ${args.out}` : ''}`);
      return 0;
    }
    if (command === 'init') {
      // A repository that already has the old directory gets a migrate, not a second directory:
      // creating `.agentlinkops/` beside `.linktrail/` would shadow the existing ledger.
      const existing = await resolveDirName(cwd);
      if (existing.legacy) throw new ConfigError(`${join(cwd, LEGACY_DIR)} already exists; run \`agentlinkops migrate\` to rename it to ${DEFAULTS.dir}/ instead of creating a second directory.`);
      const config = await loadConfig({ cwd, root: cwd });
      await mkdir(config.dir, { recursive: true });
      await writeFile(`${config.dir}/config.json`, `${JSON.stringify({ project: null, cloud: null, paths: {}, defaults: {} }, null, 2)}\n`, 'utf8');
      await mkdir(dirname(config.paths.ledger), { recursive: true });
      await writeFile(config.paths.ledger, '', { flag: 'wx' }).catch(() => {});
      out(`created ${config.dir}`);
      out(NUDGE);
      return 0;
    }

    if (command === 'migrate') {
      // Renames `.linktrail/` to `.agentlinkops/`, and does nothing else: no merge, no delete, no
      // rewrite of the files inside. A customer's repository is not ours to reorganise beyond the
      // one move they asked for, and the receipt names what moved so the commit can say so too.
      if (args._.length !== 1 || Object.keys(args).some(key => !['_', 'tag', 'json'].includes(key)) || args.tag.length) throw new ConfigError('migrate [--json]');
      const root = await findRoot(cwd, LEGACY_DIR) ?? cwd;
      const from = join(root, LEGACY_DIR), to = join(root, DEFAULTS.dir);
      const isDir = async path => stat(path).then(info => info.isDirectory(), () => false);
      if (!await isDir(from)) {
        if (await isDir(to)) { out(args.json ? JSON.stringify({ migrated: false, reason: 'already_migrated', dir: to }) : `nothing to migrate: ${to} is already in use`); return 0; }
        throw new ConfigError(`no ${LEGACY_DIR}/ directory found at or above ${cwd}; nothing to migrate.`);
      }
      if (await isDir(to)) throw new ConfigError(`${to} already exists; nothing was moved. Reconcile the two directories by hand — migrate never merges.`);
      if (await stat(join(from, 'sync.lock')).then(() => true, () => false)) throw new ConfigError(`${from} is locked by a running sync; retry after it finishes.`);
      const files = (await readdir(from, { recursive: true })).filter(name => !/(^|\/)\._/u.test(name)).sort();
      await rename(from, to);
      const receipt = { migrated: true, from, to, files, at: new Date().toISOString(),
        next: `commit the rename; update .gitignore, CI and any script that names ${LEGACY_DIR}/` };
      if (args.json) { out(JSON.stringify(receipt, null, 2)); return 0; }
      out(`moved ${from} -> ${to} (${plural(files.length, 'file')}; nothing merged or deleted)`);
      for (const file of files.slice(0, 20)) out(`  ${file}`);
      if (files.length > 20) out(`  … and ${files.length - 20} more`);
      out(receipt.next);
      return 0;
    }

    if (command === 'import') {
      const path = args._[1];
      if (!path || !args.target) { err('agentlinkops import FILE --target DOMAIN'); return 2; }
      const result = await readImport(path, {
        supplier: args.from === true ? 'csv' : (args.from ?? 'csv'),
        map: parseMap(args.map), target: args.target,
        targetKind: args['exact-url'] ? 'exact_url' : 'domain',
        includeSubdomains: !args['no-subdomains'],
        supplierGeneratedAt: args['generated-at'] === true ? null : (args['generated-at'] ?? null),
      });
      if (result.error) { err(result.error); return 2; }
      if (args.json) { out(JSON.stringify(result.accepted.map(candidate => JSON.stringify(candidate)).join('\n'))); return 0; }
      out(`mapped ${Object.entries(result.mapping).map(([field, column]) => `${field}="${column}"`).join(', ')}`);
      if (result.unclaimed.length) out(`kept as supplier metrics: ${result.unclaimed.join(', ')}`);
      out(`\n${JSON.stringify(result.counts)}`);
      // One reason accounting for nearly every row means the MAPPING is wrong, not the data,
      // and saying so beats making the reader infer it from two thousand identical lines.
      if (result.counts.read && result.counts.accepted === 0) {
        out(`\nNOTHING imported. When every row fails the same way the column mapping is usually wrong, not the file.`);
        out(`  columns present: ${result.header.join(' | ')}`);
        out(`  name them explicitly with --map source=<column>,target=<column>`);
      }
      for (const group of result.reasons.slice(0, 10)) out(`  ${String(group.count).padStart(6)}  ${group.reason}  (first at row ${group.example_row})`);
      if (result.reasons.length > 10) out(`  … and ${result.reasons.length - 10} more kinds`);
      // Writing candidates into the repository mirror is `sync`'s job (T05): a preview that
      // wrote files would make a dry run indistinguishable from a real one.
      out('\npreview only — nothing was written');
      return 0;
    }

    if (command === 'adopt') {
      const path = args._[1];
      if (!path) { err('agentlinkops adopt CRM.sqlite'); return 2; }
      // node:sqlite is loaded only here: importing it prints Node's experimental warning on stderr,
      // and every other command (including the ones an agent pipes) must stay quiet.
      const { readCrm } = await import('./adapters/sqlite-crm.js');
      const result = readCrm(path, { defaultScope: args.scope === true ? 'exact' : (args.scope ?? 'exact') });
      const byIntent = result.entries.reduce((acc, entry) => { acc[entry.intent] = (acc[entry.intent] ?? 0) + 1; return acc; }, {});
      out(`${result.entries.length} entr(ies): ${JSON.stringify(byIntent)}`);
      // What was assumed, named. A status vocabulary this adapter does not know is treated as
      // active, and the operator should see the list rather than find out from a watch.
      for (const [table, list] of Object.entries(result.assumed_active)) {
        if (list.length) out(`  ${table} statuses treated as active: ${list.join(', ')}`);
      }
      for (const entry of result.unmapped.slice(0, 20)) out(`  ${entry.table}/${entry.id}: ${entry.reason}`);
      if (!args.write) { out('\npreview only — pass --write to append to the ledger'); return 0; }
      const ledgerPath = (await loadConfig({ cwd })).paths.ledger;
      const existing = await readLedger(ledgerPath);
      if (existing.missing) { err('no ledger here — run `agentlinkops init` first'); return 2; }
      const known = new Set(existing.entries.map(entry => entry.id));
      const added = result.entries.filter(entry => !known.has(entry.id));
      await mutateLedger(ledgerPath, rows => {
        const ids = new Set(rows.map(row => row.id));
        return [...rows, ...result.entries.filter(row => !ids.has(row.id))];
      });
      out(`\nappended ${added.length}, skipped ${result.entries.length - added.length} already present`);
      return 0;
    }

    if (command === 'platforms') {
      // Explicit inputs, no ledger required: a placement agent asks this BEFORE anything is
      // pursued, from whatever verification results exist — ours, a customer's, or the seeds.
      const query = args._[1] ? String(args._[1]) : null;
      const aggregate = await platformAggregate({
        observations: args.observations ?? [],
        benchmark: args.benchmark ?? [],
        seed: args.seed ?? [],
      });
      if (args['for-candidates'] && args['for-candidates'] !== true) {
        const candidates = await readJsonl(String(args['for-candidates']));
        for (const row of attachToCandidates(candidates, aggregate)) out(JSON.stringify(row));
        return 0;
      }
      if (args.json) { out(JSON.stringify(query ? aggregate.platforms.find(row => row.platform.includes(query.replace(/^www\./u, ''))) ?? { platform: query, observations: 0, majority_class: null, claim: 'no_observations_unknown' } : aggregate, null, 1)); return 0; }
      return renderPlatforms(aggregate, query, out);
    }

    if (command === 'fleet') {
      // No config needed: the fleet is many repos, so every ledger path is named explicitly
      // and nothing is discovered from a cwd that only knows about one of them.
      const projects = (args.project ?? []).length ? args.project : (args._.slice(1).map(value => value));
      const pairs = projects.map(value => {
        const [name, path] = String(value).split('=');
        if (!name || !path) throw new ConfigError(`--project expects NAME=LEDGER_PATH, got "${value}"`);
        return { name, ledger: path };
      });
      if (!pairs.length) { err('agentlinkops fleet --project NAME=LEDGER [--project …]'); return 2; }
      const observationsOf = {};
      for (const value of [].concat(args['observations-of'] ?? [])) {
        const [name, path] = String(value).split('=');
        if (!name || !path) throw new ConfigError(`--observations-of expects NAME=FILE, got "${value}"`);
        observationsOf[name] = path;
      }
      const summary = await fleetSummary(pairs, { observationsOf });
      if (args.json) { out(JSON.stringify(summary, null, 1)); return 0; }
      return renderFleet(summary, out);
    }

    if (command === 'mix') {
      // The local referring-domain mix (DP-0003-T10): same ledger lanes the cloud report
      // accepts, no account. Flags after the command word, like context.
      return mixMain(argv.slice(argv.indexOf(command) + 1), { cwd, out, err });
    }
    if (command === 'context') {
      // DP-0017's context surface owns its config and files and needs no ledger, so it runs
      // before the ledger check below. contextMain parses its own argv; hand it everything
      // after the command word (found positionally, because flags may precede it).
      return await contextMain(argv.slice(argv.indexOf(command) + 1), { cwd, out, err });
    }
    if (command === 'doctor') {
      // Doctor must run exactly where the ledger cannot be trusted yet: its job is to name
      // what is broken, so it dispatches before the ledger requirement and inspects each
      // file itself. Takes no flags and repairs nothing. Awaited on purpose: a promise returned
      // from inside the try escapes the ConfigError handler below, and a disagreeing pair of
      // token spellings would surface as a stack trace instead of the exit-2 message.
      return await doctorMain(argv.slice(argv.indexOf(command) + 1), { cwd, out, err });
    }

    const config = await loadConfig({ cwd });
    if (['sync','receive','check','compact','adopt-result'].includes(command) && !(command === 'sync' && args['dry-run'])) {
      const lockPath = join(config.dir, 'sync.lock');
      try { syncLock = { handle: await open(lockPath, 'wx'), path: lockPath }; }
      catch (error) { if (error.code === 'ENOENT') throw new ConfigError('no ledger here — run `agentlinkops init` first'); if (error.code === 'EEXIST') throw new ConfigError('sync writer already locked; retry delivery after it finishes'); throw error; }
    }
    if (command === 'adopt-result') {
      if (args._.length !== 2 || Object.keys(args).some(key => !['_', 'intent', 'tag'].includes(key)) || args.tag.length) throw new ConfigError('adopt-result FILE [--intent wanted|expected]');
      const result = await adoptLocalResult(config, JSON.parse(await readFile(resolve(cwd, args._[1]), 'utf8')), { intent: args.intent ?? 'wanted' });
      out(JSON.stringify(result));
      return 0;
    }
    const ledger = await readLedger(config.paths.ledger);
    if (ledger.missing) { err(`no ledger at ${config.paths.ledger} — run \`agentlinkops init\``); return 2; }
    const observations = await readObservations(config.paths.observations);

    if (command === 'receipt') {
      if (args._[1] === 'history') {
        let history = receiptHistory(await readReceipts(config.paths.receipts), ledger.entries, observations.rows, await readState(config.paths.state));
        if (args.performance) {
          // Opt-in dated context beside a claim. It reads the saved GSC/GA4 context rows and
          // never edits the receipt, the ledger or the verification history.
          if (args.performance === true) throw new ConfigError('performance requires a JSON file');
          const spec = JSON.parse(await readFile(resolve(cwd, String(args.performance)), 'utf8'));
          const paths = contextPaths({ dir: config.dir, file: await loadContextConfig(config.dir) });
          const [gsc, ga4] = await Promise.all([readGscRows(paths.gsc), spec.ga4_property ? readGa4Rows(paths.ga4) : { rows: [], problems: [] }]);
          if (gsc.problems.length || ga4.problems.length) throw new ConfigError('performance context contains malformed rows');
          history = attachReceiptPerformance(history, spec, { gscRows: gsc.rows, ga4Rows: ga4.rows });
        }
        out(JSON.stringify(history, null, 2));
        return 0;
      }
      if (args._[1] !== 'add' || !args.file || args.file === true) throw new ConfigError('receipt add --file CLAIM.json | receipt history');
      const result = await writeReceipt(config, JSON.parse(await readFile(String(args.file), 'utf8')));
      out(JSON.stringify(result));
      return 0;
    }

    if (command === 'add') {
      const entry = normalizeEntry({
        intent: args.intent ?? 'wanted', source: args.source, target: args.target, scope: args.scope,
        expect: (args.anchor || args.rel) ? { anchor: args.anchor, rel: args.rel ? String(args.rel).split(',') : undefined } : undefined,
        cadence: args.cadence, ref: args.ref, tags: args.tag.length ? args.tag : undefined,
        note: args.note, added: new Date().toISOString().slice(0, 10),
      }, { assignId: true });
      if (ledger.entries.some(existing => existing.source === entry.source && existing.target === entry.target && existing.scope === entry.scope)) {
        err('an entry with the same source, target and scope is already in the ledger');
        return 2;
      }
      await mutateLedger(config.paths.ledger, rows => {
        if (rows.some(row => row.id === entry.id)) throw new Error('Duplicate ledger id.');
        return [...rows, entry];
      });
      out(entry.id);
      return 0;
    }

    if (command === 'report') {
      // `--as-of` is what makes a report reproducible: without it the current date is used and
      // the same ledger produces a different document tomorrow. The digest is over the DATASET,
      // so it is unchanged by a cosmetic edit to the template and changes the moment a figure does.
      const asOf = args['as-of'] === true ? null : (args['as-of'] ?? null);
      const dataset = freezeDataset(ledger.entries, observations.rows, {
        asOf: asOf ?? new Date().toISOString().slice(0, 10),
        title: args.title === true ? 'Backlink report' : (args.title ?? 'Backlink report'),
        includeNotes: args['include-notes'] === true,
        includeRetired: args['include-retired'] === true,
      });
      if (args['digest-only']) { out(datasetDigest(dataset)); return 0; }
      const html = renderReport(dataset, { brand: args.brand === true ? null : (args.brand ?? null) });
      if (args.out && args.out !== true) {
        await mkdir(dirname(String(args.out)), { recursive: true });
        await writeFile(String(args.out), html, 'utf8');
        out(`${dataset.totals.entries} link(s), digest ${datasetDigest(dataset)}`);
        out(`wrote ${args.out}`);
        if (!asOf) out('NOT reproducible: no --as-of, so the prepared date is today and tomorrow differs.');
        if (dataset.include_notes) out('Private notes are IN this document.');
        return 0;
      }
      out(html);
      return 0;
    }

    if (command === 'fmt') {
      reportProblems(ledger.problems, 'ledger line(s)', out);
      if (ledger.problems.length) return 2;
      const before = await readFile(config.paths.ledger, 'utf8');
      const after = serializeLedger(ledger.entries);
      if (before !== after) { await mutateLedger(config.paths.ledger, rows => rows); out(`formatted ${plural(ledger.entries.length, 'entry', 'entries')}`); }
      else out('already formatted');
      return ledger.problems.length ? 2 : 0;
    }

    if (command === 'compact') {
      if (observations.problems.length) throw new ConfigError('repair malformed observation history before compacting');
      const plan = compactionPlan(observations.rows);
      out(`${plural(plan.dropped.length, 'repeated observation')} would be collapsed, ${plan.keep.length} kept`);
      if (!args.apply) { out('nothing was written — pass --apply'); return 0; }
      await writeObservations(config.paths.observations, plan.keep);
      out(`wrote ${plan.keep.length}`);
      return 0;
    }

    if (command === 'status' || command === 'diff') {
      const found = command === 'status' ? disagreements(ledger.entries, observations.rows) : transitions(observations.rows);
      if (args.json) { out(JSON.stringify(found, null, 1)); return 0; }
      reportProblems(ledger.problems, 'ledger line(s)', out);
      if (command === 'diff') {
        if (!found.length) out('no state changes recorded');
        for (const change of found.slice(0, 100)) out(`  ${change.at.slice(0, 10)}  ${change.from} -> ${change.to}  ${change.id}`);
        return 0;
      }
      const groups = { appeared: 'appeared', lost: 'LOST', cannot_say: 'cannot say', never_checked: 'never checked' };
      for (const [kind, label] of Object.entries(groups)) {
        const rows = found.filter(item => item.kind === kind);
        if (!rows.length) continue;
        out(`\n${label} (${rows.length})`);
        for (const item of rows.slice(0, 50)) {
          out(`  ${item.entry.id}  ${item.entry.source}${item.row ? `  [${item.row.reason}]` : ''}`);
        }
      }
      if (!found.length) out('intent and observations agree on every entry');
      return 0;
    }

    if (command === 'sync' || command === 'receive') {
      if (ledger.problems.length) { reportProblems(ledger.problems, 'ledger line(s)', err); return 2; }
      if (command === 'receive') {
        if (!args.body || !args.headers) throw new ConfigError('receive --body RAW_BODY_FILE --headers HEADERS_JSON_FILE');
        verifyDelivery({ body: await readFile(String(args.body), 'utf8'), headers: JSON.parse(await readFile(String(args.headers), 'utf8')),
          secret: readEnv(process.env, 'WEBHOOK_SECRET').value, workspaceId: config.cloud?.workspaceId });
        args['pull-only'] = true;
        args['push-only'] = false;
      }
      const state = await readState(config.paths.state);
      if (args['pull-only'] && args['push-only']) throw new ConfigError('Choose --pull-only or --push-only.');
      const selection = { includeWanted: args['include-wanted'] === true, ledgerIds: config.cloud?.ledgerIds ?? null };
      if (args['dry-run']) { out(JSON.stringify({ network: false, rows: args['pull-only'] ? [] : syncPlan(ledger.entries, state, selection) }, null, 2)); return 0; }
      const connection = cloudConnection(config);
      if (!connection.origin) { err('no cloud origin — run agentlinkops connect'); return 2; }
      if (!connection.token) { err(keySetup(connection.origin)); return 2; }
      if (!connection.projectId) { err('no project id — run agentlinkops connect'); return 2; }
      const client = createClient(connection);
      let next = { ...state };
      let pushFailed = false;
      if (!args['pull-only']) {
        const pushed = await pushExpectations(client, ledger.entries, state, { projectId: connection.projectId, ...selection });
        next.watches = pushed.watches;
        out(`pushed ${pushed.pushed} (${pushed.created} new, ${pushed.retired} retired, ${pushed.local} kept local)`);
        for (const failure of pushed.failed.slice(0, 20)) out(`  ${failure.id}: ${failure.code} ${failure.message}`);
        if (pushed.failed.length) out(`  ${pushed.failed.length} entr(ies) the cloud refused, listed above`);
        pushFailed = pushed.failed.length > 0;
      }
      if (!args['push-only']) {
        const pulled = await pullEvents(client, next, {
          onSnapshot: async snapshot => {
            // A resync writes the snapshot beside the mirror rather than into the ledger: the
            // cloud is a mirror of the customer's file and never the other way round.
            await writeFile(join(config.dir, `snapshot-${Date.now()}.json`), `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8');
          },
        });
        // Two feeds, two cursors. They are pulled separately and written separately, so an
        // expiry on one cannot move the other.
        const targets = await pullTargetEvents(client, next);
        const index = await watchIndex(client, next);
        const { fresh, duplicates } = await persistPulledHistory(config, pulled.events, targets.events, index);
        next.cursors = { ...(next.cursors ?? {}), events: pulled.cursor, target_events: targets.cursor };
        next.gaps = [...(next.gaps ?? []), ...pulled.gaps, ...targets.gaps];
        out(`pulled ${pulled.events.length} event(s) over ${pulled.pages} page(s), ${fresh.length} observation(s)${duplicates.length ? `, ${duplicates.length} already held` : ''}`);
        if (targets.events.length) out(`pulled ${targets.events.length} target event(s) over ${targets.pages} page(s)`);
        // A gap is stated, never inferred. An empty feed means nothing happened; an expired
        // cursor means something happened and is gone.
        for (const gap of [...pulled.gaps, ...targets.gaps]) out(`  RESYNC ${gap.at}: ${gap.reason}; a snapshot was written to ${config.dir}`);
      }
      await writeState(config.paths.state, next);
      return pushFailed ? 2 : 0;
    }

    if (command === 'check') {
      const state = await readState(config.paths.state);
      const selected = selectEntries(ledger.entries, { filter: args.filter === true ? null : args.filter });
      const entries = args.all ? selected : dueEntries(selected, lastCheckedMap(state));
      if (!entries.length) { out(`nothing due (${plural(selected.length, 'entry', 'entries')} in scope; pass --all to recheck)`); return 0; }
      if (!args.json) err(`checking ${plural(entries.length, 'entry', 'entries')}…`);
      const rows = await runCheck(entries, {
        concurrency: Number(args.concurrency ?? config.defaults.concurrency ?? DEFAULTS.concurrency),
        timeoutMs: Number(args.timeout ?? config.defaults.timeoutMs ?? DEFAULTS.timeoutMs),
        hostDelayMs: Number(args['host-delay'] ?? config.defaults.hostDelayMs ?? DEFAULTS.hostDelayMs),
      });
      // The mirror records changes; `state.json` records activity. Appending a row that says
      // the same thing as the one above it is 2 KB of git churn per link per run, and the only
      // thing it adds is work for a later compaction.
      const { changed, repeated } = selectChanged(rows, state);
      await appendObservations(config.paths.observations, changed);
      await writeState(config.paths.state, applyRun(state, rows));
      const summary = summarize(entries, rows);
      if (args.json) { out(rows.map(row => JSON.stringify(row)).join('\n')); return summary.exitCode; }
      reportProblems(ledger.problems, 'ledger line(s)', out);
      for (const { entry, row } of summary.appeared) out(`APPEARED  ${entry.id}  ${entry.source}  (${row.occurrences} occurrence(s))`);
      for (const { entry, row } of summary.failures) out(`LOST      ${entry.id}  ${entry.source}  [${row.reason}]`);
      out(`\n${JSON.stringify(summary.counts)}`);
      out(`${plural(changed.length, 'observation')} recorded, ${repeated.length} repeated an answer already on file`);
      if (summary.counts.unknown) {
        out(`${plural(summary.counts.unknown, 'page')} could not be concluded. An unknown is not a lost link; run \`agentlinkops status\` for the reasons.`);
      }
      if (args['fail-on-unknown'] && summary.counts.unknown) return 1;
      return summary.exitCode;
    }

    err(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError) { err(error.message); return 2; }
    err(`agentlinkops: ${error?.message ?? error}`);
    return 2;
  } finally {
    if (syncLock) { await syncLock.handle.close(); await unlink(syncLock.path); }
  }
}
