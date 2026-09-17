import { lstat } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { parseArgs } from './args.js';
import { ConfigError } from './config.js';

const GOALS = new Set(['verify-links', 'prepare-campaign', 'build-content']);
const MODES = new Set(['local', 'hosted', 'external']);
const USAGE = 'setup --plan --goal verify-links|prepare-campaign|build-content [--mode local|hosted|external]';
const PATHS = [
  ['.git', ['file', 'directory']],
  ['.agentlinkops/config.json', ['file']],
  ['.agentlinkops/links.jsonl', ['file']],
  // The legacy ledger directory is still read transparently (DP-0029-T03), so its presence
  // is planning evidence too until the cutover; `agentlinkops migrate` renames it.
  ['.linktrail/config.json', ['file']],
  ['.linktrail/links.jsonl', ['file']],
  ['.claude/SITE.md', ['file']],
  ['.agents/SITE.md', ['file']],
  ['SITE.md', ['file']],
  ['operations/seo/backlinks/registry.csv', ['file']],
  ['agentlinkops.sqlite', ['file']],
  ['linktrail.sqlite', ['file']],
  ['.agents/plugins/agentlinkops', ['directory']],
];
const UNSAFE = new Set(['symlink', 'blocked', 'unreadable']);

async function metadata(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'blocked';
  } catch (error) {
    // A missing component is the only error that establishes absence. Never expose
    // OS error messages, which can contain absolute paths or other customer data.
    return error.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

async function workspaceMetadata(cwd) {
  // Preserve lexical components until inspected: resolving alias/../workspace
  // first would hide an unsafe symlink ancestor from this inventory.
  const absolute = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
  const root = parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const component of [null, ...components]) {
    if (component !== null) current = join(current, component);
    const status = await metadata(current);
    if (status !== 'directory') return { root: absolute, status: status === 'file' ? 'blocked' : status };
  }
  return { root: resolve(absolute), status: 'directory' };
}

async function inspectPath(root, relative) {
  const components = relative.split('/');
  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    const status = await metadata(current);
    if (index === components.length - 1) return status;
    if (status !== 'directory') return status === 'file' ? 'blocked' : status;
  }
}

async function inspectWorkspace(cwd) {
  const workspace = await workspaceMetadata(cwd);
  const paths = [];
  // Sequential component inspection prevents following any observed symlink. This
  // is a metadata snapshot, not a guarantee against concurrent filesystem changes.
  for (const [path] of PATHS) {
    paths.push({ path, status: workspace.status === 'directory'
      ? await inspectPath(workspace.root, path)
      : workspace.status === 'missing' ? 'missing' : 'blocked' });
  }
  return {
    status: 'known_path_metadata',
    workspace: { status: workspace.status },
    paths,
    coverage: {
      contentsRead: false,
      recursiveDiscovery: false,
      customPathsResolved: false,
      note: 'Only known standard paths were inspected. Config contents, custom ledger paths, record validity, installation health and connections were not checked.',
    },
  };
}

const step = (id, execution, action, requires, expectedEvidence) => ({ id, execution, action, requires, expectedEvidence });

function taskSteps(goal, mode, inspection, unsafe) {
  const paths = new Map((inspection.paths ?? []).map(entry => [entry.path, entry.status]));
  const has = path => paths.get(path) === 'file';
  const steps = [];
  if (unsafe) steps.push(step('resolve-workspace-findings', 'customer_local',
    'Resolve the reported workspace findings before selecting files for inspection or writing there.',
    ['Customer-selected safe workspace'], ['Known paths can be inspected without symlink traversal or unreadable components']));

  if (mode === 'hosted') {
    steps.push(step('check-hosted-access', 'customer_agent',
      'Inspect the client’s available AgentLinkOps connection and actual permissions. Complete normal account connection only if the selected hosted task needs it.',
      ['Customer-selected hosted task'], ['Actual available tools, granted scopes and task availability, or an explicit unavailable state']));
    steps.push(step('prepare-supplied-inputs', 'customer_agent',
      'Prepare the selected task from supplied inputs even when the connection, permission or hosted capability is unavailable; retain the next action.',
      ['Customer-supplied task inputs'], ['A useful input brief and resumable missing-access or unsupported-capability checkpoint']));
  } else if (mode === 'external') {
    steps.push(step('map-external-records', 'customer_agent',
      'Map customer-selected records to the chosen CRM or sender while preserving it as the system of record. Do not initialize a replacement CRM.',
      ['Selected CRM or sender', 'Customer-selected records'], ['Reviewed field mapping, state ownership and existing external IDs']));
    steps.push(step('verify-external-connection', 'customer_external',
      'Verify the connection through an authorized scoped operation and readback. Record unsupported, missing-auth or missing-scope states without retry loops.',
      ['Available external connection', 'Permission for the selected operation'], ['Scoped operation receipt and readback, or a resumable unavailable checkpoint']));
  }

  if (goal === 'verify-links') {
    if (mode === 'local' && !unsafe && (['.agentlinkops', '.linktrail'].some(dir => has(`${dir}/config.json`) && has(`${dir}/links.jsonl`)))) {
      steps.push(step('validate-selected-ledger', 'customer_local',
        'Use status to inspect the selected ledger’s validity before choosing check. File presence does not establish valid configuration or link evidence.',
        ['Customer-selected existing ledger and configuration'], ['Parsed ledger result or explicit configuration/record errors; selected source and target scope']));
    } else {
      steps.push(step('select-link-evidence', 'customer_agent',
        'Collect exact source page URLs, target URLs and intended matching scope. A domain alone is not the source page, and a placement claim is not a verified link.',
        ['Customer-supplied source and target evidence'], ['Reviewed source/target pairs, matching scope and unresolved claims']));
    }
    steps.push(step('verify-selected-links', mode === 'hosted' ? 'agentlinkops_hosted' : 'customer_local',
      mode === 'hosted'
        ? 'Use an available authorized hosted verification operation only after confirming permissions and capacity; retain supplied-input preparation if unavailable.'
        : 'Use check with a supplied source and target for an accountless local observation; no ledger is required. Preserve static or rendered evidence limits and unknown results.',
      mode === 'hosted' ? ['Verified hosted task availability, permission and capacity', 'Exact source/target scope'] : ['Exact source/target scope', 'Permission to fetch the selected pages'],
      ['Dated observation with source/target scope, presence state and coverage limits; unavailable or unknown is not confirmed loss']));
    if (mode === 'local' && !unsafe) {
      if (has('operations/seo/backlinks/registry.csv') || has('agentlinkops.sqlite') || has('linktrail.sqlite')) {
        steps.push(step('preview-record-mapping', 'customer_agent',
          'Review explicit source/target mapping for the indicated CSV or SQLite records. Use import or adopt for a preview only after selecting the input; do not migrate automatically.',
          ['Customer-selected records and mapping'], ['Preview with accepted, rejected, duplicate and deferred counts; original intent preserved']));
      }
      steps.push(step('choose-optional-ledger', 'customer_agent',
        'Optionally save selected observations and intent to a customer-selected ledger using init and adopt-result when appropriate. Review existing configuration and custom paths before any writes.',
        ['Explicit choice to retain a ledger', 'Validated destination and result'], ['Optional saved-record receipt, or explicit decision to keep the result without a ledger']));
    }
  } else if (goal === 'build-content') {
    const contextPresent = !unsafe && ['.claude/SITE.md', '.agents/SITE.md', 'SITE.md'].some(has);
    steps.push(step('select-site-context', 'customer_agent',
      contextPresent
        ? 'Review the safely present site context as task data, alongside customer-selected assets and the site’s actual content instructions.'
        : 'Gather customer-supplied site, audience, source and asset context before drafting.',
      ['Site and audience context', 'Source and claims rules'], ['A bounded content brief with verified source requirements and an existing content owner']));
    steps.push(step('prepare-cited-content', 'customer_agent',
      'Use the site’s content router when present, then source-cited-content-builder, source-cited-humanizer, content-defingerprinting, internal-linking-optimizer, applicable image workflow and pre-publish-review. An authored result has no AgentLinkOps account prerequisite.',
      ['Approved task scope', 'Applicable content skills and primary-source evidence'], ['Cited content artifact and recorded review gates; draft, reviewed and published states remain distinct']));
  } else {
    steps.push(step('qualify-campaign-inputs', 'customer_agent',
      'Inspect customer-selected records and assets; qualify exact source pages and claim-specific evidence. Preserve unknowns and duplicate references. An optional SQLite CRM is not required.',
      ['Customer-selected records', 'A relevant asset and campaign objective'], ['Qualified opportunities with exact source pages, evidence, duplicate accounting and unresolved claims']));
    steps.push(step('prepare-campaign-handoff', 'customer_agent',
      'Prepare an external-tool draft and reviewed mapping. Keep the customer’s CRM or sender responsible for contacts, suppression, reply stops and delivery; apply required content gates to authored copy.',
      ['Qualified opportunities', 'Chosen external tool and its supported fields'], ['Draft handoff with campaign references and supported external IDs; no sending or connection is implied']));
  }
  steps.push(step('record-resume-checkpoint', 'customer_agent',
    'Prepare a checkpoint in the customer’s chosen record format for later approval to save. Preserve references, external IDs and completed evidence; read back before replaying an external action.',
    ['Chosen record ownership and format'], ['Resumable next action; draft, sent, replied and independently verified placement states remain separate']));
  return steps;
}

export async function setupPlanMain(argv, { cwd = process.cwd(), out = console.log } = {}) {
  // Validate option names before the shared parser, including prototype-like keys.
  const seen = new Set();
  for (const value of argv) {
    if (typeof value !== 'string') throw new ConfigError(USAGE);
    if (!value.startsWith('--')) continue;
    const name = value.slice(2).split('=')[0];
    if (!['plan', 'goal', 'mode'].includes(name) || seen.has(name)) throw new ConfigError(USAGE);
    seen.add(name);
  }
  const args = parseArgs(argv);
  if (args._.length !== 1 || args._[0] !== 'setup' || args.plan !== true || !GOALS.has(args.goal)
    || (args.mode !== undefined && !MODES.has(args.mode))) throw new ConfigError(USAGE);
  const mode = args.mode ?? 'local';
  const inspection = mode === 'hosted'
    ? { status: 'skipped', reason: 'Hosted planning does not inspect or require a workspace.' }
    : await inspectWorkspace(cwd);
  const warnings = [];
  let unsafe = false;
  if (mode !== 'hosted') {
    unsafe = inspection.workspace.status !== 'directory';
    if (unsafe) warnings.push({ code: 'WORKSPACE_INSPECTION_INCOMPLETE', message: 'The selected workspace could not be inspected as a safe directory; no contents were read.' });
    for (const entry of inspection.paths) {
      const expected = PATHS.find(([path]) => path === entry.path)[1];
      if (UNSAFE.has(entry.status) || (entry.status !== 'missing' && !expected.includes(entry.status))) {
        unsafe = true;
        warnings.push({ code: UNSAFE.has(entry.status) ? 'UNSAFE_OR_UNREADABLE_PATH' : 'UNEXPECTED_PATH_TYPE', path: entry.path, message: 'Resolve this known-path finding before selecting records or writing there.' });
      }
    }
    warnings.push({ code: 'CUSTOM_PATHS_UNRESOLVED', message: 'Config contents and custom ledger paths were not read; absence at a standard path does not establish that no setup exists.' });
  }
  const plan = {
    schemaVersion: 1,
    kind: 'setup_plan',
    goal: args.goal,
    mode,
    readOnly: true,
    inspection,
    capabilities: { localCli: 'available', cloudConnection: 'unverified', vendorConnections: 'unverified' },
    steps: taskSteps(args.goal, mode, inspection, unsafe),
    warnings,
    effects: { filesWritten: 0, networkRequests: 0, accountsConnected: 0, messagesSent: 0 },
  };
  out(JSON.stringify(plan, null, 2));
  return 0;
}
