import {z} from 'zod';

// Two axes, kept off the existing count fields.
// Enrollment is the watch's current record: monitored, a retained candidate, or archived.
// Absent is only for a retained event whose watch row is gone.
// Discovery is how that event was produced. It is not a publication date and not who earned the link.
export const POPULATIONS = Object.freeze(['monitored', 'candidate_only', 'archived', 'absent']);
export const ENROLLMENTS = Object.freeze(['monitored', 'candidate_only', 'archived']);
export const DISCOVERY_ORIGINS = Object.freeze(['baseline_discovery', 'prospect_win', 'monitored_check', 'unrecorded']);
export const REASON_CLASS_SCOPE = Object.freeze(['couldnt_check', 'missing']);
export const CHANGE_KEYS = Object.freeze(['found', 'back', 'lost', 'went_missing']);

const count = z.number().int().nonnegative();
export const population = z.enum(POPULATIONS);
export const discoveryOrigin = z.enum(DISCOVERY_ORIGINS);
export const populationCounts = z.object({monitored: count, candidate_only: count, archived: count, absent: count}).strict();
export const discoveryCounts = z.object({
  baseline_discovery: count, prospect_win: count, monitored_check: count, unrecorded: count,
}).strict();
export const statusEnrollment = z.object({
  links: count, live: count, missing: count, couldnt_check: count, paused: count, not_checked_yet: count, prospect: count,
}).strict();
export const enrollmentBreakdown = z.object({
  monitored: statusEnrollment, candidate_only: statusEnrollment, archived: statusEnrollment,
}).strict();
export const reasonClassesByStatus = z.object({
  couldnt_check: z.record(z.string(), count), missing: z.record(z.string(), count),
}).strict();
export const changePopulation = z.object({
  found: populationCounts, back: populationCounts, lost: populationCounts, went_missing: populationCounts,
}).strict();
export const changeDiscovery = z.object({
  found: discoveryCounts, back: discoveryCounts, lost: discoveryCounts, went_missing: discoveryCounts,
}).strict();
export const discoveryDetail = z.object({
  origin: discoveryOrigin,
  execution_mode: z.string().max(40).nullable(),
  baseline_run_id: z.string().max(200).nullable(),
  clock: z.literal('event_recorded_at'),
}).strict();

export const emptyPopulationCounts = () => ({monitored: 0, candidate_only: 0, archived: 0, absent: 0});
export const emptyDiscoveryCounts = () => ({baseline_discovery: 0, prospect_win: 0, monitored_check: 0, unrecorded: 0});
export const emptyStatusEnrollment = () => ({links: 0, live: 0, missing: 0, couldnt_check: 0, paused: 0, not_checked_yet: 0, prospect: 0});
export const emptyEnrollment = () => ({monitored: emptyStatusEnrollment(), candidate_only: emptyStatusEnrollment(), archived: emptyStatusEnrollment()});
export const emptyChangePopulation = () => Object.fromEntries(CHANGE_KEYS.map(key => [key, emptyPopulationCounts()]));
export const emptyChangeDiscovery = () => Object.fromEntries(CHANGE_KEYS.map(key => [key, emptyDiscoveryCounts()]));
