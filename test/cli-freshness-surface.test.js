import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../cli/main.js';
import {normalizeEntry,serializeLedger} from '../cli/ledger.js';
import {observationRow} from '../cli/mirror.js';
import {applyRun} from '../cli/state.js';

const at=minutes=>new Date(Date.parse('2026-10-07T00:00:00.000Z')+minutes*60_000).toISOString();
const entry=id=>normalizeEntry({id,intent:'expected',source:`https://publisher.example/${id}`,target:'https://customer.example/guide',scope:'exact'});
const row=(entry,state,minutes)=>observationRow(entry.id,{sourceUrl:entry.source,targetUrl:entry.target,targetScope:entry.scope,state,checkedAt:at(minutes),
  reason:state==='unknown'?'source_http_403':state==='present'?'link_found':'no_matching_link_in_complete_html',
  occurrences:state==='present'?[{targetUrl:entry.target,anchor:'Guide',rel:[]}]:[],linkSignature:state==='present'?'stable-present':null,
  evidence:{complete:state!=='unknown',method:'http_html',checkerVersion:'fixture-1',sha256:'a'.repeat(64)}});
const invoke=async(cwd,argv)=>{
  const out=[],err=[];
  const code=await main(argv,{cwd,env:{},out:value=>out.push(String(value)),err:value=>err.push(String(value)),fetchImpl:()=>assert.fail('local freshness reads must not fetch')});
  return {code,out:out.join('\n'),err:err.join('\n')};
};
async function bytes(dir){
  const found={};
  const visit=async(path=dir,prefix='')=>{
    for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      const absolute=join(path,item.name),relative=prefix+item.name;
      if(item.isDirectory())await visit(absolute,relative+'/');else found[relative]=(await readFile(absolute)).toString('base64');
    }
  };
  await visit();return found;
}
async function workspace(t,entries,observations,state){
  const cwd=await mkdtemp(join(tmpdir(),'alo-freshness-surface-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const dir=join(cwd,'.agentlinkops');await mkdir(dir);
  const paths={ledger:join(dir,'links.jsonl'),observations:join(dir,'observations.jsonl'),state:join(dir,'state.json')};
  await writeFile(paths.ledger,serializeLedger(entries));await writeFile(paths.observations,observations.map(value=>JSON.stringify(value)).join('\n')+'\n');
  await writeFile(paths.state,JSON.stringify(state)+'\n');return {cwd,paths};
}

test('actual status --all joins latest activity while legacy array, receipt dates and customer bytes stay stable',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('status/report/fleet never fetch'));
  const healthy=entry('lk_healthy01'),blocked=entry('lk_blocked01'),corrected=entry('lk_corrected1'),missing=entry('lk_missing01');
  const retained=[row(healthy,'present',0),row(blocked,'present',0),row(blocked,'unknown',100),row(corrected,'present',0),row(missing,'absent',40)];
  const activity=applyRun({v:2,entries:{},cursors:{events:'source-keep',target_events:'target-keep'},doctor:{keep:true},future:{keep:['custom']}},
    [row(healthy,'present',0),row(healthy,'present',50),row(blocked,'present',0),row(blocked,'present',50),row(blocked,'unknown',100),row(corrected,'present',0),row(missing,'absent',40),row(missing,'absent',90)]);
  activity.entries[healthy.id].futureEntry={keep:17};
  const f=await workspace(t,[healthy,blocked,{...corrected,scope:'domain'},missing],retained,activity),before=await bytes(f.cwd);
  const legacy=await invoke(f.cwd,['status','--json']);assert.equal(legacy.code,0);assert.equal(legacy.err,'');
  const disagreements=JSON.parse(legacy.out);assert.equal(Array.isArray(disagreements),true);
  assert.deepEqual(disagreements.map(item=>[item.entry.id,item.kind]),[[blocked.id,'cannot_say'],[corrected.id,'never_checked'],[missing.id,'suspected_missing']]);
  const all=await invoke(f.cwd,['status','--all','--json']);assert.equal(all.code,0);assert.equal(all.err,'');
  const result=JSON.parse(all.out);assert.deepEqual(result.disagreements,disagreements);assert.equal(result.placements.length,4);
  const healthyView=result.placements.find(item=>item.id===healthy.id),blockedView=result.placements.find(item=>item.id===blocked.id),correctedView=result.placements.find(item=>item.id===corrected.id);
  assert.equal(healthyView.current_state,'present');assert.equal(healthyView.latest_attempt.checked_at,at(50));assert.equal(healthyView.evidence_observed_at,at(0));
  assert.equal(healthyView.last_link_verification.evidence_reference,null);
  assert.equal(blockedView.current_state,'present');assert.equal(blockedView.uncertain,true);assert.equal(blockedView.latest_attempt.checked_at,at(100));
  assert.equal(blockedView.latest_attempt.reason,'source_http_403');assert.equal(blockedView.last_successful_observation.checked_at,at(50));
  assert.equal(correctedView.current_state,'unchecked');assert.equal(correctedView.identity_status,'not_matched');assert.equal(correctedView.latest_attempt,null);
  assert.equal((await invoke(f.cwd,['status','--all','--json'])).out,all.out,'the read has no current-time input or mutation');
  const human=await invoke(f.cwd,['status','--all']);assert.equal(human.code,0);assert.match(human.out,/Latest attempt: 2026-10-07T01:40:00\.000Z \(source_http_403\)/);
  assert.ok(human.out.includes(`${healthy.id}: latest attempt ${at(50)}; last conclusive ${at(50)}; last link verification ${at(50)}`));
  const report=await invoke(f.cwd,['report','--json','--as-of','2026-10-07']);assert.equal(report.code,0);
  const dataset=JSON.parse(report.out),reportHealthy=dataset.rows.find(item=>item.id===healthy.id),reportBlocked=dataset.rows.find(item=>item.id===blocked.id);
  assert.equal(reportHealthy.checked_at,at(0));assert.deepEqual(reportHealthy.activity.latest_attempt,healthyView.latest_attempt);
  assert.equal(reportBlocked.state,'unknown');assert.equal(reportBlocked.current_state,'present');assert.equal(dataset.coverage.identity_unmatched_entries,1);
  const fleet=await invoke(f.cwd,['fleet','--project',`isolated=${f.paths.ledger}`,'--observations-of',`isolated=${f.paths.observations}`,'--state-of',`isolated=${f.paths.state}`,'--json']);
  assert.equal(fleet.code,0);const project=JSON.parse(fleet.out).projects[0];assert.equal(project.last_attempt_at,at(100));assert.equal(project.last_link_verification_at,at(90));
  assert.equal(project.uncertain_entries,1);assert.equal(project.coverage.identity_unmatched_entries,1);
  assert.deepEqual(await bytes(f.cwd),before,'all read surfaces preserve ledger, mirror, activity, cursors and unknown keys byte-for-byte');
});

test('actual main distinguishes state-only checks from unavailable receipts without inventing a locator',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('state-only reads never fetch'));
  const selected=entry('lk_stateonly1'),state=applyRun({v:2,entries:{},cursors:{events:'keep',target_events:'keep-too'}},[row(selected,'present',50)]);
  const f=await workspace(t,[selected],[],state),before=await bytes(f.cwd);
  const status=await invoke(f.cwd,['status','--all','--json']);assert.equal(status.code,0);const value=JSON.parse(status.out);
  assert.deepEqual(value.disagreements,[]);assert.equal(value.placements[0].latest_attempt.checked_at,at(50));
  assert.equal(value.placements[0].evidence_observed_at,null);assert.equal(value.placements[0].last_link_verification.evidence_reference,null);
  const report=await invoke(f.cwd,['report','--json','--as-of','2026-10-07']),dataset=JSON.parse(report.out);
  assert.equal(report.code,0);assert.equal(dataset.rows[0].evidence,null);assert.equal(dataset.rows[0].current_state,'present');
  assert.equal(dataset.coverage.checked,1);assert.equal(dataset.coverage.never_checked,0);assert.equal(dataset.coverage.retained_receipt_entries,0);
  assert.deepEqual(await bytes(f.cwd),before);
});
