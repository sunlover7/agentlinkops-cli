import {createServer} from 'node:http';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import {validatePublicUrl} from '../src/verifier/url.js';

const plans = new WeakSet();
const resolvers = new WeakMap();
const authorizations = new WeakMap();
const LIMIT = 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const check = (value, code) => { if (!value) fail(code); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\s\u0000-\u001f\u007f]/.test(value);
const normalizeScopes = value => {
  check(Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every(s => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s))
    && new Set(value).size === value.length, 'INVALID_OAUTH_SCOPES');
  return [...value].sort();
};
const scopeString = value => {
  check(typeof value === 'string' && value.length <= 20000 && value.trim() === value
    && !value.includes('  '), 'TOKEN_SCOPE_MISMATCH');
  try { return normalizeScopes(value.split(' ')); } catch { fail('TOKEN_SCOPE_MISMATCH'); }
};
const sameScopes = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function publicHttps(value, code) {
  check(typeof value === 'string' && validatePublicUrl(value).valid, code);
  let url; try { url = new URL(value); } catch { fail(code); }
  check(url.protocol === 'https:' && !url.hash && !url.username && !url.password, code);
  return url;
}
function originOf(value) {
  const url = publicHttps(value, 'CANONICAL_HTTPS_ORIGIN_REQUIRED');
  check(value === url.origin, 'CANONICAL_HTTPS_ORIGIN_REQUIRED');
  return url.origin;
}
function endpoint(value, issuer) {
  const url = publicHttps(value, 'ISSUER_ENDPOINT_INVALID');
  check(url.origin === issuer && value === url.href && !value.includes('?') && !value.includes('#'), 'ISSUER_ENDPOINT_INVALID');
  return url.href;
}
function requirePlan(plan) {
  check(plan && plans.has(plan), 'OAUTH_PLAN_REQUIRED');
  return plan;
}
function requested(plan, scopes) {
  const value = normalizeScopes(scopes);
  check(value.includes('offline_access') && value.every(s => plan.scopes.includes(s)), 'INVALID_OAUTH_SCOPES');
  return value;
}

const defaultResolver = hostname => lookup(hostname, {all: true});
async function publicDestination(url, resolveHost) {
  check(typeof resolveHost === 'function', 'OAUTH_DESTINATION_REFUSED');
  let timer;
  try {
    // This is DNS preflight, not address pinning or a rebinding-proof transport.
    const addresses = await Promise.race([Promise.resolve().then(() => resolveHost(new URL(url).hostname)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 20000); })]);
    check(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 100
      && addresses.every(value => {
        try { return ipaddr.process(typeof value === 'string' ? value : value?.address).range() === 'unicast'; }
        catch { return false; }
      }), 'OAUTH_DESTINATION_REFUSED');
  } catch { fail('OAUTH_DESTINATION_REFUSED'); }
  finally { clearTimeout(timer); }
}
async function jsonRequest(fetchImpl, url, init = {}, resolveHost = defaultResolver) {
  await publicDestination(url, resolveHost);
  let response;
  try { response = await fetchImpl(url, {...init, redirect: 'error', signal: AbortSignal.timeout(20000)}); }
  catch { fail('OAUTH_REQUEST_FAILED'); }
  check(response && !response.redirected && !(response.status >= 300 && response.status < 400)
    && (!response.url || response.url === url), 'OAUTH_REDIRECT_REFUSED');
  check(response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json', 'JSON_RESPONSE_REQUIRED');
  const length = response.headers.get('content-length');
  if (length !== null) check(/^\d+$/.test(length) && Number(length) <= LIMIT, 'RESPONSE_TOO_LARGE');
  check(response.body?.getReader, 'JSON_RESPONSE_REQUIRED');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMIT) { await reader.cancel().catch(() => {}); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE') throw error;
    fail('OAUTH_RESPONSE_FAILED');
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes))); }
  catch { fail('JSON_RESPONSE_REQUIRED'); }
  check(data && typeof data === 'object' && !Array.isArray(data), 'JSON_RESPONSE_REQUIRED');
  return {response, data};
}

export async function discoverOAuth({origin, issuer, clientId, scopes, fetchImpl = fetch, resolveHost = defaultResolver}) {
  originOf(origin); originOf(issuer);
  check(typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 2048
    && !/[\s\u0000-\u001f\u007f]/.test(clientId), 'EXISTING_PUBLIC_CLIENT_REQUIRED');
  const declared = normalizeScopes(scopes);
  check(declared.includes('offline_access'), 'INVALID_OAUTH_SCOPES');
  const resource = `${origin}/mcp`;
  const protectedResource = await jsonRequest(fetchImpl, `${origin}/.well-known/oauth-protected-resource/mcp`, {}, resolveHost);
  const p = protectedResource.data;
  check(protectedResource.response.ok && p.resource === resource
    && Array.isArray(p.authorization_servers) && p.authorization_servers.length === 1
    && p.authorization_servers[0] === issuer, 'RESOURCE_DISCOVERY_MISMATCH');
  check(Array.isArray(p.scopes_supported) && declared.filter(s => s !== 'offline_access')
    .every(s => p.scopes_supported.includes(s)), 'RESOURCE_SCOPES_MISSING');
  const discovery = await jsonRequest(fetchImpl, `${issuer}/.well-known/oauth-authorization-server`, {}, resolveHost);
  const m = discovery.data;
  check(discovery.response.ok && m.issuer === issuer, 'ISSUER_DISCOVERY_MISMATCH');
  check(Array.isArray(m.code_challenge_methods_supported) && m.code_challenge_methods_supported.includes('S256'), 'PKCE_DISCOVERY_FAILED');
  check(Array.isArray(m.grant_types_supported) && ['authorization_code', 'refresh_token']
    .every(g => m.grant_types_supported.includes(g)), 'GRANT_DISCOVERY_FAILED');
  if (m.response_types_supported !== undefined)
    check(Array.isArray(m.response_types_supported) && m.response_types_supported.includes('code'), 'GRANT_DISCOVERY_FAILED');
  if (m.token_endpoint_auth_methods_supported !== undefined)
    check(Array.isArray(m.token_endpoint_auth_methods_supported) && m.token_endpoint_auth_methods_supported.includes('none'), 'EXISTING_PUBLIC_CLIENT_REQUIRED');
  if (m.scopes_supported !== undefined)
    check(Array.isArray(m.scopes_supported) && declared.every(s => m.scopes_supported.includes(s)), 'RESOURCE_SCOPES_MISSING');
  const plan = Object.freeze({origin, issuer, clientId, resource, scopes: Object.freeze(declared),
    authorizationEndpoint: endpoint(m.authorization_endpoint, issuer), tokenEndpoint: endpoint(m.token_endpoint, issuer),
    ...(m.revocation_endpoint === undefined ? {} : {revocationEndpoint: endpoint(m.revocation_endpoint, issuer)}),
    requireIssuerResponse: m.authorization_response_iss_parameter_supported === true});
  plans.add(plan);
  resolvers.set(plan, resolveHost);
  return plan;
}

export async function receiveOAuthConsent({plan, scopes, timeoutMs = 600000, onAuthorization}) {
  requirePlan(plan);
  const selected = requested(plan, scopes);
  check(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600000 && typeof onAuthorization === 'function', 'INVALID_OAUTH_CONSENT');
  await publicDestination(plan.authorizationEndpoint, resolvers.get(plan));
  const verifier = randomBytes(64).toString('base64url'), state = randomBytes(32).toString('base64url');
  let finish, rejectCallback, rejectTimeout, used = false, timer;
  const received = new Promise((resolve, reject) => { finish = resolve; rejectCallback = reject; });
  received.catch(() => {});
  const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
  timedOut.catch(() => {});
  const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/plain',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"};
  const server = createServer({maxHeaderSize: 16384}, (request, response) => {
    if (typeof request.url !== 'string' || request.url.length > 8192) {
      response.writeHead(400, headers); response.end('Invalid authorization response.'); return;
    }
    let url; try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { response.writeHead(400, headers); response.end('Invalid authorization response.'); return; }
    if (request.method === 'GET' && url.pathname === '/oauth/complete') {
      response.writeHead(200, headers); response.end('Authorization received. You can close this tab.'); return;
    }
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback' || request.socket.remoteAddress !== '127.0.0.1'
      || !request.url.startsWith('/') || request.url.startsWith('//')
      || request.headers.host !== `127.0.0.1:${server.address().port}` || used) {
      response.writeHead(404, headers); response.end('Not found.'); return;
    }
    const params = url.searchParams;
    const duplicate = ['code', 'state', 'iss', 'error'].some(k => params.getAll(k).length > 1);
    if (duplicate || !same(params.get('state'), state) || (params.has('iss') && params.get('iss') !== plan.issuer)
      || (plan.requireIssuerResponse && !params.has('iss')) || (params.has('code') && params.has('error'))) {
      response.writeHead(400, headers); response.end('Invalid authorization response.'); return;
    }
    used = true;
    response.writeHead(303, {...headers, Location: '/oauth/complete'}); response.end();
    if (params.has('error')) rejectCallback(Object.assign(new Error('CONSENT_DENIED'), {code: 'CONSENT_DENIED'}));
    else if (!secret(params.get('code'))) rejectCallback(Object.assign(new Error('AUTHORIZATION_CODE_MISSING'), {code: 'AUTHORIZATION_CODE_MISSING'}));
    else finish(params.get('code'));
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
    const url = new URL(plan.authorizationEndpoint);
    for (const [key, value] of Object.entries({response_type: 'code', client_id: plan.clientId, redirect_uri: redirectUri,
      scope: selected.join(' '), resource: plan.resource, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'})) url.searchParams.set(key, value);
    timer = setTimeout(() => rejectTimeout(Object.assign(new Error('CONSENT_PENDING'), {code: 'CONSENT_PENDING'})), timeoutMs);
    // Race the browser hook too: a stalled opener must not retain the listener forever.
    await Promise.race([Promise.resolve().then(() => onAuthorization({authorizationUrl: url.href, redirectUri,
      clientId: plan.clientId, scopes: [...selected]})), timedOut]);
    const authorization = Object.freeze({code: await Promise.race([received, timedOut]), verifier, redirectUri});
    authorizations.set(authorization, {plan, scopes: selected, used: false});
    return authorization;
  } catch (error) {
    if (['CONSENT_DENIED', 'AUTHORIZATION_CODE_MISSING', 'CONSENT_PENDING'].includes(error?.code)) fail(error.code);
    fail('OAUTH_CONSENT_FAILED');
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}

function retainTokens(plan, data, selected, now, previous) {
  const at = typeof now === 'function' ? now() : now;
  check(Number.isSafeInteger(at) && at >= 0, 'INVALID_OAUTH_CLOCK');
  check(secret(data.access_token) && typeof data.token_type === 'string' && data.token_type.toLowerCase() === 'bearer'
    && Number.isSafeInteger(data.expires_in) && data.expires_in > 0 && data.expires_in <= 31536000, 'TOKEN_CONTRACT_MISMATCH');
  check((data.resource === undefined || data.resource === plan.resource)
    && (data.iss === undefined || data.iss === plan.issuer), 'TOKEN_RESOURCE_MISMATCH');
  const granted = data.scope === undefined ? selected : scopeString(data.scope);
  check(sameScopes(granted, selected), 'TOKEN_SCOPE_MISMATCH');
  const refreshToken = data.refresh_token === undefined ? previous?.refreshToken : data.refresh_token;
  check(secret(refreshToken), 'REFRESH_TOKEN_REQUIRED');
  let expiresAt = at + data.expires_in * 1000;
  check(Number.isSafeInteger(expiresAt), 'TOKEN_CONTRACT_MISMATCH');
  if (data.access_token.split('.').length === 3) {
    let header, claims;
    try {
      const [h, p, signature] = data.access_token.split('.');
      check([h, p, signature].every(s => /^[A-Za-z0-9_-]+$/.test(s)), 'TOKEN_CLAIMS_INVALID');
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch { fail('TOKEN_CLAIMS_INVALID'); }
    // Binding checks only. The resource server verifies the signature and current grant.
    check(typeof header?.alg === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(header.alg)
      && header.alg.toLowerCase() !== 'none' && claims?.iss === plan.issuer
      && (claims.aud === plan.resource || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === plan.resource))
      && Number.isSafeInteger(claims.exp) && claims.exp * 1000 > at
      && (claims.nbf === undefined || (Number.isSafeInteger(claims.nbf) && claims.nbf * 1000 <= at))
      && (claims.client_id === undefined || claims.client_id === plan.clientId)
      && (claims.azp === undefined || claims.azp === plan.clientId), 'TOKEN_CLAIMS_INVALID');
    if (claims.scope !== undefined) check(sameScopes(scopeString(claims.scope), selected), 'TOKEN_SCOPE_MISMATCH');
    expiresAt = Math.min(expiresAt, claims.exp * 1000);
  }
  return {accessToken: data.access_token, refreshToken, expiresAt, scope: granted.join(' ')};
}

export async function exchangeOAuthCode({plan, authorization, scopes, fetchImpl = fetch, now = Date.now}) {
  requirePlan(plan);
  const selected = requested(plan, scopes), bound = authorizations.get(authorization);
  check(bound?.plan === plan && !bound.used && sameScopes(bound.scopes, selected), 'OAUTH_AUTHORIZATION_REQUIRED');
  bound.used = true;
  const {response, data} = await jsonRequest(fetchImpl, plan.tokenEndpoint, {method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: plan.clientId,
      grant_type: 'authorization_code', code: authorization.code, code_verifier: authorization.verifier,
      redirect_uri: authorization.redirectUri, resource: plan.resource})}, resolvers.get(plan));
  check(response.ok, 'CODE_EXCHANGE_FAILED');
  return retainTokens(plan, data, selected, now);
}

export async function refreshOAuthTokens({plan, tokens, fetchImpl = fetch, now = Date.now}) {
  requirePlan(plan);
  check(tokens && secret(tokens.refreshToken), 'REFRESH_TOKEN_REQUIRED');
  const selected = requested(plan, scopeString(tokens.scope));
  const {response, data} = await jsonRequest(fetchImpl, plan.tokenEndpoint, {method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: plan.clientId,
      grant_type: 'refresh_token', refresh_token: tokens.refreshToken, scope: selected.join(' '), resource: plan.resource})}, resolvers.get(plan));
  check(response.ok, 'REFRESH_FAILED');
  // RFC6749 section6 permits omission of a replacement refresh token.
  return retainTokens(plan, data, selected, now, tokens);
}
