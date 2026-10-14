import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLink,transitionState} from '../src/verifier/index.js';

const source='https://publisher.com/article',target='https://customer.com/';
const start=Date.parse('2026-10-11T00:00:00.000Z');
const at=minute=>new Date(start+minute*60000).toISOString();
const observed=(state,minute)=>({state,reason:state,checkedAt:at(minute),sourceUrl:source,finalUrl:source,targetUrl:target,
  httpStatus:200,occurrences:state==='present'?[{targetUrl:target,anchor:'Customer',rel:[]}]:[],evidence:{complete:true}});
async function blocked(reason,minute){
  const timeout=reason==='timeout';
  const result=await verifyLink({sourceUrl:source,targetUrl:target},{publicFetchSafe:true,timeoutMs:timeout?20:1000,now:at(minute),
    fetchImpl:async url=>url.endsWith('/robots.txt')?new Response(null,{status:404})
      :timeout?new Response(new ReadableStream({}),{headers:{'content-type':'text/html'}})
        :new Response(null,{status:Number(reason.slice('source_http_'.length))})});
  assert.equal(result.state,'unknown');assert.equal(result.reason,reason);return result;
}

for(const reason of ['source_http_403','timeout','source_http_526'])test(`latest ${reason} cannot confirm a suspected loss`,async()=>{
  const present=transitionState(null,observed('present',0));
  const suspected=transitionState(present,observed('absent',1));
  const current=transitionState(suspected,await blocked(reason,45));
  assert.equal(current.state,'unknown');assert.equal(current.confirmedState,'present');assert.equal(current.uncertain,true);
  assert.equal(current.latestAttempt.state,'unknown');assert.equal(current.latestAttempt.reason,reason);
  assert.deepEqual(current.lastSuccessfulObservation,suspected.lastSuccessfulObservation);
  assert.equal(current.absentCount,1);assert.equal(current.firstAbsentAt,at(1));assert.equal(current.event,null);
  const clean=transitionState(current,observed('absent',50));
  assert.equal(clean.state,'confirmed_missing');assert.equal(clean.absentCount,2);assert.equal(clean.event.type,'placement_lost');
});
for(const reason of ['source_http_403','timeout','source_http_526'])test(`latest ${reason} exposes uncertainty without erasing a historical two-check loss`,async()=>{
  const present=transitionState(null,observed('present',0));
  const confirmed=transitionState(transitionState(present,observed('absent',1)),observed('absent',31));
  const current=transitionState(confirmed,await blocked(reason,45));
  assert.equal(current.state,'unknown');assert.equal(current.confirmedState,'confirmed_missing');assert.equal(current.uncertain,true);
  assert.equal(current.latestAttempt.state,'unknown');assert.equal(current.latestAttempt.reason,reason);
  assert.deepEqual(current.lastSuccessfulObservation,confirmed.lastSuccessfulObservation);
  assert.equal(current.firstAbsentAt,at(1));assert.equal(current.absentCount,2);assert.equal(current.event,null);
  const stillMissing=transitionState(current,observed('absent',50));
  assert.equal(stillMissing.state,'confirmed_missing');assert.equal(stillMissing.event,null,'an access failure cannot create another loss event');
  const recovered=transitionState(current,observed('present',51));
  assert.equal(recovered.state,'present');assert.equal(recovered.confirmedState,'present');
  assert.equal(recovered.event.type,'placement_recovered');assert.equal(recovered.absentCount,0);
});
test('a legacy confirmed loss gains explicit historical provenance on its next blocked check',async()=>{
  const present=transitionState(null,observed('present',0));
  const legacy=transitionState(transitionState(present,observed('absent',1)),observed('absent',31));
  delete legacy.confirmedState;
  const current=transitionState(legacy,await blocked('source_http_403',45));
  assert.equal(current.state,'unknown');assert.equal(current.confirmedState,'confirmed_missing');
  assert.equal(current.absentCount,2);assert.equal(current.firstAbsentAt,at(1));
  assert.equal(transitionState(current,observed('present',50)).event.type,'placement_recovered');
});
test('incomplete claimed absence cannot change current or historical confirmation',()=>{
  const present=transitionState(null,observed('present',0));
  const invalid=transitionState(present,{...observed('absent',40),evidence:{complete:false}});
  assert.equal(invalid.state,'unknown');assert.equal(invalid.confirmedState,'present');
  assert.equal(invalid.absentCount,0);assert.deepEqual(invalid.lastSuccessfulObservation,present.lastSuccessfulObservation);
  assert.equal(invalid.event,null);
});
test('an observed source 404 remains a source fact and cannot confirm link loss',()=>{
  const present=transitionState(null,observed('present',0));
  const missingSource=transitionState(present,{...observed('source_unavailable',40),reason:'source_http_404',httpStatus:404});
  assert.equal(missingSource.state,'source_unavailable');assert.equal(missingSource.absentCount,0);
  assert.equal(missingSource.sourceUnavailableConfirmed,false);assert.equal(missingSource.event,null);
});
