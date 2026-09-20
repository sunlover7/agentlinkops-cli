import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleAioEngine, EngineError } from '../src/citations/adapter.js';
import { runEpoch, CITATION_FILES } from '../src/citations/runner.js';
import { engineIdentity, evidenceEnvelopeSchema } from '../src/citations/contract.js';
const credentials = { login: 'fixture-user', password: 'fixture-only-password' };
const fixture = JSON.parse(await readFile(new URL('./fixtures/citations/dataforseo-aio.json', import.meta.url)));
const prompt = fixture.tasks[0].result[0].keyword;
const copy = () => structuredClone(fixture);
const engine = (body = copy(), options = {}) => createGoogleAioEngine({ credentials, fetchImpl: async () => Response.json(body), ...options });
const code = expected => cause => { assert.equal(cause.code,expected,cause.message); assert.ok(cause instanceof EngineError); return true; };

test('AIO refuses missing credentials and invalid cost/locale settings without fixture fallback', () => {
  for (const options of [{},{credentials:{login:'x'}},{credentials:{login:' ',password:'x'}},{credentials,costEstimateUsd:NaN},{credentials,costEstimateUsd:-1},{credentials,device:'tablet'},{credentials,locationCode:0}]) assert.throws(()=>createGoogleAioEngine(options),code('AIO_CONFIGURATION'));
});
test('AIO injected fixture preserves provider sources and exact request provenance', async () => {
  let request;
  const run = await engine(copy(),{fetchImpl:async(url,init)=>{request={url,init};return Response.json(copy());}}).run({prompt});
  assert.equal(run.citations.length,4); assert.equal(run.provider,'dataforseo-serp'); assert.equal(run.provenance.query,prompt);
  assert.equal(run.provenance.task_id,fixture.tasks[0].id); assert.equal(run.provenance.location_code,2840); assert.equal(run.provenance.device,'desktop');
  assert.equal(request.url,'https://api.dataforseo.com/v3/serp/google/organic/live/advanced'); assert.equal(request.init.redirect,'error');
  assert.deepEqual(JSON.parse(request.init.body),[{keyword:prompt,location_code:2840,language_code:'en',device:'desktop',depth:10,load_async_ai_overview:false}]);
  assert.ok(!JSON.stringify(run).includes(credentials.password));
});
test('AIO handles documented markdown and references collections, deduplicates and omits missing titles', async () => {
  const body=copy(), block=body.tasks[0].result[0].items[0];
  block.markdown=block.text;delete block.text;block.references=[{url:'https://example.com/source'}];block.items=[{type:'ai_overview_element',text:'Body',references:[{url:'https://example.com/source'},{url:'https://example.org/source',title:'Second'}]}];
  const run=await engine(body).run({prompt});assert.equal(run.citations.length,2);assert.deepEqual(run.citations[0],{url:'https://example.com/source'});
});
test('AIO distinguishes missing overview, malformed response and supplier task failures', async () => {
  const absent=copy();absent.tasks[0].result[0].items=[];
  await assert.rejects(engine(absent).run({prompt}),cause=>{code('AIO_NOT_RENDERED')(cause);assert.equal(cause.unknown,true);assert.equal(cause.retriable,false);assert.equal(cause.costEstimateUsd,0.0012);return true;});
  for (const mutate of [b=>{b.tasks[0].result=null;},b=>{b.tasks[0].result[0].items={};},b=>{b.tasks[0].result[0].items[0].references={};}]) {const b=copy();mutate(b);await assert.rejects(engine(b).run({prompt}),code('AIO_MALFORMED_RESPONSE'));}
  const rejected=copy();rejected.status_code=40200;await assert.rejects(engine(rejected).run({prompt}),code('AIO_SUPPLIER_ERROR'));
  const failed=copy();failed.tasks[0].status_code=50000;await assert.rejects(engine(failed).run({prompt}),code('AIO_TASK_ERROR'));
  const blank=copy();blank.tasks[0].result[0].items[0].text='';await assert.rejects(engine(blank).run({prompt}),code('AIO_INCOMPLETE_OVERVIEW'));
});
test('AIO validates query/location/device provenance and sends explicit locale', async () => {
  const body=copy();body.tasks[0].result[0].location_code=2826;body.tasks[0].result[0].language_code='fr';body.tasks[0].result[0].device='mobile';
  let sent;const run=await engine(body,{locationCode:2826,languageCode:'fr',device:'mobile',fetchImpl:async(_,init)=>{sent=JSON.parse(init.body)[0];return Response.json(body);}}).run({prompt});
  assert.equal(sent.location_code,2826);assert.equal(run.provenance.device,'mobile');
  await assert.rejects(engine(body).run({prompt}),code('AIO_PROVENANCE_MISMATCH'));
  await assert.rejects(engine().run({prompt:'different query'}),code('AIO_PROVENANCE_MISMATCH'));
});
test('AIO rejects unsupported tariffs and insufficient admission budgets before any call', async () => {
  let calls=0;const adapter=engine(copy(),{fetchImpl:async()=>{calls++;return Response.json(copy());}});
  for(const query of ['site:example.com links','hello filetype:pdf','x inurl:blog'])await assert.rejects(adapter.run({prompt:query}),code('AIO_UNPRICED_QUERY'));
  await assert.rejects(adapter.run({prompt,maxCostUsd:0.001}),code('AIO_BUDGET'));
  assert.equal(calls,0);
  const expensive=copy();expensive.cost=0.01;await assert.rejects(engine(expensive).run({prompt}),cause=>{code('AIO_COST_EXCEEDED')(cause);assert.equal(cause.costEstimateUsd,0.01);return true;});
});
test('AIO encodes literal plus/percent without changing retained query', async () => {
  const body=copy(),query='C++ 10% research';body.tasks[0].result[0].keyword=query;let keyword;
  const run=await engine(body,{fetchImpl:async(_,init)=>{keyword=JSON.parse(init.body)[0].keyword;return Response.json(body);}}).run({prompt:query});
  assert.equal(keyword,'C%2B%2B 10%25 research');assert.equal(run.provenance.query,query);
});
test('AIO bounds headers and streaming bodies and rejects invalid JSON/unsafe source URLs', async () => {
  await assert.rejects(engine(copy(),{maxResponseBytes:100}).run({prompt}),code('AIO_RESPONSE_TOO_LARGE'));
  await assert.rejects(engine(copy(),{fetchImpl:async()=>new Response('x',{headers:{'content-length':'999999'}})}).run({prompt}),code('AIO_RESPONSE_TOO_LARGE'));
  await assert.rejects(engine(copy(),{fetchImpl:async()=>new Response('{')}).run({prompt}),code('AIO_MALFORMED_RESPONSE'));
  const body=copy();body.tasks[0].result[0].items[0].items[0].url='javascript:alert(1)';await assert.rejects(engine(body).run({prompt}),code('AIO_MALFORMED_RESPONSE'));
});
test('AIO timeout and caller abort bound both fetch and body reads, without leaking transport messages', async () => {
  await assert.rejects(engine(copy(),{timeoutMs:10,fetchImpl:async()=>new Promise(()=>{})}).run({prompt}),code('AIO_TIMEOUT'));
  await assert.rejects(engine(copy(),{timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))}).run({prompt}),code('AIO_TIMEOUT'));
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(engine(copy(),{fetchImpl:async()=>{calls++;return Response.json(copy());}}).run({prompt,signal:controller.signal}),code('AIO_ABORTED'));assert.equal(calls,0);
  const during=new AbortController();const pending=engine(copy(),{fetchImpl:async()=>{during.abort();return new Promise(()=>{});}}).run({prompt,signal:during.signal});await assert.rejects(pending,code('AIO_ABORTED'));
  await assert.rejects(engine(copy(),{fetchImpl:async()=>{throw new Error(credentials.password);}}).run({prompt}),cause=>{code('AIO_TRANSPORT_ERROR')(cause);assert.ok(!cause.message.includes(credentials.password));return true;});
});

test('AIO panel budget retains unknown paid attempts and provenance in standard evidence envelopes', async t => {
  const dir=await mkdtemp(join(tmpdir(),'aio-budget-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const body=copy();body.tasks[0].result[0].items=[];let calls=0;
  const adapter=engine(body,{fetchImpl:async()=>{calls++;return Response.json(body);}});
  const spec={engine:'google-aio',via:'api'};
  const result=await runEpoch({schema_version:1,targets:[{domain:'example.com',scope:'domain',brand:'Example'}],prompts:[{id:'p',text:prompt}],engines:[spec],samples:4,maxUsd:0.0025},{dir,engines:new Map([[engineIdentity(spec),adapter]])});
  assert.equal(calls,2);assert.equal(result.aborted.reason,'budget');assert.equal(result.spentEstimateUsd,0.0024);assert.equal(result.cells[0].n,0);assert.equal(result.cells[0].unknowns,2);assert.equal(result.cells[0].rate,null);
  const evidenceDir=join(dir,CITATION_FILES.evidenceDir,result.epochId);
  const filenames=await readdir(evidenceDir);assert.equal(filenames.length,2);
  const retained=evidenceEnvelopeSchema.parse(JSON.parse(await readFile(join(evidenceDir,filenames[0]),'utf8')));
  assert.equal(retained.provenance.query,prompt);assert.equal(retained.provenance.device,'desktop');assert.equal(retained.failure.code,'AIO_NOT_RENDERED');assert.equal(retained.cost_estimate_usd,0.0012);
});

test('runner reserves retry attempts and stops when supplier reports an estimate overrun', async t => {
  const dir=await mkdtemp(join(tmpdir(),'aio-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const spec={engine:'google-aio',via:'api'},panel={schema_version:1,targets:[{domain:'example.com',scope:'domain',brand:'Example'}],prompts:[{id:'p',text:prompt}],engines:[spec],samples:4,maxUsd:0.0015};
  let attempts=0;const retrying={estimateCostUsd:()=>0.0012,run:async()=>{attempts++;throw new EngineError('temporary',{retriable:true});}};
  const retried=await runEpoch(panel,{dir,engines:new Map([[engineIdentity(spec),retrying]])});assert.equal(attempts,1);assert.equal(retried.spentEstimateUsd,0.0012);assert.equal(retried.cells[0].unknowns,1);assert.equal(retried.aborted.reason,'budget');
  const body=copy();body.cost=0.01;let calls=0;
  const exceeded=await runEpoch({...panel,maxUsd:0.003},{dir,engines:new Map([[engineIdentity(spec),engine(body,{fetchImpl:async()=>{calls++;return Response.json(body);}})]])});
  assert.equal(calls,1);assert.equal(exceeded.aborted.reason,'supplier_cost_exceeded');assert.equal(exceeded.spentEstimateUsd,0.01);assert.equal(exceeded.cells[0].n,0);
});

test('AIO successful panel writes honest cited tier and retained provider provenance', async t => {
  const dir=await mkdtemp(join(tmpdir(),'aio-success-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const spec={engine:'google-aio',via:'api'};
  const result=await runEpoch({schema_version:1,targets:[{domain:'backlinkmonitoring.ai',scope:'domain',brand:'Backlink Monitoring'}],prompts:[{id:'p',text:prompt}],engines:[spec],samples:1,maxUsd:0.002},{dir,engines:new Map([[engineIdentity(spec),engine()]])});
  const rows=(await readFile(join(dir,CITATION_FILES.observations),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].outcome,'cited');assert.equal(rows[0].verify,'unverified');assert.equal(result.spentEstimateUsd,0.0012);
  const path=join(dir,CITATION_FILES.evidenceDir,result.epochId,`${rows[0].evidence_sha256}.json`);
  const retained=evidenceEnvelopeSchema.parse(JSON.parse(await readFile(path,'utf8')));
  assert.equal(retained.engine_identity,'google-aio:api');assert.equal(retained.provenance.task_id,fixture.tasks[0].id);assert.equal(retained.provenance.location_code,2840);
});

test('AIO timed-out panel reserves possible supplier charges and records unknown evidence without retry', async t => {
  const dir=await mkdtemp(join(tmpdir(),'aio-timeout-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const spec={engine:'google-aio',via:'api'};let calls=0;
  const adapter=engine(copy(),{timeoutMs:5,fetchImpl:async()=>{calls++;return new Promise(()=>{});}});
  const result=await runEpoch({schema_version:1,targets:[{domain:'example.com',scope:'domain',brand:'Example'}],prompts:[{id:'p',text:prompt}],engines:[spec],samples:2,maxUsd:0.0015},{dir,engines:new Map([[engineIdentity(spec),adapter]])});
  assert.equal(calls,1);assert.equal(result.spentEstimateUsd,0.0012);assert.equal(result.cells[0].unknowns,1);assert.equal(result.cells[0].rate,null);assert.equal(result.aborted.reason,'budget');
});

test('AIO rejects HTTP errors without auto-retrying or following redirects', async () => {
  for(const status of [302,401,429,503]) {
    let calls=0;await assert.rejects(engine(copy(),{fetchImpl:async()=>{calls++;return new Response('',{status});}}).run({prompt}),cause=>{code('AIO_HTTP_ERROR')(cause);assert.equal(cause.httpStatus,status);assert.equal(cause.retriable,false);assert.equal(cause.costEstimateUsd,0.0012);return true;});assert.equal(calls,1);
  }
});
