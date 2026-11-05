import {createHash} from 'node:crypto';
import {readTable} from './adapters/csv.js';

const VERSION='agentlinkops-outcome-import-v1';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f@]/.test(value)&&!/https?:\/\//i.test(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value.slice(0,10);
const seal=body=>({...body,sha256:hash(body)});
const OUTCOMES=['contacted','replied','publication_promised','declined','publication_claimed','bounced','send_error','wrong_person','do_not_contact','email_health'];
const IGNORED=new Set(['opened','clicked','open','click','pending','queued','drafted','draft','canceled','cancelled','completed','not yet contacted','not_yet_contacted']);
const COMMON=Object.freeze({sent:'contacted',contacted:'contacted',replied:'replied',reply:'replied',bounced:'bounced',bounce:'bounced',error:'send_error',failed:'send_error',unsubscribed:'do_not_contact',unsubscribe:'do_not_contact',won:'publication_claimed'});

/** The imported shape is explicit. Vendor docs do not promise universal stable CSV headers. */
export const OUTCOME_EXPORT_PROFILES=Object.freeze({
 hunter:{version:'hunter-selected-leads-mapped-csv-v1',documentation:'https://help.hunter.io/en/articles/8572858-sequences-reporting',statusDocumentation:'https://hunter.io/api-documentation',checkedAt:'2026-10-24',statusMap:COMMON,requiresExplicitColumns:true},
 lemlist:{version:'lemlist-step-timestamps-csv-v1',documentation:'https://help.lemlist.com/en/articles/7219811-export-campaign-results',checkedAt:'2026-10-24',statusMap:COMMON,requiresExplicitColumns:true,stepTimestampColumns:['sentAtN','repliedAtN']},
 instantly:{version:'instantly-selected-leads-mapped-csv-v1',documentation:'https://help.instantly.ai/en/articles/6285719-how-to-download-leads-csv',checkedAt:'2026-10-24',statusMap:COMMON,requiresExplicitColumns:true},
 manual:{version:'agentlinkops-supplied-outcomes-v1',requiresExplicitColumns:false,statusMap:Object.fromEntries(OUTCOMES.map(s=>[s,s]))},
 agent:{version:'agentlinkops-supplied-outcomes-v1',requiresExplicitColumns:false,statusMap:Object.fromEntries(OUTCOMES.map(s=>[s,s]))},
});

function validateColumns(columns){
 if(!columns||typeof columns!=='object'||Array.isArray(columns)||Object.keys(columns).some(k=>!['recordRef','status','occurredAt','eventId','dates','validity'].includes(k)))fail('INVALID_OUTCOME_COLUMNS');
 for(const key of ['recordRef','status','occurredAt','eventId','validity'])if(columns[key]!=null&&(typeof columns[key]!=='string'||columns[key].length>100))fail('INVALID_OUTCOME_COLUMNS');
 if(!columns.recordRef)fail('OUTCOME_STABLE_REFERENCE_COLUMN_REQUIRED');
 if(columns.dates&&(typeof columns.dates!=='object'||Array.isArray(columns.dates)||Object.entries(columns.dates).some(([k,v])=>!OUTCOMES.includes(k)||typeof v!=='string'||v.length>100)))fail('INVALID_OUTCOME_COLUMNS');
}

/** Output contains only identity, date, normalized outcome and scoped contact-method metadata. */
export function planOutcomeImport({projectId,provider,accountRef,rows,bindings,columns=null,sourceSha256=null,statusMap=null}){
 if(!opaque(projectId)||!opaque(accountRef)||!OUTCOME_EXPORT_PROFILES[provider]||!Array.isArray(rows)||rows.length>10000||!Array.isArray(bindings))fail('INVALID_OUTCOME_IMPORT');
 const profile=OUTCOME_EXPORT_PROFILES[provider];
 const mapping=columns??(profile.requiresExplicitColumns?null:{recordRef:'recordRef',status:'outcome',occurredAt:'occurredAt',eventId:'eventId',validity:'validity'});
 validateColumns(mapping);
 // A caller can map a vendor-specific status to a supported supplied fact; it cannot map to verified won.
 const statuses={...profile.statusMap,...statusMap};
 if(Object.values(statuses).some(v=>!OUTCOMES.includes(v)&&v!=='ignore'))fail('INVALID_OUTCOME_STATUS_MAP');
 const results=[];
 for(const [index,raw]of rows.entries()){
  const row=index+1;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.__parseError){results.push({row,status:'held',reason:'invalid_export_row'});continue;}
  const ref=raw[mapping.recordRef];
  if(!opaque(ref)){results.push({row,status:'held',reason:'missing_stable_record_reference'});continue;}
  const matches=bindings.filter(b=>b.namespace===provider&&b.accountRef===accountRef&&b.recordRef===ref);
  if(matches.length!==1){results.push({row,status:'held',reason:matches.length?'ambiguous_binding':'unmapped_binding',recordRef:ref});continue;}
  const b=matches[0];
  if(b.projectId!==projectId||!opaque(b.watchId)||b.contactId!=null&&!opaque(b.contactId)||!['email','contact_url','none'].includes(b.method??'none')){results.push({row,status:'held',reason:'invalid_or_cross_project_binding',recordRef:ref});continue;}
  if(b.contactId&&(!uuid(b.contactRevision)||!(b.associationRevision===0||uuid(b.associationRevision)))){results.push({row,status:'held',reason:'contact_method_provenance_required',recordRef:ref});continue;}
  const events=[];
  // lemlist documents sentAt1/repliedAt1 etc. Each timestamp remains its own supplied fact.
  if(provider==='lemlist'&&!mapping.status){
   for(const [name,value]of Object.entries(raw)){
    const match=/^(sentAt|repliedAt)([1-9]\d*)$/.exec(name);
    if(match&&value)events.push({outcome:match[1]==='sentAt'?'contacted':'replied',date:value,step:name});
   }
   if(!events.length){results.push({row,status:'ignored',reason:'no_supported_step_timestamp',recordRef:ref});continue;}
  }else{
   const original=String(raw[mapping.status]??'').trim().toLowerCase();
   if(IGNORED.has(original)||statuses[original]==='ignore'){results.push({row,status:'ignored',reason:'no_campaign_progress_fact',recordRef:ref});continue;}
   const outcome=statuses[original];
   if(!outcome){results.push({row,status:'held',reason:'unmapped_outcome',recordRef:ref});continue;}
   // A last-contact date is a send date, never evidence of a later reply or bounce time.
   const dateColumn=mapping.dates?.[outcome]??mapping.occurredAt;
   if(!dateColumn){results.push({row,status:'held',reason:'event_date_column_required',recordRef:ref});continue;}
   events.push({outcome,date:raw[dateColumn],step:null});
  }
  for(const {outcome,date,step}of events){
   if(!validDate(date)){results.push({row,status:'held',reason:'missing_or_invalid_event_date',recordRef:ref,...(step?{step}:{})});continue;}
   if(['bounced','send_error','wrong_person','do_not_contact','email_health'].includes(outcome)&&(!b.contactId||!uuid(b.contactRevision)||!(b.associationRevision===0||uuid(b.associationRevision))||b.method==='none')){results.push({row,status:'held',reason:'contact_method_provenance_required',recordRef:ref});continue;}
   const validity=outcome==='email_health'?raw[mapping.validity]:undefined;
   if(outcome==='email_health'&&!['valid','role','invalid','catch-all','unknown'].includes(validity)){results.push({row,status:'held',reason:'unmapped_validity',recordRef:ref});continue;}
   const suppliedEvent=raw[mapping.eventId];
   if(suppliedEvent!=null&&suppliedEvent!==''&&!opaque(suppliedEvent)){results.push({row,status:'held',reason:'invalid_source_event_reference',recordRef:ref});continue;}
   const eventId=suppliedEvent?(step?'step:'+hash([suppliedEvent,step]):String(suppliedEvent)):'export:'+hash([provider,accountRef,ref,step,outcome,date,validity??null]);
   const input={projectId,watchId:b.watchId,...(b.contactId?{contactId:b.contactId}:{}),idempotencyKey:'outcome:'+hash([projectId,provider,accountRef,ref,eventId]),source:{namespace:provider,accountRef,recordRef:ref,eventId},outcome,occurredAt:date,method:b.method??'none',...(b.contactRevision?{contactRevision:b.contactRevision}:{}),...(b.associationRevision?{associationRevision:b.associationRevision}:{}),...(validity?{validity}:{}),...(outcome==='do_not_contact'?{restrictionScope:b.restrictionScope??'method'}:{})};
   results.push({row,status:'ready',recordRef:ref,...(step?{step}:{}),input});
  }
 }
 // Same source event with different content is a conflict, never input-order precedence.
 const groups=new Map();for(const row of results)if(row.input){const k=row.input.idempotencyKey;groups.set(k,[...(groups.get(k)??[]),row]);}
 for(const group of groups.values())if(new Set(group.map(row=>hash(row.input))).size>1)for(const row of group){row.status='held';row.reason='conflicting_source_event';delete row.input;}
 return seal({schemaVersion:VERSION,projectId,provider,accountRef,profile:profile.version,sourceSha256,sourceRowsSha256:hash(rows),results,effects:{sourceWrites:0,checks:0,credits:0,sends:0,enrollments:0}});
}

export function planOutcomeCsvImport({csv,...options}){
 if(typeof csv!=='string'||Buffer.byteLength(csv)>16*1024*1024)fail('OUTCOME_EXPORT_TOO_LARGE');
 const table=readTable(csv);if(new Set(table.header).size!==table.header.length)fail('DUPLICATE_OUTCOME_HEADER');
 return planOutcomeImport({...options,sourceSha256:hash(csv),rows:table.records.map(r=>r.error?{__parseError:true}:r.values)});
}

export async function applyOutcomeImport(plan,call,{sourceSha256=plan?.sourceSha256}={}){
 const {sha256,...body}=plan??{};if(body.schemaVersion!==VERSION||sha256!==hash(body))fail('OUTCOME_PLAN_CHANGED');
 if(plan.sourceSha256!==sourceSha256)fail('OUTCOME_SOURCE_CHANGED');
 const results=[],effects={...plan.effects,recorded:0,replayed:0,rowsRequiringReadback:0};
 for(const row of plan.results){
  if(row.status!=='ready'){results.push({row:row.row,status:row.status,reason:row.reason});continue;}
  try{
   const result=await call('record_outreach_outcome',row.input);
   if(!result?.event||typeof result.replayed!=='boolean'||result.event.outcome!==row.input.outcome)fail('INVALID_OUTCOME_RESPONSE');
   effects[result.replayed?'replayed':'recorded']++;
   results.push({row:row.row,status:result.event.disposition==='accepted'?'applied':'recorded',eventId:result.event.id,disposition:result.event.disposition,replayed:result.replayed});
  }catch(error){effects.rowsRequiringReadback++;results.push({row:row.row,status:'held',reason:error.code??error.message,effectState:'requires_readback',idempotencyKey:row.input.idempotencyKey});}
 }
 return{schemaVersion:VERSION,projectId:plan.projectId,planSha256:plan.sha256,results,effects};
}
