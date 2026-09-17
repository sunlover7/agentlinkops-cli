const CONFIRMATION_MS = 30 * 60 * 1000;

const timeOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

function summary(observation) {
  if (!observation) return null;
  const { evidence } = observation;
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
    evidence: evidence ? {
      complete: evidence.complete, method: evidence.method, checkerVersion: evidence.checkerVersion,
      sha256: evidence.sha256, bytes: evidence.bytes, fetchedAt: evidence.fetchedAt,
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

/** Pure state reducer. Persist its result atomically with the observation + outbox. */
export function transitionState(previous, observation, now = Date.now()) {
  const prior = previous ?? {};
  const checkedMs = timeOf(observation.checkedAt) ?? timeOf(typeof now === 'function' ? now() : now);
  if (checkedMs === null) throw new TypeError('A valid observation timestamp is required');
  const checkedAt = new Date(checkedMs).toISOString();
  const latestMs = prior.latestAttempt ? timeOf(prior.latestAttempt.checkedAt) : null;
  const base = {
    state: prior.state ?? 'unknown',
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
    base.wasEverPresent = true;
    base.firstAbsentAt = null;
    base.absentCount = 0;
    base.firstUnavailableAt = null;
    base.unavailableCount = 0;
    base.sourceUnavailableConfirmed = false;
    let type;
    if (!prior.wasEverPresent && prior.lastSuccessfulObservation?.state !== 'present') type = 'placement_acquired';
    else if (prior.state === 'confirmed_missing' || prior.sourceUnavailableConfirmed) type = 'placement_recovered';
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
    if (!confirmed) base.nextCheckAt = new Date((first ?? checkedMs) + CONFIRMATION_MS).toISOString();
    if (confirmed && prior.state !== 'confirmed_missing' && base.wasEverPresent) {
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
  if (!base.sourceUnavailableConfirmed) base.nextCheckAt = new Date((first ?? checkedMs) + CONFIRMATION_MS).toISOString();
  if (base.sourceUnavailableConfirmed && !prior.sourceUnavailableConfirmed) {
    base.event = { type: 'source_unavailable', before: summary(prior.lastSuccessfulObservation), after: base.latestAttempt };
  }
  return base;
}
