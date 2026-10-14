import {browsePageInput,browsePageOutput,browseCursor} from './table-page-contract.js';
import {z} from 'zod';
export const DISAVOW_LIMITS=Object.freeze({projectRules:10000,ruleBytes:3072,importRules:500,importBytes:240000,comments:8,commentChars:120});
const id=z.string().min(1).max(200),revision=z.number().int().positive();
const comments=z.array(z.string().max(120).startsWith('#')).max(8);
export const disavowListInput=z.object({...browsePageInput,projectId:id.optional(),status:z.enum(['proposed','active','rejected']).optional(),limit:z.number().int().min(1).max(100).optional(),cursor:browseCursor.optional()}).strict();
export const disavowHistoryInput=z.object({...browsePageInput,projectId:id,limit:z.number().int().min(1).max(100).optional(),cursor:browseCursor.optional()}).strict();
export const disavowProposeInput=z.object({projectId:id,kind:z.enum(['domain','url']),value:z.string().min(1).max(2048),comments:comments.optional(),source:z.enum(['manual','agent_proposal']).optional(),status:z.enum(['proposed','active']).optional()}).strict();
export const disavowImportInput=z.object({projectId:id,text:z.string().max(240000),approve:z.boolean().optional()}).strict();
export const disavowReviewManyInput=z.object({projectId:id,rules:z.array(z.object({ruleId:id,revision}).strict()).min(1).max(100),decision:z.enum(['approve','reject'])}).strict();
export const disavowReviewInput=z.object({projectId:id,ruleId:id,revision,decision:z.enum(['approve','reject'])}).strict();
export const disavowDeleteInput=z.object({projectId:id,ruleId:id,revision}).strict();
export const disavowProjectInput=z.object({projectId:id}).strict();
export const disavowRule=z.object({id,workspace_id:id,project_id:id,kind:z.enum(['domain','url']),value:z.string(),identity:z.string(),source:z.enum(['manual','import','agent_proposal']),status:z.enum(['proposed','active','rejected']),comments,revision,created_by:id,approved_by:id.nullable(),created_at:z.string(),updated_at:z.string(),covered_links:z.number().int().nonnegative().optional(),created_by_label:z.enum(['you','imported','agent','owner','admin','member','viewer','former member']).optional()}).strict();
const count=z.number().int().nonnegative();
export const disavowSummary=z.object({active:count,proposed:count,rejected:count}).strict();
export const disavowListOutput=z.object({...browsePageOutput,rules:z.array(disavowRule),revision:count,cursor:z.string().nullable(),summary:disavowSummary.optional()}).strict();
export const disavowMutationOutput=z.object({rules:z.array(disavowRule),created:count,unchanged:count,revision:count,approved:z.boolean().optional(),counts:z.object({sites:count,pages:count,already_listed:count}).strict().optional(),warnings:z.array(z.string()).max(50).optional(),failed:z.array(z.object({ruleId:id,code:z.string()}).strict()).optional()}).strict();
export const disavowDeleteOutput=z.object({deleted:z.literal(true),rule_id:id,revision:z.number().int().nonnegative()}).strict();
export const disavowExportReceipt=z.object({id,workspace_id:id,project_id:id,format_version:z.literal(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),stored_active_count:z.number().int().nonnegative(),effective_count:z.number().int().nonnegative(),byte_length:z.number().int().nonnegative(),collection_revision:z.number().int().nonnegative(),source_revisions:z.array(z.object({id,revision}).strict()),created_by:id,created_at:z.string(),exported_by_label:z.enum(['you','owner','admin','member','viewer','former member']).optional()}).strict();
export const disavowExportOutput=z.object({filename:z.literal('disavow.txt'),content_type:z.literal('text/plain; charset=utf-8'),text:z.string(),receipt:disavowExportReceipt}).strict();
export const disavowHistoryOutput=z.object({...browsePageOutput,receipts:z.array(disavowExportReceipt),cursor:z.string().nullable(),changed_since:count.nullable().optional(),revision:count.optional()}).strict();
// Agent handoffs: what Google holds, checked against the approved list (never assumed).
export const DISAVOW_CHECK_LIMITS=Object.freeze({textBytes:2000000,examples:20,counts:100000});
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const handoffInput=z.object({projectId:id,handoff:z.enum(['disavow_upload'])}).strict();
export const disavowConfirmInput=z.object({projectId:id,text:z.string().max(DISAVOW_CHECK_LIMITS.textBytes).optional(),counts:z.object({domains:z.number().int().min(0).max(DISAVOW_CHECK_LIMITS.counts),urls:z.number().int().min(0).max(DISAVOW_CHECK_LIMITS.counts),uploaded_on:day.optional()}).strict().optional()}).strict();
const examples=z.array(z.string()).max(DISAVOW_CHECK_LIMITS.examples);
export const disavowGoogleCheck=z.object({id,checked_at:z.string(),method:z.enum(['text','counts']),result:z.enum(['match','differs','counts_match','counts_differ']),missing_in_google:count,extra_in_google:count,examples:z.object({missing_in_google:examples,extra_in_google:examples}).strict(),google:z.object({domains:count,urls:count}).strict(),uploaded_on:day.nullable(),checked_by:z.enum(['person','agent'])}).strict();
export const disavowGoogleState=z.enum(['never_checked','in_sync','behind','differs','counts_only']);
export const disavowStatusOutput=z.object({
 project_id:id,
 rules:z.object({active:count,effective:count,domains:count,urls:count}).strict(),
 changed_since_download:count.nullable(),
 last_change_at:z.string().nullable(),
 last_download:disavowExportReceipt.nullable(),
 google:z.object({state:disavowGoogleState,changes_since_check:count.nullable(),last_check:disavowGoogleCheck.nullable()}).strict(),
}).strict();
export const disavowConfirmOutput=z.object({check:disavowGoogleCheck,status:disavowStatusOutput}).strict();
const handoffStep=z.object({text:z.string(),href:z.string().url().optional(),action:z.enum(['download','verify']).optional()}).strict();
export const handoffOutput=z.object({
 id:z.enum(['disavow_upload']),title:z.string(),why:z.string(),prompt:z.string(),steps:z.array(handoffStep),
 agent:z.object({goal:z.string(),needs:z.array(z.string()),procedure:z.array(z.string()),verify:z.object({command:z.string(),input:z.string()}).strict(),stop_if:z.array(z.string()),never:z.array(z.string())}).strict(),
 website:z.object({project_id:id,domain:z.string()}).strict(),
 status:disavowStatusOutput,
}).strict();
