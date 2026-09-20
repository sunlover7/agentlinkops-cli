import test from 'node:test';
import assert from 'node:assert/strict';
import {decimalCostToMinor,minorCostToDecimal,legacyCostPatch,CURRENCY_MINOR_DIGITS} from '../shared/lifecycle-money.js';
import {LIFECYCLE_CURRENCIES,emptyDeal} from '../shared/lifecycle-contract.js';
import {normalizeEntry,serializeLedger} from '../cli/ledger.js';
import {pullLifecycleMirrors} from '../cli/sync.js';
test('legacy decimal costs convert exactly with declared currency scales and no rounding',()=>{
 assert.deepEqual(Object.keys(CURRENCY_MINOR_DIGITS).sort(),[...LIFECYCLE_CURRENCIES].sort());
 for(const [amount,currency,minor] of [['0.29','USD',29],['12','JPY',12],['0.001','KWD',1],['10.000','JPY',10],['10000000000.00','USD',1e12]]){
  assert.equal(decimalCostToMinor(amount,currency),minor);assert.equal(decimalCostToMinor(minorCostToDecimal(minor,currency),currency),minor);
 }
 for(const [amount,currency] of [['1.001','USD'],['0.1','JPY'],['1e2','USD'],['-1','USD'],[0.29,'USD'],['10000000000.01','USD'],['1','XYZ']])assert.throws(()=>decimalCostToMinor(amount,currency));
 assert.deepEqual(legacyCostPatch({cost_amount:null,cost_currency:null,dealNote:'cleared'}),{costMinor:null,currency:null,dealNote:'cleared'});
 assert.throws(()=>legacyCostPatch({cost_amount:'1',cost_currency:'USD',costMinor:100}));
});
test('ledger round-trip preserves complete deal intent and old unknown customer fields',()=>{
 const original={id:'lk_abcd',intent:'expected',source:'https://a.example.com',target:'https://b.example.com',custom:'keep'};
 const deal={...emptyDeal(),costMinor:0,currency:'USD',expiresOn:'2027-01-01'};
 const row=normalizeEntry({...original,deal});assert.deepEqual(JSON.parse(serializeLedger([row])).deal,deal);assert.equal(row.custom,'keep');
 assert.ok(!('deal' in normalizeEntry(original)));assert.throws(()=>normalizeEntry({...original,deal:{...deal,costMinor:0.29}}));
});
test('lifecycle pull mirrors only matching scoped snapshots and never mutates intent or old state',async()=>{
 const state={watches:{lk_abcd:'watch_1'},lifecycle:{prior:'keep'}},before=JSON.stringify(state);
 const value={watchId:'watch_1',projectId:'project_1',revision:2,deal:{...emptyDeal(),costMinor:1,currency:'KWD'},createdAt:null,updatedAt:null};
 const mirror=await pullLifecycleMirrors({callCommand:async(name,args)=>{assert.equal(name,'get_link_lifecycle');assert.equal(args.projectId,'project_1');return value;}},state,{projectId:'project_1',now:()=> '2026-09-20T00:00:00Z'});
 assert.equal(mirror.rows.lk_abcd.revision,2);assert.equal(mirror.rows.lk_abcd.deal.costMinor,1);assert.equal(JSON.stringify(state),before);
 await assert.rejects(pullLifecycleMirrors({callCommand:async()=>({...value,projectId:'other'})},state,{projectId:'project_1'}),e=>e.code==='LIFECYCLE_MIRROR_SCOPE');
 await assert.rejects(pullLifecycleMirrors({callCommand:async()=>{throw Error('revoked');}},state,{projectId:'project_1'}),/revoked/);assert.equal(JSON.stringify(state),before);
});
test('lifecycle mirror fails closed on duplicate identity, a later read failure and excessive rows',async()=>{
 let calls=0;const prior={watches:{lk_one:'w1',lk_two:'w2'},lifecycle:{prior:'keep'}},before=JSON.stringify(prior);
 await assert.rejects(pullLifecycleMirrors({callCommand:async()=>{if(++calls===2)throw Error('second failed');return {projectId:'p',watchId:'w1',revision:0,deal:emptyDeal(),createdAt:null,updatedAt:null};}},prior,{projectId:'p'}),/second failed/);assert.equal(JSON.stringify(prior),before);
 calls=0;const client={callCommand:async()=>{calls++;throw Error('unexpected');}};
 await assert.rejects(pullLifecycleMirrors(client,{}, {projectId:'p',index:new Map([['w1','lk_one'],['w2','lk_one']])}),e=>e.code==='LIFECYCLE_MAPPING_CONFLICT');
 await assert.rejects(pullLifecycleMirrors(client,{watches:Object.fromEntries(Array.from({length:1001},(_,i)=>['lk_'+i,'w'+i]))},{projectId:'p'}),e=>e.code==='LIFECYCLE_MIRROR_LIMIT');assert.equal(calls,0);
});
