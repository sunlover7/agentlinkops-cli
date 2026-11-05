import test from 'node:test';
import assert from 'node:assert/strict';
import {planContactAdoption,applyContactAdoption,rollbackContactAdoption} from '../cli/contact-adoption.js';

const contact={externalRef:'outreach:example:editor',name:'Example editor',email:'editor@publisher.example',contactUrl:null};
const link={projectId:'p1',watchId:'w1',localReference:'ledger-original',contactId:null,revision:0};
function transport(){
 let record=null,association={watchId:'w1',contactId:null,revision:0};const calls=[];
 return{calls,get record(){return record;},edit(){record={...record,name:'Later human edit',revision:record.revision+1};},async call(name,input){
  calls.push(name);
  if(name==='list_contacts')return{items:record?[record]:[],nextAfter:null,link:association};
  if(name==='save_contact'){
   if(record&&JSON.stringify(input.contact)===JSON.stringify(Object.fromEntries(Object.keys(contact).map(k=>[k,record[k]]))))return{contact:record,replayed:true};
   if(input.revision!==(record?.revision??0))throw new Error('CONTACT_REVISION_CONFLICT');
   record={...input.contact,id:'contact_fixture',projectId:'p1',revision:(record?.revision??0)+1,createdAt:'fixture',updatedAt:'fixture'};return{contact:record,replayed:false};
  }
  if(name==='set_link_contact'){
   if(association.contactId!==input.contactId){if(input.revision!==association.revision)throw new Error('CONTACT_REVISION_CONFLICT');association={watchId:'w1',contactId:input.contactId,revision:association.revision+1};}return association;
  }
  if(name==='delete_contact'){if(input.onlyIfUnlinked&&association.contactId===record.id)throw new Error('CONTACT_REVISION_CONFLICT');record=null;return{deleted:true};}
  throw new Error('UNEXPECTED_EFFECT');
 }};
}
test('contact adoption previews conflicts, replays without new effects and rolls back with concurrency holds',async()=>{
 const plan=planContactAdoption({projectId:'p1',rows:[{contact,localReference:link.localReference}],links:[link]});assert.equal(plan.results[0].status,'ready');
 const api=transport(),first=await applyContactAdoption(plan,api.call),again=await applyContactAdoption(plan,api.call);assert.equal(first.results[0].status,'applied');assert.equal(again.results[0].status,'applied');assert.equal(api.record.revision,1);assert.equal(again.results[0].link.revision,1);assert.equal(again.results[0].replayed,true);
 const rollback=await rollbackContactAdoption(first,api.call);assert.equal(rollback.results[0].status,'restored');assert.equal(api.record,null);assert.ok(api.calls.every(n=>['list_contacts','save_contact','set_link_contact','delete_contact'].includes(n)));
 const rollbackReplay=await rollbackContactAdoption(first,api.call);assert.equal(rollbackReplay.results[0].status,'already_restored');assert.equal(rollbackReplay.effects.confirmedContactDeletes,0);assert.equal(rollbackReplay.effects.confirmedAssociationWrites,0);
 const changed=transport(),saved=await applyContactAdoption(plan,changed.call);changed.edit();const held=await rollbackContactAdoption(saved,changed.call);assert.equal(held.results[0].status,'held');assert.equal(changed.record.name,'Later human edit');
 const conflicts=planContactAdoption({projectId:'p1',rows:[{contact,localReference:link.localReference},{contact:{...contact,name:'Conflicting source'},localReference:link.localReference}],links:[link]});assert.ok(conflicts.results.every(r=>r.status==='conflict'));
 const duplicateLink=planContactAdoption({projectId:'p1',rows:[{contact,localReference:link.localReference},{contact:{...contact,externalRef:'another:editor'},localReference:link.localReference}],links:[link]});assert.ok(duplicateLink.results.every(r=>r.reason==='conflicting_link_contact'));
 const ambiguous=planContactAdoption({projectId:'p1',rows:[{contact,localReference:link.localReference}],links:[link,{...link,watchId:'w2'}]});assert.equal(ambiguous.results[0].reason,'ambiguous_link_reference');
 await assert.rejects(applyContactAdoption({...plan,projectId:'changed'},api.call),/ADOPTION_PLAN_CHANGED/);
});
