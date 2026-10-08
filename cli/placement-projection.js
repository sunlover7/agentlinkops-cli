// One identity-bound projection for local activity and retained observations. A change-only
// mirror is not a complete probe log, so local absence remains provisional. Hosted watch
// state is carried independently from the raw check; this module never confirms loss.
import { mirrorEvidenceReference } from '../src/evidence-reference.js';

const conclusive = new Set(['present', 'absent', 'source_unavailable']);
const watchStates = new Set(['present', 'suspected_missing', 'confirmed_missing', 'source_unavailable']);
export const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function placementIdentity(value) {
  const record = value?.result ?? value;
  const source = record?.sourceUrl ?? record?.source_url ?? record?.source;
  const target = record?.targetUrl ?? record?.target_url ?? record?.target;
  const scope = record?.targetScope ?? record?.target_scope ?? record?.scope ?? 'exact';
  return typeof source === 'string' && typeof target === 'string'
    ? JSON.stringify([source, target, scope]) : null;
}

export function attemptSummary(row, { retained = false } = {}) {
  if (!validTime(row?.checked_at)) return null;
  const cloud = row.source === 'cloud';
  const rawState = cloud && conclusive.has(row.result?.checkState) ? row.result.checkState
    : ['suspected_missing', 'confirmed_missing'].includes(row.state) ? 'absent' : row.state;
  const method = row.result?.evidence?.method ?? null;
  return {
    checked_at: row.checked_at, placement: placementIdentity(row),
    state: rawState, reason: row.reason ?? null, complete: row.complete === true,
    origin: row.source ?? 'local',
    watch_state: cloud && watchStates.has(row.result?.watchState) ? row.result.watchState
      : ['suspected_missing', 'confirmed_missing'].includes(row.state) ? row.state : null,
    link_signature: row.result?.linkSignature ?? null,
    method, checker_version: row.checker_version ?? row.result?.evidence?.checkerVersion ?? null,
    content_hash: row.result?.evidence?.sha256 ?? null,
    evidence_reference: retained ? mirrorEvidenceReference({ entryId: row.id, checkedAt: row.checked_at, origin: row.source ?? 'local' }) : null,
    retained,
  };
}

export const isConclusive = attempt => attempt?.complete === true && conclusive.has(attempt.state);
export const isLinkVerification = attempt => isConclusive(attempt) && ['present', 'absent'].includes(attempt.state);

// Equal timestamps never qualify another probe. Stable tie-breaking makes frozen exports
// independent of input ordering; an activity summary cannot replace a richer retained receipt.
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function latest(items) {
  return items.filter(item => item && validTime(item.checked_at)).sort((a, b) =>
    Date.parse(b.checked_at) - Date.parse(a.checked_at)
      || Number(b.retained === true) - Number(a.retained === true)
      || compareText(JSON.stringify(a), JSON.stringify(b)))[0] ?? null;
}

function activityAttempt(record, identity) {
  if (record?.last_placement !== identity) return null;
  if (record.last_attempt?.placement === identity && record.last_attempt.checked_at === record.last_checked
    && validTime(record.last_attempt.checked_at)) return record.last_attempt;
  // Legacy activity can prove its last conclusive time, but cannot invent a method/hash or
  // reconstruct the overwritten successful check after a later unknown attempt.
  if (!validTime(record.last_checked)) return null;
  return { checked_at: record.last_checked, placement: identity, state: record.last_state ?? 'unknown',
    reason: record.last_reason ?? null, complete: record.last_complete === true, origin: 'local',
    watch_state: null, link_signature: record.last_signature ?? null, method: null,
    checker_version: null, content_hash: null, evidence_reference: null, retained: false };
}

export function projectPlacement(entry, observations, { state = null } = {}) {
  const identity = placementIdentity(entry);
  const history = identity ? observations.filter(row => row.id === entry.id && placementIdentity(row) === identity && validTime(row.checked_at)) : [];
  const attempts = history.map(row => attemptSummary(row, { retained: true }));
  const record = state?.entries?.[entry.id];
  const locate = item => item?.retained === true && !attempts.some(receipt => receipt.checked_at === item.checked_at
    && receipt.origin === item.origin && receipt.content_hash === item.content_hash)
    ? { ...item, retained: false, evidence_reference: null } : item;
  const activity = locate(identity ? activityAttempt(record, identity) : null);
  const saved = key => locate(identity && record?.last_placement === identity && record[key]?.placement === identity ? record[key] : null);
  const latestAttempt = latest([...attempts, activity]);
  const savedSuccess = saved('last_successful_observation'), savedLink = saved('last_link_verification');
  const lastSuccessful = latest([...attempts.filter(isConclusive), isConclusive(savedSuccess) ? savedSuccess : null, isConclusive(activity) ? activity : null]);
  const lastLink = latest([...attempts.filter(isLinkVerification), isLinkVerification(savedLink) ? savedLink : null, isLinkVerification(activity) ? activity : null]);
  const retained = latest(attempts);
  const row = retained ? history.filter(item => JSON.stringify(attemptSummary(item, { retained: true })) === JSON.stringify(retained))
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)))[0] ?? null : null;
  const firstDates = attempts.filter(item => isConclusive(item) && item.state === 'present').map(item => item.checked_at);
  const first = saved('first_present_observation');
  if (isConclusive(first) && first.state === 'present' && validTime(first.checked_at)) firstDates.push(first.checked_at);
  const firstPresent = firstDates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const current = latestAttempt?.watch_state ?? lastSuccessful?.watch_state ?? (lastSuccessful?.state === 'absent' ? 'suspected_missing'
    : lastSuccessful?.state ?? (latestAttempt ? 'unknown' : 'unchecked'));
  return {
    entry, row, placement: identity, current_state: current,
    uncertain: !!latestAttempt && !isConclusive(latestAttempt),
    latest_attempt: latestAttempt, last_successful_observation: lastSuccessful,
    last_link_verification: lastLink, first_present: firstPresent,
    evidence_observed_at: retained?.checked_at ?? null,
    activity_available: activity !== null,
    identity_status: history.length || activity ? 'matched' : observations.some(item => item.id === entry.id) || record ? 'not_matched' : 'not_observed',
  };
}

export function projectPlacements(entries, observations, options = {}) {
  const byId = new Map();
  for (const row of observations) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  return entries.map(entry => projectPlacement(entry, byId.get(entry.id) ?? [], options));
}
