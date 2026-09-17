import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { cloudConnection } from './connection.js';
import { createClient, CloudError } from './client.js';
import { parseArgs } from './args.js';
import { NUDGE } from './skill.js';
import { CATALOG_COMMANDS, CATALOG_TOOLSETS } from './catalog.js';
import { oneLiner } from '../src/tool-views.js';

// DP-0036-T05: the CLI's three-level discovery over the cloud catalog — index (`tools`),
// describe (`describe NAME`) and call (`call NAME`). `tools` and `describe` answer from the
// bundled snapshot in cli/catalog.js with no account and no network; `--refresh` reads the
// live catalog instead. Output is JSON whenever stdout is not a terminal or --json is given,
// and one error shape ({ error: { code, message, next } }) on every failure.
const USAGE = 'tools [TOOLSET] [--json] [--refresh] | describe NAME [--examples] [--output-schema] [--json] [--refresh] | call NAME [--args JSON | --file FILE | --set PATH=VALUE ...] [--dry-run] [-y] [--json]';
const NAME = /^[a-z][a-z0-9_]*$/;
const NEXT = {
  TOOL_NOT_FOUND: 'Run `agentlinkops tools` to list commands, or `agentlinkops tools TOOLSET` for one group.',
  INVALID_INPUT: 'Run `agentlinkops describe NAME` for the exact input schema.',
  INSUFFICIENT_SCOPE: 'This credential lacks a scope the command needs; request it through your connection or a new project-scoped key.',
  NO_CLOUD_ORIGIN: 'Run `agentlinkops connect` or set AGENTLINKOPS_API_URL.',
  INVALID_CLOUD_ORIGIN: 'Cloud commands need an HTTPS origin without a path, for example https://app.agentlinkops.com.',
  NO_TOKEN: 'Set AGENTLINKOPS_TOKEN or AGENTLINKOPS_API_KEY from a project-scoped key.',
  PROVIDER_NOT_CONFIGURED: 'An operator must enable this supplier admission; retrying does not change it.',
  OWNED_DISCOVERY_NOT_CONFIGURED: 'An operator must configure owned discovery; retrying does not change it.',
  IDEMPOTENCY_CONFLICT: 'Reuse an idempotency key only with identical arguments; choose a new key for a new request.',
};
export const explain = code => NEXT[code] ?? 'Run `agentlinkops describe NAME` and check the arguments, scopes and availability.';

export const resolveName = (commands, name) => commands.find(c => c.name === name) ?? commands.find(c => c.aliases?.includes(name)) ?? null;

// The index: grouped by toolset, one line per command, core and write and admission marked.
export function renderIndex(commands, { toolset = null, json = false } = {}) {
  const selected = toolset ? commands.filter(c => c.toolset === toolset) : commands;
  if (json) return JSON.stringify({ toolsets: toolset ? { [toolset]: CATALOG_TOOLSETS[toolset] } : CATALOG_TOOLSETS, commands: selected.map(c => ({ name: c.name, toolset: c.toolset, tier: c.tier, readOnly: c.readOnly, summary: oneLiner(c.description, 96), ...(c.admissionGated ? { admission: 'gated' } : {}), ...(c.aliases?.length ? { aliases: c.aliases } : {}) })), next: 'Run `agentlinkops describe NAME` for a schema, then `agentlinkops call NAME --args JSON`.' }, null, 2);
  const groups = new Map();
  for (const c of selected) (groups.get(c.toolset) ?? groups.set(c.toolset, []).get(c.toolset)).push(c);
  const lines = [];
  for (const [group, members] of [...groups].sort()) {
    lines.push(CATALOG_TOOLSETS[group] ? `${group}: ${CATALOG_TOOLSETS[group]}` : `${group}:`);
    for (const c of members.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`  ${c.name}${c.tier === 'core' ? ' (core)' : ''}${c.readOnly ? '' : ' [write]'}${c.admissionGated ? ' [admission-gated]' : ''}  ${oneLiner(c.description, 48)}`);
    lines.push('');
  }
  lines.push(`${selected.length} commands${toolset ? ` in ${toolset}` : ''}. describe NAME shows the schema; call NAME --args JSON runs it.`);
  return lines.join('\n');
}

// One definition: what a describe_tools call returns, printed for a terminal or as JSON.
export function renderDescription(command, requested, { examples = false, outputSchema = false, json = false } = {}) {
  const props = command.inputSchema?.properties ?? {};
  const required = new Set(command.inputSchema?.required ?? []);
  const definition = {
    name: command.name, ...(requested !== command.name ? { requestedAs: requested, note: `${requested} is a retired name; use ${command.name}.` } : {}),
    toolset: command.toolset, tier: command.tier, readOnly: command.readOnly, scopes: command.scopes, description: command.description,
    ...(command.admissionGated ? { admission: 'gated', note: 'Unavailable until an operator enables its supplier admission; calls return the configuration error.' } : {}),
    ...(command.confirm && command.confirm !== 'none' ? { confirm: command.confirm } : {}),
    inputSchema: command.inputSchema,
    ...(outputSchema ? { outputSchema: command.outputSchema } : {}),
    ...(examples && command.examples?.length ? { examples: command.examples } : {}),
    ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    runWith: `agentlinkops call ${command.name} --args '{...}'`,
  };
  if (json) return JSON.stringify(definition, null, 2);
  const lines = [`${command.name}  (${command.toolset}${command.tier === 'core' ? ', core' : ''}${command.readOnly ? ', read-only' : ', write'})`];
  if (definition.note) lines.push(`note: ${definition.note}`);
  lines.push(`scopes: ${command.scopes.join(' ')}`, '', command.description, '', 'parameters:');
  if (!Object.keys(props).length) lines.push('  (none)');
  for (const [key, schema] of Object.entries(props)) {
    const type = schema.enum ? schema.enum.join('|') : schema.type ?? 'any';
    const bounds = [schema.minimum !== undefined ? `min ${schema.minimum}` : null, schema.maximum !== undefined ? `max ${schema.maximum}` : null, schema.maxLength !== undefined ? `≤${schema.maxLength} chars` : null].filter(Boolean).join(', ');
    lines.push(`  ${key}${required.has(key) ? '' : '?'}: ${type}${bounds ? ` (${bounds})` : ''}${schema.description ? `  ${schema.description}` : ''}`);
  }
  if (definition.examples) lines.push('', 'examples:', ...definition.examples.map(e => `  ${JSON.stringify(e)}`));
  if (outputSchema) lines.push('', 'output schema:', JSON.stringify(command.outputSchema, null, 1));
  if (definition.aliases) lines.push('', `also known as: ${definition.aliases.join(', ')}`);
  lines.push('', `run: agentlinkops call ${command.name} --args '{...}'`);
  return lines.join('\n');
}

// --set PATH=VALUE overlays: dotted paths, JSON values when they parse, strings otherwise.
export function applySet(target, assignments) {
  const result = structuredClone(target);
  for (const assignment of assignments) {
    const at = assignment.indexOf('=');
    if (at <= 0) throw new ConfigError(`--set expects PATH=VALUE, got "${assignment}"`);
    const path = assignment.slice(0, at).split('.').filter(Boolean);
    const raw = assignment.slice(at + 1);
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    let cursor = result;
    for (const key of path.slice(0, -1)) { if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}; cursor = cursor[key]; }
    cursor[path.at(-1)] = value;
  }
  return result;
}

const errorJson = (code, message, next) => JSON.stringify({ error: { code, message, next } });

export async function commandsMain(argv, { cwd = process.cwd(), env = process.env, out = console.log, err = console.error, fetchImpl = globalThis.fetch, isTTY = process.stdout.isTTY === true } = {}) {
  const flags = new Set(argv.filter(a => a === '-y' || a === '--yes'));
  const args = parseArgs(argv.filter(a => a !== '-y' && a !== '--yes'), ['set']);
  const [command, name] = args._;
  const json = args.json === true || !isTTY;
  const fail = (code, message) => { if (json) err(errorJson(code, message, explain(code))); else err(`${message}\n${explain(code)}`); return 2; };
  const allowed = { tools: ['_', 'json', 'refresh'], describe: ['_', 'json', 'refresh', 'examples', 'output-schema'], call: ['_', 'args', 'file', 'set', 'dry-run', 'json'] };
  if (!allowed[command] || Object.keys(args).some(key => !allowed[command].includes(key)) || (command === 'tools' && args._.length > 2) || (command !== 'tools' && (args._.length !== 2 || !NAME.test(name)))) throw new ConfigError(USAGE);
  if (args.set?.length && (args.set.some(v => typeof v !== 'string') || args.args !== undefined || args.file !== undefined)) throw new ConfigError('--set cannot be combined with --args or --file');
  if (args.args !== undefined && args.file !== undefined) throw new ConfigError(USAGE);

  // Arguments are validated before any configuration or network is touched.
  let input = {};
  if (command === 'call') {
    if (args.args !== undefined || args.file !== undefined) {
      if ((args.args !== undefined && typeof args.args !== 'string') || (args.file !== undefined && typeof args.file !== 'string')) throw new ConfigError('Provide a JSON object or a file path.');
      try { input = JSON.parse(args.file ? await readFile(resolve(cwd, args.file), 'utf8') : args.args); }
      catch { throw new ConfigError('Cannot read command arguments as JSON.'); }
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new ConfigError('Command arguments must be a JSON object.');
    }
    if (args.set?.length) input = applySet(input, args.set);
  }

  // Catalog: bundled snapshot, or the live one when asked (needs a configured origin and key).
  let commands = CATALOG_COMMANDS, client = null;
  const connect = () => {
    const connection = cloudConnection(loadConfigSync(), env);
    if (!connection.origin) throw new CloudError('NO_CLOUD_ORIGIN', 0);
    let origin;
    try { origin = new URL(connection.origin); } catch { throw new CloudError('INVALID_CLOUD_ORIGIN', 0); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new CloudError('INVALID_CLOUD_ORIGIN', 0);
    return createClient({ ...connection, fetchImpl });
  };
  let loaded = null;
  const loadConfigSync = () => loaded;
  const needsConfig = args.refresh === true || command === 'call';
  if (needsConfig) loaded = await loadConfig({ cwd });
  if (args.refresh === true) {
    try {
      client = connect();
      const live = await client.listCommands();
      commands = live.items.map(item => ({ ...item, readOnly: item.annotations?.readOnlyHint === true, admissionGated: false }));
    } catch (error) {
      if (error instanceof CloudError) return fail(error.code, `catalog refresh: ${error.code}${error.status ? ` (${error.status})` : ''}`);
      throw error;
    }
  }

  if (command === 'tools') {
    const toolset = args._[1] ?? null;
    if (toolset && !commands.some(c => c.toolset === toolset)) return fail('TOOLSET_NOT_FOUND', `No toolset named ${toolset}. Toolsets: ${[...new Set(commands.map(c => c.toolset))].sort().join(', ')}.`);
    out(renderIndex(commands, { toolset, json }));
    // DP-0037-T05: the index is the discovery moment; a person at a terminal gets one line on
    // stderr pointing at the reference. A JSON reader (an agent piping the index) gets nothing
    // extra: the stub skill already sent it to the reference, and stderr stays error objects.
    if (!json) err(NUDGE);
    return 0;
  }
  if (command === 'describe') {
    const found = resolveName(commands, name);
    if (!found) return fail('TOOL_NOT_FOUND', `No command named ${name}.`);
    out(renderDescription(found, name, { examples: args.examples === true, outputSchema: args['output-schema'] === true, json }));
    return 0;
  }

  // call
  const found = resolveName(commands, name);
  const canonical = found?.name ?? name;
  if (args['dry-run'] === true) {
    const plan = { dryRun: true, command: canonical, ...(canonical !== name ? { requestedAs: name } : {}), arguments: input,
      ...(found ? { scopes: found.scopes, readOnly: found.readOnly, ...(found.confirm && found.confirm !== 'none' ? { confirm: found.confirm } : {}) } : { note: 'Not in the bundled catalog; the cloud decides.' }),
      next: found?.readOnly === false && !flags.has('-y') && !flags.has('--yes') ? 'This command writes; run again without --dry-run (add -y to answer confirmations).' : 'Run again without --dry-run to send it.' };
    out(JSON.stringify(plan, null, 2));
    return 0;
  }
  try {
    client ??= connect();
    const result = await client.callCommand(canonical, input);
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof CloudError) return fail(error.code, `${canonical}: ${error.code}${error.status ? ` (${error.status})` : ''}${error.details ? ` ${JSON.stringify(error.details)}` : ''}`);
    throw error;
  }
}
