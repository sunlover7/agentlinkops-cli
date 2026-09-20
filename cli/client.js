import {restResponseContract} from '../shared/response-contract.js';
// A small HTTP client for the cloud. Scoped keys only; no human session ever reaches here.
// DP-0036-T13: the CLI names itself so the usage counters can tell it from other REST callers.
// The version follows the plugin manifests; bump it with them.
export const CLI_VERSION = '0.6.7';
export const CLI_USER_AGENT = `agentlinkops-cli/${CLI_VERSION}`;
export class CloudError extends Error {
  constructor(code, status, details = null) {
    super(`${code}${status ? ` (${status})` : ''}`);
    this.name = 'CloudError'; this.code = code; this.status = status; this.details = details;
    this.exitCode = 2;
  }
}

export function createClient({ origin, token, workspaceId, projectId, fetchImpl = globalThis.fetch } = {}) {
  if (!origin) throw new CloudError('NO_CLOUD_ORIGIN', 0);
  if (!token) throw new CloudError('NO_TOKEN', 0);
  const base = origin.replace(/\/$/u, '');
  async function call(method, path, { body = null, query = null } = {}) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url.href, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': CLI_USER_AGENT,
        ...(workspaceId ? { 'X-Workspace-ID': workspaceId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      // The error BODY is the useful part — a 410 carries the resync instructions, and losing
      // them would turn a recoverable expiry into "the sync failed, try again forever".
      throw new CloudError(payload?.error?.code ?? `HTTP_${response.status}`, response.status, payload?.error?.details ?? null);
    }
    const parsed=restResponseContract(path,method).safeParse(payload);
    if(!parsed.success)throw new CloudError('INVALID_RESPONSE',502);
    return parsed.data;
  }
  return {
    listCommands: () => call('GET', '/v1/commands', { query: { include: 'schemas' } }),
    describeCommand: name => call('GET', `/v1/commands/${encodeURIComponent(name)}`),
    callCommand: (name, args = {}) => call('POST', `/v1/commands/${encodeURIComponent(name)}`, { body: args }),
    getWorkspace: () => call('GET', '/v1/workspace'),
    getProject: projectId => call('GET', `/v1/projects/${encodeURIComponent(projectId)}`),
    importWatches: (projectId, watches) => call('POST', '/v1/watches/import', { body: { projectId, watches } }),
    updateWatch: (watchId, patch) => call('PATCH', `/v1/watches/${encodeURIComponent(watchId)}`, { body: patch }),
    listWatches: query => call('GET', '/v1/watches', { query: { ...query, ...(projectId ? { projectId } : {}) } }),
    listEvents: query => call('GET', '/v1/events', { query: { ...query, ...(projectId ? { projectId } : {}) } }),
    // The cloud keeps a SEPARATE sequence for target events. One client method per feed, because
    // one method with a flag is how two feeds end up sharing a cursor.
    listTargets: query => call('GET', '/v1/targets', { query: { ...query, ...(projectId ? { projectId } : {}) } }),
    listTargetEvents: query => call('GET', '/v1/target-events', { query: { ...query, ...(projectId ? { projectId } : {}) } }),
    exportWatches: query => call('GET', '/v1/exports/watches', { query: { ...query, ...(projectId ? { projectId } : {}) } }),
  };
}
