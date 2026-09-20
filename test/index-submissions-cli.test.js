import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateSubmission,saveSubmissions,readSubmissions,reconcileSubmissions,submissionCsv} from '../cli/index-submissions.js';
import {saveIndexReceipts} from '../cli/index-observations.js';
import {gscIndexObservation} from '../src/index-observation.js';
const url='https://example.com/article',at='2026-09-20T00:00:00.000Z';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function submission(changes={}){const body={v:1,id:'attempt1',project_id:'project1',url,channel:'indexnow',endpoint:'https://api.indexnow.org/indexnow',submitted_at:at,http_status:200,...changes};return {...body,evidence_sha256:hash(body)};}
function observation({project='project1',href=url,date='2026-09-20T01:00:00.000Z',status=429,id='a'}={}){
 const raw={error:{code:status}},o=gscIndexObservation({observationId:`observation${id}`,inspectionUrl:href,checkedAt:date,siteUrl:'sc-domain:example.com',grantedProperties:['sc-domain:example.com'],payload:raw});delete o.raw_response;
 return {v:1,project_id:project,watch_id:'watch1',receipt:{observation:{...o,id:id.repeat(64),observationId:`observation${id}`,checkedAt:date,recordedAt:date,expiresAt:'2026-10-20T00:00:00.000Z',evidenceSha256:hash(raw),eventId:null,ignored:null},rawResponse:raw,evidenceAvailable:true}};
}
async function setup(t){const cwd=await mkdtemp(join(tmpdir(),'index-submissions-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(join(cwd,'.agentlinkops'));await writeFile(join(cwd,'.agentlinkops','links.jsonl'),'');return {cwd,path:join(cwd,'.agentlinkops','index-submissions.jsonl')};}
test('immutable attempts preserve status distinctions and reject hash, field and identity corruption',async t=>{
 const {path}=await setup(t),first=submission(),pending=submission({id:'attempt2',http_status:202});await saveSubmissions(path,[first,pending]);await saveSubmissions(path,[first]);assert.equal((await readSubmissions(path)).length,2);
 const before=await readFile(path,'utf8');await assert.rejects(saveSubmissions(path,[submission({http_status:202})]),/identity conflict/);assert.equal(await readFile(path,'utf8'),before);
 assert.throws(()=>validateSubmission({...first,http_status:500}),/hash mismatch/);assert.throws(()=>validateSubmission({...first,key:'secret'}),/Invalid/);
 for(const edit of [{url:`${url}#x`},{url:'https://user:pass@example.com/article'},{submitted_at:'2026-09-20'},{http_status:'200'},{endpoint:'https://other.example/'},{url:'HTTPS://example.com/article'}])assert.throws(()=>validateSubmission(submission(edit)));
 const report=reconcileSubmissions([first,pending,submission({id:'failure',http_status:403}),submission({id:'timeout',http_status:null})],[],'project1');assert.deepEqual(report.submissions.map(s=>s.outcome),['received','key_validation_pending','failed','unknown']);assert.ok(report.submissions.every(s=>s.verification==='not_established'));
});
test('chronological join keeps exact project and URL boundaries, unknowns and all attempts',()=>{
 const rows=[observation({date:at,id:'b'}),observation({project:'project2',id:'c'}),observation({href:`${url}/`,id:'d'}),observation({date:'2026-09-19T23:59:59.000Z',id:'e'}),observation({date:'2026-09-20T02:00:00.000Z',id:'f'}),observation()];
 const report=reconcileSubmissions([submission(),submission({id:'attempt2',http_status:202}),submission({project_id:'project2'})],rows,'project1');assert.equal(report.submissions.length,2);
 for(const s of report.submissions){assert.deepEqual(s.observations.map(o=>o.observation_id),['a'.repeat(64),'f'.repeat(64)]);assert.ok(s.observations.every(o=>o.tier==='unknown'&&!o.participant_indexing_verified&&!o.causation_established));assert.equal(s.observations[0].evidence_sha256,hash({error:{code:429}}));}
 assert.throws(()=>reconcileSubmissions([],[],undefined),/project-id/);
 const indexed=observation();indexed.receipt.observation.tier='indexed';const joined=reconcileSubmissions([submission()],[indexed],'project1');assert.equal(joined.submissions[0].observations[0].participant_indexing_verified,false);assert.equal(joined.submissions[0].verification,'not_established');
 indexed.receipt.observation.reason=' =HYPERLINK("bad")';assert.match(submissionCsv(reconcileSubmissions([submission()],[indexed],'project1')),/"' =HYPERLINK/);
});
test('real CLI process imports, exports and reconciles offline with retained observation provenance',async t=>{
 const {cwd,path}=await setup(t),entry=new URL('../cli/agentlinkops.mjs',import.meta.url).pathname;
 const run=(...args)=>execFileSync(process.execPath,[entry,'index',...args],{cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 await writeFile(join(cwd,'submissions.json'),JSON.stringify([submission(),submission({id:'attempt2',http_status:202})]));
 assert.equal(JSON.parse(run('submissions-import','submissions.json')).total,2);run('submissions-import','submissions.json');assert.equal((await readSubmissions(path)).length,2);
 await saveIndexReceipts(join(cwd,'.agentlinkops','index-observations.jsonl'),[observation()]);
 run('submissions-export','--project-id','project1','--out','nested/export.json');assert.deepEqual(JSON.parse(await readFile(join(cwd,'nested/export.json'),'utf8')),[submission(),submission({id:'attempt2',http_status:202})]);
 const report=JSON.parse(run('reconcile-submissions','--project-id','project1'));assert.equal(report.submissions[0].observations.length,1);assert.match(report.note,/do not verify/);
 run('reconcile-submissions','--project-id','project1','--format','csv','--out','nested/report.csv');assert.match(await readFile(join(cwd,'nested/report.csv'),'utf8'),/key_validation_pending/);
 assert.deepEqual(JSON.parse(run('reconcile-submissions','--project-id','other')).submissions,[]);
});
