const CONFIRMATION_MS = 30 * 60 * 1000;
import {recoverySummary} from '../page-acquisition/recovery.js';

const timeOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

// Retain a compact access history without private transport receipts or captures.
const acquisitionSummary=recoverySummary;

function summary(observation) {
  if (!observation) return null;
  const { evidence } = observation;
  const acquisition = acquisitionSummary(evidence?.acquisition);
  const all = observation.occurrences ?? [];
  // State/event snapshots are small references to full observations in D1/R2.
  // linkSignature covers ALL occurrences, preserving change detection beyond excerpts.
  return {
    state: observation.state,
    reason: observation.reason,
    sourceUrl: observation.sourceUrl,
    finalUrl: observation.finalUrl,
    targetUrl: observation.targetUrl,
    targetScope: observation.targetScope,
    httpStatus: observation.httpStatus,
    checkedAt: observation.checkedAt,
    linkSignature: observation.linkSignature,
    occurrenceCount: observation.occurrenceCount ?? all.length,
    occurrencesTruncated: observation.occurrencesTruncated === true || all.length > 10,
    occurrences: all.slice(0, 10).map(({ href, targetUrl, anchor, rel, context, locator }) => ({
      href: href?.slice(0, 512), targetUrl: targetUrl?.slice(0, 512), anchor: anchor?.slice(0, 256),
      rel, context: context?.slice(0, 320), locator,
    })),
    directives: observation.directives ? { noindex: observation.directives.noindex, nofollow: observation.directives.nofollow, indexingStatus: observation.directives.indexingStatus } : undefined,
    // DP-0004-T26 wrong landing page: where the page links on the same site instead (at most three).
    ...(Array.isArray(observation.landingLinks) && observation.landingLinks.length ? {
      landingLinks: observation.landingLinks.slice(0, 3).map(({ href, targetUrl, anchor }) => ({
        href: href?.slice(0, 512), targetUrl: targetUrl?.slice(0, 512), anchor: anchor?.slice(0, 256) })),
      landingLinkCount: observation.landingLinkCount ?? observation.landingLinks.length,
    } : {}),
    // The other links to the watched site this read saw (at most ten), so the next read can tell a
    // replacement link from one that was always on the page.
    ...(Array.isArray(observation.siteLinks) && Number.isInteger(observation.siteLinkCount) ? {
      siteLinks: observation.siteLinks.slice(0, SITE_LINK_LIMIT).map((url) => String(url).slice(0, 512)),
      siteLinkCount: observation.siteLinkCount,
    } : {}),
    evidence: evidence ? {
      complete: evidence.complete, method: evidence.method, checkerVersion: evidence.checkerVersion,
      sha256: evidence.sha256, decodedSha256: evidence.decodedSha256, bytes: evidence.bytes, fetchedAt: evidence.fetchedAt,
      ...(acquisition?{acquisition}:{}),
    } : undefined,
  };
}

function fingerprint(observation) {
  if (observation?.linkSignature) return observation.linkSignature;
  return JSON.stringify({
    source: observation?.finalUrl,
    occurrences: observation?.occurrences?.map(({ targetUrl, anchor, rel }) => ({ targetUrl, anchor, rel: [...(rel ?? [])].sort() })),
    noindex: observation?.directives?.noindex,
    nofollow: observation?.directives?.nofollow,
  });
}

const SITE_LINK_LIMIT = 10;
const WRONG_LANDING = 'wrong_landing_page';

/**
 * DP-0004-T26: settle a read's wrong_landing_page reason against the last complete read. The page
 * "points to another page" only when a link to the watched site is NEW since the last read that saw
 * the watched link, so it replaced that link; a brand or homepage link that was already on the page
 * proves nothing, and the read is a plain removal (counted as lost). A read after one already settled
 * as wrong landing keeps the reading while one of those links remains. Without a baseline that lists
 * the page's links (older saved states, a link never seen) the read stays a plain removal. Pure and
 * idempotent: the observation comes back unchanged or as a copy.
 */
export function settleLandingReason(previous, observation) {
  if (observation?.reason !== WRONG_LANDING) return observation;
  const plain = () => {
    const { landingLinks, landingLinkCount, ...rest } = observation;
    return { ...rest, reason: 'no_matching_link_in_complete_html' };
  };
  const current = Array.isArray(observation.landingLinks) ? observation.landingLinks : [];
  const baseline = previous?.lastSuccessfulObservation;
  let kept = [];
  if (baseline?.state === 'absent' && baseline.reason === WRONG_LANDING && Array.isArray(baseline.landingLinks)) {
    const before = new Set(baseline.landingLinks.map((link) => link?.targetUrl));
    kept = current.filter((link) => before.has(link?.targetUrl));
  } else if (baseline?.state === 'present' && Array.isArray(baseline.siteLinks) && Number.isInteger(baseline.siteLinkCount)
    && baseline.siteLinkCount <= baseline.siteLinks.length) {
    // Only a complete list of the page's earlier same-site links (possibly empty) proves a link is new.
    const before = new Set(baseline.siteLinks);
    kept = current.filter((link) => !before.has(link?.targetUrl));
  }
  if (!kept.length) return plain();
  return { ...observation, landingLinks: kept, landingLinkCount: kept.length };
}

/** Pure state reducer. Persist its result atomically with the observation + outbox. */
export function transitionState(previous, observation, now = Date.now()) {
  const prior = previous ?? {};
  observation = settleLandingReason(prior, observation);
  // Keep a historical confirmed fact separate from the latest check's ability
  // to verify it. Older saved states predate this explicit historical field.
  const confirmedState = prior.confirmedState ?? (prior.state === 'present' || prior.state === 'confirmed_missing'
    || prior.state === 'source_unavailable' && prior.sourceUnavailableConfirmed === true ? prior.state : null);
  const checkedMs = timeOf(observation.checkedAt) ?? timeOf(typeof now === 'function' ? now() : now);
  if (checkedMs === null) throw new TypeError('A valid observation timestamp is required');
  const checkedAt = new Date(checkedMs).toISOString();
  const latestMs = prior.latestAttempt ? timeOf(prior.latestAttempt.checkedAt) : null;
  const base = {
    state: prior.state ?? 'unknown',
    confirmedState,
    latestAttempt: prior.latestAttempt ?? null,
    lastSuccessfulObservation: prior.lastSuccessfulObservation ?? null,
    firstAbsentAt: prior.firstAbsentAt ?? null,
    absentCount: prior.absentCount ?? 0,
    firstUnavailableAt: prior.firstUnavailableAt ?? null,
    unavailableCount: prior.unavailableCount ?? 0,
    sourceUnavailableConfirmed: prior.sourceUnavailableConfirmed ?? false,
    wasEverPresent: prior.wasEverPresent ?? prior.lastSuccessfulObservation?.state === 'present',
    nextCheckAt: null,
    retryNotBefore: prior.retryNotBefore ?? null,
    uncertain: prior.uncertain ?? true,
    event: null,
    ignored: false,
  };
  if (latestMs !== null && checkedMs <= latestMs) return { ...base, nextCheckAt: prior.nextCheckAt ?? null, ignored: true };
  base.latestAttempt = summary({ ...observation, checkedAt });
  if (observation.state === 'unknown' || observation.evidence?.complete !== true) {
    base.state = 'unknown';
    base.uncertain = true;
    // A scheduler decides retry/backoff after an unknown; no past due timestamp loop. The one
    // thing carried is a floor the publisher stated in a Retry-After — "not before", never "then",
    // so the scheduler takes the later of this and the watch's own cadence.
    if (Number.isFinite(observation.retryAfterSeconds)) {
      base.retryNotBefore = new Date(checkedMs + observation.retryAfterSeconds * 1000).toISOString();
    }
    return base;
  }
  if (!['present', 'absent', 'source_unavailable'].includes(observation.state)) throw new TypeError('Invalid observation state');
  base.lastSuccessfulObservation = base.latestAttempt;
  base.uncertain = false;
  if (observation.state === 'present') {
    base.state = 'present';
    base.confirmedState = 'present';
    base.wasEverPresent = true;
    base.firstAbsentAt = null;
    base.absentCount = 0;
    base.firstUnavailableAt = null;
    base.unavailableCount = 0;
    base.sourceUnavailableConfirmed = false;
    let type;
    if (!prior.wasEverPresent && prior.lastSuccessfulObservation?.state !== 'present') type = 'placement_acquired';
    else if (confirmedState === 'confirmed_missing' || prior.sourceUnavailableConfirmed) type = 'placement_recovered';
    else if (prior.lastSuccessfulObservation?.state === 'present' && fingerprint(prior.lastSuccessfulObservation) !== fingerprint(observation)) type = 'placement_changed';
    if (type) base.event = { type, before: summary(prior.lastSuccessfulObservation), after: base.latestAttempt };
    return base;
  }
  if (observation.state === 'absent') {
    const first = timeOf(base.firstAbsentAt);
    base.firstAbsentAt = first === null ? checkedAt : base.firstAbsentAt;
    base.absentCount = first === null ? 1 : base.absentCount + 1;
    base.firstUnavailableAt = null;
    base.unavailableCount = 0;
    base.sourceUnavailableConfirmed = false;
    const confirmed = first !== null && checkedMs - first >= CONFIRMATION_MS && base.absentCount >= 2;
    base.state = confirmed ? 'confirmed_missing' : 'suspected_missing';
    if (confirmed) base.confirmedState = 'confirmed_missing';
    if (!confirmed) base.nextCheckAt = new Date((first ?? checkedMs) + CONFIRMATION_MS).toISOString();
    if (confirmed && confirmedState !== 'confirmed_missing' && base.wasEverPresent) {
      base.event = { type: 'placement_lost', before: summary(prior.lastSuccessfulObservation), after: base.latestAttempt };
    }
    return base;
  }
  const first = timeOf(base.firstUnavailableAt);
  base.firstUnavailableAt = first === null ? checkedAt : base.firstUnavailableAt;
  base.unavailableCount = first === null ? 1 : base.unavailableCount + 1;
  base.firstAbsentAt = null;
  base.absentCount = 0;
  base.state = 'source_unavailable';
  base.sourceUnavailableConfirmed = first !== null && checkedMs - first >= CONFIRMATION_MS && base.unavailableCount >= 2;
  if (base.sourceUnavailableConfirmed) base.confirmedState = 'source_unavailable';
  if (!base.sourceUnavailableConfirmed) base.nextCheckAt = new Date((first ?? checkedMs) + CONFIRMATION_MS).toISOString();
  if (base.sourceUnavailableConfirmed && !prior.sourceUnavailableConfirmed) {
    base.event = { type: 'source_unavailable', before: summary(prior.lastSuccessfulObservation), after: base.latestAttempt };
  }
  return base;
}
