import { validatePublicUrl } from '../verifier/url.js';
import { PRODUCT_TOKEN } from './http.js';
import { VerificationError, cancelBody, withAbort, readBoundedBytes, decodeBytes, inflateGzipBounded } from './bytes.js';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 20_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function bounded(value, fallback, cap, minimum = 0) {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), minimum), cap) : fallback;
}

function abortableWait(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new VerificationError('timeout')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new VerificationError('timeout')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Bounded bootstrap documents: robots.txt must not recursively authorize itself.
 * The caller owns transport egress qualification; lexical URL checks are not DNS proof.
 * Fetching an XML document here does not enroll a crawl or establish link presence.
 *
 * One absolute budget covers pacing, every redirect, headers, body and inflation.
 * `signal` and `deadlineAt` can shorten that budget, never extend it.
 */
export function createDocumentTransport({
  fetchImpl = globalThis.fetch, timeoutMs = MAX_TIMEOUT_MS, maxBytes = MAX_DOCUMENT_BYTES,
  maxRedirects = 5, hostDelayMs = 2_000, now = () => Date.now(), wait = abortableWait,
} = {}) {
  const byteCap = bounded(maxBytes, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES, 1);
  const timeout = bounded(timeoutMs, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS, 1);
  const redirectCap = bounded(maxRedirects, 5, 5);
  const nextAllowed = new Map();

  async function pace(host, signal) {
    const delay = (nextAllowed.get(host) ?? 0) - now();
    if (delay > 0) await withAbort(Promise.resolve().then(() => wait(delay, { signal })), signal);
    if (signal.aborted) throw new VerificationError('timeout');
    nextAllowed.set(host, now() + Math.max(0, hostDelayMs));
  }

  async function fetchText(rawUrl, {
    accept = 'text/plain,application/xml,text/xml', signal = null, deadlineAt = null,
    purpose = 'document',
  } = {}) {
    const checked = validatePublicUrl(rawUrl);
    if (!checked.valid) return { ok: false, url: rawUrl, reason: `unsafe_url:${checked.reason}` };
    let url = checked.url;
    const controller = new AbortController();
    const ownerAbort = () => controller.abort();
    signal?.addEventListener('abort', ownerAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const remaining = Math.min(timeout, Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : timeout);
    const absoluteDeadline = Date.now() + remaining;
    if (remaining <= 0) controller.abort();
    const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
    const limit = purpose === 'robots' ? Math.min(byteCap, MAX_ROBOTS_BYTES) : byteCap;
    const seen = new Set();
    let status;
    let phase = 'request';
    try {
      for (let redirects = 0; redirects <= redirectCap; redirects++) {
        status = undefined;
        if (controller.signal.aborted) throw new VerificationError('timeout');
        if (seen.has(url)) return { ok: false, url, reason: 'redirect_loop' };
        seen.add(url);
        phase = 'request';
        await pace(new URL(url).hostname, controller.signal);
        const pending = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new VerificationError('timeout');
          return fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
            signal: controller.signal, headers: { 'User-Agent': `${PRODUCT_TOKEN}/0.1`, Accept: accept } });
        });
        // A custom transport may ignore abort. Dispose of its late body as soon as it appears.
        pending.then(response => { if (controller.signal.aborted) cancelBody(response); }, () => {});
        const response = await withAbort(pending, controller.signal);
        status = response.status;
        let followed;
        try { followed = response.redirected || (response.url && new URL(response.url).href !== url); }
        catch { followed = true; }
        if (followed) {
          cancelBody(response);
          return { ok: false, url, status, reason: 'transport_followed_redirect' };
        }
        if (response.headers.get('cf-mitigated') === 'challenge') {
          cancelBody(response);
          return { ok: false, url, status, reason: 'access_challenge' };
        }
        if (REDIRECTS.has(status)) {
          cancelBody(response);
          const location = response.headers.get('location');
          let next;
          try { next = location ? validatePublicUrl(new URL(location, url).href) : null; }
          catch { next = null; }
          if (!next?.valid) return { ok: false, url, reason: 'unsafe_or_missing_redirect' };
          url = next.url;
          continue;
        }
        if (status === 404 || status === 410) {
          cancelBody(response);
          return { ok: false, url, status, reason: 'not_found' };
        }
        if (!response.ok) {
          cancelBody(response);
          return { ok: false, url, status, reason: `http_${status}` };
        }
        phase = 'body';
        const body = await readBoundedBytes(response, limit, controller.signal);
        let data = body.data;
        const gzipped = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
        if (gzipped) {
          phase = 'inflate';
          data = (await inflateGzipBounded(data, limit, controller.signal)).data;
        }
        if (controller.signal.aborted) throw new VerificationError('timeout');
        phase = 'decode';
        const text = decodeBytes(data);
        if (controller.signal.aborted || Date.now() >= absoluteDeadline) throw new VerificationError('timeout');
        if (purpose === 'robots' && (/text\/html/iu.test(response.headers.get('content-type') ?? '')
          || /<(?:!doctype|html|body)\b/iu.test(text))) {
          return { ok: false, url, status, reason: 'robots_not_plain_text' };
        }
        return { ok: true, url, final_url: url, status, text, bytes: body.bytes, gzipped };
      }
      return { ok: false, url, reason: 'redirect_limit' };
    } catch (error) {
      let reason = error?.reason ?? (phase === 'request' ? 'timeout_or_network_error' : 'read_failed');
      if (phase === 'inflate' && reason !== 'timeout') {
        reason = reason === 'body_too_large' ? 'sitemap_too_large' : 'sitemap_gunzip_failed';
      }
      return { ok: false, url, ...(status === undefined ? {} : { status }), reason };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', ownerAbort);
      controller.abort();
    }
  }

  return { fetchText };
}
