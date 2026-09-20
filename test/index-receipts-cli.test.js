import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {main} from '../cli/main.js';import {saveIndexReceipts,readIndexReceipts,indexCsv} from '../cli/index-observations.js';
import {gscIndexObservation} from '../src/index-observation.js';import {indexEvidenceReference,parseEvidenceReference,describeEvidenceReference} from '../src/evidence-reference.js';
import {normalizeEntry} from '../cli/ledger.js';
const at='2026-09-20T00:00:00.000Z',url='https://example.com/article';
function bundle(){const raw={error:{code:429}},o=gscIndexObservation({observationId:'fixture1',inspectionUrl:url,checkedAt:at,siteUrl:'sc-domain:example.com',grantedProperties:['sc-domain:example.com'],payload:raw});delete o.raw_response;return {v:1,project_id:'pr_fixture',watch_id:'wa_fixture',receipt:{observation:{...o,id:'a'.repeat(64),observationId:'fixture1',checkedAt:at,recordedAt:at,expiresAt:'2026-10-20T00:00:00.000Z',evidenceSha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),eventId:null,ignored:null},rawResponse:raw,evidenceAvailable:true}};}
async function setup(t){const cwd=await mkdtemp(join(tmpdir(),'index-receipts-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(join(cwd,'.agentlinkops'));await writeFile(join(cwd,'.agentlinkops','links.jsonl'),JSON.stringify(normalizeEntry({id:'lk_index001',intent:'expected',source:url,target:'https://target.example/'}))+'\n');return {cwd,path:join(cwd,'.agentlinkops','index-observations.jsonl')};}
async function run(cwd,args,extra={}){const out=[],err=[];const code=await main(args,{cwd,env:{},out:v=>out.push(v),err:v=>err.push(v),...extra});return {code,out:out.join('\n'),err:err.join('\n')};}
test('verified local receipt survives expired hosted export and resolves offline through CLI report and locator',async t=>{
 const {cwd,path}=await setup(t),row=bundle();await saveIndexReceipts(path,[row]);await saveIndexReceipts(path,[{...row,receipt:{...row.receipt,evidenceAvailable:false,rawResponse:null}}]);assert.equal((await readIndexReceipts(path))[0].receipt.evidenceAvailable,true);
 const json=await run(cwd,['report','--json','--as-of',at]);assert.equal(json.code,0,json.err);const data=JSON.parse(json.out);assert.equal(data.rows[0].state,'unchecked');assert.equal(data.rows[0].index_observations[0].tier,'unknown');assert.equal(data.rows[0].index_observations[0].checked_at,at);
 const located=await run(cwd,['locate','--ref',data.rows[0].index_observations[0].locator]);assert.equal(located.code,0,located.err);assert.deepEqual(JSON.parse(located.out).rawResponse,row.receipt.rawResponse);
 const html=await run(cwd,['report','--as-of',at]);assert.equal(html.code,0,html.err);assert.match(html.out,/Index evidence/);assert.match(html.out,/unknown/);
 const exported=await run(cwd,['index','export','--out','nested/receipts.json']);assert.equal(exported.code,0,exported.err);assert.equal(JSON.parse(await readFile(join(cwd,'nested/receipts.json'),'utf8')).length,1);
});
test('hash and identity corruption cannot replace previously verified local receipt',async t=>{
 const {path}=await setup(t),row=bundle();await saveIndexReceipts(path,[row]);const before=await readFile(path,'utf8');await assert.rejects(saveIndexReceipts(path,[{...row,receipt:{...row.receipt,rawResponse:{error:{code:500}}}}]),/hash mismatch/);
 await assert.rejects(saveIndexReceipts(path,[{...row,watch_id:'other'}]),/identity conflict/);assert.equal(await readFile(path,'utf8'),before);
});
test('CSV retains reason/date/backend and unknown rows without reclassifying misses',async t=>{
 const {cwd,path}=await setup(t);await saveIndexReceipts(path,[bundle()]);await writeFile(join(cwd,'urls.csv'),`URL\n${url}\nhttps://unknown.example/\n`);const result=await run(cwd,['index','csv','urls.csv']);assert.equal(result.code,0,result.err);assert.match(result.out,/Check Date/);assert.match(result.out,/2026-09-20/);assert.match(result.out,/not_checked/);assert.match(result.out,/google_url_inspection/);
 const dangerous=bundle();dangerous.receipt.observation.reason=' =HYPERLINK("x")';assert.match(indexCsv([url],[dangerous]),/"' =HYPERLINK/);
});
test('index references preserve scope and require stable receipt digests',()=>{
 const mirror=indexEvidenceReference({receiptId:'a'.repeat(64)}),hosted=indexEvidenceReference({receiptId:'a'.repeat(64),projectId:'pr_fixture',watchId:'wa_fixture',storage:'hosted'});assert.equal(parseEvidenceReference(mirror).subject,'index');assert.equal(parseEvidenceReference(hosted).watchId,'wa_fixture');assert.match(JSON.stringify(describeEvidenceReference(hosted)),/get_index_observation/);assert.equal(indexEvidenceReference({receiptId:'oops'}),null);
});
