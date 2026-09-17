// The write-time check behind DP-0020's `internal` / `external` observation kinds.
//
// A receipt names a placement in exactly the ledger's terms, plus one new field: `kind`, the
// observation type. `internal` means both source and target are pages of the project's own
// declared site; `external` means the source belongs to someone else. The distinction is
// mechanical, not editorial — an actor does not get to choose its observation type, because
// mislabeling an external placement as internal would claim ownership the customer does not
// have and hide the placement from publisher-delay semantics.
//
// This module decides that question and nothing else. It never fetches: it runs at receipt
// WRITE time, so a receipt that could never be checked honestly (a staging host, a non-public
// host) is refused once, up front, instead of being checked into an eternal `unknown`.
import { validatePublicUrl } from './url.js';

// Same host grammar the fetch boundary enforces, so a declared site cannot smuggle in a
// spelling the verifier would later refuse. A bare label ("intranet") is not a site.
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/**
 * Normalizes project identity's declared site into a host set. Accepts a single origin/host or
 * a list of them ("https://customer.com", "customer.com"). Both apex and www forms must be
 * declared explicitly: membership is exact-host, because ownership is DECLARED, not inferred —
 * this module no more infers a registrable domain than `matchesTarget` does a public suffix.
 * That is also what refuses a staging subdomain the customer never declared.
 */
export function normalizeDeclaredSite(site) {
  // `null`/`undefined`/blank is "no declared site" — a distinct answer from junk, because it is
  // the state of every project that has not declared one yet, and the error must say that.
  const entries = site === null || site === undefined || (typeof site === 'string' && !site.trim())
    ? [] : Array.isArray(site) ? site : [site];
  const hosts = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) return { valid: false, reason: 'invalid_declared_site_entry' };
    const text = entry.trim().toLowerCase();
    let host = text;
    if (/^https?:\/\//u.test(text)) {
      let parsed;
      try { parsed = new URL(text); } catch { return { valid: false, reason: 'invalid_declared_site_entry' }; }
      // A credentials-bearing origin in project identity is a config mistake, and silently
      // stripping it would bless a spelling the fetch boundary itself refuses everywhere.
      if (parsed.username || parsed.password) return { valid: false, reason: 'invalid_declared_site_entry' };
      host = parsed.hostname;
    }
    host = host.replace(/\.$/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) return { valid: false, reason: 'invalid_declared_site_entry' };
    if (!HOST_PATTERN.test(host) || host.length > 253) return { valid: false, reason: 'invalid_declared_site_entry' };
    hosts.add(host);
  }
  if (!hosts.size) return { valid: false, reason: 'no_declared_site' };
  return { valid: true, hosts: [...hosts].sort() };
}

/** Exact, case-insensitive host membership in the declared site. No suffix inference. */
export function withinDeclaredSite(url, hosts) {
  try { return hosts.includes(new URL(url).hostname.toLowerCase().replace(/\.$/, '')); }
  catch { return false; }
}

/**
 * Parse-level check of a receipt's observation kind against the declared site, per the
 * DP-0020-T01 contract. Returns `{valid:true, kind, sourceInSite, targetInSite, declaredSite}`
 * or `{valid:false, reason}` where the reason names the mismatch (the offending host, or the
 * boundary's own refusal). Callers refuse the write on `valid:false`; the check is free and
 * meters nothing.
 *
 * Refusals, all fixed by the contract:
 * - `internal` whose source or target falls outside the declared site;
 * - `external` whose source IS the declared site;
 * - either kind naming a host the public fetch boundary would refuse (staging spellings on
 *   reserved suffixes, localhost, IPs) — refused here rather than checked into an unknown;
 * - either kind without a declared site: with no declared site there is no fact of ownership,
 *   and the actor's label is the only thing left, which is exactly what must not decide it.
 */
export function checkObservationKind({ kind, sourceUrl, targetUrl }, site) {
  const declared = normalizeDeclaredSite(site);
  if (!declared.valid) return { valid: false, reason: declared.reason };
  if (kind !== 'internal' && kind !== 'external') return { valid: false, reason: `unknown_kind:${String(kind)}` };
  const source = validatePublicUrl(sourceUrl);
  if (!source.valid) return { valid: false, reason: `invalid_source:${source.reason}` };
  const target = validatePublicUrl(targetUrl);
  if (!target.valid) return { valid: false, reason: `invalid_target:${target.reason}` };
  const sourceInSite = withinDeclaredSite(source.url, declared.hosts);
  const targetInSite = withinDeclaredSite(target.url, declared.hosts);
  if (kind === 'internal') {
    if (!sourceInSite) return { valid: false, reason: `internal_source_outside_declared_site:${source.hostname}` };
    if (!targetInSite) return { valid: false, reason: `internal_target_outside_declared_site:${target.hostname}` };
  } else if (sourceInSite) {
    return { valid: false, reason: `external_source_on_declared_site:${source.hostname}` };
  }
  return { valid: true, kind, sourceInSite, targetInSite, declaredSite: declared.hosts };
}
