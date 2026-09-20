import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { citationMain } from '../cli/citation.js';
import { buildStarterPanel, selectResearchPrompts } from '../src/citations/panel-builder.js';
import { freezeCitationInventory, citationGap, exportCitationSources } from '../src/citations/inventory.js';
import { runEpoch } from '../src/citations/runner.js';
import { createMockEngine } from '../src/citations/adapter.js';
import { engineIdentity } from '../src/citations/contract.js';
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
