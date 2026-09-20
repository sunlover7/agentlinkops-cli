import test from 'node:test';
import assert from 'node:assert/strict';
import {gscIndexObservation,licensedSiteIndexObservation,validateInspectionProperty,transitionIndexObservation,inspectionQuotaHeadroom,URL_INSPECTION_LIMITS} from '../src/index-observation.js';
const URL='https://example.com/article',PROPERTY='https://example.com/';
const time=hours=>new Date(Date.UTC(2026,8,20)+hours*3600000).toISOString();
const input=(id,hours=0)=>({observationId:id,inspectionUrl:URL,checkedAt:time(hours),siteUrl:PROPERTY,grantedProperties:[PROPERTY]});
const positive={verdict:'PASS',coverageState:'Submitted and indexed',indexingState:'INDEXING_ALLOWED',pageFetchState:'SUCCESSFUL',robotsTxtState:'ALLOWED',googleCanonical:URL,userCanonical:URL,lastCrawlTime:'2026-09-15T00:00:00Z',crawledAs:'MOBILE'};
const response=tuple=>({inspectionResult:{inspectionResultLink:'https://search.google.com/search-console/inspect',indexStatusResult:structuredClone(tuple)}});
const gsc=(id,hours=0,tuple=positive)=>gscIndexObservation({...input(id,hours),payload:response(tuple)});
const negative=(id,hours)=>gsc(id,hours,{verdict:'NEUTRAL',coverageState:'Crawled - currently not indexed',indexingState:'INDEXING_ALLOWED',pageFetchState:'SUCCESSFUL'});
const site=(id,hours=0,rows=[],extra={})=>licensedSiteIndexObservation({observationId:id,inspectionUrl:URL,checkedAt:time(hours),provider:'licensed-fixture',query:`site:${URL}`,country:'US',language:'en',payload:{success:true,complete:true,results:rows},...extra});

test('GSC indexed tuple retains source reasons/canonical/crawl time/raw response without inventing a live fetch',()=>{
 const raw=response(positive),o=gscIndexObservation({...input('o1'),payload:raw});
 assert.equal(o.tier,'indexed');assert.equal(o.confidence,'google_index_snapshot');assert.equal(o.reason,positive.coverageState);
 assert.equal(o.last_crawl_at,positive.lastCrawlTime);assert.notEqual(o.last_crawl_at,o.checked_at);
 assert.equal(o.live_page_test,false);assert.equal(o.submission_requested,false);assert.deepEqual(o.raw_response,raw);
 raw.inspectionResult.indexStatusResult.verdict='FAIL';assert.equal(o.inspection.verdict,'PASS');
});

test('compound positive rule refuses excluded, noindex, different/missing canonical and unknown localized labels',()=>{
 for(const change of [{coverageState:'Excluded'},{indexingState:'BLOCKED_BY_META_TAG'},{googleCanonical:'https://example.com/other'},
 {googleCanonical:undefined},{coverageState:'Indexée'},{pageFetchState:'SERVER_ERROR'},{verdict:'VERDICT_UNSPECIFIED'}]){
  const o=gsc('o',0,{...positive,...change});assert.equal(o.tier,'unknown',JSON.stringify(change));
 }
});

test('Google negative retains its reason; malformed, errors and contradictory negative tuples are unknown',()=>{
 assert.equal(negative('n',0).tier,'not_indexed');
 assert.equal(negative('n',0).reason,'Crawled - currently not indexed');
 assert.equal(gsc('o',0,{...positive,verdict:'FAIL'}).tier,'unknown');
 for(const payload of [null,{}, {error:{code:403,message:'permission denied'}},{inspectionResult:{indexStatusResult:{verdict:'FAIL'}}}]){
  assert.equal(gscIndexObservation({...input('error'),payload}).tier,'unknown');
 }
});

test('property grant keeps exact trailing slash and enforces prefix/domain boundaries',()=>{
 assert.equal(validateInspectionProperty(URL,PROPERTY,[PROPERTY]),PROPERTY);
 assert.throws(()=>validateInspectionProperty(URL,'https://example.com',['https://example.com']),/INVALID_INDEX_PROPERTY/);
 assert.throws(()=>validateInspectionProperty(URL,PROPERTY,['https://example.com']),/INDEX_PROPERTY_NOT_GRANTED/);
 assert.throws(()=>validateInspectionProperty('https://example.com/other','https://example.com/articles/',['https://example.com/articles/']),/OUTSIDE_PROPERTY/);
 assert.equal(validateInspectionProperty('https://www.example.com/article','sc-domain:example.com',['sc-domain:example.com']),'sc-domain:example.com');
 assert.throws(()=>validateInspectionProperty('https://notexample.com/article','sc-domain:example.com',['sc-domain:example.com']),/OUTSIDE_PROPERTY/);
});

test('licensed site positives require exact returned URL; misses remain weak and partial/error payloads unknown',()=>{
 assert.equal(site('s1',0,[{url:URL}]).tier,'likely_indexed');
 for(const rows of [[],[{url:URL+'/child'}],[{url:URL+'?other=1'}],[{url:'https://www.example.com/article'}]])assert.equal(site('s',0,rows).tier,'not_found_in_site_query');
 for(const payload of [{success:false,complete:true,results:[]},{success:true,complete:false,results:[]},{success:true,complete:true,results:[{url:'javascript:alert(1)'}]}])assert.equal(site('s',0,[],{payload}).tier,'unknown');
 assert.throws(()=>site('s',0,[],{query:'site:example.com'}),/QUERY_SCOPE_MISMATCH/);
 assert.equal(site('s').confidence,'search_result_sample');
});

test('deindex requires separate qualified probes and elapsed grace; unknown preserves last known state',()=>{
 let {state}=transitionIndexObservation(null,gsc('baseline'));
 ({state}=transitionIndexObservation(state,negative('first',1)));assert.equal(state.confirmed.tier,'indexed');
 let step=transitionIndexObservation(state,negative('too-close',1.1));state=step.state;assert.equal(state.pending_negative.observation_ids.length,1);assert.equal(step.event,null);
 step=transitionIndexObservation(state,negative('second',2));state=step.state;assert.equal(state.pending_negative.observation_ids.length,2);assert.equal(step.event,null);
 const unknown=gscIndexObservation({...input('unknown',24),payload:{error:{code:429}}});
 step=transitionIndexObservation(state,unknown);state=step.state;assert.equal(state.confirmed.tier,'indexed');assert.equal(step.event,null);
 step=transitionIndexObservation(state,negative('confirmed',25));assert.equal(step.state.confirmed.tier,'not_indexed');assert.equal(step.event.type,'index.deindexed');
 assert.deepEqual(step.event.observation_ids,['first','second','confirmed']);
 assert.equal(transitionIndexObservation(step.state,negative('still-negative',26)).event,null);
 const restored=transitionIndexObservation(step.state,gsc('restored',27));assert.equal(restored.event.type,'index.reindexed');
});

test('replay/out-of-order inputs never count and transition does not mutate caller state',()=>{
 let {state}=transitionIndexObservation(null,gsc('baseline'));
 ({state}=transitionIndexObservation(state,negative('first',1)));
 const before=structuredClone(state);
 for(const observation of [negative('first',1),negative('first',30),negative('out-of-order',0.5),negative('same-time',1)]){
  const result=transitionIndexObservation(state,observation);assert.equal(result.event,null);assert.equal(result.ignored,'duplicate_or_out_of_order');assert.deepEqual(result.state,state);
 }
 transitionIndexObservation(state,negative('next',30));assert.deepEqual(state,before);
});

test('a fresh indexed observation resets suspicion; initial negatives never announce deindexing',()=>{
 let {state}=transitionIndexObservation(null,gsc('baseline'));
 ({state}=transitionIndexObservation(state,negative('first',1)));
 ({state}=transitionIndexObservation(state,gsc('present',2)));assert.equal(state.pending_negative,null);
 assert.equal(transitionIndexObservation(state,negative('new-first',30)).event,null);
 ({state}=transitionIndexObservation(null,negative('initial-negative',0)));
 const next=transitionIndexObservation(state,negative('initial-confirmed',24));assert.equal(next.state.confirmed.tier,'not_indexed');assert.equal(next.event,null);
});

test('weak supplier samples never generate deindex events or combine into a Google confirmation',()=>{
 let state=null;
 for(let i=0;i<5;i++){const next=transitionIndexObservation(state,site(`s${i}`,i*24,i===0?[{url:URL}]:[]));state=next.state;assert.equal(next.event,null);assert.equal(state.confirmed,null);}
 assert.throws(()=>transitionIndexObservation(state,negative('google',150)),/STATE_SCOPE_MISMATCH/);
 assert.throws(()=>transitionIndexObservation(null,{...site('forged'),tier:'not_indexed'}),/INVALID_INDEX_CONFIDENCE/);
});

test('quota headroom independently charges attempted and reserved requests at all four bounds',()=>{
 const usage=Object.fromEntries(Object.keys(URL_INSPECTION_LIMITS).map(key=>[key,{attempted:0,reserved:0}]));
 assert.equal(inspectionQuotaHeadroom(usage),600);
 usage.propertyPerDay={attempted:1999,reserved:1};assert.equal(inspectionQuotaHeadroom(usage),0);
 usage.propertyPerDay={attempted:0,reserved:0};usage.projectPerMinute={attempted:14999,reserved:0};assert.equal(inspectionQuotaHeadroom(usage),1);
 assert.throws(()=>inspectionQuotaHeadroom({...usage,propertyPerDay:{attempted:-1,reserved:0}}),/INVALID_INDEX_QUOTA/);
});

test('invalid envelope version, timestamp and confirmation policies fail before changing state',()=>{
 assert.throws(()=>gscIndexObservation({...input('o'),checkedAt:'not-a-time',payload:response(positive)}),/INVALID_INDEX_TIMESTAMP/);
 assert.throws(()=>transitionIndexObservation(null,{...gsc('o'),version:2}),/INVALID_INDEX_OBSERVATION/);
 assert.throws(()=>transitionIndexObservation(null,gsc('o'),{probes:1,minProbeIntervalMs:1,graceMs:1}),/CONFIRMATION_POLICY/);
 assert.throws(()=>gscIndexObservation({...input('o'),payload:{large:'x'.repeat(262145)}}),/EXCEEDS_BOUND/);
});
