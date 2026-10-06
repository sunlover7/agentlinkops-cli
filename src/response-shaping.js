// DP-0036-T15: response shaping. A list or report command whose rows carry evidence has a
// reviewed CONCISE projection: the fields an agent needs to decide and to call next, with the
// observation facts the unknown-versus-absent rule depends on always kept (state, uncertain,
// the latest attempt and its reason, the last verified observation). MCP and code mode default
// to concise; REST and the CLI default to detailed; every caller can ask for either with
// `format`. Rows only are projected: top-level envelope fields (cursors, coverage, counts,
// reservations, run and inventory metadata) are never dropped. Rules: AGENT-SURFACE-CONTRACT.md.

export const FORMATS = ['concise','detailed'];

const pick = (row, keys) => Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
// The evidence core of an observation_state or an attempt: never more than these, never less.
const attempt = value => value && typeof value === 'object' ? pick(value, ['state','reason','checkedAt','httpStatus','occurrenceCount','checkerVersion']) : value;
export function conciseObservationState(state) {
  if (!state || typeof state !== 'object') return state ?? {};
  const out = pick(state, ['state','uncertain','checked_at','reason','confirmedState','lastChangedAt','firstAbsentAt','consecutiveAbsent','nextCheckAt','lastSuccessfulAt','lastHealthyAt','firstUnavailableAt','unavailableCount','retryNotBefore']);
  if (state.latestAttempt !== undefined) out.latestAttempt = attempt(state.latestAttempt);
  if (state.lastSuccessfulObservation !== undefined) out.lastSuccessfulObservation = attempt(state.lastSuccessfulObservation);
  if (state.lastSuccessfulObservationSameAsLatestAttempt !== undefined) out.lastSuccessfulObservationSameAsLatestAttempt = state.lastSuccessfulObservationSameAsLatestAttempt;
  return out;
}
const withState = (row, keys) => ({ ...pick(row, keys), observation_state: conciseObservationState(row.observation_state) });
// An event snapshot (shared/observation-event.js) minus the occurrence list, expectations and
// signatures: the state, uncertainty, check state, reason, status and timing stay.
const conciseSnapshot = snapshot => snapshot && typeof snapshot === 'object'
  ? pick(snapshot, ['state','uncertain','check_state','reason','checked_at','http_status','occurrence_count','occurrences_truncated','source_url','target_url','url','next_check_at','watch_id','target_id'])
  : snapshot;
const observationResult = result => result && typeof result === 'object'
  ? { ...pick(result, ['state','reason','checkedAt','httpStatus','checkerVersion','evidence','redirects']), occurrenceCount: result.occurrenceCount ?? result.occurrences?.length ?? 0 }
  : result;

// One entry per shaped command: which array holds the rows and how a row is projected. The
// `keeps` list is what the docs and the tests read; `row` is the projection itself.
export const SHAPES = {
  list_rank_history: { rows: 'items', keeps: ['overview_run_id','slot_at','rank','observed_at','retrieved_at','freshness','outcome','execution','cost'],
    row: r => pick(r, ['overview_run_id','slot_at','rank','observed_at','retrieved_at','freshness','outcome','execution','cost']) },
  list_link_watches: { rows: 'items', keeps: ['id','source_url','target_url','status','state','observation_state','next_check_at','local_reference'], row: r => withState(r, ['id','source_url','target_url','status','state','next_check_at','local_reference']) },
  list_targets: { rows: 'items', keeps: ['id','url','status','state','observation_state','next_check_at'], row: r => withState(r, ['id','url','status','state','next_check_at']) },
  get_target_placements: { rows: 'items', keeps: ['id','source_url','target_url','target_scope','status','state'], row: r => pick(r, ['id','source_url','target_url','target_scope','status','state']) },
  list_check_jobs: { rows: 'items', keeps: ['id','state','type','watch_id','target_id','attempt_count','error_code','created_at','completed_at'], row: r => pick(r, ['id','state','type','watch_id','target_id','attempt_count','error_code','created_at','completed_at']) },
  get_history: { rows: 'items', keeps: ['id','state','reason','checked_at','job_id','evidence_key','result (state, reason, checkedAt, httpStatus, checkerVersion, evidence, redirects, occurrenceCount)'], row: r => ({ ...pick(r, ['id','state','reason','checked_at','job_id','evidence_key']), result: observationResult(r.result) }) },
  list_events: { rows: 'events', keeps: ['id','type','watch_id','target_id','created_at','cursor','data (before and after snapshots without occurrences, expectations and signatures; observation_id; evidence_key)'], row: r => ({ ...pick(r, ['id','type','watch_id','target_id','created_at','cursor']), data: r.data && typeof r.data === 'object' ? { ...pick(r.data, ['observation_id','evidence_key']), ...(r.data.before !== undefined ? { before: conciseSnapshot(r.data.before) } : {}), ...(r.data.after !== undefined ? { after: conciseSnapshot(r.data.after) } : {}) } : r.data }) },
  list_discovery_candidates: { rows: 'items', keeps: ['id','source_url','target_url','anchor','dofollow','provider_last_seen','verification_status','verified_at','observation_id'], row: r => pick(r, ['id','source_url','target_url','anchor','dofollow','provider_last_seen','verification_status','verified_at','observation_id']) },
  list_competitor_inventory_rows: { rows: 'items', keeps: ['id','source_url','target_url','anchor','dofollow','provider_last_seen','verification_status','observation_id','member_role'], row: r => pick(r, ['id','source_url','target_url','anchor','dofollow','provider_last_seen','verification_status','observation_id','member_role']) },
  get_candidate_verification_batch: { rows: 'items', keeps: ['ordinal','candidate_id','local_reference','job_id','watch_id','state','error_code','observation','usage'], row: r => pick(r, ['ordinal','candidate_id','local_reference','job_id','watch_id','state','error_code','observation','usage']) },
};
export const SHAPED_COMMANDS = Object.keys(SHAPES);

// Apply the requested (or defaulted) format. Detailed returns the data untouched apart from
// `defaults_applied`; concise projects the rows. Both formats say which defaults were applied.
export function shapeResponse(name, data, { format = null, defaultFormat = 'detailed' } = {}) {
  const shape = SHAPES[name];
  if (!shape || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  const applied = format ?? defaultFormat;
  const defaults = format ? {} : { format: defaultFormat };
  if (applied !== 'concise' || !Array.isArray(data[shape.rows])) return { ...data, defaults_applied: defaults };
  return { ...data, [shape.rows]: data[shape.rows].map(row => row && typeof row === 'object' ? shape.row(row) : row), defaults_applied: defaults };
}
