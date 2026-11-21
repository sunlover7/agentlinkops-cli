import {z} from 'zod';
import {changeDiscovery,changePopulation,enrollmentBreakdown,reasonClassesByStatus} from './report-population.js';
// The per-website summary every console count reads (GET /v1/reports/summary, get_link_summary).
const count=z.number().int().nonnegative();
const at=z.string().nullable();
// last_checked_at is the oldest latest check among active links (every one was checked since);
// latest_check_at is the newest. Missing changes require historical presence evidence.
// couldnt_check_parts splits couldnt_check exactly; reason_classes counts Couldn't check and Missing
// links by their latest check's reason class (DP-0004-T24/T26, shared/check-reasons.js).
// reason_classes_by_status is that same map split by status, so a shared class such as not_on_page
// is not read as one pile. enrollment is the current record population; the status counts above
// stay the monitored population. change_enrollment and change_origin partition found, back, lost
// and went_missing. found still includes back. Daily rows stay the four counts only.
const parts=z.looseObject({cant_reach:count,rechecking:count,not_yet_verified:count,site_gone:count.optional(),page_gone:count.optional()});
const statusCounts={couldnt_check_parts:parts.optional(),reason_classes:z.record(z.string(),count).optional(),reason_classes_by_status:reasonClassesByStatus,enrollment:enrollmentBreakdown,prospect:count.optional(),by_intent:z.record(z.string(),count).optional(),by_outreach_status:z.record(z.string(),count).optional(),links:count,live:count,missing:count,couldnt_check:count,paused:count,not_checked_yet:count,last_checked_at:at,latest_check_at:at.optional(),change_enrollment:changePopulation.nullable(),change_origin:changeDiscovery.nullable()};
export const linkSummaryWebsite=z.looseObject({project_id:z.string(),domain:z.string().nullable(),name:z.string().nullable(),...statusCounts,found:count.nullable(),back:count.nullable().optional(),lost:count.nullable(),went_missing:count.nullable().optional()});
export const linkSummaryResponse=z.looseObject({
  schema_version:z.literal(1),workspace_id:z.string(),project_id:z.string().nullable(),as_of:z.string(),
  period:z.looseObject({days:z.number().int().min(1).max(90),from:z.string(),to:z.string()}),
  totals:z.looseObject({...statusCounts,found:count.nullable(),back:count.nullable().optional(),lost:count.nullable(),went_missing:count.nullable().optional()}),
  websites:z.array(linkSummaryWebsite),websites_truncated:z.boolean(),
  daily:z.array(z.looseObject({day:z.string(),found:count,back:count.optional(),lost:count,went_missing:count.optional()})).nullable(),
  changes_complete:z.boolean().nullable(),
  statuses:z.array(z.string()),
  reason_class_scope:z.tuple([z.literal('couldnt_check'),z.literal('missing')]),
});
