import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncPlan, pushExpectations, watchIndex} from '../cli/sync.js';
import {normalizeEntry} from '../cli/ledger.js';
import {createClient} from '../cli/client.js';
import {main} from '../cli/main.js';
const entry=(id,intent='expected')=>normalizeEntry({id,intent,source:`https://source.example/${id}`,target:'https://target.example/',scope:'domain',cadence:'weekly'});

test('existing-ledger onboarding keeps 307 wanted and 3 unselected expected entries local',async()=>{
  const expected=Array.from({length:52},(_,i)=>entry(`lk_e${String(i).padStart(7,'0')}`));
  const wanted=Array.from({length:307},(_,i)=>entry(`lk_w${String(i).padStart(7,'0')}`,'wanted'));
  const entries=[...expected,...wanted], ledgerIds=expected.slice(0,49).map(e=>e.id);
  const before=JSON.stringify(entries),sent=[];
  const client={importWatches:async(projectId,watches)=>{sent.push(...watches);return {rows:watches.map((w,index)=>({index,watch:{id:`wat_${w.localReference}`,created:false}}))};}};
  const result=await pushExpectations(client,entries,{}, {projectId:'prj_one',ledgerIds});
  assert.equal(result.pushed,49);assert.equal(result.created,0);assert.equal(result.local,310);
  assert.ok(sent.every(w=>w.targetScope==='domain'&&w.cadenceSeconds===604800));
  assert.equal(JSON.stringify(entries),before);
  assert.equal(syncPlan(entries,{}).filter(r=>r.action==='monitor').length,52);
  assert.equal(syncPlan(entries,{}, {includeWanted:true}).filter(r=>r.action==='monitor').length,359);
  assert.throws(()=>syncPlan(entries,{}, {ledgerIds:['lk_missing']}),{code:'INVALID_SYNC_SELECTION'});
});

test('dry-run is deterministic, offline and byte-preserving with an explicit subset',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'linktrail-onboard-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const dir=join(cwd,'.agentlinkops');await mkdir(dir);
  const entries=[entry('lk_aaaaaaaa'),entry('lk_bbbbbbbb','wanted')];
  await writeFile(join(dir,'links.jsonl'),entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  await writeFile(join(dir,'config.json'),JSON.stringify({cloud:{ledgerIds:['lk_aaaaaaaa']}}));
  const snapshot=async()=>Object.fromEntries(await Promise.all((await readdir(dir)).map(async name=>[name,await readFile(join(dir,name),'utf8')])));
  const before=await snapshot(), output=[];
  assert.equal(await main(['sync','--dry-run'],{cwd,out:v=>output.push(v),err:assert.fail}),0);
  assert.equal(await main(['sync','--dry-run'],{cwd,out:v=>output.push(v),err:assert.fail}),0);
  assert.equal(output[0],output[1]);assert.equal(JSON.parse(output[0]).network,false);
  assert.deepEqual(JSON.parse(output[0]).rows.map(r=>r.action),['monitor','stay_local']);
  assert.deepEqual(await snapshot(),before);
});

test('project-scoped cloud reads and reference mapping survive URL normalization',async()=>{
  const paths=[];
  const client=createClient({origin:'https://api.example',token:'fixture',projectId:'prj_selected',fetchImpl:async(url)=>{
    const u=new URL(url);assert.equal(u.searchParams.get('projectId'),'prj_selected');paths.push(u.pathname);
    if(u.pathname.includes('events'))return Response.json({events:[],next_cursor:'cursor',has_more:false});
    return Response.json({items:[{id:'wat_one',local_reference:'lk_aaaaaaaa',source_url:'https://source.example/'}],next_cursor:null});
  }});
  assert.equal((await watchIndex(client,{})).get('wat_one'),'lk_aaaaaaaa');
  await client.listEvents({});await client.listTargetEvents({});await client.listTargets({});await client.exportWatches({});
  assert.equal(paths.length,5);
});

test('malformed ledger makes even offline sync planning fail instead of hiding rows',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'linktrail-malformed-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const dir=join(cwd,'.agentlinkops');await mkdir(dir);await writeFile(join(dir,'links.jsonl'),JSON.stringify(entry('lk_aaaaaaaa'))+'\n{broken}\n');
 const errors=[];assert.equal(await main(['sync','--dry-run'],{cwd,out:assert.fail,err:v=>errors.push(v)}),2);
 assert.match(errors.join('\n'),/ledger line/);assert.deepEqual(await readdir(dir),['links.jsonl']);
});

test('a partially refused upload persists successful mapping but exits nonzero',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'linktrail-partial-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const dir=join(cwd,'.agentlinkops');await mkdir(dir);const ledger=[entry('lk_aaaaaaaa'),entry('lk_bbbbbbbb')].map(e=>JSON.stringify(e)).join('\n')+'\n';
 await writeFile(join(dir,'links.jsonl'),ledger);await writeFile(join(dir,'config.json'),JSON.stringify({project:{id:'prj_one'},cloud:{origin:'https://api.example',token:'fixture'}}));
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({rows:[{index:0,watch:{id:'wat_ok',created:true}},{index:1,error:{code:'CHECK_LIMIT_REACHED',message:'No remaining capacity.'}}]});
 t.after(()=>{globalThis.fetch=original;});
 assert.equal(await main(['sync','--push-only'],{cwd,out:()=>{},err:assert.fail}),2);
 assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).watches.lk_aaaaaaaa,'wat_ok');
 assert.equal(await readFile(join(dir,'links.jsonl'),'utf8'),ledger);
});
test('pull-only lifecycle recovers a fresh clone from scoped hosted references without rewriting the ledger',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'lifecycle-recover-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const dir=join(cwd,'.agentlinkops');await mkdir(dir);const ledger=JSON.stringify(entry('lk_aaaaaaaa'))+'\n';
 await writeFile(join(dir,'links.jsonl'),ledger);await writeFile(join(dir,'config.json'),JSON.stringify({project:{id:'prj_one'},cloud:{origin:'https://api.example',token:'fixture'}}));
 const {emptyDeal}=await import('../shared/lifecycle-contract.js');const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{const u=new URL(url);calls.push(u.pathname);
  if(u.pathname.includes('/commands/')){const input=JSON.parse(options.body);assert.deepEqual(input,{projectId:'prj_one',watchId:'wat_one'});return Response.json({projectId:'prj_one',watchId:'wat_one',revision:3,deal:{...emptyDeal(),costMinor:29,currency:'USD'},createdAt:null,updatedAt:null});}
  assert.equal(u.searchParams.get('projectId'),'prj_one');
  if(u.pathname.includes('events'))return Response.json({events:[],next_cursor:'cursor',has_more:false});
  return Response.json({items:[{id:'wat_one',project_id:'prj_one',local_reference:'lk_aaaaaaaa'}],next_cursor:null});
 };t.after(()=>{globalThis.fetch=original;});
 assert.equal(await main(['sync','--pull-only','--lifecycle'],{cwd,out:()=>{},err:assert.fail}),0);
 const state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));assert.equal(state.lifecycle.rows.lk_aaaaaaaa.deal.costMinor,29);assert.equal(state.lifecycle.rows.lk_aaaaaaaa.revision,3);assert.equal(await readFile(join(dir,'links.jsonl'),'utf8'),ledger);assert.ok(calls.includes('/v1/commands/get_link_lifecycle'));
 const saved=await readFile(join(dir,'state.json'),'utf8');globalThis.fetch=async()=>{throw Error('fixture unavailable');};
 const errors=[];assert.equal(await main(['sync','--pull-only','--lifecycle'],{cwd,out:()=>{},err:v=>errors.push(v)}),2);assert.equal(await readFile(join(dir,'state.json'),'utf8'),saved);
 assert.equal(await main(['sync','--dry-run','--lifecycle'],{cwd,out:()=>{},err:assert.fail}),0);
 assert.equal(await main(['sync','--push-only','--lifecycle'],{cwd,out:()=>{},err:()=>{}}),2);
});
