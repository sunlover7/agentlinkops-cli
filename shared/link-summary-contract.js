import {z} from 'zod';
// The per-website summary every console count reads (GET /v1/reports/summary, get_link_summary).
const count=z.number().int().nonnegative();
const at=z.string().nullable();
// last_checked_at is the oldest latest check among active links (every one was checked since);
// latest_check_at is the newest. went_missing counts never-seen links that turned Missing.
const statusCounts={links:count,live:count,missing:count,couldnt_check:count,paused:count,not_checked_yet:count,last_checked_at:at,latest_check_at:at.optional()};
export const linkSummaryWebsite=z.looseObject({project_id:z.string(),domain:z.string().nullable(),name:z.string().nullable(),...statusCounts,found:count.nullable(),back:count.nullable().optional(),lost:count.nullable(),went_missing:count.nullable().optional()});
export const linkSummaryResponse=z.looseObject({
  schema_version:z.literal(1),workspace_id:z.string(),project_id:z.string().nullable(),as_of:z.string(),
  period:z.looseObject({days:z.number().int().min(1).max(90),from:z.string(),to:z.string()}),
  totals:z.looseObject({...statusCounts,found:count.nullable(),back:count.nullable().optional(),lost:count.nullable(),went_missing:count.nullable().optional()}),
  websites:z.array(linkSummaryWebsite),websites_truncated:z.boolean(),
  daily:z.array(z.looseObject({day:z.string(),found:count,back:count.optional(),lost:count,went_missing:count.optional()})).nullable(),
  changes_complete:z.boolean().nullable(),
  statuses:z.array(z.string()),
});
