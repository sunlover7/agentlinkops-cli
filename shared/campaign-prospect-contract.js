import {z} from 'zod';

const id=z.string().trim().min(1).max(200);
const text=max=>z.string().trim().max(max).refine(v=>!/[\u0000-\u001f\u007f]/.test(v),'Control characters are not allowed');
export const prospectRevision=z.union([z.literal(0),z.uuid()]);
export const manualProspectStatuses=['candidate','requested','pending','declined','abandoned'];
export const prospectSourceFields={sourceUrl:z.string().max(2048).nullable().optional(),publisherUrl:z.string().max(2048).optional(),targetUrl:z.string().max(2048),targetScope:z.enum(['exact','domain','subdomain','path']).optional()};
export const saveProspectInput=z.object({projectId:id,externalRef:text(200).min(1).refine(v=>!/@|https?:\/\//i.test(v),'Use an opaque source record reference'),revision:z.literal(0),...prospectSourceFields,campaign:text(80).nullable().optional(),context:text(1000).nullable().optional(),expectedAnchor:text(1000).nullable().optional()}).strict();
export const getProspectInput=z.object({projectId:id,watchId:id}).strict();
export const listProspectsInput=z.object({projectId:id,view:z.enum(['active','won','closed','all']).default('active'),externalRef:text(200).min(1).refine(v=>!/@|https?:\/\//i.test(v),'Use an opaque source record reference').optional(),contactId:id.optional(),campaign:text(80).optional(),after:z.string().max(1200).optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const updateProspectInput=getProspectInput.extend({revision:z.uuid(),sourceUrl:prospectSourceFields.sourceUrl,publisherUrl:prospectSourceFields.publisherUrl,targetUrl:prospectSourceFields.targetUrl.optional(),targetScope:prospectSourceFields.targetScope,campaign:text(80).nullable().optional(),context:text(1000).nullable().optional(),expectedAnchor:text(1000).nullable().optional(),outreachStatus:z.enum(manualProspectStatuses).optional(),archived:z.boolean().optional()}).strict();
export const setProspectMonitoringInput=getProspectInput.extend({revision:z.uuid(),enabled:z.boolean(),cadenceSeconds:z.number().int().min(3600).max(2592000).optional()}).strict();
export const verifyProspectInput=getProspectInput.extend({idempotencyKey:text(200).min(1)}).strict();

export const prospectRecord=z.object({
 id,watchId:id,projectId:id,externalRef:z.string().nullable(),revision:z.uuid(),sourceKind:z.enum(['publisher','page']),sourceUrl:z.string().nullable(),publisherUrl:z.string(),targetUrl:z.string(),targetScope:z.string(),campaign:z.string().nullable(),context:z.string().nullable(),outreachStatus:z.string().nullable(),progress:z.string().nullable(),intent:z.string(),archived:z.boolean(),expectedAnchor:z.string().nullable(),lastContactedAt:z.string().nullable(),createdAt:z.string(),updatedAt:z.string(),
 contact:z.object({id,name:z.string(),revision:z.uuid()}).nullable(),contactId:id.nullable(),associationRevision:prospectRevision,contactLink:z.object({watchId:id,contactId:id.nullable(),revision:prospectRevision}),latestOutcome:z.unknown().nullable(),contactAttention:z.unknown().nullable().optional(),
 monitoring:z.object({enabled:z.boolean(),enrolled:z.boolean(),status:z.enum(['active','paused']),cadenceSeconds:z.number(),nextCheckAt:z.string().nullable()}),
 evidence:z.object({state:z.string(),complete:z.boolean(),wasEverPresent:z.boolean(),confirmedLost:z.boolean(),checkedAt:z.string().nullable(),confirmedAt:z.string().nullable(),verifiedWon:z.boolean()}),
}).strict();
export const prospectMutationOutput=z.object({prospect:prospectRecord,replayed:z.boolean()}).strict();
export const prospectVerificationOutput=z.object({watchId:id,jobId:id,state:z.string(),errorCode:z.string().nullable(),replayed:z.boolean(),recurringMonitoringCreated:z.literal(false),usage:z.object({unit:z.literal('source_check'),units:z.literal(1)}),prospect:prospectRecord}).strict();
export const prospectResponses={list_prospects:z.object({items:z.array(prospectRecord),nextAfter:z.string().nullable()}),get_prospect:prospectRecord,save_prospect:prospectMutationOutput,update_prospect:prospectMutationOutput,set_prospect_monitoring:prospectMutationOutput,verify_prospect:prospectVerificationOutput};
