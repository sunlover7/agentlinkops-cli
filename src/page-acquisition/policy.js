const HTTP_REASONS=new Set(['access_challenge','source_http_403','target_http_403','network_error','route_timeout','robots_access_challenge','robots_fetch_failed','robots_not_plain_text']);
const BROWSER_REASONS=new Set([...HTTP_REASONS,'possible_render_required','navigation_requires_browser']);
const PROXY_REASONS=new Set([...HTTP_REASONS,'render_failed','render_timeout','render_not_admitted',
  'acquisition_origin_connection_failed','acquisition_dns_resolution_failed','acquisition_executor_failed','acquisition_executor_busy']);
export const acquisitionState=value=>value?.state??(value?.outcome==='fetched'&&value.reason?'unknown':({fetched:'healthy',not_found:'unavailable',blocked:'unknown',unavailable:'unknown',not_configured:'unknown',deferred:'deferred',unchanged:'healthy'}[value?.outcome]??'unknown'));
export const completedAcquisition=value=>value?.evidence?.complete===true||value?.outcome==='fetched'&&!value.reason&&value.body_truncated!==true||['unchanged','not_found'].includes(value?.outcome);

/** Recovery never waives access policy, earned-monitor limits or publisher backoff. */
export function recoveryEligibility(value,method){
  const history=value?.robotsHistory??(value?.robots?[value.robots]:[]);
  if(history.some(row=>row?.overrideUsed===true))return {allowed:false,reason:'robots_override'};
  if(Number.isFinite(value?.retryAfterSeconds)||Number.isFinite(value?.sourceResponse?.retryAfterSeconds)
    ||/^((?:source|target|robots)_http_429|origin_busy|robots_crawl_delay_)/u.test(value?.reason??''))return {allowed:false,reason:'rate_limit'};
  if(completedAcquisition(value))return {allowed:false,reason:'complete'};
  if(['present','absent','healthy','source_unavailable'].includes(acquisitionState(value)))return {allowed:false,reason:'complete'};
  if(!['unknown','deferred'].includes(acquisitionState(value)))return {allowed:false,reason:'unsupported'};
  if(value?.occurrences?.length)return {allowed:false,reason:'complete'};
  const allowed=(method==='node_browser'?BROWSER_REASONS:method==='proxy_http'?PROXY_REASONS:HTTP_REASONS).has(value?.reason);
  return {allowed,reason:allowed?null:'unsupported'};
}
