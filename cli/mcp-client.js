import {CloudError} from './cloud-error.js';
import {createOAuthCredentialStore} from './oauth-credentials.js';
import {discoverOAuth, refreshOAuthTokens} from './oauth-flow.js';
import {restResponseContract} from '../shared/response-contract.js';
import {SHAPES} from '../src/response-shaping.js';

const sleepDefault = ms => new Promise(done => setTimeout(done, ms));
const fail = (code, status = 400) => { throw new CloudError(code, status); };
const ERROR_BYTES = 65536;
const sensitive = (text, token) => typeof text === 'string' && (token && text.includes(token)
  || /\blt_[a-f0-9]{64}\b|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/.test(text));
function publicError(value, token, depth = 0) {
  if (depth > 8) return '[redacted]';
  if (typeof value === 'string') return sensitive(value, token) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => publicError(item, token, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100)
    .filter(([key]) => !/token|authorization|password|secret|cookie|session/i.test(key))
    .map(([key, item]) => [key, publicError(item, token, depth + 1)]));
  return value;
}
async function boundedError(response) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > ERROR_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size)));
  } catch { return null; } finally { reader.releaseLock(); }
}
const statusOf = error => (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : null) ?? ({INSUFFICIENT_SCOPE: 403, AGENT_APPROVAL_REQUIRED: 403,
  GRANT_REVOKED: 401, UNAUTHORIZED: 401, CURSOR_EXPIRED: 410, RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429, SERVICE_UNAVAILABLE: 503}[error.code]) ?? 400;
function payloadOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try { return JSON.parse(result?.content?.find(item => item.type === 'text')?.text); }
  catch { fail('INVALID_RESPONSE', 502); }
}
function normalized(result, token) {
  const data = payloadOf(result);
  if (result?.isError) {
    const error = publicError(data?.error, token);
    if (!error || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,100}$/.test(error.code)) fail('INVALID_RESPONSE', 502);
    throw new CloudError(error.code, statusOf(error), error.details ?? null, error.message ?? null,
      error, {retryAfter: error.retryAfter ?? publicError(result.retryAfter, token) ?? null,
        requestId: error.requestId ?? publicError(result.requestId, token) ?? null});
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_RESPONSE', 502);
  return data;
}
function retryDelay(error, attempt, now) {
  if (!(error instanceof CloudError) || ![0, 429, 503].includes(error.status)) return null;
  if (error.status === 0 && !['CLOUD_NETWORK_ERROR', 'CLOUD_TIMEOUT'].includes(error.code)) return null;
  const value = error.retryAfter;
  if (value == null || value === '') return Math.min(5000, 250 * 2 ** (attempt - 1));
  const delay = /^\d+$/.test(String(value).trim()) ? Number(value) * 1000 : Date.parse(value) - now();
  return Number.isFinite(delay) && delay >= 0 && delay <= 5000 ? delay : null;
}

async function sdkClient({url, token, workspaceId, fetchImpl}) {
  const {Client, StreamableHTTPClientTransport} = await import('@modelcontextprotocol/client');
  const client = new Client({name: 'agentlinkops-cli', version: '0.6.10'});
  const destination = new URL(url);
  const transport = new StreamableHTTPClientTransport(destination, {
    authProvider: {token: async () => token},
    fetch: async (input, init = {}) => {
      const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (target.href !== destination.href) fail('OAUTH_TOKEN_DESTINATION_MISMATCH');
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      if (workspaceId) headers.set('X-Workspace-ID', workspaceId);
      headers.set('User-Agent', 'agentlinkops-cli/0.6.10');
      const response = await fetchImpl(input, {...init, headers, redirect: 'error', signal: AbortSignal.timeout(30000)});
      if (response.redirected || response.status >= 300 && response.status < 400
        || response.url && response.url !== destination.href) fail('OAUTH_TOKEN_DESTINATION_MISMATCH');
      if (!response.ok) {
        const data = await boundedError(response), error = publicError(data?.error, token);
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code)
          ? error.code : `HTTP_${response.status}`;
        throw new CloudError(code, response.status, error?.details ?? null,
          error?.message ?? null, error ?? null,
          {retryAfter: publicError(response.headers.get('Retry-After'), token),
            requestId: error?.requestId ?? publicError(response.headers.get('X-Request-ID'), token)});
      }
      return response;
    },
  });
  try { await client.connect(transport, {timeout: 30000}); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}

export function createMcpClient({origin, auth, workspaceId, projectId, credentialStore,
  createSdkClient = sdkClient, fetchImpl = globalThis.fetch, sleepImpl = sleepDefault, now = Date.now, resolveHost} = {}) {
  let base, issuer;
  try { base = new URL(origin); issuer = new URL(auth?.issuer); } catch { fail('OAUTH_CONFIG_INVALID'); }
  if (base.protocol !== 'https:' || base.origin !== origin || issuer.protocol !== 'https:' || issuer.origin !== auth?.issuer
    || auth?.kind !== 'oauth' || auth.resource !== `${origin}/mcp` || typeof auth.clientId !== 'string'
    || !auth.clientId || auth.clientId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(auth.clientId)
    || !/^oauth_[a-f0-9]{32}$/.test(auth.credentialRef ?? '')) fail('OAUTH_CONFIG_INVALID');
  const binding = {issuer: auth.issuer, resource: auth.resource, clientId: auth.clientId};
  const store = credentialStore ?? createOAuthCredentialStore();
  async function currentToken() {
    try {
      await store.read(auth.credentialRef, binding);
      return await store.withCredential(auth.credentialRef, binding, async record => {
        if (record.tokens.expiresAt > now() + 30000) return {value: record.tokens.accessToken};
        const plan = await discoverOAuth({origin, ...binding, scopes: record.tokens.scope.split(' '), fetchImpl, resolveHost});
        const tokens = await refreshOAuthTokens({plan, tokens: record.tokens, fetchImpl, now});
        return {tokens, value: tokens.accessToken};
      });
    } catch (error) {
      if (error instanceof CloudError) throw error;
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'OAUTH_CREDENTIAL_UNAVAILABLE';
      throw new CloudError(code, 401, null, 'OAuth credentials could not be used. Reconnect through the configured issuer; do not repeat an unresolved write.');
    }
  }
  async function perform(operation, {safeRead = false, all = false} = {}) {
    for (let attempt = 1; attempt <= (safeRead ? 3 : 1); attempt++) {
      const token = await currentToken();
      let client;
      try {
        client = await createSdkClient({url: all ? `${origin}/mcp/all` : auth.resource, token, workspaceId, fetchImpl});
        return await operation(client, token);
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
        const failure = error instanceof CloudError ? error : status !== null ? new CloudError(`HTTP_${status}`, status,
          null, 'The cloud request was refused.', null, {retryAfter: error.retryAfter ?? null, requestId: error.requestId ?? null}) : new CloudError(
          ['AbortError', 'TimeoutError'].includes(error?.name) ? 'CLOUD_TIMEOUT' : 'CLOUD_NETWORK_ERROR', 0,
          {attempts: attempt}, safeRead ? 'The cloud read failed. Check the connection before retrying.'
            : 'The cloud request did not return a conclusive result. Check its outcome before sending it again.');
        const delay = safeRead && attempt < 3 ? retryDelay(failure, attempt, now) : null;
        if (delay === null) throw failure;
        await sleepImpl(delay);
      } finally { await client?.close().catch(() => {}); }
    }
  }
  const detailed = (name, args) => Object.hasOwn(SHAPES, name) ? {format: 'detailed', ...args} : args;
  const scoped = (name, args) => detailed(name, {...args, ...(projectId ? {projectId} : {})});
  const tool = (name, args, safeRead = false, path = null, method = 'GET') => perform(async (client, token) => {
    const data = normalized(await client.callTool({name, arguments: args}, {timeout: 30000}), token);
    if (!path) return data;
    const parsed = restResponseContract(path, method).safeParse(data);
    if (!parsed.success) fail('INVALID_RESPONSE', 502);
    return parsed.data;
  }, {safeRead});
  return {
    listCommands: () => perform(async (client, token) => {
      const items = []; let cursor = '';
      const visited = new Set([cursor]);
      do {
        // An explicit cursor selects the SDK's per-page path. A missing cursor
        // auto-aggregates and can hide a repeated-page stop from our own guards.
        const page = await client.listTools({cursor});
        if (!Array.isArray(page?.tools)) fail('INVALID_RESPONSE', 502);
        items.push(...page.tools);
        if (items.length > 1000) fail('INVALID_RESPONSE', 502);
        if (page.nextCursor === undefined) break;
        if (typeof page.nextCursor !== 'string' || !page.nextCursor
          || visited.has(page.nextCursor) || visited.size >= 100) fail('INVALID_RESPONSE', 502);
        cursor = page.nextCursor; visited.add(cursor);
      } while (true);
      // Meta tools are registered only on the default view, not the flat listing.
      const meta = await createSdkClient({url: auth.resource, token, workspaceId, fetchImpl});
      try {
        const described = new Map();
        for (let start = 0; start < items.length; start += 10) {
          const names = items.slice(start, start + 10).map(item => item.name);
          if (names.some(name => typeof name !== 'string' || !name || name.length > 64)) fail('INVALID_RESPONSE', 502);
          const data = normalized(await meta.callTool({name: 'describe_tools',
            arguments: {names, include: 'input+output'}}, {timeout: 30000}), token);
          if (!Array.isArray(data.tools) || data.tools.length !== names.length || data.unknown?.length) fail('INVALID_RESPONSE', 502);
          for (const item of data.tools) {
            if (!names.includes(item.name) || described.has(item.name)) fail('INVALID_RESPONSE', 502);
            described.set(item.name, item);
          }
        }
        return {items: items.map(item => ({...item, ...described.get(item.name), annotations: item.annotations}))};
      } finally { await meta.close().catch(() => {}); }
    }, {safeRead: true, all: true}),
    describeCommand: name => perform(async (client, token) => {
      const data = normalized(await client.callTool({name: 'describe_tools', arguments: {names: [name], include: 'input+output'}}, {timeout: 30000}), token);
      if (!Array.isArray(data?.tools) || data.tools.length !== 1) fail('INVALID_RESPONSE', 502);
      return data.tools[0];
    }, {safeRead: true}),
    callCommand: (name, args = {}) => tool(name, detailed(name, args)),
    getWorkspace: () => tool('get_workspace', {}, true, '/v1/workspace'),
    getProject: id => tool('get_project', {projectId: id}, true, '/v1/projects/' + encodeURIComponent(id)),
    importWatches: (id, watches) => tool('import_link_watches', {projectId: id, watches}, false, '/v1/watches/import', 'POST'),
    updateWatch: (watchId, patch) => tool('update_link_watch', {...patch, watchId}, false, '/v1/watches/' + encodeURIComponent(watchId), 'PATCH'),
    listWatches: query => tool('list_link_watches', scoped('list_link_watches', query), true, '/v1/watches'),
    listEvents: query => tool('list_events', {...scoped('list_events', query), feed: 'links'}, true, '/v1/events'),
    listTargets: query => tool('list_targets', scoped('list_targets', query), true, '/v1/targets'),
    listTargetEvents: query => tool('list_events', {...scoped('list_events', query), feed: 'targets'}, true, '/v1/target-events'),
    exportWatches: query => tool('export_link_watches', scoped('export_link_watches', query), true, '/v1/exports/watches'),
  };
}
