import {z} from 'zod';
const text=z.string(),nullable=text.nullable();
export const searchConnection=z.looseObject({
 id:text,project_id:text,provider:z.enum(['google','bing']),status:text,property:nullable,
 last_sync_at:nullable,next_sync_at:nullable,last_error:nullable,coverage:z.record(text,z.unknown()).nullable(),
 snapshot_id:nullable,capability:z.enum(['search_performance','backlinks']),created_at:text,updated_at:text,
});
export const searchConnectionsResponse=z.looseObject({connections:z.array(searchConnection),providers:z.array(z.looseObject({provider:z.enum(['google','bing']),configured:z.boolean(),capability:z.enum(['search_performance','backlinks'])}))});
const rowMeta={rowId:text,fetched_at:text};
export const searchProviderRow=z.discriminatedUnion('kind',[
 z.looseObject({...rowMeta,kind:z.literal('search_performance'),page:text,query:text,clicks:z.number().nonnegative(),impressions:z.number().nonnegative(),ctr:z.number().nonnegative(),position:z.number().nonnegative(),startDate:text,endDate:text}),
 z.looseObject({...rowMeta,kind:z.literal('backlinks'),source_url:text,target_url:text,anchor:nullable,supplier:z.literal('bing_webmaster_tools'),verification_status:z.literal('unverified')}),
]);
export const searchRowsResponse=z.looseObject({connection:searchConnection,rows:z.array(searchProviderRow),nextCursor:nullable});
export const searchSyncResponse=z.looseObject({connection:searchConnection,rowCount:z.number().int().nonnegative()});
export const searchPropertiesResponse=z.looseObject({properties:z.array(z.looseObject({property:text,permission:text}))});
export const searchStartResponse=z.looseObject({authorizationUrl:z.url(),expiresAt:text});
export const searchImportResponse=z.looseObject({id:text,status:text,replayed:z.boolean().optional(),usage:z.looseObject({accepted_candidates:z.number().int().nonnegative()}),rejected:z.array(z.looseObject({row:z.number(),reason:text})),duplicates:z.array(z.looseObject({row:z.number(),first_seen_on_row:z.number()})),rejected_total:z.number().int().nonnegative(),duplicates_total:z.number().int().nonnegative()});
