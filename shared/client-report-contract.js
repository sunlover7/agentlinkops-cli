import {z} from 'zod';
// DP-0058-T10: the one-page client link report. One website, one period, the links a client
// asks about (live, new, back, lost, went missing, changed, won), each with its last check and
// the observation behind it. Counts come from the same rules as get_link_summary and the
// Changes page, so the report agrees with Links, Changes and agent reads.
const id=z.string().min(1).max(200),count=z.number().int().nonnegative(),instant=z.string();
export const CLIENT_REPORT_SECTIONS=Object.freeze(['live','new','back','lost','went_missing','changed','won']);
export const CLIENT_REPORT_BRANDING=Object.freeze(['agentlinkops','agency','none']);
export const clientReportBranding=z.object({mode:z.enum(CLIENT_REPORT_BRANDING),name:z.string().trim().min(1).max(80).optional()}).strict()
 .refine(b=>b.mode==='agency'?Boolean(b.name):b.name===undefined,{message:'An agency name is required for agency branding and only allowed with it.'});
export const clientReportInput=z.object({
 projectId:id,
 // A calendar month (UTC) or the last 1-90 days, counted like get_link_summary. Not both.
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
 days:z.number().int().min(1).max(90).optional(),
 branding:clientReportBranding.optional(),
 limit:z.number().int().min(1).max(200).optional(),
}).strict().refine(a=>!(a.month&&a.days),{message:'Choose a month or a number of days, not both.'});
export const clientReportItem=z.object({
 watch_id:id,source_url:z.string(),target_url:z.string(),
 status:z.enum(['live','missing','couldnt_check','paused','not_checked_yet','prospect','archived']),
 event_at:instant.nullable(),last_checked_at:instant.nullable(),
 evidence:z.object({observation_id:id.nullable(),checked_at:instant.nullable()}).strict(),
}).strict();
export const clientReportSection=z.object({total:count,items:z.array(clientReportItem).max(200),truncated:z.boolean()}).strict();
export const clientReportOutput=z.object({
 schema_version:z.literal(1),workspace_id:id,
 project:z.object({id,domain:z.string().nullable(),name:z.string().nullable()}).strict(),
 generated_at:instant,
 period:z.object({kind:z.enum(['month','days']),month:z.string().nullable(),days:z.number().int().min(1).max(90).nullable(),from:instant,to:instant,complete:z.boolean()}).strict(),
 branding:z.object({mode:z.enum(CLIENT_REPORT_BRANDING),name:z.string().nullable()}).strict(),
 counts:z.object({links:count,live:count,missing:count,couldnt_check:count,paused:count,not_checked_yet:count,prospects:count,new:count,back:count,lost:count,went_missing:count,changed:count,won:count}).strict(),
 won:z.object({state:z.literal('recorded'),reason:z.null(),clock:z.literal('win_verified_at')}).strict(),
 sections:z.object({live:clientReportSection,new:clientReportSection,back:clientReportSection,lost:clientReportSection,went_missing:clientReportSection,changed:clientReportSection,won:clientReportSection}).strict(),
 coverage:z.object({basis:z.literal('monitored_links_and_retained_change_feed'),live_clock:z.literal('read_time'),change_clock:z.literal('event_recorded_at'),changes_complete:z.boolean(),limitations:z.array(z.string())}).strict(),
 notes:z.array(z.string()),
}).strict();
// DP-0058-T08a: client results for up to ten websites, each its own population (no pooling).
export const EARNED_ORIGINS=Object.freeze(['import','discovery_candidate','prospect_pipeline','direct_or_unrecorded']);
export const clientResultsInput=z.object({
 projectIds:z.array(id).min(1).max(10).refine(v=>new Set(v).size===v.length,{message:'List each website once.'}),
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
 days:z.number().int().min(1).max(90).optional(),
 limit:z.number().int().min(1).max(200).optional(),
}).strict().refine(a=>!(a.month&&a.days),{message:'Choose a month or a number of days, not both.'});
// The link's saved outreach record as the pipeline holds it (status, last contact, campaign) and
// the last check that verified it as a won prospect. A record, not an attribution of who earned it.
const outreachRecord=z.object({status:z.string().nullable(),last_contacted_at:z.string().nullable(),campaign:z.string().nullable(),verified_win_at:instant.nullable()}).strict();
export const clientResultsEarnedItem=clientReportItem.extend({origin:z.enum(EARNED_ORIGINS),outreach:outreachRecord.nullable()}).strict();
const won=z.object({state:z.literal('recorded'),reason:z.null(),clock:z.literal('win_verified_at')}).strict();
export const clientResultsSite=z.object({
 project:z.object({id,domain:z.string().nullable(),name:z.string().nullable()}).strict(),
 counts:z.object({links:count,prospects:count,live_now:count,earned:count,retained:count,recovered:count,lost:count,went_missing:count,changed:count,never_live:count,couldnt_check:count,won:count}).strict(),
 earned_by_origin:z.object(Object.fromEntries(EARNED_ORIGINS.map(k=>[k,count]))).strict(),
 earned_with_verified_outreach:count,
 earned:z.object({total:count,items:z.array(clientResultsEarnedItem).max(200),truncated:z.boolean()}).strict(),
 review:z.object({lost:clientReportSection,recovered:clientReportSection,went_missing:clientReportSection,changed:clientReportSection,cant_reach_lasting:clientReportSection}).strict(),
 won,
 coverage:z.object({basis:z.literal('monitored_links_and_retained_change_feed'),live_clock:z.literal('read_time'),change_clock:z.literal('event_recorded_at'),changes_complete:z.boolean(),limitations:z.array(z.string()),retained_basis:z.literal('recorded_found_back_lost_missing_changes'),retained_complete:z.boolean()}).strict(),
}).strict();
export const clientResultsOutput=z.object({
 schema_version:z.literal(1),workspace_id:id,generated_at:instant,
 period:z.object({kind:z.enum(['month','days']),month:z.string().nullable(),days:z.number().int().min(1).max(90).nullable(),from:instant,to:instant,complete:z.boolean()}).strict(),
 sites:z.array(clientResultsSite).min(1).max(10),
 comparison:z.object({state:z.literal('no_comparable_cohort_yet'),reason:z.string()}).strict(),
 notes:z.array(z.string()),
}).strict();
export const CLIENT_REPORT_OUTPUTS=Object.freeze({get_client_link_report:clientReportOutput.passthrough(),get_client_results_report:clientResultsOutput.passthrough()});
const empty={total:0,items:[],truncated:false};
const resultsSection={total:0,items:[],truncated:false};
export const CLIENT_REPORT_EXAMPLES=Object.freeze({get_client_results_report:{schema_version:1,workspace_id:'workspace_example',generated_at:'2026-10-26T12:00:00.000Z',period:{kind:'month',month:'2026-09',days:null,from:'2026-09-01T00:00:00.000Z',to:'2026-09-30T23:59:59.999Z',complete:true},sites:[{project:{id:'project_example',domain:'example.com',name:'Example'},counts:{links:0,prospects:0,live_now:0,earned:0,retained:0,recovered:0,lost:0,went_missing:0,changed:0,never_live:0,couldnt_check:0,won:0},earned_by_origin:{import:0,discovery_candidate:0,prospect_pipeline:0,direct_or_unrecorded:0},earned_with_verified_outreach:0,earned:resultsSection,review:{lost:resultsSection,recovered:resultsSection,went_missing:resultsSection,changed:resultsSection,cant_reach_lasting:resultsSection},won:{state:'recorded',reason:null,clock:'win_verified_at'},coverage:{basis:'monitored_links_and_retained_change_feed',live_clock:'read_time',change_clock:'event_recorded_at',changes_complete:true,limitations:[],retained_basis:'recorded_found_back_lost_missing_changes',retained_complete:true}}],comparison:{state:'no_comparable_cohort_yet',reason:'Each website is its own population. No competitor or pooled cohort is compared in client results yet.'},notes:['This empty example does not establish that no links existed.']},get_client_link_report:{schema_version:1,workspace_id:'workspace_example',project:{id:'project_example',domain:'example.com',name:'Example'},generated_at:'2026-10-26T12:00:00.000Z',period:{kind:'days',month:null,days:30,from:'2026-09-27T00:00:00.000Z',to:'2026-10-26T12:00:00.000Z',complete:false},branding:{mode:'agentlinkops',name:null},counts:{links:0,live:0,missing:0,couldnt_check:0,paused:0,not_checked_yet:0,prospects:0,new:0,back:0,lost:0,went_missing:0,changed:0,won:0},won:{state:'recorded',reason:null,clock:'win_verified_at'},sections:{live:empty,new:empty,back:empty,lost:empty,went_missing:empty,changed:empty,won:empty},coverage:{basis:'monitored_links_and_retained_change_feed',live_clock:'read_time',change_clock:'event_recorded_at',changes_complete:true,limitations:[]},notes:['This empty example does not establish that no links existed.']}});
