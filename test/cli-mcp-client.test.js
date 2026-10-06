import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMcpClient } from '../cli/mcp-client.js';
import { CloudError } from '../cli/client.js';
import { CATALOG_COMMANDS } from '../cli/catalog.js';

const origin = 'https://app.example.com';
const binding = { issuer: 'https://identity.example.com', resource: origin + '/mcp', clientId: 'cli_fixture' };
const auth = { kind: 'oauth', ...binding, credentialRef: 'oauth_' + 'a'.repeat(32) };
const now = Date.parse('2026-09-30T12:00:00.000Z');
const tokens = { accessToken: 'opaque-fixture-token', refreshToken: 'fixture-refresh', expiresAt: now + 3600000, scope: 'offline_access projects:read watches:read' };
const reply = value => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
const page = { items: [], next_cursor: null };
const events = { events: [], next_cursor: 'feed_next', has_more: false };
const definition = { name: 'get_workspace', description: 'Workspace fixture.', inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, scopes: ['projects:read'], toolset: 'workspace', tier: 'core' };
const inputs = new Map(CATALOG_COMMANDS.map(command => [command.name, command.inputSchema]));

function credentialFixture(initial = tokens) {
  let record = { version: 1, revision: 1, binding, tokens: { ...initial } };
  const calls = [];
  return {
    calls,
    replace(value) { record = { ...record, revision: record.revision + 1, tokens: { ...value } }; },
    store: {
      async read(ref, supplied) {
        assert.equal(ref, auth.credentialRef); assert.deepEqual(supplied, binding);
        calls.push('read'); return structuredClone(record);
      },
      async withCredential(ref, supplied, callback) {
        assert.equal(ref, auth.credentialRef); assert.deepEqual(supplied, binding);
        calls.push('withCredential');
        const result = await callback(structuredClone(record));
        assert.ok(Object.hasOwn(result, 'value'));
        if (result.tokens) record = { ...record, revision: record.revision + 1, tokens: result.tokens };
        return result.value;
      },
    },
  };
}

function fixture({ handler, initialTokens, ...options } = {}) {
  const credentials = credentialFixture(initialTokens), calls = [], connections = [];
  const client = createMcpClient({ origin, auth, workspaceId: 'ws_fixture', projectId: 'pr_configured',
    now: () => now, credentialStore: credentials.store,
    fetchImpl: async () => assert.fail('unplanned HTTP request'),
    createSdkClient: async connection => {
      assert.ok([origin + '/mcp', origin + '/mcp/all'].includes(String(connection.url)));
      assert.equal(connection.workspaceId, 'ws_fixture');
      connections.push(connection);
      return {
        async callTool(request) {
          calls.push(request);
          const schema = inputs.get(request.name);
          if (schema) {
            const args = request.arguments ?? {};
            for (const key of Object.keys(args))
              assert.ok(Object.hasOwn(schema.properties, key), request.name + ': unsupported ' + key);
            for (const key of schema.required ?? [])
              assert.ok(Object.hasOwn(args, key), request.name + ': missing ' + key);
            if (Object.hasOwn(args, 'format'))
              assert.ok(schema.properties.format.enum.includes(args.format), request.name + ': invalid format');
          }
          if (handler) return handler(request);
          if (request.name === 'describe_tools') return reply({ tools: [definition] });
          if (request.name === 'list_events') return reply(events);
          if (['list_link_watches', 'list_targets', 'export_link_watches'].includes(request.name)) return reply(page);
          return reply({ id: 'fixture_result', received: request.arguments });
        },
        async listTools() { return { tools: [definition] }; },
        async close() {},
      };
    }, ...options });
  return { client, credentials, calls, connections };
}

test('OAuth MCP facade reads credentials lazily and uses fresh stored tokens without trusting their scope string', async () => {
  const f = fixture();
  assert.deepEqual(f.credentials.calls, []); assert.deepEqual(f.connections, []);
  await f.client.getWorkspace();
  assert.equal(f.connections[0].token, tokens.accessToken);
  f.credentials.replace({ ...tokens, accessToken: 'rotated-opaque-token', scope: 'untrusted:claim' });
  await f.client.getProject('pr_explicit');
  assert.equal(f.connections.at(-1).token, 'rotated-opaque-token');
  assert.equal(f.calls.at(-1).name, 'get_project');
  assert.deepEqual(f.calls.at(-1).arguments, { projectId: 'pr_explicit' });
});

test('facade helpers preserve explicit mutations and force configured project and independent feed selectors', async () => {
  const f = fixture(), query = { projectId: 'pr_override', cursor: 'links_cursor', limit: 7 };
  await f.client.listWatches(query);
  await f.client.listEvents({ ...query, feed: 'targets' });
  await f.client.listTargets({ ...query, cursor: 'targets_cursor' });
  await f.client.listTargetEvents({ ...query, cursor: 'targets_cursor', feed: 'links' });
  await f.client.exportWatches(query);
  const watches = [{ sourceUrl: 'https://publisher.example.com/article', targetUrl: 'https://example.com/' }];
  await f.client.importWatches('pr_explicit', watches);
  await f.client.updateWatch('wat_fixture', { status: 'paused' });
  await f.client.callCommand('create_project', { name: 'Explicit', domain: 'example.com' });
  assert.deepEqual(query, { projectId: 'pr_override', cursor: 'links_cursor', limit: 7 });
  assert.deepEqual(f.calls.map(c => [c.name, c.arguments]), [
    ['list_link_watches', { ...query, projectId: 'pr_configured', format: 'detailed' }],
    ['list_events', { ...query, projectId: 'pr_configured', feed: 'links', format: 'detailed' }],
    ['list_targets', { ...query, projectId: 'pr_configured', cursor: 'targets_cursor', format: 'detailed' }],
    ['list_events', { ...query, projectId: 'pr_configured', cursor: 'targets_cursor', feed: 'targets', format: 'detailed' }],
    ['export_link_watches', { ...query, projectId: 'pr_configured' }],
    ['import_link_watches', { projectId: 'pr_explicit', watches }],
    ['update_link_watch', { watchId: 'wat_fixture', status: 'paused' }],
    ['create_project', { name: 'Explicit', domain: 'example.com' }],
  ]);
});

test('generic calls default supported projections to detailed and preserve an explicit concise choice', async () => {
  const f = fixture();
  await f.client.callCommand('list_link_watches', { limit: 4 });
  await f.client.callCommand('list_link_watches', { limit: 4, format: 'concise' });
  await f.client.callCommand('export_link_watches', { limit: 4 });
  await f.client.callCommand('list_rank_history', { scheduleId: 'rank_fixture' });
  assert.deepEqual(f.calls.map(call => call.arguments), [
    { limit: 4, format: 'detailed' }, { limit: 4, format: 'concise' }, { limit: 4 },
    { scheduleId: 'rank_fixture', format: 'detailed' },
  ]);
});

test('direct factory rejects unknown credential kinds before reading or transmitting credentials', async () => {
  for (const kind of [undefined, 'api_key', 'session', 'unknown']) {
    const credentials = credentialFixture();
    await assert.rejects(async () => {
      const client = createMcpClient({ origin, auth: { ...auth, kind }, credentialStore: credentials.store,
        fetchImpl: async () => assert.fail('invalid credential kind must not reach HTTP') });
      await client.getWorkspace();
    }, { code: 'OAUTH_CONFIG_INVALID' });
    assert.deepEqual(credentials.calls, []);
  }
});

test('catalog and describe normalize SDK discovery into the REST facade shapes', async () => {
  const f = fixture();
  const catalog = await f.client.listCommands();
  assert.ok(Array.isArray(catalog.items)); assert.equal(catalog.items[0].name, definition.name);
  assert.deepEqual(catalog.items[0].scopes, ['projects:read']);
  assert.equal(catalog.items[0].toolset, 'workspace'); assert.equal(catalog.items[0].tier, 'core');
  assert.equal(catalog.items[0].annotations.readOnlyHint, true);
  assert.deepEqual(catalog.items[0].outputSchema, definition.outputSchema);
  assert.ok(f.connections.some(c => String(c.url) === origin + '/mcp/all'));
  const described = await f.client.describeCommand('get_workspace');
  assert.equal(described.name, 'get_workspace');
  assert.deepEqual(f.calls.at(-1), { name: 'describe_tools', arguments: { names: ['get_workspace'], include: 'input+output' } });
});

test('scoped MCP errors preserve recovery fields and never become successful empty data', async () => {
  const exposed = { code: 'INSUFFICIENT_SCOPE', message: 'Grant the required scope.', requestId: 'req_scoped',
    details: { requiredScope: 'watches:read' } };
  const f = fixture({ handler: () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: exposed }) }] }) });
  await assert.rejects(f.client.listWatches(), error => {
    assert.ok(error instanceof CloudError); assert.equal(error.code, exposed.code);
    assert.deepEqual(error.details, exposed.details); assert.equal(error.requestId, exposed.requestId);
    assert.equal(error.serverMessage, exposed.message); return true;
  });
  assert.equal(f.calls.length, 1);
});

test('invalid successful helper payload fails closed without retry', async () => {
  const f = fixture({ handler: () => reply({}) });
  await assert.rejects(f.client.listWatches(), { code: 'INVALID_RESPONSE', status: 502 });
  assert.equal(f.calls.length, 1);
});

test('full SDK catalog follows independent listTools cursors and refuses repeated cursors', async () => {
  const cursors = [], f = fixture({ createSdkClient: async () => ({
    async listTools(args) {
      cursors.push(args);
      return args.cursor ? { tools: [{ ...definition, name: 'get_project' }] }
        : { tools: [definition], nextCursor: 'catalog_second' };
    },
    async callTool({ name, arguments: args }) {
      assert.equal(name, 'describe_tools'); assert.equal(args.include, 'input+output');
      assert.ok(args.names.length <= 10);
      return reply({ tools: args.names.map(name => ({ ...definition, name })) });
    }, async close() {},
  }) });
  assert.deepEqual((await f.client.listCommands()).items.map(item => item.name), ['get_workspace', 'get_project']);
  assert.deepEqual(cursors, [{ cursor: '' }, { cursor: 'catalog_second' }]);
  const loop = fixture({ createSdkClient: async () => ({
    async listTools() { return { tools: [], nextCursor: 'repeated' }; }, async close() {},
  }) });
  await assert.rejects(loop.client.listCommands(), { code: 'INVALID_RESPONSE', status: 502 });
});

test('catalog metadata hydrates authoritative descriptions in batches of at most ten', async () => {
  const listed = Array.from({ length: 11 }, (_, index) => ({ ...definition, name: 'fixture_' + index,
    toolset: 'untrusted-listing', tier: 'deferred', scopes: ['forged:scope'] }));
  const batches = [], f = fixture({ createSdkClient: async () => ({
    async listTools() { return { tools: listed }; },
    async callTool({ name, arguments: args }) {
      assert.equal(name, 'describe_tools'); assert.equal(args.include, 'input+output'); batches.push(args.names);
      return reply({ tools: args.names.map(name => ({ ...definition, name })) });
    }, async close() {},
  }) });
  const result = await f.client.listCommands();
  assert.deepEqual(batches.map(batch => batch.length), [10, 1]);
  assert.equal(result.items.length, 11);
  for (const item of result.items) {
    assert.equal(item.toolset, 'workspace'); assert.equal(item.tier, 'core');
    assert.deepEqual(item.scopes, ['projects:read']); assert.equal(item.annotations.readOnlyHint, true);
  }
});

test('write timeout, 401 and arbitrary callCommand failures never replay', async () => {
  for (const failure of [new DOMException('lost reply', 'TimeoutError'), Object.assign(new Error('401'), { status: 401 })]) {
    const waits = [], f = fixture({ handler: () => { throw failure; }, sleepImpl: async ms => waits.push(ms) });
    await assert.rejects(f.client.updateWatch('wat_fixture', { status: 'paused' }));
    assert.equal(f.calls.length, 1); assert.deepEqual(waits, []);
  }
  const f = fixture({ handler: () => { throw new TypeError('reply lost'); } });
  await assert.rejects(f.client.callCommand('unknown_fixture', {}, { readOnly: true }));
  assert.equal(f.calls.length, 1);
});

test('safe reads retry at most three times while authentication failure never retries', async () => {
  const waits = [], f = fixture({ handler: () => { throw new DOMException('timeout', 'TimeoutError'); },
    sleepImpl: async ms => waits.push(ms) });
  await assert.rejects(f.client.listWatches());
  assert.equal(f.calls.length, 3); assert.deepEqual(waits, [250, 500]);
  const denied = fixture({ handler: () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
    sleepImpl: async () => assert.fail('401 must not retry') });
  await assert.rejects(denied.client.getWorkspace()); assert.equal(denied.calls.length, 1);
});

test('safe read throttling respects Retry-After without shortening a wait beyond five seconds', async () => {
  for (const retryAfter of ['2', new Date(now + 3000).toUTCString(), '6']) {
    const waits = [], failure = new CloudError('RATE_LIMITED', 429, null, 'Wait before retrying.', null,
      { retryAfter, requestId: 'req_throttled' });
    const f = fixture({ handler: () => { throw failure; }, sleepImpl: async ms => waits.push(ms) });
    await assert.rejects(f.client.listWatches(), error => {
      assert.equal(error.code, 'RATE_LIMITED'); assert.equal(error.retryAfter, retryAfter);
      assert.equal(error.requestId, 'req_throttled'); return true;
    });
    assert.equal(f.calls.length, retryAfter === '6' ? 1 : 3);
    assert.deepEqual(waits, retryAfter === '2' ? [2000, 2000] : retryAfter === '6' ? [] : [3000, 3000]);
  }
});

test('expired credentials refresh within the store lock and bind discovery and token exchange without bearer leakage', async () => {
  const requests = [], f = fixture({ initialTokens: { ...tokens, expiresAt: now - 1 },
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.redirect, 'error');
    if (request.url === origin + '/.well-known/oauth-protected-resource/mcp') return Response.json({
      resource: binding.resource, authorization_servers: [binding.issuer], scopes_supported: ['projects:read', 'watches:read'] });
    if (request.url === binding.issuer + '/.well-known/oauth-authorization-server') return Response.json({
      issuer: binding.issuer, authorization_endpoint: binding.issuer + '/authorize', token_endpoint: binding.issuer + '/token',
      code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: tokens.scope.split(' ') });
    assert.equal(request.url, binding.issuer + '/token'); assert.equal(request.method, 'POST');
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get('resource'), binding.resource); assert.equal(form.get('client_id'), binding.clientId);
    assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), tokens.refreshToken);
    return Response.json({ access_token: 'refreshed-opaque-token', refresh_token: 'rotated-refresh-token', token_type: 'Bearer',
      expires_in: 3600, scope: tokens.scope });
  } });
  await f.client.getWorkspace();
  assert.ok(f.credentials.calls.includes('withCredential'));
  assert.equal(f.connections.at(-1).token, 'refreshed-opaque-token');
  await f.client.getProject('pr_fixture');
  assert.equal(f.connections.at(-1).token, 'refreshed-opaque-token');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1, 'retained refresh result avoids a second exchange');
});

test('mismatched resource or noncanonical origin refuses before exposing credentials', async () => {
  for (const settings of [
    { auth: { ...auth, resource: 'https://other.example.test/mcp' } },
    { origin: origin + '/v1' }, { origin: origin + '?secret=1' },
    { origin: 'http://app.example.test' }, { origin: 'https://user:pass@app.example.test' },
  ]) {
    const credentials = credentialFixture();
    await assert.rejects(async () => {
      const client = createMcpClient({ origin, auth, credentialStore: credentials.store,
        fetchImpl: async () => assert.fail('invalid binding must not reach HTTP'), ...settings });
      await client.getWorkspace();
    });
    assert.deepEqual(credentials.calls, []);
  }
});

test('real SDK HTTP errors redact bearer and credential material while retaining safe recovery', async () => {
  const key = 'lt_' + 'a'.repeat(64), jwt = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)].join('.');
  const credentials = credentialFixture(); let calls = 0;
  const client = createMcpClient({ origin, auth, credentialStore: credentials.store, now: () => now,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init); assert.equal(request.url, binding.resource);
      assert.equal(request.headers.get('authorization'), 'Bearer ' + tokens.accessToken); calls++;
      return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Rejected ' + tokens.accessToken,
        requestId: 'req_safe', details: { next: 'Reconnect through the configured issuer.', access_token: 'hidden-access',
          refreshToken: 'hidden-refresh', password: 'hidden-password', authorization: 'hidden-auth',
          cookie: 'hidden-cookie', nested: { content: jwt, reference: key, sample: tokens.accessToken } } } }, { status: 401 });
    } });
  await assert.rejects(client.getWorkspace(), error => {
    assert.ok(error instanceof CloudError); assert.equal(error.code, 'UNAUTHORIZED'); assert.equal(error.status, 401);
    assert.equal(error.requestId, 'req_safe'); assert.equal(error.details.next, 'Reconnect through the configured issuer.');
    const serialized = JSON.stringify({ message: error.serverMessage, details: error.details, publicError: error.publicError });
    for (const secret of [tokens.accessToken, key, jwt, 'hidden-access', 'hidden-refresh', 'hidden-password', 'hidden-auth', 'hidden-cookie'])
      assert.ok(!serialized.includes(secret), secret);
    return true;
  });
  assert.equal(calls, 1);
});

test('real SDK oversized error body cancels the stream and refuses unbounded error parsing', async () => {
  const credentials = credentialFixture(); let calls = 0, cancelled = false;
  const body = new TextEncoder().encode(JSON.stringify({ error: { code: 'BODY_MUST_NOT_PARSE',
    message: tokens.accessToken + 'x'.repeat(70000) } }));
  const client = createMcpClient({ origin, auth, credentialStore: credentials.store, now: () => now,
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(body); },
        cancel() { cancelled = true; },
      }), { status: 401, headers: { 'content-type': 'application/json', 'X-Request-ID': 'req_oversize' } });
    } });
  await assert.rejects(client.getWorkspace(), error => {
    assert.equal(error.code, 'HTTP_401'); assert.equal(error.status, 401); assert.equal(error.requestId, 'req_oversize');
    assert.ok(!JSON.stringify(error.publicError).includes(tokens.accessToken));
    assert.ok(!JSON.stringify(error.publicError).includes('BODY_MUST_NOT_PARSE')); return true;
  });
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test('real SDK Streamable HTTP initializes, lists and calls tools using canonical bearer-bound MCP URLs', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push({ path: req.url, authorization: req.headers.authorization,
      workspace: req.headers['x-workspace-id'], body });
    if (body.method?.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
    let result;
    if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'facade-protocol-fixture', version: '1.0.0' } };
    else if (body.method === 'tools/list') result = { tools: [definition] };
    else if (body.method === 'tools/call') {
      assert.equal(req.url, '/mcp', 'flat catalog view must not receive meta or operation calls');
      result = body.params.name === 'describe_tools'
        ? reply({ tools: [definition] }) : reply({ id: 'ws_fixture', transport: 'real-sdk' });
    }
    else { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const forwarded = [], credentials = credentialFixture();
  const client = createMcpClient({ origin, auth, workspaceId: 'ws_fixture', credentialStore: credentials.store, now: () => now,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      assert.equal(url.origin, origin); assert.ok(['/mcp', '/mcp/all'].includes(url.pathname));
      assert.equal(url.search, ''); assert.equal(url.hash, '');
      assert.equal(request.headers.get('authorization'), 'Bearer ' + tokens.accessToken);
      assert.equal(request.headers.get('x-workspace-id'), 'ws_fixture');
      forwarded.push(url.href);
      const response = await fetch('http://127.0.0.1:' + server.address().port + url.pathname, {
        method: request.method, headers: request.headers,
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.text() } : {}), redirect: 'error',
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    } });
  assert.equal((await client.getWorkspace()).transport, 'real-sdk');
  assert.equal((await client.listCommands()).items[0].name, 'get_workspace');
  assert.equal((await client.describeCommand('get_workspace')).name, 'get_workspace');
  assert.ok(requests.some(r => r.body.method === 'initialize'));
  assert.ok(requests.some(r => r.body.method === 'tools/list' && r.path === '/mcp/all'));
  assert.ok(requests.some(r => r.body.method === 'tools/call' && r.body.params.name === 'get_workspace'));
  assert.ok(forwarded.every(url => url === origin + '/mcp' || url === origin + '/mcp/all'));
});

async function realSdkCatalogFixture(t, listPage) {
  const requests = [], failures = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push({ path: req.url, body });
      if (body.method?.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      let result;
      if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'pagination-protocol-fixture', version: '1.0.0' } };
      else if (body.method === 'tools/list') {
        assert.equal(req.url, '/mcp/all');
        assert.ok(Object.hasOwn(body.params ?? {}, 'cursor'), 'catalog reads must remain explicit per-page SDK requests');
        result = listPage(body.params.cursor);
      } else if (body.method === 'tools/call') {
        assert.equal(req.url, '/mcp');
        assert.equal(body.params.name, 'describe_tools');
        assert.equal(body.params.arguments.include, 'input+output');
        const names = body.params.arguments.names;
        assert.ok(names.length > 0 && names.length <= 10);
        result = reply({ tools: names.map(name => ({ ...definition, name, description: `Authoritative ${name}.` })) });
      } else assert.fail(`Unexpected fixture method: ${body.method}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      failures.push(error);
      res.writeHead(500); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, [], 'controlled protocol server received no unexpected requests');
  });
  const credentials = credentialFixture();
  const client = createMcpClient({ origin, auth, workspaceId: 'ws_fixture', credentialStore: credentials.store, now: () => now,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      assert.equal(url.origin, origin); assert.ok(['/mcp', '/mcp/all'].includes(url.pathname));
      assert.equal(url.search, ''); assert.equal(url.hash, '');
      assert.equal(request.headers.get('authorization'), 'Bearer ' + tokens.accessToken);
      assert.equal(request.headers.get('x-workspace-id'), 'ws_fixture');
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, {
        method: request.method, headers: request.headers,
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.text() } : {}), redirect: 'error',
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    } });
  return { client, requests,
    listed: () => requests.filter(request => request.body.method === 'tools/list'),
    described: () => requests.filter(request => request.body.method === 'tools/call'),
  };
}

test('real SDK catalog preserves ordered pages and hydrates every listed tool after the complete walk', async t => {
  const pages = new Map([
    ['', { tools: [definition], nextCursor: 'second' }],
    ['second', { tools: [{ ...definition, name: 'get_project' }], nextCursor: 'third' }],
    ['third', { tools: [{ ...definition, name: 'list_targets' }] }],
  ]);
  const f = await realSdkCatalogFixture(t, cursor => {
    assert.ok(pages.has(cursor), `Unexpected catalog cursor: ${cursor}`);
    return pages.get(cursor);
  });
  const result = await f.client.listCommands();
  const names = ['get_workspace', 'get_project', 'list_targets'];
  assert.deepEqual(result.items.map(item => item.name), names);
  assert.deepEqual(f.listed().map(request => request.body.params.cursor), ['', 'second', 'third']);
  assert.deepEqual(f.described().map(request => request.body.params.arguments.names), [names]);
  assert.ok(f.requests.indexOf(f.described()[0]) > f.requests.indexOf(f.listed().at(-1)), 'metadata is hydrated only after all pages pass');
  for (const item of result.items) {
    assert.equal(item.description, `Authoritative ${item.name}.`);
    assert.deepEqual(item.scopes, ['projects:read']);
    assert.equal(item.annotations.readOnlyHint, true);
  }
});

test('real SDK repeated catalog page refuses instead of returning a silently truncated aggregate', async t => {
  const f = await realSdkCatalogFixture(t, cursor => {
    assert.ok(['', 'repeated'].includes(cursor));
    return { tools: [definition], nextCursor: 'repeated' };
  });
  await assert.rejects(f.client.listCommands(), { code: 'INVALID_RESPONSE', status: 502 });
  assert.deepEqual(f.listed().map(request => request.body.params.cursor), ['', 'repeated']);
  assert.equal(f.described().length, 0, 'an incomplete catalog cannot reach metadata hydration');
});

test('real SDK catalog enforces facade page and item bounds before another page or metadata request', async t => {
  for (const terminalPage of [100, 101]) await t.test(`${terminalPage} offered pages`, async t => {
    const f = await realSdkCatalogFixture(t, cursor => {
      const number = cursor === '' ? 1 : Number(/^page_(\d+)$/u.exec(cursor)?.[1]);
      assert.ok(Number.isInteger(number) && number >= 1 && number <= terminalPage);
      return { tools: [{ ...definition, name: `fixture_${number}` }],
        ...(number < terminalPage ? { nextCursor: `page_${number + 1}` } : {}) };
    });
    if (terminalPage === 100) {
      const result = await f.client.listCommands();
      assert.equal(result.items.length, 100);
      assert.equal(result.items.at(-1).name, 'fixture_100');
      assert.equal(f.described().length, 10);
    } else {
      await assert.rejects(f.client.listCommands(), { code: 'INVALID_RESPONSE', status: 502 });
      assert.equal(f.described().length, 0);
    }
    assert.equal(f.listed().length, 100, 'the 101st page is never requested');
    assert.equal(f.listed().at(-1).body.params.cursor, 'page_100');
  });
  for (const count of [1000, 1001]) await t.test(`${count} offered items`, async t => {
    const f = await realSdkCatalogFixture(t, cursor => {
      assert.equal(cursor, '');
      return { tools: Array.from({ length: count }, (_, index) => ({ ...definition, name: `fixture_${index}` })) };
    });
    if (count === 1000) {
      const result = await f.client.listCommands();
      assert.equal(result.items.length, 1000);
      assert.equal(result.items.at(-1).name, 'fixture_999');
      assert.equal(f.described().length, 100);
    } else {
      await assert.rejects(f.client.listCommands(), { code: 'INVALID_RESPONSE', status: 502 });
      assert.equal(f.described().length, 0);
    }
    assert.equal(f.listed().length, 1);
  });
});
