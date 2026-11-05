import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {planCampaignPush,applyCampaignPush,reconcileCampaignPush,rollbackCampaignPush,planCampaignPull,applyCampaignPull,applyCampaignPullFile,rollbackCampaignPullFile,projectCampaignSource,readCampaignDocument,campaignMain} from '../cli/campaign-bridge.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const desired={sourceUrl:'https://publisher.example/article',publisherUrl:'https://publisher.example/',targetUrl:'https://customer.example/asset',targetScope:'exact',campaign:'Resource',context:'A relevant source',expectedAnchor:null};
const source=[{localReference:'ledger:one',prospect:desired,gate:{approved:true},sender:{job:'keep-local'},notes:'Keep this'}];
const original={watchId:'w1',projectId:'p1',externalRef:'ledger:one',revision:'rev-1',...desired,monitoring:{enabled:false},evidence:{state:'unknown',checkedAt:null,verifiedWon:false,confirmedLost:false,wasEverPresent:false},archived:false};
function api({initial=null,loseReply=false}={}){
 let record=initial?structuredClone(initial):null,n=1;const calls=[];
 return{calls,get record(){return record;},change(patch){record={...record,...patch,revision:'human-'+(++n)};},async call(name,a){
  calls.push({name,input:structuredClone(a)});
  if(name==='list_prospects')return{items:record&&!record.archived&&record.externalRef===a.externalRef?[structuredClone(record)]:[],nextAfter:null};
  if(name==='get_prospect')return structuredClone(record);
  if(name==='save_prospect'){
   assert.equal(a.revision,0);
   if(record){assert.equal(record.externalRef,a.externalRef);return{prospect:structuredClone(record),replayed:true};}
   record={...original,...a,watchId:'w1',revision:'rev-'+(++n)};
   if(loseReply){loseReply=false;throw new Error('TRANSPORT_LOST');}
   return{prospect:structuredClone(record),replayed:false};
  }
  if(name==='update_prospect'){
   if(a.revision!==record.revision)throw new Error('REVISION_CONFLICT');
   record={...record,...a,revision:'rev-'+(++n)};return{prospect:structuredClone(record),replayed:false};
  }
  throw new Error('UNEXPECTED_EFFECT');
 }};
}

test('campaign push is explicit, idempotent and carries no local-only fields into remote calls',async()=>{
 const plan=planCampaignPush({projectId:'p1',rows:source});assert.equal(plan.results[0].status,'ready');assert.equal(plan.effects.checks,0);
 const a=api(),first=await applyCampaignPush(plan,a.call);assert.equal(first.results[0].status,'applied');assert.equal(first.effects.prospectsCreated,1);
 const again=await applyCampaignPush(plan,a.call);assert.equal(again.results[0].status,'unchanged');assert.equal(again.effects.prospectsCreated,0);
 assert.equal(a.calls.filter(c=>c.name==='save_prospect').length,1);
 assert.deepEqual(Object.keys(a.calls.find(c=>c.name==='save_prospect').input).sort(),['projectId','externalRef','revision',...Object.keys(desired)].sort());
 assert.ok(a.calls.every(c=>!['monitor_link','check_link','set_prospect_monitoring'].includes(c.name)));
 const back=await rollbackCampaignPush(first,a.call);assert.equal(back.results[0].status,'restored');assert.equal(a.record.archived,true);assert.equal(back.effects.prospectsArchived,1);
 assert.equal((await rollbackCampaignPush(first,a.call)).results[0].status,'already_restored');
});

test('rollback archives stay archived when list hides them and save replays their stable reference',async()=>{
 const plan=planCampaignPush({projectId:'p1',rows:source}),a=api();
 const first=await applyCampaignPush(plan,a.call);await rollbackCampaignPush(first,a.call);
 const archived=structuredClone(a.record),again=await applyCampaignPush(plan,a.call);
 assert.equal(again.results[0].status,'held');assert.equal(again.results[0].reason,'CAMPAIGN_ARCHIVED_REQUIRES_EXPLICIT_RESTORE');
 assert.equal(again.results[0].watchId,archived.watchId);assert.equal(again.results[0].effectState,'requires_readback');assert.equal(again.effects.rowsRequiringReadback,1);
 assert.equal(again.effects.prospectsCreated,0);assert.equal(again.effects.prospectsUpdated,0);assert.deepEqual(a.record,archived);
 assert.equal(a.calls.filter(c=>c.name==='update_prospect').length,1);
 const known=planCampaignPush({projectId:'p1',rows:source,prospects:[archived]});
 const listedArchived=async(name,input)=>name==='list_prospects'?{items:[archived],nextAfter:null}:a.call(name,input);
 assert.equal((await applyCampaignPush(known,listedArchived)).results[0].effectState,'none');
 assert.equal(a.calls.filter(c=>c.name==='save_prospect').length,2);
});

test('an active stable-reference save replay is unchanged and cannot acquire rollback ownership',async()=>{
 const plan=planCampaignPush({projectId:'p1',rows:source}),a=api({initial:{...original,monitoring:{enabled:true,enrolled:true},evidence:{...original.evidence,checkedAt:'2026-10-24T12:00:00Z'}}});
 // The record appears between lookup and save; the service safely returns its original.
 const call=async(name,input)=>name==='list_prospects'?{items:[],nextAfter:null}:a.call(name,input);
 const receipt=await applyCampaignPush(plan,call);assert.equal(receipt.results[0].status,'unchanged');assert.equal(receipt.results[0].replayed,true);
 assert.equal(receipt.effects.prospectsCreated,0);assert.equal(receipt.effects.prospectsUpdated,0);assert.equal(receipt.effects.rowsRequiringReadback,0);
 assert.equal(receipt.results[0].rollback,undefined);assert.equal((await rollbackCampaignPush(receipt,a.call)).results[0].status,'no_effect');
 assert.equal(a.calls.filter(c=>c.name==='update_prospect').length,0);
});

test('malformed or scope-changing mutation replies require readback without claimed creations',async()=>{
 for(const change of [r=>({...r,replayed:undefined}),r=>({...r,prospect:{...r.prospect,archived:undefined}}),r=>({...r,prospect:{...r.prospect,externalRef:'other:row'}}),r=>({...r,prospect:{...r.prospect,projectId:'other-project'}})]){
  const a=api(),call=async(name,input)=>{const response=await a.call(name,input);return name==='save_prospect'?change(response):response;};
  const receipt=await applyCampaignPush(planCampaignPush({projectId:'p1',rows:source}),call);
  assert.equal(receipt.results[0].status,'held');assert.equal(receipt.results[0].effectState,'requires_readback');assert.equal(receipt.effects.prospectsCreated,0);assert.equal(receipt.effects.rowsRequiringReadback,1);
  assert.equal((await reconcileCampaignPush(planCampaignPush({projectId:'p1',rows:source}),a.call)).results[0].status,'matched');
  assert.equal(a.calls.filter(c=>c.name==='save_prospect').length,1);
 }
});

test('a lost write response is explicitly uncertain and reconciled by stable reference without replay',async()=>{
 const plan=planCampaignPush({projectId:'p1',rows:source}),a=api({loseReply:true});
 const receipt=await applyCampaignPush(plan,a.call);assert.equal(receipt.results[0].effectState,'requires_readback');assert.equal(receipt.effects.rowsRequiringReadback,1);
 assert.equal((await reconcileCampaignPush(plan,a.call)).results[0].status,'matched');assert.equal(a.calls.filter(c=>c.name==='save_prospect').length,1);
 const rollback=await rollbackCampaignPush(receipt,a.call);assert.equal(rollback.results[0].status,'held');assert.equal(a.record.archived,false);
});

test('concurrent edits and ambiguous stable references hold rather than overwrite or guess',async()=>{
 const a=api({initial:{...original,campaign:'Old'}}),plan=planCampaignPush({projectId:'p1',rows:source,prospects:[a.record]});
 a.change({context:'Human research'});assert.equal((await applyCampaignPush(plan,a.call)).results[0].reason,'CAMPAIGN_CHANGED_SINCE_PREVIEW');
 assert.equal(a.record.context,'Human research');
 const duplicate=planCampaignPush({projectId:'p1',rows:[...source,{...source[0],prospect:{...desired,campaign:'Other'}}]});assert.ok(duplicate.results.every(r=>r.status==='held'));
 const ambiguous=planCampaignPush({projectId:'p1',rows:source,prospects:[original,{...original,watchId:'w2'}]});assert.equal(ambiguous.results[0].reason,'ambiguous_hosted_reference');
 const foreign=planCampaignPush({projectId:'p1',rows:source,prospects:[{...original,projectId:'other'}]});assert.equal(foreign.results[0].reason,'project_mismatch');
 await assert.rejects(applyCampaignPush({...plan,projectId:'changed'},a.call),/CAMPAIGN_PLAN_CHANGED/);
});

test('rollback preserves later contact, evidence and monitoring use and restores only owned fields',async()=>{
 const a=api(),first=await applyCampaignPush(planCampaignPush({projectId:'p1',rows:source}),a.call);
 a.change({contact:{id:'contact_shared'}});assert.equal((await rollbackCampaignPush(first,a.call)).results[0].status,'held');assert.equal(a.record.archived,false);
 const old={...original,campaign:'Old',extra:'keep'},b=api({initial:old}),receipt=await applyCampaignPush(planCampaignPush({projectId:'p1',rows:source,prospects:[old]}),b.call);
 assert.equal(receipt.results[0].status,'applied');assert.equal((await rollbackCampaignPush(receipt,b.call)).results[0].status,'restored');assert.equal(b.record.campaign,'Old');assert.equal(b.record.extra,'keep');
});

test('pull uses independent evidence and never provider won, never first absence, preserving local fields',()=>{
 const rows=[...source,{...source[0],localReference:'ledger:two'},{...source[0],localReference:'ledger:three'}].map(r=>({...r,status:'pending'}));
 const prospects=[{...original,outreachStatus:'won'}, {...original,watchId:'w2',externalRef:'ledger:two',evidence:{state:'present',complete:true,checkedAt:'2026-10-24T12:00:00Z',verifiedWon:true}}, {...original,watchId:'w3',externalRef:'ledger:three',evidence:{state:'absent',wasEverPresent:true,confirmedLost:false,checkedAt:'2026-10-24T12:00:00Z'}}];
 const plan=planCampaignPull({projectId:'p1',rows,prospects}),next=applyCampaignPull(plan,rows);assert.equal(next.changed,1);assert.deepEqual(next.rows.map(r=>r.status),['pending','live','pending']);assert.deepEqual(next.rows[1].sender,rows[1].sender);assert.deepEqual(next.rows[1].gate,rows[1].gate);assert.equal(rows[1].status,'pending');
 assert.throws(()=>applyCampaignPull(plan,[{...rows[0],notes:'late'},...rows.slice(1)]),/CAMPAIGN_SOURCE_CHANGED/);
 const lost=planCampaignPull({projectId:'p1',rows:[rows[0]],prospects:[{...original,evidence:{state:'absent',wasEverPresent:true,confirmedLost:true,checkedAt:'2026-10-24T12:00:00Z'}}]});assert.equal(lost.results[0].after,'lost');
});

test('explicit local pull keeps a private byte backup, refuses stale source and never overwrites input outputs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'campaign-pull-'));
 try{
  const path=join(dir,'source.json'),text=JSON.stringify([{...source[0],status:'pending'}])+'\n';await writeFile(path,text);
  const plan=planCampaignPull({projectId:'p1',rows:JSON.parse(text),prospects:[{...original,evidence:{state:'present',complete:true,verifiedWon:true,checkedAt:'2026-10-24T12:00:00Z'}}],sourceSha256:hash(text)});
  const result=await applyCampaignPullFile(plan,path);assert.equal(result.sourceWrites,1);assert.equal(await readFile(result.backup,'utf8'),text);assert.equal((await lstat(result.backup)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(path,'utf8'))[0].status,'live');
  await assert.rejects(applyCampaignPullFile(plan,path),/CAMPAIGN_SOURCE_CHANGED/);
  await writeFile(path,'[{\"human\":true}]\n');await assert.rejects(rollbackCampaignPullFile(result,path),/ROLLBACK_CONCURRENT_CHANGE/);
  await writeFile(path,JSON.stringify([{...source[0],status:'live'}],null,2)+'\n');
  assert.equal((await rollbackCampaignPullFile(result,path)).sourceWrites,1);assert.equal(await readFile(path,'utf8'),text);assert.equal((await rollbackCampaignPullFile(result,path)).alreadyRestored,true);
  await assert.rejects(campaignMain({_:['campaign','pull-apply'],tag:[],plan:'plan.json',source:'source.json',out:'source.json'},{cwd:dir}),/output must differ/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const fieldMap={schemaVersion:'agentlinkops-local-campaign-map-v1',kind:'global-placements',rowsPath:'placements',selection:{references:['opaque1']},projectField:'project',projectValue:'site-one',referenceField:'source_id',referencePrefix:'global:',sourceUrlField:'payload.source_url',publisherUrlField:'domain',targetUrl:'https://customer.example/asset',pull:{statusField:'status',statusMap:{won:'live',lost:'lost'}}};
test('actual global placements mapping selects exact project/id and retains container history and unrelated records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'campaign-global-'));
 try{
  const raw={placements:[{project:'site-one',source_id:'opaque1',domain:'publisher.example',url:'https://publisher.example/',status:'pending',payload:{source_url:null,notes:'retain local'}},{project:'site-two',source_id:'opaque1',domain:'other.example',status:'do-not-change',payload:{private:'retained'}}],history:[{event:'original'}],snapshots:[{hash:'retained'}],unknown:{retain:true}};
  const text=JSON.stringify(raw,null,4).replaceAll('\n','\r\n')+'\r\n',document=readCampaignDocument(text,{rowsPath:'placements'}),projection=projectCampaignSource(document.rows,fieldMap);
  assert.equal(projection.rows.length,1);assert.equal(projection.rows[0].localReference,'global:opaque1');assert.equal(projection.rows[0].prospect.sourceUrl,null);assert.equal(projection.rows[0].prospect.publisherUrl,'https://publisher.example');
  const path=join(dir,'global.json');await writeFile(path,text);
  const plan=planCampaignPull({projectId:'p1',rows:document.rows,prospects:[{...original,externalRef:'global:opaque1',evidence:{state:'present',complete:true,wasEverPresent:true,verifiedWon:false,checkedAt:dateValue()}}],referenceField:fieldMap.referenceField,referencePrefix:fieldMap.referencePrefix,projectField:fieldMap.projectField,projectValue:fieldMap.projectValue,statusField:fieldMap.pull.statusField,statusMap:fieldMap.pull.statusMap,rowsPath:'placements',sourceSha256:hash(text)});
  assert.equal(plan.results[1].reason,'unselected_project');
  const receipt=await applyCampaignPullFile(plan,path),saved=await readFile(path,'utf8'),after=JSON.parse(saved);
  assert.equal(after.placements[0].status,'live');assert.deepEqual(after.placements[1],raw.placements[1]);assert.deepEqual(after.history,raw.history);assert.deepEqual(after.snapshots,raw.snapshots);assert.deepEqual(after.unknown,raw.unknown);assert.ok(saved.includes('\r\n    "placements"'));assert.ok(saved.endsWith('\r\n'));
  await rollbackCampaignPullFile(receipt,path);assert.equal(await readFile(path,'utf8'),text);
 }finally{await rm(dir,{recursive:true,force:true});}
});
const dateValue=()=>'2026-10-24T12:00:00Z';

test('registry CSV patches exactly the selected status cell and preserves quoted newlines and unknown columns',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'campaign-csv-'));
 try{
  const csv='\uFEFFid,site,source_url,domain,link_status,notes,Unknown (kept)\r\nopaque1,site-one,https://publisher.example/article,publisher.example,"pending","Keep, this\r\nand this",untouched\r\nopaque1,site-two,,other.example,pending,other,also untouched\r\n';
  const loaded=readCampaignDocument(csv,{format:'csv'}),mapping={...fieldMap,kind:'link-registry',rowsPath:null,projectField:'site',referenceField:'id',referencePrefix:'registry:',sourceUrlField:'source_url'};
  const projected=projectCampaignSource(loaded.rows,mapping);assert.equal(projected.rows.length,1);assert.equal(projected.rows[0].localReference,'registry:opaque1');assert.equal(projected.rows[0].prospect.sourceUrl,'https://publisher.example/article');
  const plan=planCampaignPull({projectId:'p1',rows:loaded.rows,prospects:[{...original,externalRef:'registry:opaque1',evidence:{state:'confirmed_missing',wasEverPresent:true,confirmedLost:true,checkedAt:dateValue()}}],referenceField:'id',referencePrefix:'registry:',projectField:'site',projectValue:'site-one',statusField:'link_status',statusMap:{won:'live',lost:'lost'},sourceSha256:hash(csv)});
  const path=join(dir,'registry.csv');await writeFile(path,csv);const receipt=await applyCampaignPullFile(plan,path,{format:'csv'});
  assert.equal(await readFile(path,'utf8'),csv.replace('"pending"','"lost"'));assert.equal(await readFile(receipt.backup,'utf8'),csv);
  await rollbackCampaignPullFile(receipt,path);assert.equal(await readFile(path,'utf8'),csv);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI creates private offline field-map plans without network, while input evidence remains unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'campaign-cli-'));
 try{
  const sourceFile=join(dir,'global.json'),mappingFile=join(dir,'map.json'),hostedFile=join(dir,'hosted.json'),output=join(dir,'plan.json');
  const sourceText=JSON.stringify({placements:[{project:'site-one',source_id:'opaque1',domain:'publisher.example',status:'new',payload:{}}],history:[{keep:true}],snapshots:[]});
  await writeFile(sourceFile,sourceText);await writeFile(mappingFile,JSON.stringify(fieldMap));await writeFile(hostedFile,'[]');let called=0;
  const args={_:['campaign','plan'],tag:[],source:sourceFile,hosted:hostedFile,'field-map':mappingFile,'project-id':'p1',out:output};
  assert.equal(await campaignMain(args,{cwd:dir,out:()=>{},fetchImpl:async()=>{called++;throw new Error('network forbidden');}}),0);assert.equal(called,0);assert.equal((await lstat(output)).mode&0o777,0o600);assert.equal((JSON.parse(await readFile(output,'utf8'))).results[0].localReference,'global:opaque1');assert.equal(await readFile(sourceFile,'utf8'),sourceText);
 }finally{await rm(dir,{recursive:true,force:true});}
});
