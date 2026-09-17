import {searchConnectionsResponse,searchRowsResponse,searchSyncResponse,searchPropertiesResponse,searchStartResponse,searchConnection,searchImportResponse} from './search-connection-contract.js';
import {z} from 'zod';
export const objectResponse=z.looseObject({});
export const pageResponse=z.looseObject({items:z.array(objectResponse),next_cursor:z.string().nullable().optional()});
export const watchResponse=z.looseObject({id:z.string(),source_url:z.string(),target_url:z.string(),state:z.string(),observation_state:objectResponse});
export const targetResponse=z.looseObject({id:z.string(),url:z.string(),state:z.string(),observation_state:objectResponse});
export const historyResponse=z.looseObject({items:z.array(z.looseObject({id:z.string(),state:z.string(),checked_at:z.string(),result:objectResponse})),next_cursor:z.string().nullable().optional()});
export const jobResponse=z.looseObject({id:z.string(),state:z.enum(['queued','running','succeeded','failed','cancelled'])});
export const observationEvent=z.looseObject({id:z.string(),data:objectResponse});
export const eventFeedResponse=z.looseObject({events:z.array(observationEvent),next_cursor:z.string(),has_more:z.boolean()});
export const usageResponse=z.looseObject({
  workspace_id:z.string(),period:z.string().regex(/^\d{4}-\d{2}$/),plan:z.string(),
  check_reservations:z.looseObject({reserved:z.number().nonnegative(),consumed:z.number().nonnegative(),released:z.number().nonnegative()}),
  units:z.record(z.string(),z.looseObject({used:z.number().nonnegative()})),
  at_allowance:z.looseObject({note:z.string()}),checkout:z.looseObject({available:z.boolean(),reason:z.string().nullable().optional()}),
});
export const candidateVerificationBatchResponse=z.looseObject({
  schema_version:z.literal(1),id:z.string(),workspace_id:z.string(),project_id:z.string(),run_id:z.string(),
  state:z.enum(['pending','completed','partial','failed']),
  counts:z.object(Object.fromEntries(['rejected','queued','running','succeeded','failed','cancelled'].map(state=>[state,z.number().int().nonnegative()]))),
  items:z.array(z.looseObject({
    ordinal:z.number().int().nonnegative(),candidate_id:z.string(),local_reference:z.string().nullable(),
    job_id:z.string().nullable(),watch_id:z.string().nullable(),
    state:z.enum(['rejected','queued','running','succeeded','failed','cancelled']),error_code:z.string().nullable(),
    observation:z.looseObject({id:z.string(),state:z.string(),reason:z.string().nullable(),checked_at:z.string()}).nullable(),
    usage:z.looseObject({unit:z.literal('source_check'),state:z.string()}).nullable(),
  })).min(1).max(50),
  reservation:z.looseObject({units:z.number().int().nonnegative(),outstanding:z.number().int().nonnegative(),consumed:z.number().int().nonnegative(),released:z.number().int().nonnegative(),period:z.string()}).nullable(),
  replayed:z.boolean().optional(),
});
export const candidateMonitoringResponse=z.looseObject({
  watch:z.looseObject({id:z.string(),source_url:z.string(),target_url:z.string(),status:z.enum(['active','paused']),observation_state:objectResponse}),verification_job_id:z.string(),candidate_id:z.string(),run_id:z.string(),
  local_reference:z.string().nullable(),replayed:z.boolean(),recurring_monitoring_created:z.literal(true),
});
/** Network boundary shared by the console and command adapters. Unknown fields survive evolution. */
export function restResponseContract(path,method='GET') {
  const pathname=path.split('?')[0];
  if(method==='POST' && /^\/v1\/discovery\/runs\/[^/]+\/verification-batches$/.test(pathname))return candidateVerificationBatchResponse;
  if(method==='GET' && /^\/v1\/discovery\/verification-batches\/[^/]+$/.test(pathname))return candidateVerificationBatchResponse;
  if(method==='POST' && /^\/v1\/discovery\/verifications\/[^/]+\/monitor$/.test(pathname))return candidateMonitoringResponse;
  if(pathname==='/v1/search-connections'&&method==='GET')return searchConnectionsResponse;
  if(pathname==='/v1/search-connections/start'&&method==='POST')return searchStartResponse;
  if(/^\/v1\/search-connections\/[^/]+\/rows$/.test(pathname)&&method==='GET')return searchRowsResponse;
  if(/^\/v1\/search-connections\/[^/]+\/properties$/.test(pathname)&&method==='GET')return searchPropertiesResponse;
  if(/^\/v1\/search-connections\/[^/]+\/sync$/.test(pathname)&&method==='POST')return searchSyncResponse;
  if(/^\/v1\/search-connections\/[^/]+\/property$/.test(pathname)&&method==='PUT')return z.object({connection:searchConnection});
  if(/^\/v1\/search-connections\/[^/]+\/import$/.test(pathname)&&method==='POST')return searchImportResponse;
  if(/^\/v1\/search-connections\/[^/]+\/disconnect$/.test(pathname)&&method==='POST')return z.object({disconnected:z.literal(true),retainedRows:z.literal(true)});
  if(/^\/v1\/search-connections\/[^/]+$/.test(pathname)&&method==='DELETE')return z.object({forgotten:z.literal(true)});
  if(method!=='GET')return objectResponse;
  if(/^\/v1\/(?:watches|targets)\/[^/]+\/history$/.test(pathname))return historyResponse;
  if(/^\/v1\/watches\/[^/]+$/.test(pathname))return watchResponse;
  if(/^\/v1\/targets\/[^/]+$/.test(pathname))return targetResponse;
  if(['/v1/watches','/v1/targets','/v1/projects','/v1/exports/watches'].includes(pathname))return pageResponse;
  if(pathname==='/v1/usage')return usageResponse;
  if(['/v1/events','/v1/target-events'].includes(pathname))return eventFeedResponse;
  if(/^\/v1\/(?:jobs|target-jobs)\/[^/]+$/.test(pathname))return jobResponse;
  return objectResponse;
}
