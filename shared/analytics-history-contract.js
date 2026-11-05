import {z} from 'zod';

const id=z.string().min(1).max(200),count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const historyInstant=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
export const historyKind=z.enum(['found','back','lost','missing']);
const token=z.string().min(1).max(8192);
export const profileHistoryInput=z.object({projectId:id,from:historyInstant,to:historyInstant.optional(),kinds:z.array(historyKind).min(1).max(4).refine(v=>new Set(v).size===v.length).optional(),selection:token.optional()}).strict();
export const profileHistoryRecordsInput=z.object({projectId:id,selection:token,cursor:token.optional(),limit:z.number().int().min(1).max(200).optional(),format:z.enum(['json','csv']).optional()}).strict();
export const historyCounts=z.object({new:count,recovered:count,lost:count,went_missing:count,net:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),records:count}).strict();
export const historyRecord=z.object({event_id:id,sequence:count,project_id:id,watch_id:id,event_type:z.string().min(1).max(100),recorded_at:historyInstant,kind:historyKind}).strict();
export const historyIdentity=z.object({id:z.string().regex(/^sha256:[a-f0-9]{64}$/),selection:token,workspace_id:id,project_id:id,from:historyInstant,to:historyInstant,kinds:z.array(historyKind).min(1).max(4).refine(v=>new Set(v).size===v.length),through_sequence:count,retention_floor:count,issued_at:historyInstant,expires_at:historyInstant}).strict();
export const historyCoverage=z.object({basis:z.literal('retained_watch_transition_events'),clock:z.literal('event_recorded_at'),unit:z.literal('watch_transition_events'),whole_web_coverage:z.literal(false),unique_physical_links:z.literal(false),includes_archived_watches:z.literal(true),scan_limited:z.literal(false),retained_selection_complete:z.literal(true),historical_completeness:z.enum(['no_recorded_retention_gap','retention_gap']),limitations:z.array(z.string())}).strict();
const unavailable=z.object({state:z.literal('unavailable'),reason:z.string(),values:z.null()}).strict();
export const profileHistoryOutput=z.object({schema_version:z.literal(1),identity:historyIdentity,coverage:historyCoverage,totals:historyCounts,daily:z.array(historyCounts.extend({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict()),category_history:unavailable,authority_history:unavailable,notes:z.array(z.string())}).strict();
export const profileHistoryRecordsOutput=z.object({schema_version:z.literal(1),identity:historyIdentity,coverage:historyCoverage,total_records:count,items:z.array(historyRecord).max(200),next_cursor:token.nullable(),has_more:z.boolean(),format:z.enum(['json','csv']),csv:z.string().nullable()}).strict();
