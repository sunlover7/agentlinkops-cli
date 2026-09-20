// Pure index-observation semantics. No fetch, OAuth, scraping, quota mutation,
// persistence or hosted feature activation occurs in this module.
export const INDEX_OBSERVATION_VERSION = 1;
export const INDEX_CONFIRMATION = Object.freeze({ probes: 2, minProbeIntervalMs: 30 * 60_000, graceMs: 24 * 60 * 60_000 });
export const URL_INSPECTION_LIMITS = Object.freeze({ propertyPerDay: 2000, propertyPerMinute: 600, projectPerDay: 10_000_000, projectPerMinute: 15_000 });
const positiveCoverage = new Set(['Submitted and indexed', 'Indexed, not submitted in sitemap', 'Indexed']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = value => typeof value === 'string' && value.length ? value : null;
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_INDEX_TIMESTAMP');
  return new Date(value).toISOString();
}
function url(value) {
  let parsed; try { parsed = new URL(value); } catch { fail('INVALID_INDEX_URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) fail('INVALID_INDEX_URL');
  return parsed.href;
}
export function validateInspectionProperty(inspectionUrl, siteUrl, grantedProperties) {
  const inspected = new URL(url(inspectionUrl));
  if (!Array.isArray(grantedProperties) || !grantedProperties.includes(siteUrl)) fail('INDEX_PROPERTY_NOT_GRANTED');
  if (typeof siteUrl !== 'string') fail('INVALID_INDEX_PROPERTY');
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice(10);
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(domain) || domain.includes('..')) fail('INVALID_INDEX_PROPERTY');
    if (inspected.hostname !== domain && !inspected.hostname.endsWith(`.${domain}`)) fail('INDEX_URL_OUTSIDE_PROPERTY');
  } else {
    const property = new URL(url(siteUrl));
    if (!siteUrl.endsWith('/') || property.search) fail('INVALID_INDEX_PROPERTY');
    if (inspected.origin !== property.origin || !inspected.pathname.startsWith(property.pathname)) fail('INDEX_URL_OUTSIDE_PROPERTY');
  }
  // Keep the exact granted property string; do not silently fix a missing slash.
  return siteUrl;
}
function envelope({ observationId, inspectionUrl, checkedAt, payload, lane, backend, sourceKey }) {
  if (!text(observationId) || observationId.length > 128) fail('INVALID_INDEX_OBSERVATION_ID');
  let raw; try { raw = payload === undefined ? null : JSON.parse(JSON.stringify(payload)); } catch { fail('INVALID_INDEX_RESPONSE'); }
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 262144) fail('INDEX_RESPONSE_EXCEEDS_BOUND');
  return { version: INDEX_OBSERVATION_VERSION, observation_id: observationId, url: url(inspectionUrl), checked_at: timestamp(checkedAt),
    lane, backend, source_key: sourceKey, tier: 'unknown', confidence: 'unknown', reason: 'invalid_response',
    raw_response: raw, last_crawl_at: null, live_page_test: false, submission_requested: false };
}
export function gscIndexObservation(input) {
  const siteUrl = validateInspectionProperty(input.inspectionUrl, input.siteUrl, input.grantedProperties);
  const observation = envelope({ ...input, lane: 'gsc', backend: 'google_url_inspection', sourceKey: `gsc:${siteUrl}` });
  observation.property = siteUrl;
  const response = observation.raw_response;
  const result = response?.inspectionResult?.indexStatusResult;
  if (response?.error) return { ...observation, reason: 'inspection_request_failed' };
  if (!result || typeof result !== 'object' || Array.isArray(result)) return observation;
  const tuple = Object.fromEntries(['verdict', 'coverageState', 'indexingState', 'robotsTxtState', 'pageFetchState', 'googleCanonical', 'userCanonical', 'lastCrawlTime', 'crawledAs'].map(key => [key, text(result[key])]));
  observation.inspection = tuple;
  observation.reason = tuple.coverageState ?? 'coverage_reason_missing';
  observation.last_crawl_at = tuple.lastCrawlTime; // Provider time is not our retrieval time.
  observation.inspection_result_link = text(response.inspectionResult.inspectionResultLink);
  if (!tuple.coverageState) return observation;
  if (tuple.verdict === 'PASS') {
    // coverageState is human-readable and can be localized. v1 admits only these
    // reviewed en-US positive labels; unknown/new labels fail closed.
    let canonicalMatches = false;
    try { canonicalMatches = url(tuple.googleCanonical) === observation.url; } catch { /* missing or invalid is unknown */ }
    if (positiveCoverage.has(tuple.coverageState) && tuple.indexingState === 'INDEXING_ALLOWED' && tuple.pageFetchState === 'SUCCESSFUL' && canonicalMatches) {
      return { ...observation, tier: 'indexed', confidence: 'google_index_snapshot' };
    }
    return { ...observation, reason: 'inconsistent_or_unsupported_index_tuple' };
  }
  if (['NEUTRAL', 'FAIL'].includes(tuple.verdict) && !positiveCoverage.has(tuple.coverageState)) {
    return { ...observation, tier: 'not_indexed', confidence: 'google_index_snapshot' };
  }
  return { ...observation, reason: 'unspecified_or_inconsistent_index_verdict' };
}
export function licensedSiteIndexObservation(input) {
  if (!text(input.provider) || input.provider.length > 128) fail('INVALID_INDEX_PROVIDER');
  const inspected = url(input.inspectionUrl);
  if (input.query !== `site:${inspected}`) fail('INDEX_QUERY_SCOPE_MISMATCH');
  if (!text(input.country) || !text(input.language)) fail('INDEX_LOCALE_REQUIRED');
  const sourceKey = JSON.stringify(['licensed_site', input.provider, input.query, input.country, input.language]);
  const observation = envelope({ ...input, lane: 'licensed_site', backend: input.provider, sourceKey });
  observation.query = input.query; observation.country = input.country; observation.language = input.language;
  const result = observation.raw_response;
  if (result?.success !== true || result.complete !== true || !Array.isArray(result.results)) return observation;
  const urls = [];
  for (const row of result.results) {
    try { urls.push(url(row?.url)); } catch { return { ...observation, reason: 'invalid_result_url' }; }
  }
  return { ...observation, tier: urls.includes(inspected) ? 'likely_indexed' : 'not_found_in_site_query',
    confidence: 'search_result_sample', reason: urls.includes(inspected) ? 'exact_url_returned' : 'exact_url_not_returned' };
}

export function transitionIndexObservation(previous, observation, policy = INDEX_CONFIRMATION) {
  if (observation?.version !== INDEX_OBSERVATION_VERSION || !['gsc', 'licensed_site'].includes(observation.lane)
    || !['indexed', 'not_indexed', 'likely_indexed', 'not_found_in_site_query', 'unknown'].includes(observation.tier)
    || !text(observation.observation_id) || !text(observation.source_key)) fail('INVALID_INDEX_OBSERVATION');
  if (observation.lane !== 'gsc' && ['indexed', 'not_indexed'].includes(observation.tier)) fail('INVALID_INDEX_CONFIDENCE');
  const at = timestamp(observation.checked_at);
  if (!Number.isInteger(policy.probes) || policy.probes < 2 || policy.probes > 10 || !Number.isFinite(policy.minProbeIntervalMs)
    || policy.minProbeIntervalMs < 1 || !Number.isFinite(policy.graceMs) || policy.graceMs < policy.minProbeIntervalMs) fail('INVALID_INDEX_CONFIRMATION_POLICY');
  if (previous && (previous.url !== observation.url || previous.source_key !== observation.source_key)) fail('INDEX_STATE_SCOPE_MISMATCH');
  const state = previous ? structuredClone(previous) : { version: 1, url: observation.url, source_key: observation.source_key,
    confirmed: null, pending_negative: null, latest: null };
  if (state.latest && (state.latest.observation_id === observation.observation_id || state.confirmed?.observation_id === observation.observation_id
    || state.pending_negative?.observation_ids.includes(observation.observation_id) || Date.parse(at) <= Date.parse(state.latest.checked_at))) {
    return { state, event: null, ignored: 'duplicate_or_out_of_order' };
  }
  state.latest = structuredClone(observation);
  if (observation.tier === 'unknown' || observation.lane !== 'gsc') return { state, event: null };
  if (observation.tier === 'indexed') {
    const before = state.confirmed;
    state.confirmed = { tier: 'indexed', observed_at: at, observation_id: observation.observation_id, reason: observation.reason };
    state.pending_negative = null;
    return { state, event: before?.tier === 'not_indexed' ? { type: 'index.reindexed',
      id: `index.reindexed:${before.observation_id}:${observation.observation_id}`, url: observation.url,
      source_key: observation.source_key, before: before.tier, after: 'indexed', observation_ids: [before.observation_id, observation.observation_id] } : null };
  }
  if (observation.tier !== 'not_indexed' || state.confirmed?.tier === 'not_indexed') return { state, event: null };
  const pending = state.pending_negative ?? { first_at: at, last_counted_at: at, observation_ids: [observation.observation_id] };
  if (state.pending_negative && Date.parse(at) - Date.parse(pending.last_counted_at) >= policy.minProbeIntervalMs) {
    if (pending.observation_ids.length < policy.probes) pending.observation_ids.push(observation.observation_id);
    pending.last_counted_at = at;
  }
  state.pending_negative = pending;
  if (pending.observation_ids.length < policy.probes || Date.parse(at) - Date.parse(pending.first_at) < policy.graceMs) return { state, event: null };
  const before = state.confirmed;
  state.confirmed = { tier: 'not_indexed', observed_at: at, observation_id: observation.observation_id, reason: observation.reason };
  state.pending_negative = null;
  return { state, event: before?.tier === 'indexed' ? { type: 'index.deindexed',
    id: `index.deindexed:${pending.observation_ids[0]}:${observation.observation_id}`, url: observation.url,
    source_key: observation.source_key, before: before.tier, after: 'not_indexed',
    observation_ids: [...new Set([...pending.observation_ids, observation.observation_id])], first_negative_at: pending.first_at } : null };
}

// Advisory arithmetic only: a future transactional scheduler must reserve all
// four budgets atomically. This function cannot admit a network call.
export function inspectionQuotaHeadroom(usage, limits = URL_INSPECTION_LIMITS) {
  return Math.min(...Object.keys(URL_INSPECTION_LIMITS).map(key => {
    const row = usage?.[key];
    if (!row || !Number.isSafeInteger(row.attempted) || row.attempted < 0 || !Number.isSafeInteger(row.reserved) || row.reserved < 0
      || !Number.isSafeInteger(limits[key]) || limits[key] < 0) fail('INVALID_INDEX_QUOTA_USAGE');
    return Math.max(0, limits[key] - row.attempted - row.reserved);
  }));
}

// Compare dated evidence; never overwrite either source or select a winner.
export function reconcileIndexObservations(observations,{maxSkewMs=86400000}={}){
 if(!Array.isArray(observations)||observations.length>100||!Number.isFinite(maxSkewMs)||maxSkewMs<0)fail('INVALID_INDEX_RECONCILIATION');
 const bySource=new Map();
 for(const observation of observations){
  if(!observation?.url||!observation.source_key)fail('INVALID_INDEX_OBSERVATION');timestamp(observation.checked_at);
  const before=bySource.get(observation.source_key);if(!before||observation.checked_at>before.checked_at||(observation.checked_at===before.checked_at&&observation.observation_id>before.observation_id))bySource.set(observation.source_key,observation);
 }
 const rows=[...bySource.values()].sort((a,b)=>a.source_key.localeCompare(b.source_key));
 if(new Set(rows.map(r=>r.url)).size>1)fail('INDEX_STATE_SCOPE_MISMATCH');
 const comparisons=[];
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  const a=rows[i],b=rows[j];if(a.lane===b.lane)continue;
  const signs={indexed:1,likely_indexed:1,not_indexed:-1,not_found_in_site_query:-1};
  const skew=Math.abs(Date.parse(a.checked_at)-Date.parse(b.checked_at));
  const finding=skew>maxSkewMs?'not_comparable':!signs[a.tier]||!signs[b.tier]?'inconclusive':signs[a.tier]===signs[b.tier]?'agreement':'disagreement';
  comparisons.push({finding,resolution:'unresolved',observation_ids:[a.observation_id,b.observation_id],source_keys:[a.source_key,b.source_key],checked_at:[a.checked_at,b.checked_at],tiers:[a.tier,b.tier],time_skew_ms:skew,negative_search_result_is_not_proof:true});
 }
 return {version:1,url:rows[0]?.url??null,comparisons,combined_verdict:null};
}
