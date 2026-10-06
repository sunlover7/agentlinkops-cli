import {restResponseContract} from '../shared/response-contract.js';
import {CloudError} from './cloud-error.js';
import {createMcpClient} from './mcp-client.js';
export {CloudError} from './cloud-error.js';
// A small HTTP client for the cloud. Scoped keys only; no human session ever reaches here.
// DP-0036-T13: the CLI names itself so the usage counters can tell it from other REST callers.
// The version follows the plugin manifests; bump it with them.
export const CLI_VERSION = '0.6.11';
export const CLI_USER_AGENT = `agentlinkops-cli/${CLI_VERSION}`;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 5_000;
const retryableStatus = new Set([429, 503]);
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryAfterMs = (value, now) => {
  if (value == null || value === '') return null;
  if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
};
const backoffMs = attempt => Math.min(MAX_RETRY_WAIT_MS, 250 * 2 ** (attempt - 1));
const isTimeout = error => ['TimeoutError', 'AbortError'].includes(error?.name) || error?.code === 'ETIMEDOUT';
export function createClient({ origin, token, workspaceId, projectId, fetchImpl = globalThis.fetch,
  sleepImpl = sleepDefault, now = () => Date.now(), auth, credentialStore, createSdkClient, resolveHost } = {}) {
  if (!origin) throw new CloudError('NO_CLOUD_ORIGIN', 0);
  if (auth !== undefined && auth?.kind !== 'oauth') throw new CloudError('OAUTH_CONFIG_INVALID', 400);
  if (auth?.kind === 'oauth') {
    if (token) throw new CloudError('OAUTH_CREDENTIAL_CONFLICT', 400);
    return createMcpClient({origin, workspaceId, projectId, fetchImpl, sleepImpl, now, auth, credentialStore, createSdkClient, resolveHost});
  }
  if (!token) throw new CloudError('NO_TOKEN', 0);
  const base = origin.replace(/\/$/u, '');
  async function call(method, path, { body = null, query = null } = {}) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const safeRead = method.toUpperCase() === 'GET';
    let response, text, retryAfter = null, requestId = null;
    for (let attempt = 1; attempt <= (safeRead ? MAX_ATTEMPTS : 1); attempt++) {
      response = undefined; text = undefined; retryAfter = null; requestId = null;
      try {
        response = await fetchImpl(url.href, {
          method, redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': CLI_USER_AGENT,
            ...(workspaceId ? { 'X-Workspace-ID': workspaceId } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        retryAfter = response.headers.get('Retry-After');
        requestId = response.headers.get('X-Request-ID') ?? requestId;
        text = await response.text();
      } catch (error) {
        if (safeRead && attempt < MAX_ATTEMPTS) {
          if (response && retryableStatus.has(response.status)) {
            const serverDelay = retryAfterMs(retryAfter, now());
            const delay = serverDelay === null ? backoffMs(attempt)
              : serverDelay <= MAX_RETRY_WAIT_MS ? serverDelay : null;
            if (delay !== null) {
              await sleepImpl(delay);
              continue;
            }
            throw new CloudError(`HTTP_${response.status}`, response.status, null,
              'The server returned a temporary response and requested a longer wait. Retry after the stated interval.',
              null, { retryAfter, requestId });
          }
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        if (response && !response.ok) {
          throw new CloudError(`HTTP_${response.status}`, response.status, null,
            'The server response could not be read completely. Check the request result before trying again.',
            null, { retryAfter, requestId });
        }
        const timedOut = isTimeout(error);
        const code = timedOut ? 'CLOUD_TIMEOUT' : 'CLOUD_NETWORK_ERROR';
        const message = timedOut
          ? safeRead ? `The cloud read timed out after ${attempt} attempt${attempt === 1 ? '' : 's'}. Check the connection before trying again.` : 'The cloud request timed out. Check the operation result before sending it again.'
          : safeRead ? `The cloud connection failed after ${attempt} read attempt${attempt === 1 ? '' : 's'}. Check the connection before trying again.` : 'The cloud connection failed before the request returned a response. Check the operation result before sending it again.';
        throw new CloudError(code, 0, { attempts: attempt }, message, null, { requestId, retryAfter });
      }

      if (safeRead && retryableStatus.has(response.status) && attempt < MAX_ATTEMPTS) {
        const serverDelay = retryAfterMs(retryAfter, now());
        const delay = serverDelay === null ? backoffMs(attempt)
          : serverDelay <= MAX_RETRY_WAIT_MS ? serverDelay : null;
        // A Retry-After longer than our bounded wait is never shortened into an early retry.
        if (delay !== null) {
          await sleepImpl(delay);
          continue;
        }
      }
      break;
    }
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      // The error BODY is the useful part — a 410 carries the resync instructions, and losing
      // them would turn a recoverable expiry into "the sync failed, try again forever".
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      const id = payload?.error?.requestId ?? requestId;
      const envelope = payload?.error ? { ...payload.error } : null;
      throw new CloudError(code, response.status, payload?.error?.details ?? null,
        payload?.error?.message ?? null, envelope, { retryAfter, requestId: id });
    }
    const parsed=restResponseContract(path,method).safeParse(payload);
    if(!parsed.success)throw new CloudError('INVALID_RESPONSE',502,null,null,null,{requestId});
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
