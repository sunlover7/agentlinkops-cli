import {createHash, randomUUID} from 'node:crypto';
import {readFile,writeFile,open,rename,unlink,lstat} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {parseCsv} from './adapters/csv.js';

const VERSION='agentlinkops-campaign-bridge-v1';
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const copy=value=>structuredClone(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fields=['sourceUrl','publisherUrl','targetUrl','targetScope','campaign','context','expectedAnchor'];
const effects=()=>({sourceWrites:0,checks:0,credits:0,sends:0,enrollments:0});
const opaque=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f@]|https?:\/\//i.test(v);
const publicUrl=v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!!u.hostname;}catch{return false;}};
const fromResponse=result=>result?.prospect??result;
const watchId=value=>value?.watchId??value?.id;
const url=value=>{if(value==null)return null;const u=new URL(value);u.hash='';return u.href;};
const prospectFields=value=>({sourceUrl:url(value.sourceUrl),publisherUrl:value.publisherUrl?new URL(value.publisherUrl).origin+'/':value.sourceUrl?new URL(value.sourceUrl).origin+'/':null,targetUrl:url(value.targetUrl),targetScope:value.targetScope??'exact',campaign:value.campaign??null,context:value.context??null,expectedAnchor:value.expectedAnchor??null});
const difference=(before,after)=>Object.fromEntries(fields.filter(key=>!equal(before[key],after[key])).map(key=>[key,after[key]]));
const seal=body=>({...body,sha256:hash(body)});
function unseal(value,kind){const {sha256,...body}=value??{};if(body.schemaVersion!==VERSION||body.kind!==kind||sha256!==hash(body))fail('CAMPAIGN_PLAN_CHANGED');return body;}
function assertProject(row,projectId){if(row&&row.projectId!==projectId)fail('CAMPAIGN_PROJECT_MISMATCH');}
function assertProspectState(row){
 if(!opaque(watchId(row))||!opaque(row?.revision)||typeof row.archived!=='boolean'||typeof row.monitoring?.enabled!=='boolean'||!row.evidence||!(row.evidence.checkedAt===null||typeof row.evidence.checkedAt==='string'))fail('INVALID_CAMPAIGN_RESPONSE');
}
function validateDesired(row){
 if(!row||!opaque(row.localReference)||!row.prospect||typeof row.prospect!=='object')return 'invalid_source_record';
 const p=row.prospect;
 if(Object.keys(p).some(k=>!fields.includes(k))||!publicUrl(p.targetUrl)||p.sourceUrl!=null&&!publicUrl(p.sourceUrl)||p.sourceUrl==null&&!publicUrl(p.publisherUrl))return 'invalid_prospect';
 if(p.targetScope!=null&&!['exact','domain','subdomain','path'].includes(p.targetScope)||p.campaign!=null&&(typeof p.campaign!=='string'||p.campaign.length>80)||p.context!=null&&(typeof p.context!=='string'||p.context.length>1000)||p.expectedAnchor!=null&&(typeof p.expectedAnchor!=='string'||p.expectedAnchor.length>500))return 'invalid_prospect';
 return null;
}

/** Frozen local projection up; source-only research, sender and gate fields stay local. */
export function planCampaignPush({projectId,rows,prospects=[],sourceSha256=null,fieldMapSha256=null}){
 if(!opaque(projectId)||!Array.isArray(rows)||rows.length>10000||!Array.isArray(prospects))fail('INVALID_CAMPAIGN_INPUT');
 const hostedByRef=new Map();for(const p of prospects)hostedByRef.set(p.externalRef,[...(hostedByRef.get(p.externalRef)??[]),p]);
 const results=rows.map((row,index)=>{
  let reason=validateDesired(row);const matches=hostedByRef.get(row?.localReference)??[];
  if(matches.length>1)reason='ambiguous_hosted_reference';
  if(matches[0]?.projectId!==undefined&&matches[0].projectId!==projectId)reason='project_mismatch';
  return{row:index+1,localReference:row?.localReference??null,status:reason?'held':'ready',reason,desired:reason?null:prospectFields(row.prospect),before:matches[0]?copy(matches[0]):null};
 });
 const groups=new Map();for(const row of results)groups.set(row.localReference,[...(groups.get(row.localReference)??[]),row]);
 for(const group of groups.values()){
  const row=group[0];
  if(group.length>1&&!group.every(r=>equal(r.desired,row.desired)))for(const member of group){member.status='held';member.reason='conflicting_source_reference';}
 }
 return seal({schemaVersion:VERSION,kind:'push',projectId,sourceSha256,fieldMapSha256,sourceProjectionSha256:hash(rows),results,effects:effects()});
}

async function findProspect(call,projectId,externalRef){
 const page=await call('list_prospects',{projectId,externalRef,view:'all',limit:2});
 if(!Array.isArray(page?.items)||page.nextAfter||page.items.length>1)fail('CAMPAIGN_IDENTITY_CONFLICT');
 const record=page.items[0]??null;assertProject(record,projectId);
 if(record&&record.externalRef!==externalRef)fail('CAMPAIGN_IDENTITY_CONFLICT');
 return record;
}

/** Effects are never automatically replayed after an uncertain response. Reconcile first. */
export async function applyCampaignPush(plan,call,{sourceSha256=plan?.sourceSha256}={}){
 unseal(plan,'push');if(plan.sourceSha256!==sourceSha256)fail('CAMPAIGN_SOURCE_CHANGED');
 const results=[],actual={...effects(),prospectsCreated:0,prospectsUpdated:0,rowsRequiringReadback:0};
 for(const row of plan.results){
  if(row.status!=='ready'){results.push({row:row.row,status:'held',reason:row.reason});continue;}
  let attempted=false,current=null,observedWatchId=null;
  try{
   current=await findProspect(call,plan.projectId,row.localReference);
   if(current){assertProspectState(current);if(current.archived)fail('CAMPAIGN_ARCHIVED_REQUIRES_EXPLICIT_RESTORE');}
   // Desired content may replay safely; a changed or removed preview never wins a stale race.
   if(current&&equal(prospectFields(current),row.desired)&&!current.archived){results.push({row:row.row,status:'unchanged',watchId:watchId(current),prospect:copy(current)});continue;}
   if(row.before&&(!current||current.revision!==row.before.revision||!equal(prospectFields(current),prospectFields(row.before))))fail('CAMPAIGN_CHANGED_SINCE_PREVIEW');
   if(!row.before&&current)fail('CAMPAIGN_APPEARED_SINCE_PREVIEW');
   attempted=true;
   const response=current?await call('update_prospect',{projectId:plan.projectId,watchId:watchId(current),revision:current.revision,...difference(prospectFields(current),row.desired)}):await call('save_prospect',{projectId:plan.projectId,externalRef:row.localReference,revision:0,...row.desired});
   const result=response?.prospect;
   if(typeof response?.replayed!=='boolean')fail('INVALID_CAMPAIGN_RESPONSE');
   assertProject(result,plan.projectId);assertProspectState(result);
   if(result.externalRef!==row.localReference||current&&watchId(result)!==watchId(current)||!equal(prospectFields(result),row.desired))fail('INVALID_CAMPAIGN_RESPONSE');
   observedWatchId=watchId(result);
   if(result.archived)fail('CAMPAIGN_ARCHIVED_REQUIRES_EXPLICIT_RESTORE');
   // A stable-reference replay may return an existing record. It creates no row
   // and grants no right to archive somebody else's original record on rollback.
   if(response.replayed){results.push({row:row.row,status:'unchanged',replayed:true,watchId:watchId(result),prospect:copy(result)});continue;}
   if(!current&&(result.monitoring.enabled||result.monitoring.enrolled===true||result.evidence.checkedAt))fail('UNEXPECTED_CAMPAIGN_EFFECT');
   actual[current?'prospectsUpdated':'prospectsCreated']++;
   results.push({row:row.row,status:'applied',watchId:watchId(result),prospect:copy(result),rollback:{before:current?copy(current):null,after:copy(result)}});
  }catch(error){if(attempted)actual.rowsRequiringReadback++;results.push({row:row.row,status:'held',reason:error.code??error.message,effectState:attempted?'requires_readback':'none',localReference:row.localReference,...(current||observedWatchId?{watchId:current?watchId(current):observedWatchId}:{})});}
 }
 return seal({schemaVersion:VERSION,kind:'push-receipt',projectId:plan.projectId,planSha256:plan.sha256,sourceSha256:plan.sourceSha256,results,effects:actual});
}

export async function reconcileCampaignPush(plan,call){
 unseal(plan,'push');const results=[];
 for(const row of plan.results){
  if(!row.desired){results.push({row:row.row,status:'held',reason:row.reason});continue;}
  try{const current=await findProspect(call,plan.projectId,row.localReference);results.push({row:row.row,status:current&&equal(prospectFields(current),row.desired)&&!current.archived?'matched':current?'changed':'absent',...(current?{watchId:watchId(current),revision:current.revision}:{})});}
  catch(error){results.push({row:row.row,status:'held',reason:error.code??error.message});}
 }
 return{planSha256:plan.sha256,results,effects:effects()};
}

/** New unscheduled rows are soft-removed; existing records restore only owned projection fields. */
export async function rollbackCampaignPush(receipt,call){
 unseal(receipt,'push-receipt');const results=[],actual={...effects(),prospectsRestored:0,prospectsArchived:0,rowsRequiringReadback:0};
 for(const row of [...receipt.results].reverse()){
  if(!row.rollback){results.push({row:row.row,status:row.effectState==='requires_readback'?'held':'no_effect',...(row.effectState==='requires_readback'?{reason:'ORIGINAL_EFFECT_REQUIRES_READBACK'}:{})});continue;}
  const {before,after}=row.rollback;let attempted=false;
  try{
   const current=fromResponse(await call('get_prospect',{projectId:receipt.projectId,watchId:watchId(after)}));assertProject(current,receipt.projectId);
   if(!before&&current.archived){results.push({row:row.row,status:'already_restored'});continue;}
   if(before&&equal(prospectFields(current),prospectFields(before))){results.push({row:row.row,status:'already_restored'});continue;}
   if(current.revision!==after.revision||!equal(prospectFields(current),prospectFields(after)))fail('ROLLBACK_CONCURRENT_CHANGE');
   if(!before&&(current.monitoring?.enabled||current.evidence?.checkedAt||current.contact?.id))fail('ROLLBACK_RECORD_IN_USE');
   attempted=true;await call('update_prospect',{projectId:receipt.projectId,watchId:watchId(after),revision:current.revision,...(before?difference(prospectFields(after),prospectFields(before)):{archived:true})});
   actual[before?'prospectsRestored':'prospectsArchived']++;results.push({row:row.row,status:'restored',watchId:watchId(after),compensation:before?'projection_restored':'unused_prospect_archived'});
  }catch(error){if(attempted)actual.rowsRequiringReadback++;results.push({row:row.row,status:'held',reason:error.code??error.message,effectState:attempted?'requires_readback':'none'});}
 }
 return{planSha256:receipt.planSha256,results,effects:actual};
}

/** Only independent verified presence / confirmed loss can change a local status. */
export function planCampaignPull({projectId,rows,prospects,statusField='status',referenceField='localReference',referencePrefix='',projectField=null,projectValue=null,statusMap={won:'live',lost:'lost'},sourceSha256=null,rowsPath=null,fieldMapSha256=null,selection=null}){
 if(!opaque(projectId)||!Array.isArray(rows)||rows.length>50000||!Array.isArray(prospects)||!['status','linkStatus','link_status'].includes(statusField)||!safePath(referenceField)||typeof referencePrefix!=='string'||referencePrefix.length>100||projectField!==null&&!safePath(projectField)||!Object.hasOwn(statusMap,'won')||!Object.hasOwn(statusMap,'lost'))fail('INVALID_CAMPAIGN_PULL');
 const hostedByRef=new Map(),sourceCounts=new Map();for(const p of prospects)hostedByRef.set(p.externalRef,[...(hostedByRef.get(p.externalRef)??[]),p]);
 for(const row of rows)if(projectField===null||field(row,projectField)===projectValue){const ref=referencePrefix+String(field(row,referenceField)??'');sourceCounts.set(ref,(sourceCounts.get(ref)??0)+1);}
 const results=rows.map((row,index)=>{
  if(projectField!==null&&field(row,projectField)!==projectValue)return{row:index+1,status:'unchanged',reason:'unselected_project'};
  const sourceReference=field(row,referenceField);
  if(selection?.references&&!selection.references.includes(sourceReference)||selection?.field&&!selection.values.includes(field(row,selection.field)))return{row:index+1,status:'unchanged',reason:'unselected_record'};
  if(!opaque(sourceReference))return{row:index+1,status:'held',reason:'missing_stable_reference'};
  const ref=referencePrefix+sourceReference,matched=hostedByRef.get(ref)??[];
  if(!opaque(ref)||matched.length!==1||sourceCounts.get(ref)!==1||matched[0]?.projectId!==projectId)return{row:index+1,localReference:ref??null,status:'held',reason:'ambiguous_or_missing_reference'};
  const p=matched[0],e=p.evidence??{},observed=e.confirmedLost===true&&e.wasEverPresent===true&&e.checkedAt?'lost':(e.verifiedWon===true||e.wasEverPresent===true)&&e.complete===true&&['present','changed'].includes(e.state)&&e.checkedAt?'won':null;
  if(!observed)return{row:index+1,localReference:ref,status:'unchanged',reason:'no_independent_outcome'};
  if(typeof statusMap[observed]!=='string'||!statusMap[observed].trim()||statusMap[observed].length>100||/[\u0000-\u001f\u007f]/.test(statusMap[observed])||/^[=+@-]/.test(statusMap[observed]))fail('INVALID_CAMPAIGN_STATUS_MAP');
  return{row:index+1,localReference:ref,status:row[statusField]===statusMap[observed]?'unchanged':'ready',field:statusField,before:row[statusField]??null,after:statusMap[observed],evidence:{watchId:watchId(p),checkedAt:e.checkedAt,observed}};
 });
 return seal({schemaVersion:VERSION,kind:'pull',projectId,referenceField,referencePrefix,projectField,projectValue,statusField,rowsPath,sourceSha256,fieldMapSha256,selection,sourceProjectionSha256:hash(rows),results,effects:effects()});
}

export function applyCampaignPull(plan,rows,{sourceSha256=plan?.sourceSha256}={}){
 unseal(plan,'pull');if(hash(rows)!==plan.sourceProjectionSha256||sourceSha256!==plan.sourceSha256)fail('CAMPAIGN_SOURCE_CHANGED');
 const next=copy(rows);for(const item of plan.results)if(item.status==='ready')next[item.row-1][item.field]=item.after;
 return{rows:next,planSha256:plan.sha256,changed:plan.results.filter(r=>r.status==='ready').length,effects:effects()};
}

const safeField=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_ -]{0,99}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const safePath=value=>typeof value==='string'&&value.split('.').every(safeField)&&value.split('.').length<=5;
const field=(row,path)=>path?.split('.').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,row);

/** Versioned explicit mapping; publisher/name/email never supply a record identity. */
export function projectCampaignSource(rows,mapping){
 if(!mapping||mapping.schemaVersion!=='agentlinkops-local-campaign-map-v1'||!['global-placements','link-registry'].includes(mapping.kind)||!safePath(mapping.referenceField)||/(^|[._])(?:email|mail|domain|name|url|phone)(?:$|_)/i.test(mapping.referenceField)||!safePath(mapping.projectField)||typeof mapping.projectValue!=='string'||!mapping.projectValue||typeof(mapping.referencePrefix??'')!=='string'||(mapping.referencePrefix??'').length>100||!publicUrl(mapping.targetUrl)&&!safePath(mapping.targetUrlField))fail('INVALID_CAMPAIGN_FIELD_MAP');
 for(const name of ['sourceUrlField','sourceUrlFallbackField','publisherUrlField','campaignField','contextField','targetUrlField'])if(mapping[name]!=null&&!safePath(mapping[name]))fail('INVALID_CAMPAIGN_FIELD_MAP');
 if(mapping.kind==='global-placements'&&mapping.rowsPath!=='placements'||mapping.kind==='link-registry'&&mapping.rowsPath!=null)fail('INVALID_CAMPAIGN_FIELD_MAP');
 const selection=mapping.selection;
 if(mapping.kind==='global-placements'&&!selection)fail('CAMPAIGN_EXPLICIT_BACKLINK_SELECTION_REQUIRED');
 if(selection&&!(Array.isArray(selection.references)&&selection.references.length>0&&selection.references.length<=10000&&selection.references.every(opaque)||safePath(selection.field)&&Array.isArray(selection.values)&&selection.values.length>0&&selection.values.length<=40&&selection.values.every(v=>typeof v==='string'||typeof v==='boolean')))fail('INVALID_CAMPAIGN_SELECTION');
 const results=[],sourceIndices=[],foundReferences=new Set();
 for(const [index,row]of rows.entries()){
  if(field(row,mapping.projectField)!==mapping.projectValue)continue;
  const rawReference=field(row,mapping.referenceField);
  if(selection?.references&&!selection.references.includes(rawReference)||selection?.field&&!selection.values.includes(field(row,selection.field)))continue;
  if(opaque(rawReference))foundReferences.add(rawReference);
  const localReference=opaque(rawReference)?(mapping.referencePrefix??'')+rawReference:null;
  const sourceUrl=field(row,mapping.sourceUrlField)||field(row,mapping.sourceUrlFallbackField)||null;
  let publisherUrl=field(row,mapping.publisherUrlField)||null;
  if(publisherUrl&&!/^https?:\/\//i.test(publisherUrl))publisherUrl='https://'+publisherUrl;
  const prospect={sourceUrl,publisherUrl,targetUrl:mapping.targetUrl??field(row,mapping.targetUrlField),targetScope:mapping.targetScope??'exact',campaign:field(row,mapping.campaignField)||null,context:field(row,mapping.contextField)||null,expectedAnchor:null};
  results.push({localReference,prospect});sourceIndices.push(index);
 }
 if(selection?.references&&selection.references.some(ref=>!foundReferences.has(ref)))fail('CAMPAIGN_SELECTION_REFERENCE_NOT_FOUND');
 if(!results.length)fail('CAMPAIGN_SOURCE_SELECTION_EMPTY');
 return{rows:results,sourceIndices,fieldMapSha256:hash(mapping)};
}

function csvSpans(text){
 const rows=[];let start=0,row=[],quoted=false;
 for(let i=0;i<=text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){i++;continue;}quoted=!quoted;continue;}
  if(!quoted&&(c===','||c==='\n'||c===undefined)){
   const end=c==='\n'&&text[i-1]==='\r'?i-1:i;row.push({start,end});
   if(c!==','){if(row.some(cell=>text.slice(cell.start,cell.end).length))rows.push(row);row=[];}
   start=i+1;
  }
 }
 if(quoted)fail('INVALID_CAMPAIGN_CSV');return rows;
}

export function readCampaignDocument(text,{format='json',rowsPath=null}={}){
 if(typeof text!=='string'||Buffer.byteLength(text)>64*1024*1024)fail('CAMPAIGN_SOURCE_TOO_LARGE');
 let rows,document,spans,header,lineSpans;
 const clean=text.replace(/^\uFEFF/,'');
 if(format==='csv'){
  if(rowsPath!==null)fail('CAMPAIGN_SOURCE_FORMAT_UNSUPPORTED');
  const all=parseCsv(clean);if(!all.length)fail('INVALID_CAMPAIGN_CSV');header=all[0].map(v=>v.trim());
  if(new Set(header).size!==header.length||header.some(h=>!h||h.length>2000||/[\u0000-\u001f\u007f]/.test(h)))fail('INVALID_CAMPAIGN_CSV_HEADER');
  if(all.slice(1).some(cells=>cells.length!==header.length))fail('INVALID_CAMPAIGN_CSV_ROW');
  rows=all.slice(1).map(cells=>Object.fromEntries(header.map((name,i)=>[name,cells[i]])));spans=csvSpans(text);
  if(spans.length!==all.length)fail('INVALID_CAMPAIGN_CSV');
 }else if(format==='jsonl'){
  if(rowsPath!==null)fail('CAMPAIGN_SOURCE_FORMAT_UNSUPPORTED');
  lineSpans=[];rows=[];let start=0;
  for(const line of text.split(/(?<=\n)/)){if(line.trim()){rows.push(JSON.parse(line.replace(/^\uFEFF/,'')));lineSpans.push({start,end:start+line.length});}start+=line.length;}
 }else if(format==='json'){
  document=JSON.parse(clean);rows=rowsPath?field(document,rowsPath):document;
  if(rowsPath&&!safePath(rowsPath))fail('INVALID_CAMPAIGN_ROWS_PATH');
 }else fail('CAMPAIGN_SOURCE_FORMAT_UNSUPPORTED');
 if(!Array.isArray(rows)||rows.length>50000||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))fail('INVALID_CAMPAIGN_SOURCE');
 return{format,rowsPath,rows,document,spans,header,lineSpans,text};
}

export function parseCampaignSource(text,options={}){return readCampaignDocument(text,options).rows;}

function renderCampaignDocument(loaded,next,plan){
 const newline=loaded.text.includes('\r\n')?'\r\n':'\n',ends=/\r?\n$/.test(loaded.text),bom=loaded.text.startsWith('\uFEFF')?'\uFEFF':'';
 if(loaded.format==='csv'){
  const column=loaded.header.indexOf(plan.statusField);if(column<0)fail('CAMPAIGN_STATUS_COLUMN_NOT_FOUND');
  const replacements=plan.results.filter(r=>r.status==='ready').map(r=>{const span=loaded.spans[r.row][column],value=String(next[r.row-1][plan.statusField]),wasQuoted=loaded.text[span.start]==='"';return{...span,value:wasQuoted||/[",\r\n]/.test(value)?'"'+value.replaceAll('"','""')+'"':value};});
  let text=loaded.text;for(const r of replacements.sort((a,b)=>b.start-a.start))text=text.slice(0,r.start)+r.value+text.slice(r.end);return text;
 }
 if(loaded.format==='jsonl'){
  let text=loaded.text;for(const r of plan.results.filter(r=>r.status==='ready').sort((a,b)=>b.row-a.row)){const span=loaded.lineSpans[r.row-1],old=text.slice(span.start,span.end),suffix=old.endsWith('\r\n')?'\r\n':old.endsWith('\n')?'\n':'';text=text.slice(0,span.start)+(span.start===0&&old.startsWith('\uFEFF')?'\uFEFF':'')+JSON.stringify(next[r.row-1])+suffix+text.slice(span.end);}return text;
 }
 const indentation=loaded.text.match(/\r?\n([ \t]+)"/)?.[1]??(loaded.text.includes('\n')?2:0),doc=loaded.rowsPath?copy(loaded.document):next;
 if(loaded.rowsPath){const parts=loaded.rowsPath.split('.'),last=parts.pop();let target=doc;for(const part of parts)target=target[part];target[last]=next;}
 return bom+JSON.stringify(doc,null,indentation).replaceAll('\n',newline)+(ends?newline:'');
}

/** Explicit opt-in local patch with a private immutable backup, exclusive lock and byte CAS. */
export async function applyCampaignPullFile(plan,path,{format='json'}={}){
 const target=resolve(path),lock=target+'.agentlinkops-campaign.lock';let handle,temp;
 try{
  handle=await open(lock,'wx',0o600);
  const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)fail('CAMPAIGN_SOURCE_NOT_REGULAR');
  const original=await readFile(target);if(hash(original)!==plan.sourceSha256)fail('CAMPAIGN_SOURCE_CHANGED');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original),loaded=readCampaignDocument(text,{format,rowsPath:plan.rowsPath??null});
  const patched=applyCampaignPull(plan,loaded.rows,{sourceSha256:hash(original)});
  if(!patched.changed)return{...patched,sourceWrites:0,backup:null};
  const next=renderCampaignDocument(loaded,patched.rows,plan);
  const backup=target+'.agentlinkops-backup-'+plan.sha256.slice(0,16);await writeFile(backup,original,{flag:'wx',mode:0o600});
  temp=join(dirname(target),'.'+basename(target)+'.campaign-'+randomUUID());await writeFile(temp,next,{flag:'wx',mode:info.mode&0o777});
  const currentInfo=await lstat(target);if(currentInfo.ino!==info.ino||hash(await readFile(target))!==plan.sourceSha256)fail('CAMPAIGN_SOURCE_CHANGED');
  await rename(temp,target);temp=null;
  return{planSha256:plan.sha256,changed:patched.changed,sourceWrites:1,backup,beforeSha256:hash(original),afterSha256:hash(next),effects:{...effects(),sourceWrites:1}};
 }finally{if(temp)await unlink(temp).catch(()=>{});if(handle){await handle.close();await unlink(lock).catch(()=>{});}}
}

/** Restore only this exact local patch; a later writer keeps the file and gets a hold. */
export async function rollbackCampaignPullFile(receipt,path){
 const target=resolve(path),lock=target+'.agentlinkops-campaign.lock';let handle,temp;
 try{
  handle=await open(lock,'wx',0o600);
  if(!receipt||!receipt.backup||!/^[a-f0-9]{64}$/.test(receipt.beforeSha256??'')||!/^[a-f0-9]{64}$/.test(receipt.afterSha256??''))fail('INVALID_CAMPAIGN_PULL_RECEIPT');
  const info=await lstat(target),backupInfo=await lstat(receipt.backup);if(!info.isFile()||info.isSymbolicLink()||!backupInfo.isFile()||backupInfo.isSymbolicLink()||info.size>64*1024*1024||backupInfo.size>64*1024*1024)fail('CAMPAIGN_SOURCE_NOT_REGULAR');
  const current=await readFile(target);if(hash(current)===receipt.beforeSha256)return{planSha256:receipt.planSha256,sourceWrites:0,alreadyRestored:true};
  if(hash(current)!==receipt.afterSha256)fail('ROLLBACK_CONCURRENT_CHANGE');
  const before=await readFile(receipt.backup);if(hash(before)!==receipt.beforeSha256)fail('CAMPAIGN_BACKUP_CHANGED');
  temp=join(dirname(target),'.'+basename(target)+'.campaign-'+randomUUID());await writeFile(temp,before,{flag:'wx',mode:info.mode&0o777});
  const latest=await lstat(target);if(latest.ino!==info.ino||hash(await readFile(target))!==receipt.afterSha256)fail('ROLLBACK_CONCURRENT_CHANGE');
  await rename(temp,target);temp=null;return{planSha256:receipt.planSha256,sourceWrites:1,alreadyRestored:false,restoredSha256:hash(before)};
 }finally{if(temp)await unlink(temp).catch(()=>{});if(handle){await handle.close();await unlink(lock).catch(()=>{});}}
}

export const CAMPAIGN_CLI_HELP=`agentlinkops campaign plan --source FILE --hosted FILE --project-id ID --out PLAN.json
agentlinkops campaign apply --plan PLAN.json --source FILE --out RECEIPT.json
agentlinkops campaign reconcile --plan PLAN.json --out READBACK.json
agentlinkops campaign rollback --receipt RECEIPT.json --out ROLLBACK.json
agentlinkops campaign pull-plan --source FILE --hosted FILE --project-id ID --out PLAN.json
agentlinkops campaign pull-apply --plan PLAN.json --source FILE --out RECEIPT.json
agentlinkops campaign pull-rollback --receipt RECEIPT.json --source FILE --out ROLLBACK.json
agentlinkops campaign outcomes-plan --source FILE --bindings FILE --mapping FILE --provider hunter|lemlist|instantly|manual|agent --account-ref OPAQUE --project-id ID --out PLAN.json
agentlinkops campaign outcomes-apply --plan PLAN.json --source FILE --out RECEIPT.json
Use --format json|jsonl|csv. --field-map FILE selects a versioned source/project/field mapping for a registry or global placements container. Plans are read-only.
Apply saves unscheduled prospects and supplied outcomes; it never sends, enrolls monitoring or checks links.
Pull-apply explicitly patches a selected local JSON/JSONL file with a private backup. Only independently verified wins or confirmed losses change local status.
Files may contain private contact details: plans and receipts are written mode0600, never to stdout.`;

export async function campaignMain(args,{cwd=process.cwd(),env=process.env,out=console.log,fetchImpl=globalThis.fetch,call=null}={}){
 const {loadConfig,ConfigError}=await import('./config.js');
 const usage=()=>{throw new ConfigError(CAMPAIGN_CLI_HELP);};
 const action=args._?.[1],allowed={plan:['source','hosted','project-id','format','field-map','out'],apply:['plan','source','out'],reconcile:['plan','out'],rollback:['receipt','out'],'pull-plan':['source','hosted','project-id','format','field-map','out'],'pull-apply':['plan','source','format','out'],'pull-rollback':['receipt','source','out'],'outcomes-plan':['source','bindings','mapping','provider','account-ref','project-id','format','out'],'outcomes-apply':['plan','source','out']}[action];
 if(!allowed||args._.length!==2||args.tag?.length||Object.keys(args).some(k=>!['_','tag',...allowed].includes(k))||typeof args.out!=='string')usage();
 const file=async name=>{
  if(typeof args[name]!=='string')usage();const path=resolve(cwd,args[name]),s=await lstat(path);
  if(!s.isFile()||s.isSymbolicLink()||s.size>64*1024*1024)throw new ConfigError('Campaign input must be a regular file of at most64MiB');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await readFile(path));
 };
 const json=async name=>JSON.parse((await file(name)).replace(/^\uFEFF/,''));
 const outputPath=resolve(cwd,args.out);
 // An output path must not overwrite input evidence or the selected source.
 if(['source','hosted','plan','receipt','bindings','mapping','field-map'].some(k=>typeof args[k]==='string'&&resolve(cwd,args[k])===outputPath))throw new ConfigError('Campaign output must differ from every input');
 const command=async()=>{
  if(call)return call;
  const config=await loadConfig({cwd});const {cloudConnection}=await import('./connection.js');const {createClient}=await import('./client.js');
  const client=createClient({...cloudConnection(config,env),fetchImpl});return(name,input)=>client.callCommand(name,input);
 };
 let result;
 if(action==='plan'||action==='pull-plan'){
  if(typeof args['project-id']!=='string')usage();
  const source=await file('source'),mapping=args['field-map']?await json('field-map'):null,rows=parseCampaignSource(source,{format:args.format??'json',rowsPath:mapping?.rowsPath??null}),hosted=await json('hosted');
  const projection=mapping?projectCampaignSource(rows,mapping):{rows};
  const input={projectId:args['project-id'],rows:action==='plan'?projection.rows:rows,prospects:Array.isArray(hosted)?hosted:hosted.items,sourceSha256:hash(source),fieldMapSha256:projection.fieldMapSha256??null};
  if(!Array.isArray(input.prospects)||hosted.nextAfter)throw new ConfigError('Hosted snapshot must contain the complete selected bounded record set');
  if(action==='plan')result=planCampaignPush(input);
  else{if(mapping&&(!mapping.pull||!safeField(mapping.pull.statusField)||!mapping.pull.statusMap))fail('CAMPAIGN_PULL_FIELD_AUTHORITY_REQUIRED');result=planCampaignPull({...input,...(mapping?{referenceField:mapping.referenceField,referencePrefix:mapping.referencePrefix??'',projectField:mapping.projectField,projectValue:mapping.projectValue,statusField:mapping.pull.statusField,statusMap:mapping.pull.statusMap,rowsPath:mapping.rowsPath??null,selection:mapping.selection??null}:{})});}
 }else if(action==='apply')result=await applyCampaignPush(await json('plan'),await command(),{sourceSha256:hash(await file('source'))});
 else if(action==='reconcile')result=await reconcileCampaignPush(await json('plan'),await command());
 else if(action==='rollback')result=await rollbackCampaignPush(await json('receipt'),await command());
 else if(action==='pull-apply'){if(typeof args.source!=='string')usage();result=await applyCampaignPullFile(await json('plan'),resolve(cwd,args.source),{format:args.format??'json'});}
 else if(action==='pull-rollback'){if(typeof args.source!=='string')usage();result=await rollbackCampaignPullFile(await json('receipt'),resolve(cwd,args.source));}
 else{
  const {planOutcomeImport,planOutcomeCsvImport,applyOutcomeImport}=await import('./campaign-outcomes.js');
  if(action==='outcomes-plan'){
   const source=await file('source'),mapping=await json('mapping'),bindings=await json('bindings');
   const common={projectId:args['project-id'],provider:args.provider,accountRef:args['account-ref'],bindings,...mapping};
   result=args.format==='csv'?planOutcomeCsvImport({...common,csv:source}):planOutcomeImport({...common,rows:parseCampaignSource(source,{format:args.format??'json'}),sourceSha256:hash(source)});
  }else result=await applyOutcomeImport(await json('plan'),await command(),{sourceSha256:hash(await file('source'))});
 }
 await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 out(JSON.stringify({file:outputPath,sha256:hash(JSON.stringify(result,null,2)+'\n'),rows:result.results?.length??null,effects:result.effects??null}));
 return result.results?.some(row=>row.status==='held')?2:0;
}
