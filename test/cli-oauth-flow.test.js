import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {discoverOAuth, receiveOAuthConsent, exchangeOAuthCode, refreshOAuthTokens} from '../cli/oauth-flow.js';

const options = {origin: 'https://app.example.com', issuer: 'https://clerk.example.com',
  clientId: 'existing-public-client', scopes: ['projects:read', 'offline_access']};
const resolveHost = async () => [{address: '8.8.8.8'}];
const resource = `${options.origin}/mcp`, clock = 1800000000000;
const errorCode = value => error => error.code === value && error.message === value;
const jwt = claims => [Buffer.from(JSON.stringify({alg: 'RS256'})).toString('base64url'),
  Buffer.from(JSON.stringify({iss: options.issuer, aud: resource, exp: clock / 1000 + 3600, ...claims})).toString('base64url'), 'signature'].join('.');
function fixture({resourceChange = {}, issuerChange = {}, tokens = {}} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, init});
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/.well-known/oauth-protected-resource/mcp'))
      return Response.json({resource, authorization_servers: [options.issuer], scopes_supported: ['projects:read'], ...resourceChange});
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return Response.json({issuer: options.issuer, authorization_endpoint: `${options.issuer}/authorize`,
        token_endpoint: `${options.issuer}/token`, code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'], response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true, ...issuerChange});
    assert.equal(url, `${options.issuer}/token`);
    const fields = new URLSearchParams(init.body);
    assert.equal(fields.get('client_id'), options.clientId);
    assert.equal(fields.get('resource'), resource);
    return Response.json({access_token: 'opaque-access', refresh_token: 'opaque-refresh', token_type: 'Bearer',
      expires_in: 3600, scope: 'offline_access projects:read', ...tokens});
  };
  return {fetchImpl, calls, discover: extra => discoverOAuth({...options, fetchImpl, resolveHost, ...extra})};
}
async function callback(url) {
  const response = await fetch(url, {redirect: 'manual'});
  await response.text();
  return response.status;
}
async function consent(plan, inspect = async () => {}) {
  let authorizationUrl;
  const authorization = await receiveOAuthConsent({plan, scopes: options.scopes, timeoutMs: 5000,
    async onAuthorization(value) {
      authorizationUrl = new URL(value.authorizationUrl);
      await inspect(value, authorizationUrl);
      const response = new URL(value.redirectUri);
      response.searchParams.set('state', authorizationUrl.searchParams.get('state'));
      response.searchParams.set('iss', plan.issuer);
      response.searchParams.set('code', 'private-code');
      assert.equal(await callback(response), 303);
    }});
  return {authorization, authorizationUrl};
}

test('OAuth discovery binds canonical resource, issuer, existing client and explicit scopes without registration', async () => {
  const f = fixture(), plan = await f.discover();
  assert.equal(plan.resource, resource);
  assert.deepEqual(plan.scopes, ['offline_access', 'projects:read']);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.scopes), true);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => !c.init.method));
  await assert.rejects(f.discover({scopes: ['projects:read']}), errorCode('INVALID_OAUTH_SCOPES'));
  await assert.rejects(f.discover({scopes: ['projects:read', 'projects:read', 'offline_access']}), errorCode('INVALID_OAUTH_SCOPES'));
  await assert.rejects(f.discover({scopes: ['watches:read', 'offline_access']}), errorCode('RESOURCE_SCOPES_MISSING'));
});

test('malicious discovery refuses private origins, foreign endpoints, credentials, query and issuer mismatches', async () => {
  for (const origin of ['http://app.example.com', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]',
    'https://localhost', 'https://foo.internal', 'https://user:private@app.example.com', `${options.origin}/path`])
    await assert.rejects(fixture().discover({origin}), errorCode('CANONICAL_HTTPS_ORIGIN_REQUIRED'));
  for (const token_endpoint of ['https://foreign.example.com/token', 'https://127.0.0.1/token',
    `${options.issuer}/token?secret=private`, `${options.issuer}/token?`, `${options.issuer}/token#`, 'https://secret@clerk.example.com/token'])
    await assert.rejects(fixture({issuerChange: {token_endpoint}}).discover(), errorCode('ISSUER_ENDPOINT_INVALID'));
  await assert.rejects(fixture({resourceChange: {authorization_servers: [options.issuer, 'https://other.example.com']}}).discover(), errorCode('RESOURCE_DISCOVERY_MISMATCH'));
  await assert.rejects(fixture({issuerChange: {issuer: 'https://other.example.com'}}).discover(), errorCode('ISSUER_DISCOVERY_MISMATCH'));
  await assert.rejects(fixture({issuerChange: {code_challenge_methods_supported: ['plain']}}).discover(), errorCode('PKCE_DISCOVERY_FAILED'));
  await assert.rejects(fixture({issuerChange: {token_endpoint_auth_methods_supported: ['client_secret_basic']}}).discover(), errorCode('EXISTING_PUBLIC_CLIENT_REQUIRED'));
});

test('discovery rejects redirects and streams stop before oversized responses finish allocation', async () => {
  await assert.rejects(discoverOAuth({...options, resolveHost, fetchImpl: async () => new Response('private', {status: 302,
    headers: {'Content-Type': 'application/json', Location: 'https://foreign.example.com'}})}), errorCode('OAUTH_REDIRECT_REFUSED'));
  let pulls = 0, canceled = false;
  const fetchImpl = async () => new Response(new ReadableStream({pull(controller) {
    pulls++; controller.enqueue(new Uint8Array(65536));
  }, cancel() { canceled = true; }}), {headers: {'Content-Type': 'application/json'}});
  await assert.rejects(discoverOAuth({...options, resolveHost, fetchImpl}), errorCode('RESPONSE_TOO_LARGE'));
  assert.ok(pulls < 25); assert.equal(canceled, true);
  await assert.rejects(discoverOAuth({...options, resolveHost, fetchImpl: async () => { throw new Error('private-token provider-body'); }}), errorCode('OAUTH_REQUEST_FAILED'));
});

test('DNS preflight refuses private/mixed/empty results and rechecks token destination without rebinding claims', async () => {
  for (const addresses of [[{address: '127.0.0.1'}], [{address: '::1'}], [{address: '::ffff:10.0.0.1'}],
    [{address: '8.8.8.8'}, {address: '192.168.1.1'}], [{address: '169.254.169.254'}], [], [{address: 'not-an-address'}]]) {
    const f = fixture();
    await assert.rejects(f.discover({resolveHost: async () => addresses}), errorCode('OAUTH_DESTINATION_REFUSED'));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); let privateNow = false;
  const plan = await f.discover({resolveHost: async () => [{address: privateNow ? '127.0.0.1' : '8.8.8.8'}]});
  privateNow = true;
  await assert.rejects(refreshOAuthTokens({plan, tokens: {refreshToken: 'private-refresh', scope: 'offline_access projects:read'},
    fetchImpl: f.fetchImpl, now: clock}), errorCode('OAUTH_DESTINATION_REFUSED'));
  assert.equal(f.calls.length, 2);
});

test('loopback binds S256, state, issuer and resource; invalid callbacks cannot consume consent', async () => {
  const plan = await fixture().discover();
  const {authorization, authorizationUrl} = await consent(plan, async (value, url) => {
    assert.match(value.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    assert.equal(url.searchParams.get('resource'), resource);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'offline_access projects:read');
    for (const mutate of [u => u.searchParams.set('state', 'wrong'), u => u.searchParams.set('iss', 'https://foreign.example.com'),
      u => u.searchParams.delete('iss'), u => u.searchParams.append('state', 'extra'), u => u.searchParams.append('code', 'extra'),
      u => u.searchParams.append('iss', options.issuer), u => u.searchParams.append('error', 'denied'),
      u => {u.searchParams.delete('code'); u.searchParams.append('error', 'denied'); u.searchParams.append('error', 'other');},
      u => u.searchParams.set('extra', 'x'.repeat(8300))]) {
      const u = new URL(value.redirectUri);
      u.searchParams.set('code', 'private-code'); u.searchParams.set('state', url.searchParams.get('state'));
      u.searchParams.set('iss', options.issuer); mutate(u);
      assert.equal(await callback(u), 400);
    }
  });
  assert.equal(authorization.code, 'private-code');
  assert.equal(createHash('sha256').update(authorization.verifier).digest('base64url'), authorizationUrl.searchParams.get('code_challenge'));
});

test('callback duplicates accept only one code and consent errors/timeouts stay redacted', async () => {
  const plan = await fixture().discover();
  let statuses;
  await receiveOAuthConsent({plan, scopes: options.scopes, timeoutMs: 5000, async onAuthorization(value) {
    const u = new URL(value.redirectUri), auth = new URL(value.authorizationUrl);
    u.searchParams.set('state', auth.searchParams.get('state')); u.searchParams.set('iss', options.issuer); u.searchParams.set('code', 'private-code');
    statuses = await Promise.all([callback(u), callback(u)]);
  }});
  // Both requests complete while the browser hook remains active; only the first is consumed.
  assert.deepEqual(statuses?.sort(), [303, 404]);
  await assert.rejects(receiveOAuthConsent({plan, scopes: options.scopes, timeoutMs: 1000, async onAuthorization(value) {
    const u = new URL(value.redirectUri), auth = new URL(value.authorizationUrl);
    u.searchParams.set('state', auth.searchParams.get('state')); u.searchParams.set('iss', options.issuer);
    u.searchParams.set('error', 'secret-provider-error'); u.searchParams.set('error_description', 'private-token');
    await callback(u);
  }}), errorCode('CONSENT_DENIED'));
  await assert.rejects(receiveOAuthConsent({plan, scopes: options.scopes, timeoutMs: 10, onAuthorization: () => new Promise(() => {})}), errorCode('CONSENT_PENDING'));
  await assert.rejects(receiveOAuthConsent({plan, scopes: options.scopes, timeoutMs: 1000, onAuthorization() { throw Error('private-token'); }}), errorCode('OAUTH_CONSENT_FAILED'));
});

test('code exchange is plan/consent bound, one-use, and returns bounded bearer expiry', async () => {
  const f = fixture(), plan = await f.discover(), {authorization} = await consent(plan);
  const tokens = await exchangeOAuthCode({plan, authorization, scopes: options.scopes, fetchImpl: f.fetchImpl, now: clock});
  assert.deepEqual(tokens, {accessToken: 'opaque-access', refreshToken: 'opaque-refresh', expiresAt: clock + 3600000,
    scope: 'offline_access projects:read'});
  const form = new URLSearchParams(f.calls.at(-1).init.body);
  assert.equal(form.get('code_verifier'), authorization.verifier); assert.equal(form.get('redirect_uri'), authorization.redirectUri);
  await assert.rejects(exchangeOAuthCode({plan, authorization, scopes: options.scopes, fetchImpl: f.fetchImpl}), errorCode('OAUTH_AUTHORIZATION_REQUIRED'));
  await assert.rejects(exchangeOAuthCode({plan: {...plan}, authorization, scopes: options.scopes}), errorCode('OAUTH_PLAN_REQUIRED'));
  await assert.rejects(exchangeOAuthCode({plan, authorization: {...authorization}, scopes: options.scopes}), errorCode('OAUTH_AUTHORIZATION_REQUIRED'));
});

test('refresh preserves scope and omitted rotation, accepts rotation and refuses scope broadening', async () => {
  const f = fixture({tokens: {refresh_token: undefined}}), plan = await f.discover();
  const tokens = {refreshToken: 'original-refresh', scope: 'projects:read offline_access'};
  const next = await refreshOAuthTokens({plan, tokens, fetchImpl: f.fetchImpl, now: () => clock});
  assert.equal(next.refreshToken, tokens.refreshToken); assert.equal(next.scope, 'offline_access projects:read');
  assert.equal(new URLSearchParams(f.calls.at(-1).init.body).get('scope'), next.scope);
  const rotated = fixture({tokens: {refresh_token: 'rotated-refresh'}});
  assert.equal((await refreshOAuthTokens({plan, tokens, fetchImpl: rotated.fetchImpl, now: clock})).refreshToken, 'rotated-refresh');
  for (const scope of ['offline_access projects:read watches:read', 'projects:read', 'offline_access offline_access projects:read'])
    await assert.rejects(refreshOAuthTokens({plan, tokens, fetchImpl: fixture({tokens: {scope}}).fetchImpl, now: clock}), errorCode('TOKEN_SCOPE_MISMATCH'));
});

test('token contract and JWT claims enforce binding without treating claims as current grant authority', async () => {
  const plan = await fixture().discover(), tokens = {refreshToken: 'refresh', scope: 'offline_access projects:read'};
  const valid = fixture({tokens: {access_token: jwt({scope: tokens.scope, exp: clock / 1000 + 60})}});
  assert.equal((await refreshOAuthTokens({plan, tokens, fetchImpl: valid.fetchImpl, now: clock})).expiresAt, clock + 60000);
  for (const change of [{token_type: 'MAC'}, {access_token: 'secret\nheader'}, {expires_in: 0}, {expires_in: '3600'},
    {resource: 'https://foreign.example.com/mcp'}, {iss: 'https://foreign.example.com'},
    {expires_in: 1.5}, {refresh_token: ''}, {access_token: jwt({iss: 'https://foreign.example.com'})},
    {access_token: jwt({aud: [resource, 'https://foreign.example.com/mcp']})}, {access_token: jwt({exp: clock / 1000})},
    {access_token: jwt({nbf: clock / 1000 + 1})}, {access_token: jwt({client_id: 'other-client'})},
    {access_token: jwt({scope: 'projects:read watches:read offline_access'})}, {access_token: 'abc.not-json.signature'}]) {
    await assert.rejects(refreshOAuthTokens({plan, tokens, fetchImpl: fixture({tokens: change}).fetchImpl, now: clock}),
      error => ['TOKEN_CONTRACT_MISMATCH', 'REFRESH_TOKEN_REQUIRED', 'TOKEN_CLAIMS_INVALID', 'TOKEN_SCOPE_MISMATCH', 'TOKEN_RESOURCE_MISMATCH'].includes(error.code)
        && !error.message.includes('secret') && !error.message.includes('foreign'));
  }
  await assert.rejects(refreshOAuthTokens({plan, tokens, fetchImpl: async () => Response.json({error: 'invalid_grant',
    error_description: 'private-refresh'}, {status: 400}), now: clock}), errorCode('REFRESH_FAILED'));
});
