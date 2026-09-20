import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { citationMain } from '../cli/citation.js';
import { buildStarterPanel, selectResearchPrompts } from '../src/citations/panel-builder.js';
import { freezeCitationInventory, citationGap, exportCitationSources } from '../src/citations/inventory.js';
import { runEpoch } from '../src/citations/runner.js';
import { createMockEngine } from '../src/citations/adapter.js';
import { engineIdentity, evidenceEnvelopeSchema } from '../src/citations/contract.js';
import { verifyLocalEvidenceDigest } from '../src/citations/evidence-integrity.js';
import { parseOpportunityRecord } from '../shared/opportunity-record.js';
const provenance = {source:'gsc',reference:'owned-export.csv:2',observed_at:'2026-09-19T00:00:00Z'};
const research = [{text:'Which tools help?',intent_cluster:'compare',provenance},{text:' Which tools help? ',intent_cluster:'compare',provenance},{text:'Which systems help?',intent_cluster:'compare',provenance},{text:'How do teams start?',intent_cluster:'workflow',provenance}];
test('research provenance stays user supplied, deduplicated and selected across intent groups', () => {
 const prompts = selectResearchPrompts(research,{limit:2}); assert.equal(prompts.length,2); assert.deepEqual(prompts.map(p=>p.intent_cluster),['compare','workflow']); assert.equal(prompts[0].provenance.basis,'user_supplied');
 assert.equal(buildStarterPanel({domain:'example.com',brand:'Example',prompts}).prompts[0].provenance.reference,'owned-export.csv:2');
 assert.throws(()=>selectResearchPrompts(research,{limit:NaN}),/limit/);
 assert.throws(()=>buildStarterPanel({domain:'example.com',brand:'Example',prompts:[{text:'bad',provenance:{source:'invented'}}]}));
});
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(),'citation-inventory-'));
 const panel = buildStarterPanel({domain:'example.com',brand:'Example',competitors:[{domain:'rival.example.org',brand:'Rival'}],prompts:selectResearchPrompts(research,{limit:2}),samples:2});
 const engine=createMockEngine({fixtures:Object.fromEntries(panel.prompts.map(p=>[p.text,{mentionText:'Example offers a service.',citations:[{url:'https://rival.example.org/source',weight:1}]}]))});
 const epoch=await runEpoch(panel,{dir,engines:new Map([[engineIdentity(panel.engines[0]),engine]]),delayMs:0,err:()=>{}});
 return {dir,panel,epoch};
}
test('retained fixture inventory, gap and held library exports share exact evidence without absence claims',async()=>{
 const f=await fixture(); try {
 const inventory=await freezeCitationInventory({...f,epochId:f.epoch.epochId}); assert.equal(inventory.observations.length,8); assert.equal(inventory.missing_envelopes,0);
 const roundtrip=JSON.parse(JSON.stringify(inventory)); const gap=citationGap(roundtrip); assert.equal(gap.absence_claim,'not_supported'); assert.equal(gap.mentioned_not_cited.length,4);
 assert.equal(gap.cells.find(c=>c.cell_id.endsWith('d:example.com')).finding,'not_cited_in_these_known_samples');
 await assert.rejects(exportCitationSources(inventory,{}),/consent/);
 const records=await exportCitationSources(inventory,{niche:{id:'tools',label:'Tools'},consentRef:'fixture-consent',excludedInputsAttested:true});
 assert.equal(records.length,1); records.forEach(parseOpportunityRecord); assert.equal(records[0].status,'held'); assert.equal(records[0].rights.redistributable,false); assert.equal(records[0].evidence[0].complete,false); assert.equal(records[0].provenance.seed_reason,'fixture_only');
 roundtrip.observations[0].cited=!roundtrip.observations[0].cited; assert.throws(()=>citationGap(roundtrip),/checksum/);
 const evidence=join(f.dir,'citations/evidence',f.epoch.epochId); const file=(await readdir(evidence)).find(p=>p.endsWith('.json')); await rm(join(evidence,file)); await symlink('/etc/hosts',join(evidence,file));
 const partial=await freezeCitationInventory(f); assert.equal(partial.missing_envelopes,1); assert.equal(partial.invalid_envelopes,1);
 const other=buildStarterPanel({domain:'other.example.org',brand:'Other',prompts:f.panel.prompts}); await assert.rejects(freezeCitationInventory({dir:f.dir,panel:other}),/matching panel/);
 } finally {await rm(f.dir,{recursive:true,force:true});}
});
test('CLI research → bounded mock sweep → gap/export, refuses overwrite and missing budget',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'citation-sweep-'));const errors=[];const options={cwd:dir,env:{},out:()=>{},err:v=>errors.push(v)};
 try {
 await writeFile(join(dir,'research.json'),JSON.stringify(research));
 assert.equal(await citationMain(['panel','--domain','example.com','--brand','Example','--research','research.json','--limit','2','--samples','1','--out','panel.json'],options),0);
 assert.equal(await citationMain(['sweep','panel.json','--out','frozen.json'],options),2);
 assert.equal(await citationMain(['sweep','panel.json','--max-usd','1','--out','frozen.json'],options),0,errors.join('\n'));
 assert.equal(await citationMain(['gap','frozen.json','--out','gap.json'],options),0,errors.join('\n'));
 assert.equal(await citationMain(['export-sources','frozen.json','--niche','tools','--niche-label','Tools','--consent-ref','fixture-consent','--attest-owned','--out','sources.json'],options),0,errors.join('\n'));
 const before=await readFile(join(dir,'.agentlinkops/citations-epochs.jsonl'),'utf8');
 assert.equal(await citationMain(['sweep','panel.json','--max-usd','1','--out','frozen.json'],options),2); assert.equal(await readFile(join(dir,'.agentlinkops/citations-epochs.jsonl'),'utf8'),before);
 const frozen=JSON.parse(await readFile(join(dir,'frozen.json'),'utf8')); assert.equal(frozen.observations[0].prompt_provenance.basis,'user_supplied');
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('branded prompts and unknown observations stay out of source exports; absent envelopes stay unknown',async()=>{
 const f=await fixture(); try {
 f.panel.prompts=f.panel.prompts.map(p=>({...p,branded:true}));
 const branded=await freezeCitationInventory(f); assert.ok(citationGap(branded).cells.every(c=>!c.headline_eligible));
 assert.deepEqual(await exportCitationSources(branded,{niche:{id:'tools',label:'Tools'},consentRef:'fixture',excludedInputsAttested:true}),[]);
 const evidence=join(f.dir,'citations/evidence',f.epoch.epochId); for(const file of await readdir(evidence)) await rm(join(evidence,file));
 const empty=await freezeCitationInventory(f); assert.equal(empty.missing_envelopes,8); assert.ok(citationGap(empty).cells.every(c=>c.finding==='unknown'&&c.n===0));
 } finally {await rm(f.dir,{recursive:true,force:true});}
});

const sha256 = text => createHash('sha256').update(text).digest('hex');
test('freezing rejects changed evidence and unreferenced files instead of blessing a new checksum',async()=>{
 const f=await fixture();try{
  const dir=join(f.dir,'citations/evidence',f.epoch.epochId);
  const name=(await readdir(dir)).find(n=>n.endsWith('.json'));
  const original=JSON.parse(await readFile(join(dir,name),'utf8'));
  const changed={...original,answer:'A changed answer.',citations:[{url:'https://example.com/changed'}]};
  await writeFile(join(dir,name),JSON.stringify(changed));
  // A well-formed, correctly hashed extra file still lacks a ledger reference.
  const extra=JSON.stringify({...original,run_index:999});
  await writeFile(join(dir,sha256(extra)+'.json'),extra);
  const result=await freezeCitationInventory(f);
  assert.equal(result.observations.length,7);assert.equal(result.invalid_envelopes,2);assert.equal(result.missing_envelopes,1);
  assert.ok(!result.observations.some(o=>o.citations.some(c=>c.url.includes('/changed'))));
  assert.ok(result.observations.every(o=>/^[a-f0-9]{64}$/.test(o.local_evidence_sha256)));
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('ledger references cannot extend the recorded sample range or change engine and prompt membership',async()=>{
 for(const change of ['range','engine','prompt']){
  const f=await fixture();try{
   const path=join(f.dir,'citations-observations.jsonl');
   const rows=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
   const row=rows[0],dir=join(f.dir,'citations/evidence',f.epoch.epochId),old=join(dir,row.evidence_sha256+'.json');
   const envelope=JSON.parse(await readFile(old,'utf8'));
   if(change==='range'){envelope.run_index=999;row.run_index=999;}
   if(change==='engine')envelope.engine_identity='perplexity:api';
   if(change==='prompt')envelope.prompt='A different question with the same prompt ID';
   const text=JSON.stringify(envelope);row.evidence_sha256=sha256(text);
   await rm(old);await writeFile(join(dir,row.evidence_sha256+'.json'),text);
   await writeFile(path,rows.map(JSON.stringify).join('\n')+'\n');
   const result=await freezeCitationInventory(f);
   assert.equal(result.observations.length,7,change);assert.equal(result.invalid_envelopes,1,change);assert.equal(result.missing_envelopes,1,change);
  }finally{await rm(f.dir,{recursive:true,force:true});}
 }
});
test('missing or conflicting observation ledger stays unavailable; unknown ledger outcomes cannot become absence',async()=>{
 const f=await fixture();try{
  const path=join(f.dir,'citations-observations.jsonl');
  const rows=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
  const first=rows[0];
  await writeFile(path,rows.concat({...first,evidence_sha256:'a'.repeat(64)}).map(JSON.stringify).join('\n')+'\n');
  await assert.rejects(freezeCitationInventory(f),/Conflicting retained observation identity/);
  first.outcome='unknown';
  await writeFile(path,rows.map(JSON.stringify).join('\n')+'\n');
  const unknown=await freezeCitationInventory(f);
  const observation=unknown.observations.find(o=>o.cell_id===first.cell_id&&o.run_index===first.run_index);
  assert.equal(observation.outcome,'unknown');assert.equal(observation.cited,null);assert.deepEqual(observation.citations,[]);
  await rm(path);
  const missing=await freezeCitationInventory(f);assert.equal(missing.observations.length,0);assert.equal(missing.missing_envelopes,8);
  assert.ok(citationGap(missing).cells.every(c=>c.finding==='unknown'));
  await symlink('/etc/hosts',path);await assert.rejects(freezeCitationInventory(f),/Unsafe observation ledger/);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('actual runner screenshots and token defaults retain legacy digest compatibility without byte-hash conflation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'citation-legacy-hash-'));
 try{
  const panel=buildStarterPanel({domain:'example.com',brand:'Example',prompts:[{text:'Which tools help?'}],samples:1});
  const base=createMockEngine(),engine={...base,async run(input){return {...await base.run(input),usage:{},screenshotPng:Buffer.from('fixture pixels'),browserContext:{surface:'web',authentication:'anonymous',account_tier:'unknown'}};}};
  const epoch=await runEpoch(panel,{dir,engines:new Map([[engineIdentity(panel.engines[0]),engine]])});
  const inventory=await freezeCitationInventory({dir,panel});
  assert.equal(inventory.invalid_envelopes,0);assert.equal(inventory.observations.length,1);
  const observation=inventory.observations[0];assert.notEqual(observation.evidence_sha256,observation.local_evidence_sha256);
  const path=join(dir,'citations/evidence',epoch.epochId,observation.local_evidence_sha256+'.json');
  const raw=JSON.parse(await readFile(path,'utf8'));raw.screenshot_file='a'.repeat(64)+'.screenshot.png';await writeFile(path,JSON.stringify(raw));
  const changed=await freezeCitationInventory({dir,panel});assert.equal(changed.invalid_envelopes,1);assert.equal(changed.observations.length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy no-locale envelope and optional provenance hashes verify without rewriting stored evidence',()=>{
 for(const extras of [{},{provenance:{query:'Which tools?',location_code:2840,language_code:'en',device:'desktop',endpoint:'https://api.example.com/query',depth:10,load_async_ai_overview:false},failure:{code:'UNAVAILABLE',message:'Unavailable'}}]){
  const original={schema_version:1,epoch_id:'legacy',cell_id:'mock:builtin|q|d:example.com',run_index:0,prompt:'Which tools?',engine_identity:'mock:builtin',provider_model_version:'legacy-model',answer:'',citations:[],fan_out:[],usage:{input_tokens:0,output_tokens:0},cost_estimate_usd:0,at:'2026-09-17T00:00:00.000Z',...extras};
  const digest=sha256(JSON.stringify(original)),envelope=evidenceEnvelopeSchema.parse({...original,screenshot_file:digest+'.screenshot.png'}),text=JSON.stringify(envelope);
  assert.equal(verifyLocalEvidenceDigest({envelope,text,digest}),true);
  assert.equal(verifyLocalEvidenceDigest({envelope:{...envelope,answer:'Changed'},text:JSON.stringify({...envelope,answer:'Changed'}),digest}),false);
 }
});
test('digest verification rejects stripped fields and duplicate JSON keys without rejecting harmless formatting',()=>{
 const original={schema_version:1,epoch_id:'legacy',cell_id:'mock:builtin|q|d:example.com',run_index:0,prompt:'Which tools?',engine_identity:'mock:builtin',provider_model_version:'legacy-model',answer:'Answer',citations:[{url:'https://example.com'}],fan_out:[],usage:{input_tokens:0,output_tokens:0},cost_estimate_usd:0,at:'2026-09-17T00:00:00.000Z'};
 const digest=sha256(JSON.stringify(original));
 const check=text=>verifyLocalEvidenceDigest({envelope:evidenceEnvelopeSchema.parse(JSON.parse(text)),text,digest});
 assert.equal(check(JSON.stringify(original,null,2)),true);
 assert.equal(check(JSON.stringify(Object.fromEntries(Object.entries(original).reverse()))),true);
 for(const raw of [{...original,unverified:'must not upload'}, {...original,usage:{...original.usage,unverified:'must not upload'}}, {...original,citations:[{...original.citations[0],unverified:'must not upload'}]}]) {
  const text=JSON.stringify(raw),envelope=evidenceEnvelopeSchema.parse(raw);
  assert.equal(verifyLocalEvidenceDigest({envelope,text,digest}),false);
  assert.equal(verifyLocalEvidenceDigest({envelope,text,digest:sha256(text)}),false);
 }
 const duplicated=JSON.stringify(original).replace('"answer":"Answer"','"answer":"discarded private content","answer":"Answer"');
 assert.equal(check(duplicated),false);
 const nested=JSON.stringify(original).replace('"input_tokens":0','"input_tokens":"discarded private content","input_tokens":0');
 assert.equal(check(nested),false);
 const escapedKey=JSON.stringify(original).replace('"answer":"Answer"','"an\\u0073wer":"discarded private content","answer":"Answer"');
 assert.equal(check(escapedKey),false);
});
