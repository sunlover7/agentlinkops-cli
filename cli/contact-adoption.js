import {createHash} from 'node:crypto';
import {contactFields} from '../shared/contact-record-contract.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=c=>({externalRef:c.externalRef,name:c.name,email:c.email,contactUrl:c.contactUrl});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** A contact-only bridge. Inputs are frozen exports; there are no source-CRM writes. */
export function planContactAdoption({projectId,rows,contacts=[],links=[]}){
 const seen=new Map(),results=[];
 for(const [index,row]of rows.entries()){
  const parsed=contactFields.safeParse(row.contact);
  let reason=!parsed.success?'invalid_contact':null;
  const contact=parsed.success?parsed.data:null;
  const sameRef=contact?contacts.filter(c=>c.externalRef===contact.externalRef):[];
  if(sameRef.length>1)reason='ambiguous_contact_reference';
  if(contact&&seen.has(contact.externalRef)&&!equal(seen.get(contact.externalRef),contact))reason='conflicting_source_contact';
  if(contact)seen.set(contact.externalRef,contact);
  const matches=links.filter(l=>l.localReference===row.localReference);
  if(!row.localReference||matches.length!==1)reason=matches.length>1?'ambiguous_link_reference':'link_reference_not_found';
  const beforeContact=sameRef[0]??null,beforeLink=matches[0]??null;
  if(beforeContact&&beforeContact.projectId!==projectId||beforeLink&&beforeLink.projectId!==projectId)reason='project_mismatch';
  results.push({row:index+1,localReference:row.localReference??null,contact,beforeContact,beforeLink,status:reason?'conflict':'ready',reason});
 }
 // Reject every row in a conflicting identity group; input order cannot pick a winner.
 const bad=new Set(results.filter(r=>r.reason==='conflicting_source_contact').map(r=>r.contact.externalRef));
 for(const row of results)if(bad.has(row.contact?.externalRef)){row.status='conflict';row.reason='conflicting_source_contact';}
 const byLink=new Map();
 for(const row of results){if(!row.beforeLink)continue;const group=byLink.get(row.beforeLink.watchId)??[];group.push(row);byLink.set(row.beforeLink.watchId,group);}
 for(const group of byLink.values())if(new Set(group.map(row=>row.contact?.externalRef)).size>1)for(const row of group){row.status='conflict';row.reason='conflicting_link_contact';}
 const plan={schemaVersion:'agentlinkops-contact-adoption-v1',projectId,results,effects:{sourceWrites:0,emails:0,sequenceEnrollments:0,newWatches:0,checks:0}};
 return{...plan,sha256:digest(plan)};
}

function verifyPlan(plan){const {sha256,...body}=plan;if(body.schemaVersion!=='agentlinkops-contact-adoption-v1'||digest(body)!==sha256)throw new Error('ADOPTION_PLAN_CHANGED');}
/** Caller supplies the authenticated command transport; no credentials or mailbox are read here. */
export async function applyContactAdoption(plan,call){
 verifyPlan(plan);const results=[],effects={...plan.effects,confirmedContactWrites:0,confirmedAssociationWrites:0,rowsRequiringReadback:0};
 for(const row of plan.results){
  if(row.status!=='ready'){results.push({row:row.row,status:'conflict',reason:row.reason});continue;}
  const base={projectId:plan.projectId};let saved=null,writeAttempted=false;
  try{
   const current=await call('list_contacts',{...base,externalRef:row.contact.externalRef,watchId:row.beforeLink.watchId,limit:2});
   const contact=current.items[0]??null;
   if(current.items.length>1)throw new Error('CONTACT_IDENTITY_CONFLICT');
   // Exact desired content is a safe replay. A changed source preview never overwrites a human edit.
   if(contact&&!equal(fields(contact),row.contact)&&(!row.beforeContact||contact.revision!==row.beforeContact.revision||!equal(fields(contact),fields(row.beforeContact))))throw new Error('CONTACT_CHANGED_SINCE_PREVIEW');
   if(!contact&&row.beforeContact)throw new Error('CONTACT_REMOVED_SINCE_PREVIEW');
   if(current.link?.contactId!==row.beforeLink.contactId&&current.link?.contactId!==contact?.id)throw new Error('LINK_CHANGED_SINCE_PREVIEW');
   writeAttempted=true;saved=await call('save_contact',{...base,revision:contact?.revision??0,contact:row.contact});
   if(!saved.replayed)effects.confirmedContactWrites++;
   const linked=await call('set_link_contact',{...base,watchId:row.beforeLink.watchId,contactId:saved.contact.id,revision:current.link?.revision??0});
   if(linked.revision!==(current.link?.revision??0))effects.confirmedAssociationWrites++;
   results.push({row:row.row,status:'applied',contactId:saved.contact.id,contactRevision:saved.contact.revision,link:linked,replayed:saved.replayed,rollback:{beforeContact:row.beforeContact,beforeLink:row.beforeLink,afterContact:saved.contact,afterLink:linked}});
  }catch(error){if(writeAttempted)effects.rowsRequiringReadback++;results.push({row:row.row,status:'conflict',reason:error.code??error.message,effectState:writeAttempted?'requires_readback':'none',...(saved?{contactSaved:true,contactId:saved.contact.id,contactRevision:saved.contact.revision}:{} )});}
 }
 return{schemaVersion:plan.schemaVersion,planSha256:plan.sha256,projectId:plan.projectId,results,effects};
}

/** Explicit compensating rollback. Concurrent edits hold the row; sender/source data is untouched. */
export async function rollbackContactAdoption(receipt,call){
 const results=[],effects={sourceWrites:0,emails:0,sequenceEnrollments:0,newWatches:0,checks:0,confirmedAssociationWrites:0,confirmedContactWrites:0,confirmedContactDeletes:0,rowsRequiringReadback:0};
 for(const result of [...receipt.results].reverse()){
  if(!result.rollback){results.push({row:result.row,status:'no_effect'});continue;}
  const {beforeContact,beforeLink,afterContact,afterLink}=result.rollback,base={projectId:receipt.projectId};
  try{
   const current=await call('list_contacts',{...base,externalRef:afterContact.externalRef,watchId:afterLink.watchId,limit:2});
   const contact=current.items[0];
   if(current.link.contactId===beforeLink.contactId&&(!beforeContact&&!contact||beforeContact&&contact&&equal(fields(contact),fields(beforeContact)))){results.push({row:result.row,status:'already_restored'});continue;}
   if(!contact||contact.revision!==afterContact.revision||!equal(fields(contact),fields(afterContact)))throw new Error('ROLLBACK_CONCURRENT_CHANGE');
   if(current.link.contactId!==beforeLink.contactId){
    if(current.link.contactId!==afterLink.contactId||current.link.revision!==afterLink.revision)throw new Error('ROLLBACK_CONCURRENT_CHANGE');
    const restoredLink=await call('set_link_contact',{...base,watchId:afterLink.watchId,contactId:beforeLink.contactId,revision:afterLink.revision});
    if(restoredLink.revision!==afterLink.revision)effects.confirmedAssociationWrites++;
   }
   // Newly created contacts can be shared by later rows. Restore/delete once, after all links.
   results.push({row:result.row,status:'link_restored',contactId:afterContact.id,beforeContact,afterContact});
  }catch(error){effects.rowsRequiringReadback++;results.push({row:result.row,status:'held',reason:error.code??error.message});}
 }
 const restored=new Set();
 for(const row of results){
  if(row.status!=='link_restored'||restored.has(row.contactId))continue;
  // Do not erase a new contact if another row failed to detach; preserve useful partial state.
  if(results.some(r=>r.status==='held'))continue;
  restored.add(row.contactId);
  try{if(row.beforeContact){const saved=await call('save_contact',{projectId:receipt.projectId,revision:row.afterContact.revision,contact:fields(row.beforeContact)});if(!saved.replayed)effects.confirmedContactWrites++;}
   else {const removed=await call('delete_contact',{projectId:receipt.projectId,contactId:row.contactId,revision:row.afterContact.revision,onlyIfUnlinked:true});if(removed.deleted)effects.confirmedContactDeletes++;}row.status='restored';
  }catch(error){effects.rowsRequiringReadback++;row.status='held';row.reason=error.code??error.message;}
 }
 return{planSha256:receipt.planSha256,results,effects};
}
