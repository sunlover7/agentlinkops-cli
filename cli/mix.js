// `agentlinkops mix` — the referring-domain mix over the LOCAL ledger (DP-0003-T08/T09/T10).
//
// The cloud serves this report to a customer's agent (POST /v1/competitor-sets/:id/domain-mix,
// get_domain_mix_report, the console panel). This command is the accountless local surface for
// the same question over the same ledger the agent would supply as lanes: are our referring
// domains generic padding, niche, or unlabelled — and how did that change since last run?
//
// The honesty rules are the library's, not re-stated here: class labels come only from the
// row's own tags (never inferred from a domain's shape), ratios run over labelled domains
// only, and a diff across different lanes or datasets refuses with the reason instead of
// rendering index churn as link acquisition.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { readLedger } from './ledger.js';
import { buildDomainMixReport, diffDomainMixReports, renderDomainMixDiff } from '../src/competitors/domain-mix.js';

const CLASS_LABELS = new Set(['generic', 'niche', 'outreach', 'webmcp']);

const USAGE = `agentlinkops mix — the referring-domain mix over this ledger

  agentlinkops mix [--lane-file FILE]… [--save FILE] [--against FILE] [--json]

  Class labels are the row tags (generic, niche, outreach, webmcp); lanes split on the
  row's src:<name> tag. Extra lanes (e.g. scripts/graph-domain-mix-lanes.mjs output) merge
  in unchanged. --save writes the full report JSON; --against diffs the current mix against
  a saved one in the watch format.`;

/** One lane per row-source tag, exactly the fleet-run mapping: class from the row's own tags. */
export function lanesFromEntries(entries) {
  const byLane = new Map();
  for (const entry of entries) {
    const tags = entry.tags ?? [];
    const klass = tags.find(tag => CLASS_LABELS.has(tag)) ?? null;
    const srcTag = tags.find(tag => tag.startsWith('src:'));
    const lane = srcTag ? srcTag.slice(4) : 'unattributed';
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push({ source_url: entry.source, class: klass, added: entry.added ?? null });
  }
  return [...byLane.entries()].map(([lane, rows]) => ({ lane, rows })).sort((a, b) => a.lane < b.lane ? -1 : 1);
}

/** The one-line-per-lane human rendering. Numbers stay within their dataset, always. */
export function renderMix(report, out) {
  const m = report.metadata;
  out(`referring-domain mix — lanes: ${m.lanes.length}, competitor side: ${m.competitor_side_state}`);
  for (const lane of report.ours) {
    const c = lane.classes;
    const share = lane.generic_share_of_labelled === null ? 'no labelled domains' : `generic ${lane.generic_share_of_labelled} of labelled`;
    out(`  ${lane.lane}: ${lane.referring_domains} domains — generic ${c.generic ?? 0}, niche ${c.niche ?? 0}, unlabelled ${c.unlabelled ?? 0} (${share}; label coverage ${lane.label_coverage})`);
  }
  for (const member of report.members) {
    const c = member.classes;
    out(`  ${member.member_id} (${member.member_role}, inventory coverage ${member.coverage}): ${member.referring_domains} domains — generic ${c.generic ?? 0}, niche ${c.niche ?? 0}, unlabelled ${c.unlabelled ?? 0}; our labels reach ${member.label_coverage}`);
  }
  out(`report ${m.report_hash}`);
}

const parseMixArgs = argv => {
  const parsed = { 'lane-file': [], save: null, against: null, json: false, help: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--help') parsed.help = true;
    else if (arg === '--save') parsed.save = argv[++i] ?? null;
    else if (arg === '--against') parsed.against = argv[++i] ?? null;
    else if (arg === '--lane-file') parsed['lane-file'].push(argv[++i] ?? null);
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else parsed._.push(arg);
  }
  return parsed;
};

export async function mixMain(argv = [], { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  let args;
  try { args = parseMixArgs(argv); } catch (error) { err(`${error.message}\n\n${USAGE}`); return 2; }
  if (args.help || args._.length) { out(USAGE); return args.help ? 0 : 2; }

  const config = await loadConfig({ cwd, root: cwd });
  const { entries, problems, missing } = await readLedger(config.paths.ledger);
  if (missing) { err('no ledger here — run `agentlinkops init` first'); return 2; }
  if (problems.length) {
    // Malformed lines are reported and excluded, never silently dropped.
    err(`${problems.length} ledger line(s) could not be read and are excluded from the mix:`);
    for (const problem of problems.slice(0, 10)) err(`  line ${problem.line}${problem.id ? ` (${problem.id})` : ''}: ${problem.reason}`);
  }
  const lanes = lanesFromEntries(entries);
  for (const file of args['lane-file']) {
    if (!file) { err('--lane-file needs a file'); return 2; }
    const extra = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(extra)) { err(`${file}: a lane file is a JSON array of { lane, rows }`); return 2; }
    lanes.push(...extra);
  }
  if (!lanes.length) {
    // A confirmed absence, not a usage error: the ledger exists and names no rows we can
    // split. Exit 1 says so with the reason instead of printing an empty report.
    err('no labelled rows: the ledger is empty, or no row carries a class tag (generic, niche, outreach, webmcp)');
    return 1;
  }

  let report;
  try {
    report = await buildDomainMixReport({ lanes });
  } catch (error) {
    err(`the mix could not be built: ${error.message}`);
    return 2;
  }

  if (args.save) {
    await mkdir(dirname(String(args.save)), { recursive: true });
    await writeFile(String(args.save), `${JSON.stringify(report, null, 1)}\n`, 'utf8');
    out(`saved report ${report.metadata.report_hash} to ${args.save}`);
  }
  if (args.against) {
    const previous = JSON.parse(await readFile(String(args.against), 'utf8'));
    const diff = diffDomainMixReports(previous, report);
    if (!diff.comparable) out(`not comparable: ${diff.reason}`);
    else renderDomainMixDiff(diff, out);
  }
  if (args.json) out(JSON.stringify(report, null, 1));
  else if (!args.save && !args.against) renderMix(report, out);
  return 0;
}
