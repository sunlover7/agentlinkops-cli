import test from 'node:test';
import assert from 'node:assert/strict';
import {planOutcomeImport,planOutcomeCsvImport,applyOutcomeImport} from '../cli/campaign-outcomes.js';
const date='2026-10-24T12:00:00Z';
const binding={projectId:'p1',namespace:'hunter',accountRef:'account1',recordRef:'lead1',watchId:'w1',contactId:'contact1',contactRevision:'11111111-1111-4111-8111-111111111111',associationRevision:'22222222-2222-4222-8222-222222222222',method:'email'};
const columns={recordRef:'Stable ID',status:'Sending status',occurredAt:'Event at',eventId:'Event ID'};
const options={projectId:'p1',provider:'hunter',accountRef:'account1',bindings:[binding],columns};
const raw=(status='replied')=>({'Stable ID':'lead1','Sending status':status,'Event at':date,'Email':'private@synthetic.example','Body':'never include','Reply text':'never include'});

test('provider result imports join exact scoped references and strip contact/message contents',async()=>{
 const plan=planOutcomeImport({...options,rows:[raw()]});assert.equal(plan.results[0].status,'ready');assert.equal(plan.results[0].input.outcome,'replied');
 const encoded=JSON.stringify(plan);assert.ok(!encoded.includes('private@'));assert.ok(!encoded.includes('never include'));assert.ok(!encoded.includes('Email'));
 const calls=[],seen=new Set();const call=async(name,input)=>{calls.push({name,input});const replayed=seen.has(input.idempotencyKey);seen.add(input.idempotencyKey);return{event:{id:'ev1',outcome:input.outcome,disposition:'accepted'},replayed};};
 assert.equal((await applyOutcomeImport(plan,call)).effects.recorded,1);assert.equal((await applyOutcomeImport(plan,call)).effects.replayed,1);assert.ok(calls.every(c=>c.name==='record_outreach_outcome'));
 assert.deepEqual(plan,planOutcomeImport({...options,rows:[raw()]}));
});

test('opens, clicks, queueing and drafts never imply contacted; success is not independently verified won',()=>{
 const plan=planOutcomeImport({...options,rows:['opened','clicked','queued','drafted','successful','won'].map(raw)});
 assert.deepEqual(plan.results.map(r=>r.status),['ignored','ignored','ignored','ignored','held','ready']);assert.equal(plan.results[5].input.outcome,'publication_claimed');
 assert.throws(()=>planOutcomeImport({...options,statusMap:{successful:'won'},rows:[raw('successful')]}),/INVALID_OUTCOME_STATUS_MAP/);
});

test('unknown/ambiguous/cross-project/PII joins and missing event dates are held',()=>{
 assert.equal(planOutcomeImport({...options,bindings:[],rows:[raw()]}).results[0].reason,'unmapped_binding');
 assert.equal(planOutcomeImport({...options,bindings:[binding,binding],rows:[raw()]}).results[0].reason,'ambiguous_binding');
 assert.equal(planOutcomeImport({...options,bindings:[{...binding,projectId:'other'}],rows:[raw()]}).results[0].reason,'invalid_or_cross_project_binding');
 assert.equal(planOutcomeImport({...options,rows:[{...raw(),'Stable ID':'email@not-an-id.example'}]}).results[0].reason,'missing_stable_record_reference');
 assert.equal(planOutcomeImport({...options,rows:[{...raw(),'Event at':''}]}).results[0].reason,'missing_or_invalid_event_date');
 assert.throws(()=>planOutcomeImport({...options,provider:'instantly',columns:null,rows:[]}),/INVALID_OUTCOME_COLUMNS/);
});

test('bounce/restriction facts require original contact method and preserve scoped vocabulary',()=>{
 const plan=planOutcomeImport({...options,rows:[raw('bounced'),raw('unsubscribed')]});assert.equal(plan.results[0].input.outcome,'bounced');assert.equal(plan.results[0].input.contactRevision,'11111111-1111-4111-8111-111111111111');assert.equal(plan.results[1].input.restrictionScope,'method');
 assert.ok(plan.results.every(r=>!JSON.stringify(r.input).includes('abandoned')));
 const held=planOutcomeImport({...options,bindings:[{...binding,contactRevision:undefined}],rows:[raw('bounced')]});assert.equal(held.results[0].reason,'contact_method_provenance_required');
 const health=planOutcomeImport({...options,provider:'manual',bindings:[{...binding,namespace:'manual'}],columns:{recordRef:'Stable ID',status:'Sending status',occurredAt:'Event at',validity:'Validity'},rows:[{...raw('email_health'),Validity:'catch-all'}]});assert.equal(health.results[0].input.validity,'catch-all');
});

test('lemlist documented step timestamps create separate dated facts; untouched activity has no effect',()=>{
 const plan=planOutcomeCsvImport({projectId:'p1',provider:'lemlist',accountRef:'account1',bindings:[{...binding,namespace:'lemlist'}],columns:{recordRef:'agentlinkops_record_ref'},csv:`agentlinkops_record_ref,sentAt1,repliedAt1,openAt1,email\nlead1,${date},${date},${date},private@synthetic.example\n`});
 assert.deepEqual(plan.results.map(r=>r.input.outcome),['contacted','replied']);assert.notEqual(plan.results[0].input.idempotencyKey,plan.results[1].input.idempotencyKey);assert.ok(!JSON.stringify(plan).includes('private@'));
 assert.throws(()=>planOutcomeCsvImport({...options,csv:'Stable ID,Stable ID\na,b\n'}),/DUPLICATE_OUTCOME_HEADER/);
});

test('CSV parse failures and conflicting source events stay visible, uncertainty is not replayed',async()=>{
 const conflict=planOutcomeImport({...options,rows:[{...raw('sent'),'Event ID':'same-event'},{...raw('replied'),'Event ID':'same-event'}]});assert.ok(conflict.results.every(r=>r.reason==='conflicting_source_event'));
 const csv=planOutcomeCsvImport({...options,csv:'Stable ID,Sending status,Event at\nlead1,replied\n'});assert.equal(csv.results[0].reason,'invalid_export_row');
 const plan=planOutcomeImport({...options,rows:[raw()]});let count=0;const result=await applyOutcomeImport(plan,async()=>{count++;throw new Error('lost_response');});assert.equal(count,1);assert.equal(result.effects.rowsRequiringReadback,1);assert.equal(result.results[0].effectState,'requires_readback');
 await assert.rejects(applyOutcomeImport({...plan,projectId:'changed'},async()=>{}),/OUTCOME_PLAN_CHANGED/);
});

test('frozen three-provider export profiles preserve field boundaries and ignore preparation-only states',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const provider of ['hunter','lemlist','instantly']){
  const name=provider==='lemlist'?'lemlist-step-timestamps.csv':`${provider}-mapped.csv`;
  const csv=await readFile(new URL(`./fixtures/campaign-outcomes/${name}`,import.meta.url),'utf8');
  const mapped=provider==='lemlist'?{recordRef:'alo_record_ref'}:{recordRef:'alo_record_ref',status:provider==='hunter'?'Sending status':'Lead status',occurredAt:'actual_event_at',eventId:'source_event_id'};
  const plan=planOutcomeCsvImport({projectId:'p1',provider,accountRef:'account1',bindings:[{...binding,namespace:provider,recordRef:'lead-fixture-1'}],columns:mapped,csv});
  assert.ok(plan.results.some(r=>r.status==='ready'));assert.ok(!JSON.stringify(plan).includes('synthetic@'));assert.ok(!JSON.stringify(plan).includes('fixture-only body'));
  const calls=[];await applyOutcomeImport(plan,async(name,input)=>{calls.push(input);return{event:{id:'fixture-event',outcome:input.outcome,disposition:'accepted'},replayed:false};});
  assert.ok(calls.every(row=>!['opened','completed','won'].includes(row.outcome)));
 }
});

test('derived source-event identity survives contact replacement and is scoped by record rather than row number',()=>{
 const first=planOutcomeImport({...options,rows:[raw('bounced')]}).results[0].input;
 const changed=planOutcomeImport({...options,bindings:[{...binding,contactId:'replacement',contactRevision:'33333333-3333-4333-8333-333333333333',associationRevision:'44444444-4444-4444-8444-444444444444'}],rows:[raw('bounced')]}).results[0].input;
 assert.equal(first.source.eventId,changed.source.eventId);assert.equal(first.idempotencyKey,changed.idempotencyKey);assert.notEqual(first.contactId,changed.contactId);
 const rows=[{...raw(),'Event ID':'one'},{...raw(),'Stable ID':'lead2','Event ID':'one'}];
 const plan=planOutcomeImport({...options,bindings:[binding,{...binding,recordRef:'lead2',watchId:'w2'}],rows});
 assert.equal(plan.results.filter(r=>r.status==='ready').length,2);assert.notEqual(plan.results[0].input.idempotencyKey,plan.results[1].input.idempotencyKey);
});
