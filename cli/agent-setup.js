import { readFile, writeFile, mkdir, readdir, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from './args.js';
import { ConfigError } from './config.js';
import { AGENT_CLIENTS, clientById } from '../shared/agent-clients.js';
import { NUDGE } from './skill.js';

// DP-0036-T09: `agentlinkops agent setup` (Stripe's `stripe agent setup` shape). It detects the
// agent clients on this machine, installs the skill pack at each client's path with digest
// verification, and writes the MCP entry for the view that client should use, from the one
// client table in shared/agent-clients.js. It stores no credential: OAuth happens in the
// client. It is idempotent, never overwrites a file it did not write, and prints exactly what
// changed. `agent status` reports what is installed without touching anything.
const USAGE = 'agent setup [--client ID ...] [--scope project|user] [--origin URL] [--pack DIR] [--dry-run] [--json] | agent status [--json]';
export const DEFAULT_ORIGIN = 'https://app.agentlinkops.com';
export const SERVER_NAME = 'agentlinkops';
const RECEIPT = '.agentlinkops/agent-setup.json';
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Where the pack's skills live: beside the packaged CLI (packages/agentlinkops-cli/skills), in
// the assembled plugin, or in this repository's toolkit. The first that exists wins.
export async function locatePack(explicit = null, from = fileURLToPath(import.meta.url)) {
  const candidates = explicit ? [explicit] : [join(dirname(from), '..', 'skills'), join(dirname(from), '..', 'dist', 'plugin', 'agentlinkops', 'skills'), join(dirname(from), '..', 'toolkit', 'plugin', 'agentlinkops', 'skills')];
  for (const dir of candidates) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries?.some(e => e.isDirectory())) return resolve(dir);
  }
  throw new ConfigError(explicit ? `No skills found under ${explicit}.` : 'No skill pack found beside this CLI; pass --pack DIR or install the agentlinkops package.');
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

// The pack as {skillName: {relPath: {bytes, digest}}}; only directories with a SKILL.md count.
export async function readPack(dir) {
  const skills = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(dir, entry.name);
    if (!(await stat(join(root, 'SKILL.md')).catch(() => null))) continue;
    const files = {};
    for (const rel of await walk(root)) { const bytes = await readFile(join(root, rel)); files[rel] = { bytes, digest: sha256(bytes) }; }
    skills[entry.name] = files;
  }
  if (!Object.keys(skills).length) throw new ConfigError(`No skills with a SKILL.md under ${dir}.`);
  return skills;
}

const expand = (path, home) => path.startsWith('~/') ? join(home, path.slice(2)) : path;
const exists = async path => !!(await lstat(path).catch(() => null));

export async function detectClients(home, only = null) {
  const found = [];
  for (const client of AGENT_CLIENTS) {
    if (only && !only.includes(client.id)) continue;
    const detected = only?.includes(client.id) ? true : (await Promise.all(client.detect.map(p => exists(expand(p, home))))).some(Boolean);
    if (detected) found.push(client);
  }
  return found;
}

// MCP entry writers per format. JSON files are merged under mcpServers; TOML gets a table
// appended when absent; YAML clients get the snippet printed, never an edit of a config we do
// not own. Every writer returns {file, action, entry} with action in written | unchanged |
// conflict | printed.
function mcpEntry(client, url) {
  switch (client.mcp.format) {
    case 'mcpServers-json': return client.id === 'claude-code' ? { type: 'http', url } : { url };
    case 'mcpServers-httpUrl': return { httpUrl: url };
    default: return { url };
  }
}
export async function planMcp(client, { cwd, home, origin, scope }) {
  const url = `${origin}${client.view}`;
  const entry = mcpEntry(client, url);
  const file = client.mcp.scope === 'user' || scope === 'user' ? expand(client.mcp.file, home) : join(cwd, client.mcp.file);
  if (client.mcp.format === 'toml-mcp_servers') {
    const text = await readFile(file, 'utf8').catch(() => '');
    const table = `[mcp_servers.${SERVER_NAME}]`;
    if (text.includes(table)) return { file, action: text.includes(`url = "${url}"`) ? 'unchanged' : 'conflict', entry, url, note: text.includes(`url = "${url}"`) ? undefined : `${table} already exists with a different url; edit it by hand.` };
    return { file, action: 'write', entry, url, text: `${text.length && !text.endsWith('\n') ? `${text}\n` : text}\n${table}\nurl = "${url}"\n` };
  }
  if (client.mcp.format === 'yaml-mcp_servers') return { file, action: 'printed', entry, url, snippet: `mcp_servers:\n  ${SERVER_NAME}:\n    url: ${url}\n` };
  if (client.id === 'claude-code' && (client.mcp.scope === 'user' || scope === 'user')) return { file: expand('~/.claude.json', home), action: 'printed', entry, url, snippet: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}` };
  const text = await readFile(file, 'utf8').catch(() => null);
  let config = {};
  if (text !== null) { try { config = JSON.parse(text); } catch { return { file, action: 'conflict', entry, url, note: 'existing file is not valid JSON; edit it by hand.' }; } }
  const servers = config.mcpServers ?? {};
  const current = servers[SERVER_NAME];
  if (current && JSON.stringify(current) === JSON.stringify(entry)) return { file, action: 'unchanged', entry, url };
  if (current) return { file, action: 'conflict', entry, url, note: `mcpServers.${SERVER_NAME} already exists with a different entry; edit it by hand.` };
  return { file, action: 'write', entry, url, text: `${JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, null, 2)}\n` };
}

// Skill installation plan for one client: per file, install | unchanged | conflict.
export async function planSkills(client, pack, { cwd, home, scope, receipt }) {
  const base = scope === 'user' || !client.skills.project ? client.skills.user : client.skills.project;
  const root = expand(base, home);
  const dir = isAbsolute(root) ? root : join(cwd, root);
  const plan = { dir, install: [], unchanged: [], conflicts: [] };
  const owned = new Set(Object.keys(receipt?.files ?? {}));
  for (const [name, files] of Object.entries(pack)) for (const [rel, { digest }] of Object.entries(files)) {
    const target = join(dir, name, rel);
    const existing = await readFile(target).catch(() => null);
    if (existing === null) { plan.install.push({ target, digest }); continue; }
    if (sha256(existing) === digest) { plan.unchanged.push(target); continue; }
    if (owned.has(target)) plan.install.push({ target, digest, replaces: receipt.files[target] });
    else plan.conflicts.push({ target, note: 'exists with different content and was not installed by agentlinkops; left untouched.' });
  }
  return plan;
}

async function readReceipt(cwd) { try { return JSON.parse(await readFile(join(cwd, RECEIPT), 'utf8')); } catch { return null; } }

export async function agentMain(argv, { cwd = process.cwd(), home = homedir(), env = process.env, out = console.log, err = console.error, isTTY = process.stdout.isTTY === true, packDir = null, now = () => new Date().toISOString() } = {}) {
  const args = parseArgs(argv, ['client']);
  const [command, sub] = args._;
  if (command !== 'agent' || !['setup', 'status'].includes(sub) || args._.length !== 2) throw new ConfigError(USAGE);
  const allowed = sub === 'setup' ? ['_', 'client', 'scope', 'origin', 'pack', 'dry-run', 'json'] : ['_', 'json'];
  if (Object.keys(args).some(k => !allowed.includes(k))) throw new ConfigError(USAGE);
  const json = args.json === true || !isTTY;
  const scope = args.scope ?? 'project';
  if (!['project', 'user'].includes(scope)) throw new ConfigError('--scope is project or user');
  const origin = (args.origin ?? env.AGENTLINKOPS_API_URL ?? env.LINKTRAIL_API_URL ?? DEFAULT_ORIGIN).replace(/\/$/u, '');
  if (!/^https:\/\/[^/?#]+$/u.test(origin)) throw new ConfigError('--origin must be an https origin without a path.');
  const only = args.client ? [].concat(args.client) : null;
  for (const id of only ?? []) if (!clientById(id)) throw new ConfigError(`Unknown client ${id}. Clients: ${AGENT_CLIENTS.map(c => c.id).join(', ')}.`);
  const receipt = await readReceipt(cwd);

  if (sub === 'status') {
    const clients = await detectClients(home, only);
    const report = { origin, clients: [] };
    for (const client of clients) {
      const mcp = await planMcp(client, { cwd, home, origin, scope });
      report.clients.push({ id: client.id, name: client.name, view: `${origin}${client.view}`, mcp: { file: mcp.file, state: mcp.action === 'unchanged' ? 'configured' : mcp.action === 'conflict' ? 'different' : 'absent' } });
    }
    report.receipt = receipt ? { installedAt: receipt.installedAt, files: Object.keys(receipt.files).length } : null;
    out(json ? JSON.stringify(report, null, 2) : renderStatus(report));
    return 0;
  }

  const pack = await readPack(await locatePack(args.pack ?? packDir));
  const clients = await detectClients(home, only);
  const report = { origin, scope, dryRun: args['dry-run'] === true, clients: [], next: [] };
  if (!clients.length) { report.next.push(`No agent client detected. Pass --client with one of ${AGENT_CLIENTS.map(c => c.id).join(', ')}.`); out(json ? JSON.stringify(report, null, 2) : report.next.join('\n')); return 2; }
  const ownedFiles = { ...(receipt?.files ?? {}) };
  for (const client of clients) {
    const skills = await planSkills(client, pack, { cwd, home, scope, receipt });
    const mcp = await planMcp(client, { cwd, home, origin, scope });
    const entry = { id: client.id, name: client.name, view: mcp.url, reason: client.reason, skills: { dir: skills.dir, installed: [], unchanged: skills.unchanged.length, conflicts: skills.conflicts }, mcp: { file: mcp.file, action: mcp.action, ...(mcp.note ? { note: mcp.note } : {}), ...(mcp.snippet ? { snippet: mcp.snippet } : {}) } };
    if (!report.dryRun) {
      for (const { target, digest } of skills.install) {
        const [name, ...rest] = relative(skills.dir, target).split(/[\\/]/u);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, pack[name][rest.join('/')].bytes);
        ownedFiles[target] = digest;
        entry.skills.installed.push(target);
      }
      if (mcp.action === 'write') { await mkdir(dirname(mcp.file), { recursive: true }); await writeFile(mcp.file, mcp.text); entry.mcp.action = 'written'; }
    } else {
      entry.skills.installed = skills.install.map(i => i.target);
      if (mcp.action === 'write') entry.mcp.action = 'would write';
    }
    if (mcp.action === 'printed') report.next.push(`${client.name}: add the MCP server yourself:\n${mcp.snippet}`);
    if (mcp.action === 'conflict') report.next.push(`${client.name}: ${mcp.note}`);
    for (const c of skills.conflicts) report.next.push(`${client.name}: ${c.target} ${c.note}`);
    report.clients.push(entry);
  }
  if (!report.dryRun) {
    await mkdir(join(cwd, '.agentlinkops'), { recursive: true });
    await writeFile(join(cwd, RECEIPT), `${JSON.stringify({ installedAt: now(), origin, scope, clients: report.clients.map(c => c.id), files: ownedFiles }, null, 2)}\n`);
  }
  report.next.push('Sign in through each client\'s MCP OAuth flow; no credential was stored by this command.');
  report.next.push(NUDGE);
  out(json ? JSON.stringify(report, null, 2) : renderSetup(report));
  return report.clients.some(c => c.skills.conflicts.length || c.mcp.action === 'conflict') ? 1 : 0;
}

function renderStatus(report) {
  const lines = [`origin ${report.origin}`];
  for (const c of report.clients) lines.push(`${c.name.padEnd(12)} ${c.mcp.state.padEnd(11)} ${c.view}  (${c.mcp.file})`);
  lines.push(report.receipt ? `receipt: ${report.receipt.files} files installed at ${report.receipt.installedAt}` : 'receipt: none (run agentlinkops agent setup)');
  return lines.join('\n');
}
function renderSetup(report) {
  const lines = [`${report.dryRun ? 'plan' : 'done'}: origin ${report.origin}, scope ${report.scope}`];
  for (const c of report.clients) {
    lines.push(`${c.name}: view ${c.view}`);
    lines.push(`  skills → ${c.skills.dir}: ${c.skills.installed.length} ${report.dryRun ? 'to install' : 'installed'}, ${c.skills.unchanged} unchanged${c.skills.conflicts.length ? `, ${c.skills.conflicts.length} conflicts` : ''}`);
    lines.push(`  mcp    → ${c.mcp.file}: ${c.mcp.action}`);
  }
  for (const n of report.next) lines.push('', n);
  return lines.join('\n');
}
