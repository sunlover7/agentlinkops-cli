import test from 'node:test';
import assert from 'node:assert/strict';
import {transitionState} from '../src/verifier/transition.js';

const trace={version:1,selectedMethod:'node_http',attempts:[
  {method:'workers_http',state:'unknown',reason:'access_challenge',complete:false,durationMs:50},
  {method:'node_http',state:'present',reason:'matching_link_found',complete:true,durationMs:100},
]};
const observed=acquisition=>({state:'present',reason:'matching_link_found',checkedAt:'2026-10-11T15:00:00.000Z',
  sourceUrl:'https://publisher.example.org/',targetUrl:'https://customer.example.com/',occurrences:[],
  evidence:{complete:true,method:'http_html',acquisition,html:'private HTML',capture:{private:'capture'}}});

test('saved monitor evidence retains bounded attempts without raw transport or capture material',()=>{
  const untrusted={...trace,transportReceipts:[{authorization:'private credential'}],attempts:trace.attempts.map(item=>({...item,body:'private HTML',url:'private URL'}))};
  const state=transitionState(null,observed(untrusted));
  assert.deepEqual(state.latestAttempt.evidence.acquisition,trace);
  const saved=JSON.stringify(state);
  assert.doesNotMatch(saved,/private credential|private HTML|private URL|transportReceipts|capture/);
});

test('invalid or oversized attempt traces are omitted instead of leaking arbitrary records',()=>{
  for(const acquisition of [{...trace,attempts:[...trace.attempts,trace.attempts[0]]},
    {...trace,selectedMethod:'unreviewed_provider'},
    {...trace,attempts:[{...trace.attempts[0],durationMs:-1},trace.attempts[1]]}]){
    assert.equal(transitionState(null,observed(acquisition)).latestAttempt.evidence.acquisition,undefined);
  }
  const input={...trace,attempts:[{...trace.attempts[0],reason:'https://private.example/?secret=1'},trace.attempts[1]]};
  assert.equal(transitionState(null,observed(input)).latestAttempt.evidence.acquisition.attempts[0].reason,undefined);
});

test('an admitted DOM capture retains browser provenance in the compact trace',()=>{
  const rendered={...trace,selectedMethod:'node_browser',attempts:[trace.attempts[0],{...trace.attempts[1],method:'node_browser'}]};
  assert.deepEqual(transitionState(null,observed(rendered)).latestAttempt.evidence.acquisition,rendered);
});
