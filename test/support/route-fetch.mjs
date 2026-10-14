// Test-only subprocess transport fixture. The public DNS/peer below are MOCKS;
// page bytes come from an explicitly selected loopback HTTP fixture. This tests
// packaged CLI parsing/output, not real public-network or TLS qualification.
// Production never imports this file or reads these test environment variables.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const host = process.env.AGENTLINKOPS_TEST_ROUTE_HOST;
const origin = process.env.AGENTLINKOPS_TEST_ROUTE_ORIGIN;
const fail = () => { throw new Error('Unexpected network request in packaged CLI fixture'); };
if (host || origin) {
  let fixture;
  try { fixture = new URL(origin); } catch { fail(); }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host ?? '') || fixture.protocol !== 'http:'
    || fixture.hostname !== '127.0.0.1' || !/^\d+$/u.test(fixture.port)
    || fixture.username || fixture.password || fixture.pathname !== '/' || fixture.search || fixture.hash) fail();
  const publicAddress = '93.184.215.14';
  const fixtureRequest = http.request;
  dns.lookup = async (hostname, options) => {
    if (hostname !== host || options?.all !== true || options?.verbatim !== true) fail();
    return [{ address: publicAddress, family: 4 }];
  };
  const routedRequest = (options, callback) => {
    if (!options || typeof options !== 'object' || options.hostname !== host || options.method !== 'GET'
      || !['http:', 'https:'].includes(options.protocol) || options.agent !== false || options.autoSelectFamily !== false
      || options.rejectUnauthorized !== true || options.servername !== host || typeof options.lookup !== 'function'
      || typeof callback !== 'function' || !String(options.path).startsWith('/')) fail();
    // Exercise the connector's lookup callback, rather than quietly bypassing
    // pinning because the fixture source happens to have a public-looking name.
    let pinned = false;
    options.lookup(host, {}, (error, address, family) => {
      if (error || address !== publicAddress || family !== 4) fail();
      pinned = true;
    });
    if (!pinned) fail();
    const request = new EventEmitter();
    let physical, physicalResponse, body;
    request.destroy = () => {
      request.destroyed = true; physical?.destroy(); physicalResponse?.destroy(); body?.destroy();
      return request;
    };
    request.end = () => {
      queueMicrotask(() => {
        if (request.destroyed) return;
        const socket = new EventEmitter(); socket.remoteAddress = publicAddress;
        request.emit('socket', socket); socket.emit('connect');
        if (request.destroyed) return;
        // Only this captured physical request function may reach the fixed
        // loopback origin. No redirects, proxies or other hosts are followed.
        physical = fixtureRequest({ protocol: 'http:', hostname: fixture.hostname, port: Number(fixture.port),
          path: options.path, method: 'GET', agent: false,
          headers: { ...options.headers, Host: fixture.host } }, response => {
          physicalResponse = response;
          if (request.destroyed) { response.destroy(); return; }
          body = new PassThrough();
          Object.assign(body, { statusCode: response.statusCode, headers: response.headers, socket });
          Object.defineProperty(body, 'complete', { get: () => response.complete });
          body.on('error', () => {});
          body.once('close', () => { if (!response.complete) response.destroy(); });
          response.once('aborted', () => body.destroy(new Error('Incomplete loopback fixture body')));
          response.once('error', error => body.destroy(error));
          callback(body); response.pipe(body);
        });
        physical.once('error', error => request.emit('error', error));
        physical.end();
      });
      return request;
    };
    return request;
  };
  http.request = routedRequest;
  https.request = routedRequest;
  // An unqualified default fetch would make this test look green again. Fail
  // it explicitly, along with every unexpected DNS/request destination.
  globalThis.fetch = async () => fail();
}
