// Accountless CLI transport. One fresh connection per hop; the canonical fetcher
// continues to own robots, redirect policy, parsing and the whole-check deadline.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';
import { validatePublicUrl } from '../src/verifier/url.js';
import { VerificationError, withAbort } from '../src/page-acquisition/bytes.js';

// Match the qualified public executor policy. Neither a public-looking hostname
// nor the Workers compatibility flag establishes this boundary in a local CLI.
const V4_DENIED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map(ipaddr.parseCIDR);
const V6_DENIED = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(ipaddr.parseCIDR);
const V6_GLOBAL = ipaddr.parseCIDR('2000::/3');
const REQUEST_HEADERS = new Set(['user-agent', 'accept', 'if-none-match', 'if-modified-since']);
const RESPONSE_HEADERS = new Set(['location', 'content-type', 'content-encoding', 'content-length',
  'etag', 'last-modified', 'retry-after', 'link', 'x-robots-tag', 'cf-mitigated']);

export function isPublicNodeAddress(value) {
  let address;
  try { if (typeof value !== 'string' || value.includes('%')) return false; address = ipaddr.parse(value); }
  catch { return false; }
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
  return address.kind() === 'ipv4' ? !V4_DENIED.some(range => address.match(range))
    : address.match(V6_GLOBAL) && !V6_DENIED.some(range => address.match(range));
}
const normalizeAddress = value => {
  let address = ipaddr.parse(value);
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
  return address.toString();
};

export async function resolveNodePublicDestination(hostname, { lookup = (...args) => dns.lookup(...args), signal } = {}) {
  let answers;
  try { answers = await withAbort(Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })), signal); }
  catch (error) { throw error instanceof VerificationError ? error : new VerificationError('dns_resolution_failed'); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 64 || answers.some(answer => {
    if (!answer || ![4, 6].includes(answer.family) || !isPublicNodeAddress(answer.address)) return true;
    return ipaddr.parse(answer.address).kind() !== (answer.family === 4 ? 'ipv4' : 'ipv6');
  })) throw new VerificationError('dns_destination_not_public');
  const address = normalizeAddress(answers[0].address);
  return { address, family: ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6 };
}

/** Fetch-compatible single-hop GET. It never follows a redirect or uses credentials. */
export function createNodePublicFetch({ lookup, requestImpl } = {}) {
  return async (rawUrl, init = {}) => {
    const checked = validatePublicUrl(rawUrl);
    if (!checked.valid) throw new VerificationError(`unsafe_url:${checked.reason}`);
    if (init.method !== 'GET' || init.redirect !== 'manual' || init.credentials !== 'omit' || init.body !== undefined)
      throw new VerificationError('transport_request_invalid');
    const url = new URL(checked.url), headers = {};
    for (const [name, value] of new Headers(init.headers)) {
      if (!REQUEST_HEADERS.has(name) || value.length > 4096 || /[\r\n\u0000]/u.test(value))
        throw new VerificationError('transport_request_invalid');
      headers[name] = value;
    }
    const controller = new AbortController();
    const onOwnerAbort = () => controller.abort();
    const timer = setTimeout(onOwnerAbort, 20_000);
    const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', onOwnerAbort); };
    init.signal?.addEventListener('abort', onOwnerAbort, { once: true });
    if (init.signal?.aborted) controller.abort();
    let outbound, incoming, socket;
    try {
      if (controller.signal.aborted) throw new VerificationError('timeout');
      const pinned = await resolveNodePublicDestination(url.hostname, { lookup, signal: controller.signal });
      if (controller.signal.aborted) throw new VerificationError('timeout');
      const assertSocket = value => {
        try {
          if (!value?.remoteAddress || normalizeAddress(value.remoteAddress) !== pinned.address)
            throw new VerificationError('socket_destination_changed');
        } catch (error) { throw error instanceof VerificationError ? error : new VerificationError('socket_destination_unverified'); }
      };
      return await new Promise((resolve, reject) => {
        let responded = false, stopped = false;
        const stop = error => {
          if (stopped) return;
          stopped = true; cleanup();
          controller.signal.removeEventListener('abort', onAbort);
          outbound?.destroy(); incoming?.destroy(error);
          if (!responded) reject(error);
        };
        const onAbort = () => stop(new VerificationError('timeout'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const implementation = requestImpl ?? (url.protocol === 'https:' ? https.request : http.request);
        try {
          outbound = implementation({ protocol: url.protocol, hostname: url.hostname,
            port: url.protocol === 'https:' ? 443 : 80, path: `${url.pathname}${url.search}`, method: 'GET',
            agent: false, servername: url.hostname, rejectUnauthorized: true,
            maxHeaderSize: 32 * 1024, family: pinned.family, autoSelectFamily: false,
            lookup: (name, options, callback) => {
              if (name !== url.hostname) return callback(new VerificationError('socket_hostname_changed'));
              // Node versions may request the callback's all-answer form. Both
              // forms contain only the already screened, pinned literal.
              if (options?.all) return callback(null, [{ address: pinned.address, family: pinned.family }]);
              callback(null, pinned.address, pinned.family);
            },
            headers: { ...headers, Host: url.host, 'Accept-Encoding': 'identity', Connection: 'close' },
          }, response => {
            incoming = response;
            // Validation may destroy the stream before a Web reader attaches.
            response.on('error', () => {});
            if (stopped || controller.signal.aborted) { response.destroy(); return; }
            try {
              assertSocket(response.socket ?? socket);
              const safeHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (!RESPONSE_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
                const text = Array.isArray(value) ? value.join(', ') : String(value);
                if (text.length > 8192 || /[\r\n\u0000]/u.test(text)) throw new VerificationError('response_headers_too_large');
                safeHeaders.set(name, text);
              }
              // Identity is requested explicitly. Unsupported encoded bodies
              // remain unknown rather than being mistaken for empty HTML.
              if (safeHeaders.has('content-encoding') && safeHeaders.get('content-encoding').trim().toLowerCase() !== 'identity')
                throw new VerificationError('content_encoding_unsupported');
              if (safeHeaders.has('content-length') && !/^\d+$/u.test(safeHeaders.get('content-length')))
                throw new VerificationError('transport_response_invalid');
              const status = response.statusCode;
              if (!Number.isInteger(status) || status < 200 || status > 599) throw new VerificationError('transport_response_invalid');
              response.once('end', () => {
                cleanup(); controller.signal.removeEventListener('abort', onAbort);
              });
              response.once('close', () => { cleanup(); controller.signal.removeEventListener('abort', onAbort); });
              response.once('aborted', () => response.destroy(new VerificationError('incomplete_body')));
              let body = null;
              if (![204, 205, 304].includes(status)) {
                const reader = Readable.toWeb(response).getReader();
                body = new ReadableStream({
                  async pull(stream) {
                    try {
                      const item = await reader.read();
                      if (item.done) {
                        if (!response.complete) throw new VerificationError('incomplete_body');
                        reader.releaseLock(); stream.close();
                      } else stream.enqueue(item.value);
                    } catch (error) {
                      stream.error(error);
                      reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
                    }
                  },
                  async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
                });
              }
              const result = new Response(body, { status, headers: safeHeaders });
              Object.defineProperty(result, 'url', { value: checked.url });
              responded = true; resolve(result);
              if (!body) { response.destroy(); cleanup(); controller.signal.removeEventListener('abort', onAbort); }
            } catch (error) { stop(error instanceof VerificationError ? error : new VerificationError('transport_response_invalid')); }
          });
          outbound.on('socket', value => {
            socket = value;
            socket.once('connect', () => { try { assertSocket(socket); } catch (error) { stop(error); } });
          });
          outbound.on('error', error => stop(error instanceof VerificationError ? error : new VerificationError('network_error')));
          if (controller.signal.aborted) return onAbort();
          outbound.end();
        } catch (error) { stop(error instanceof VerificationError ? error : new VerificationError('network_error')); }
      });
    } catch (error) {
      cleanup(); outbound?.destroy(); incoming?.destroy(); throw error;
    }
  };
}
