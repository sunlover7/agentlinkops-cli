// Toolsets, tiers, the card-catalog manifest, the meta tools and the exposure views, derived
// from registry metadata. Pure: no cloud, filesystem or service imports, so the measurement
// script, the MCP router, the CLI index and the generators all read the same definitions.
// Rules: docs/technical/AGENT-SURFACE-CONTRACT.md (DP-0036).

export const TOOLSETS = ['monitoring','evidence','discovery','library','competitors','reports','workspace','notifications','webhooks','admission','disavow','lifecycle','digests'];

// One line per toolset: what the group is for. Printed by the site brief, the REST index and the
// catalog snapshot so the same wording reaches every client; a toolset without a summary is a
// gate failure in the measurement script.
export const TOOLSET_SUMMARIES = {
  admission: 'Project rules, URL previews and retained admission decisions.',
  disavow: 'Propose, review and export website disavow rules.',
  lifecycle: 'Placement costs, expiry, renewal events and currency reports.',
  digests: 'Own-address digest preferences, delivery history and exact events.',
  monitoring: 'Watch earned links and destination URLs: create, list, update, import, export, recheck.',
  evidence: 'What a check observed: histories, snapshots, change feeds, check jobs, published contacts.',
  discovery: 'Import candidate rows, read stored runs, verify selected candidates, enroll them.',
  library: 'Read and export the coverage-stated opportunity library.',
  competitors: 'Competitor sets, dated inventories, scheduled refresh, gap and domain-mix reports.',
  reports: 'Profile, anchor and report summaries over the tracked dataset.',
  workspace: 'Workspace, projects, usage, members, invitations, scratch-resource cleanup.',
  notifications: 'Email notification preferences, previews, tests and deliveries.',
  webhooks: 'Webhook endpoints, state, secrets and delivery records.',
};

// Provisional core tier until DP-0036-T13 usage evidence replaces it. At most six.
export const CORE_DEFAULT = ['get_workspace','list_projects','list_link_watches','monitor_link','list_events'];

// Fallback toolset by documentation category and by name, used only for a binding that does not
// carry an explicit `toolset`. DP-0036-T02 makes every binding explicit; the fallback stays so a
// new command without metadata is still measured instead of silently uncounted.
const CATEGORY_TOOLSET = { monitoring:'monitoring', destinations:'monitoring', imports:'discovery', verification:'discovery', competitors:'competitors', reports:'reports', workspace:'workspace', webhooks:'webhooks' };
const NAME_TOOLSET = {
  get_evidence:'evidence', locate_link:'evidence', get_history:'evidence',
  get_public_contacts:'evidence', list_events:'evidence', list_check_jobs:'evidence', get_check_job:'evidence',
  send_invitation_email:'notifications', preview_notification_email:'notifications', get_notification_preferences:'notifications', save_notification_preferences:'notifications', list_notification_deliveries:'notifications', test_notification_email:'notifications',
  export_link_watches:'monitoring',
  list_opportunities:'library', get_opportunity:'library', export_opportunities:'library',
};

export function toolsetOf(name, binding = {}, category = null) {
  return binding.toolset ?? NAME_TOOLSET[name] ?? CATEGORY_TOOLSET[category] ?? 'workspace';
}
export function tierOf(name, binding = {}) {
  return binding.tier ?? (CORE_DEFAULT.includes(name) ? 'core' : 'deferred');
}

// The first sentence of a description, cut to `max` characters on a word boundary.
export function oneLiner(description, max = 60) {
  const sentence = (description ?? '').split(/(?<=\.)\s/)[0].trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).replace(/[,;:]$/, '')}…`;
}

// entries: [{ name, description, toolset, tier, readOnly }]. Grouped, one line per command.
export function manifestText(entries, { max = 36 } = {}) {
  const groups = new Map(TOOLSETS.map(t => [t, []]));
  for (const entry of entries) (groups.get(entry.toolset) ?? groups.set(entry.toolset, []).get(entry.toolset)).push(entry);
  const lines = ['Commands by toolset (name: what it does). Use search_tools or describe_tools for the full schema before calling.'];
  for (const [toolset, members] of groups) {
    if (!members.length) continue;
    lines.push(`\n${toolset}:`);
    for (const entry of members.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`- ${entry.name}${entry.tier === 'core' ? ' (core)' : ''}${entry.readOnly ? '' : ' [write]'}: ${oneLiner(entry.description, max)}`);
  }
  return lines.join('\n');
}

// The four meta tools of the default view. Their schemas live here so the measurement script
// counts the real definitions the router will register.
const argumentsSchema = { type:'object', description:'Arguments for the named command, exactly as its input schema describes them.', additionalProperties:true };
export const META_TOOLS = [
  { name:'search_tools', description:`Find AgentLinkOps commands by what you want to do. Searches names, descriptions, parameter names and keywords across the toolsets: ${TOOLSETS.join(', ')}. Returns names with one-line summaries; call describe_tools for a schema.`, readOnly:true,
    inputSchema:{ type:'object', properties:{ query:{ type:'string', minLength:1, maxLength:500, description:'Natural-language task or keywords.' }, toolset:{ type:'string', enum:TOOLSETS, description:'Restrict results to one toolset.' }, limit:{ type:'integer', minimum:1, maximum:25, description:'Maximum results; default 5.' } }, required:['query'], additionalProperties:false } },
  { name:'describe_tools', description:'Read the full input schema, examples and scopes for one or more commands by name. Include the output schema on request. Use before run_read_command or run_write_command.', readOnly:true,
    inputSchema:{ type:'object', properties:{ names:{ type:'array', items:{ type:'string', minLength:1, maxLength:64 }, minItems:1, maxItems:10, description:'Command names from search_tools or the toolset listing.' }, include:{ type:'string', enum:['input','input+output','examples'], description:'What to include; default input.' } }, required:['names'], additionalProperties:false } },
  { name:'run_read_command', description:'Run a read-only AgentLinkOps command by name with its arguments. Reads never change workspace data. Arguments are validated against the command\'s schema; describe_tools shows it.', readOnly:true,
    inputSchema:{ type:'object', properties:{ name:{ type:'string', minLength:1, maxLength:64, description:'A read-only command name.' }, arguments:argumentsSchema }, required:['name'], additionalProperties:false } },
  { name:'run_write_command', description:'Run an AgentLinkOps command that creates, changes or removes workspace data, by name with its arguments. Confirm irreversible changes with the person first. Arguments are validated against the command\'s schema; describe_tools shows it.', readOnly:false,
    inputSchema:{ type:'object', properties:{ name:{ type:'string', minLength:1, maxLength:64, description:'A write command name.' }, arguments:argumentsSchema }, required:['name'], additionalProperties:false } },
];

// DP-0036-T12: the three tools of the code view (/mcp/code). `execute` runs the model's
// JavaScript in a Dynamic Worker isolate with no network; the only way out is
// `agentlinkops.<command>(args)`, which dispatches to the registry under the caller's scopes.
export const CODE_TOOLS = [
  { name:'search', description:'Find AgentLinkOps commands by what you want to do; returns names, toolsets and one-line summaries. Then describe for the exact signature.', readOnly:true,
    inputSchema:{ type:'object', properties:{ query:{ type:'string', minLength:1, maxLength:500, description:'Natural-language task or keywords.' }, toolset:{ type:'string', enum:TOOLSETS }, limit:{ type:'integer', minimum:1, maximum:25, description:'Maximum results; default 5.' } }, required:['query'], additionalProperties:false } },
  { name:'describe', description:'Read the TypeScript signature of one or more commands as they are callable from execute: agentlinkops.<name>(args) with the exact argument and result shapes, scopes and examples.', readOnly:true,
    inputSchema:{ type:'object', properties:{ names:{ type:'array', items:{ type:'string', minLength:1, maxLength:64 }, minItems:1, maxItems:10 } }, required:['names'], additionalProperties:false } },
  { name:'execute', description:'Run JavaScript against AgentLinkOps in an isolated sandbox. Write the body of an async function; `return` the value you want back; call commands as `await agentlinkops.<name>({...})` (any command, with this connection\'s scopes; retired names resolve). No network, no filesystem, no env: fetch() throws. Results over about 6,000 tokens are truncated with a marker, so filter and aggregate in code. Up to 200 command calls and 30 seconds per execution.', readOnly:false,
    inputSchema:{ type:'object', properties:{ code:{ type:'string', minLength:1, maxLength:64000, description:'JavaScript: the body of an async function, or an async arrow function.' }, readOnly:{ type:'boolean', description:'When true, any write command call fails instead of running. Default false.' } }, required:['code'], additionalProperties:false } },
];
export const CODE_LIMITS = { outputChars:24000, timeoutMs:30000, maxCalls:200 };

// Views. `entries` carry name, toolset, tier, readOnly and (from tool-exposure.js) unavailable.
// An unavailable command stays a member of its views: it is listed with its marker, never
// hidden, so a client that calls it gets the stable configuration error rather than not-found.
export const VIEW_BUDGETS = {
  default: { definitions:12, tokens:6000 },
  toolset: { definitions:22, tokens:8000 },
  code: { definitions:3, tokens:2000 },
  manifest: { tokens:2500 },
};
export function viewMembers(entries, view) {
  const visible = entries;
  const core = visible.filter(e => e.tier === 'core');
  if (view === 'all') return visible;
  if (view === 'readonly') return visible.filter(e => e.readOnly);
  if (view === 'default') return core;
  if (view === 'code') return [];
  const m = /^toolset:([a-z]+)(:readonly)?$/.exec(view);
  if (!m) throw new Error(`Unknown view ${view}`);
  const members = visible.filter(e => e.toolset === m[1] || e.tier === 'core');
  return m[2] ? members.filter(e => e.readOnly) : members;
}
export function viewNames(entries) {
  const toolsets = [...new Set(entries.map(e => e.toolset))].sort();
  return ['default','all','readonly','code', ...toolsets.flatMap(t => [`toolset:${t}`, `toolset:${t}:readonly`])];
}
