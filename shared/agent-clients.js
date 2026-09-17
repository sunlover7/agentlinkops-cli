// DP-0036-T06: the client view table. Which MCP view each agent client should connect to and
// where it keeps skills and MCP configuration, from the client behavior recorded in the
// agent-surface research (docs/research/agent-surface-v2-2026-09-15/report.md §1 and §6).
// Read by `agentlinkops agent setup` (DP-0036-T09), GET /v1/catalog.json and the generators.
// Pure data; no imports. Paths use `~` for the home directory and are relative to the
// project root otherwise.
export const AGENT_CLIENTS = [
  {
    id: 'claude-code', name: 'Claude Code',
    detect: ['~/.claude', '~/.claude.json'],
    skills: { project: '.claude/skills', user: '~/.claude/skills' },
    mcp: { scope: 'project', file: '.mcp.json', format: 'mcpServers-json' },
    view: '/mcp/all', deferral: true,
    reason: 'Claude Code defers MCP tool definitions above about 10K tokens behind its own tool search, so the flat view keeps every annotation, parallel read dispatch and direct calls with no meta layer.',
  },
  {
    id: 'codex', name: 'Codex',
    detect: ['~/.codex'],
    skills: { project: '.agents/skills', user: '~/.agents/skills' },
    mcp: { scope: 'user', file: '~/.codex/config.toml', format: 'toml-mcp_servers' },
    view: '/mcp', deferral: false,
    reason: 'Codex loads MCP tools flat (its catalog limit is 2,048 definitions, not a context budget) and budgets the skill list at 2% of context, so the bounded default view keeps the connection small.',
  },
  {
    id: 'cursor', name: 'Cursor',
    detect: ['~/.cursor'],
    skills: { project: '.agents/skills', user: '~/.agents/skills' },
    mcp: { scope: 'project', file: '.cursor/mcp.json', format: 'mcpServers-json' },
    view: '/mcp', deferral: false,
    reason: 'Cursor caps active tools at 40 across every connected server and drops the rest silently; the default view uses nine definitions.',
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI',
    detect: ['~/.gemini'],
    skills: { project: '.agents/skills', user: '~/.agents/skills' },
    mcp: { scope: 'project', file: '.gemini/settings.json', format: 'mcpServers-httpUrl' },
    view: '/mcp', deferral: false,
    reason: 'Gemini CLI loads MCP tools flat and activates skills with a consent prompt; the default view keeps the listing small and the skills name the commands.',
  },
  {
    id: 'hermes', name: 'Hermes Agent',
    detect: ['~/.hermes'],
    skills: { user: '~/.hermes/skills' },
    mcp: { scope: 'user', file: '~/.hermes/config.yaml', format: 'yaml-mcp_servers' },
    view: '/mcp/all', deferral: true,
    reason: 'Hermes replaces deferred MCP tools with its own tool_search, tool_describe and tool_call bridge over a grouped manifest, so the flat view is the right input.',
  },
];
export const clientById = id => AGENT_CLIENTS.find(client => client.id === id) ?? null;
