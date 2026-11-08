// DP-0063-T05: a certificate failure gets its own code and one recovery, instead of the generic
// "connection failed" that sent people to check a network that was working.
//
// Node's fetch reports every TLS failure as `TypeError: fetch failed` with the OpenSSL reason on
// `error.cause.code`. The common one on managed machines is UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
// a corporate proxy or antivirus re-signs HTTPS with its own root, the operating system trusts
// that root, and Node does not, because Node ships its own certificate bundle. The supported
// fix is NODE_EXTRA_CA_CERTS pointing at that root as a PEM file. Turning certificate checks
// off (NODE_TLS_REJECT_UNAUTHORIZED=0) is never suggested.
//
// A certificate is checked during the handshake, before any request bytes are sent, so a TLS
// failure is the one network failure where a write provably did not reach the server.
import {readFileSync, statSync} from 'node:fs';
import {CloudError} from './cloud-error.js';

const UNTRUSTED = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'CERT_CHAIN_TOO_LONG']);
const INVALID = new Map([['CERT_HAS_EXPIRED', 'expired'], ['CERT_NOT_YET_VALID', 'not yet valid'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'issued for a different host name'], ['CERT_REVOKED', 'revoked']]);
export const TLS_FAILURE_CODES = Object.freeze([...UNTRUSTED, ...INVALID.keys()]);
export const EXTRA_CA_ENV = 'NODE_EXTRA_CA_CERTS';

/** The TLS reason inside a fetch/undici/SDK error chain, or null. Never throws. */
export function tlsFailure(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length && seen.size < 12) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const code = typeof value.code === 'string' ? value.code : null;
    if (code && UNTRUSTED.has(code)) return {code, kind: 'untrusted'};
    if (code && INVALID.has(code)) return {code, kind: 'invalid', reason: INVALID.get(code)};
    queue.push(value.cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors);
  }
  return null;
}

/** Whether NODE_EXTRA_CA_CERTS is usable. Reads only the named file; prints no contents. */
export function extraCaStatus(env = process.env, {read = path => readFileSync(path, 'utf8'), stat = statSync} = {}) {
  const path = typeof env?.[EXTRA_CA_ENV] === 'string' ? env[EXTRA_CA_ENV].trim() : '';
  if (!path) return {set: false};
  try {
    if (!stat(path).isFile()) return {set: true, path, usable: false, problem: 'is not a file'};
    const certificates = (read(path).match(/-----BEGIN CERTIFICATE-----/gu) ?? []).length;
    return certificates ? {set: true, path, usable: true, certificates} : {set: true, path, usable: false, problem: 'contains no PEM certificate'};
  } catch {
    return {set: true, path, usable: false, problem: 'cannot be read'};
  }
}

/** Whether Node was started to trust the operating system's certificate store (Node 22.15+ or 23.9+; 23.8 supports Windows and macOS only). */
export function systemCaMode(env = process.env, execArgv = process.execArgv) {
  return env?.NODE_USE_SYSTEM_CA === '1' || /(?:^|\s)--use-system-ca(?:\s|$)/u.test(env?.NODE_OPTIONS ?? '') || (execArgv ?? []).includes('--use-system-ca');
}

/** One recovery line for a TLS failure, aware of whether NODE_EXTRA_CA_CERTS is already set. */
export function tlsRecovery(failure, env = process.env, {target = 'the cloud'} = {}) {
  if (failure?.kind === 'invalid') {
    return `The certificate for ${target} is ${failure.reason}. Check that server's address; if a proxy inspects HTTPS on this network, ask its administrator to fix its certificate. Do not turn certificate checks off.`;
  }
  const extra = extraCaStatus(env);
  if (extra.set && !extra.usable) return `${EXTRA_CA_ENV} is set to ${extra.path}, but that file ${extra.problem}. Point it at the trusted PEM certificate file your network requires, open a new terminal and run \`agentlinkops doctor\` again. Do not turn certificate checks off.`;
  if (extra.set) return `${EXTRA_CA_ENV} is set, but Node still could not build a trusted certificate chain. Check the server certificate chain and confirm ${extra.path} contains any root your network requires. Node reads the file only when it starts. Open a new terminal and run \`agentlinkops doctor\` again. Do not turn certificate checks off.`;
  const system = systemCaMode(env)
    ? ' Node already reads the operating system certificate store here; check the server chain and the roots that store trusts.'
    : ' On Node.js 22.15 or later, or 23.9 or later, NODE_OPTIONS=--use-system-ca makes Node trust the roots your operating system trusts, which is often simpler.';
  return `This machine could not build a trusted certificate chain. The server may omit an intermediate certificate, or your network may require a private root. Check the server certificate chain and local trust settings. If your organization supplies an HTTPS inspection root, export it as a PEM file and set ${EXTRA_CA_ENV} to its path in your shell profile. Open a new terminal and run \`agentlinkops doctor\` again.${system} Do not turn certificate checks off.`;
}

/** The CloudError a client raises for a TLS failure. Status 0: no HTTP response exists. */
// `target` names the server: the cloud API, or the OAuth issuer when a token refresh failed.
// Only this request is known not to have been sent; a multi-request command (sync) may have
// landed earlier requests, which its own receipt reports.
export function tlsCloudError(failure, {attempts = 1, env = process.env, target = 'the cloud'} = {}) {
  const code = failure.kind === 'untrusted' ? 'CLOUD_TLS_UNTRUSTED' : 'CLOUD_TLS_INVALID';
  return new CloudError(code, 0, {tlsCode: failure.code, attempts},
    `The secure connection to ${target} failed (${failure.code}), so this request was not sent and changed nothing. ${tlsRecovery(failure, env, {target})}`);
}
