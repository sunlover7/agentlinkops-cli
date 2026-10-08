import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chronologyMain} from '../cli/chronology.js';
const page={schemaVersion:1,identity:{workspaceId:'ws',projectId:'pr',watchId:'watch',sourceUrl:'https://publisher.example/page',targetUrl:'https://example.org/',targetScope:'exact',targetId:null,localReference:null,matchBasis:'configured_target_url'},asOf:'2026-10-07T00:00:00.000Z',snapshotId:'a'.repeat(64),items:[],pageCursor:null,nextCursor:'next',hasMore:true,coverage:{context:{status:'available',reason:'retained_rows_only',hasMore:false},link_events:{status:'denied',reason:'insufficient_scope'}},historyMeaning:'Retained records only.'};
test('offline export is deterministic, explicit about partial paging and has no network or ledger dependency',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'alo-chronology-'));t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(join(dir,'pages.json'),JSON.stringify([page]));
 const args={_:['chronology','export'],tag:[],pages:'pages.json',out:'export.json'};
 await chronologyMain(args,{cwd:dir,out:()=>{},fetchImpl:()=>{throw Error('unexpected network');}});
 const first=await readFile(join(dir,'export.json'),'utf8');await chronologyMain({...args,out:'export2.json'},{cwd:dir,out:()=>{}});assert.equal(await readFile(join(dir,'export2.json'),'utf8'),first);
 await assert.rejects(chronologyMain(args,{cwd:dir,out:()=>{}}),{code:'EEXIST'});assert.equal(await readFile(join(dir,'export.json'),'utf8'),first);
 const input=await readFile(join(dir,'pages.json'),'utf8');await assert.rejects(chronologyMain({...args,out:'pages.json'},{cwd:dir,out:()=>{}}),{code:'EEXIST'});assert.equal(await readFile(join(dir,'pages.json'),'utf8'),input);
 const data=JSON.parse(first);assert.equal(data.pagination.complete,false);assert.equal(data.pagination.reason,'partial_pagination');assert.equal(data.coverage.link_events.status,'denied');assert.match(data.contentHash,/^[a-f0-9]{64}$/);
});
test('offline export refuses mixed placement snapshots before writing output',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'alo-chronology-'));t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(join(dir,'pages.json'),JSON.stringify([page,{...page,identity:{...page.identity,watchId:'other'}}]));
 await assert.rejects(chronologyMain({_:['chronology','export'],tag:[],pages:'pages.json',out:'export.json'},{cwd:dir,out:()=>{}}),{code:'CHRONOLOGY_EXPORT_SCOPE_MISMATCH'});
 await assert.rejects(readFile(join(dir,'export.json')),{code:'ENOENT'});
});

test('offline export refuses absent or malformed placement identity before writing output',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'alo-chronology-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const malformed=[undefined,null,{}, {...page.identity,projectId:''},{...page.identity,targetScope:'any'},{...page.identity,sourceUrl:'file:///tmp/source'},{...page.identity,matchBasis:undefined}];
 for(const identity of malformed){
  await writeFile(join(dir,'pages.json'),JSON.stringify({...page,identity}));
  await assert.rejects(chronologyMain({_:['chronology','export'],tag:[],pages:'pages.json',out:'export.json'},{cwd:dir,out:()=>{}}),{code:'INVALID_CHRONOLOGY_EXPORT'});
  await assert.rejects(readFile(join(dir,'export.json')),{code:'ENOENT'});
 }
});

test('new export path works on the checkout filesystem and refuses replacement',async t=>{
 const dir=await mkdtemp(new URL('../.chronology-export-',import.meta.url).pathname);t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'pages.json'),JSON.stringify([page]));
 const args={_:['chronology','export'],tag:[],pages:'pages.json',out:'export.json'};
 await chronologyMain(args,{cwd:dir,out:()=>{}});const first=await readFile(join(dir,'export.json'),'utf8');
 assert.match(JSON.parse(first).contentHash,/^[a-f0-9]{64}$/);
 await assert.rejects(chronologyMain(args,{cwd:dir,out:()=>{}}),{code:'EEXIST'});assert.equal(await readFile(join(dir,'export.json'),'utf8'),first);
});

test('offline export rejects malformed terminal and continuation metadata without output or a new file',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'alo-chronology-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const last={...page,pageCursor:page.nextCursor,nextCursor:null,hasMore:false};
 const malformed=[
  {hasMore:false,nextCursor:'older'},
  {hasMore:true,nextCursor:null},
  {hasMore:true,nextCursor:''},
  {hasMore:true,nextCursor:'x'.repeat(12001)},
  {hasMore:true,nextCursor:42},
  {hasMore:'false',nextCursor:null},
  {hasMore:undefined,nextCursor:null},
  {hasMore:false,nextCursor:undefined},
 ];
 for(const pagination of malformed)for(const pages of [[{...page,...pagination}],[page,{...last,...pagination}]])for(const destination of [{out:'export.json'},{}]){
  const input=JSON.stringify(pages),output=[];await writeFile(join(dir,'pages.json'),input);
  await assert.rejects(chronologyMain({_:['chronology','export'],tag:[],pages:'pages.json',...destination},{cwd:dir,out:value=>output.push(value),fetchImpl:()=>assert.fail('offline export must not fetch')}),{code:'INVALID_CHRONOLOGY_EXPORT'});
  assert.deepEqual(output,[]);await assert.rejects(readFile(join(dir,'export.json')),{code:'ENOENT'});
  assert.equal(await readFile(join(dir,'pages.json'),'utf8'),input);
 }
});

test('offline continuation-only export remains partial and a legacy terminal page needs no invented readAt',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'alo-chronology-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const terminal={...page,pageCursor:'previous',nextCursor:null,hasMore:false};
 await writeFile(join(dir,'pages.json'),JSON.stringify([terminal]));
 await chronologyMain({_:['chronology','export'],tag:[],pages:'pages.json',out:'continuation.json'},{cwd:dir,out:()=>{},fetchImpl:()=>assert.fail('offline export must not fetch')});
 const partial=JSON.parse(await readFile(join(dir,'continuation.json'),'utf8'));
 assert.equal(partial.pagination.complete,false);assert.equal(partial.pagination.nextCursor,null);assert.equal(partial.pagination.pageCount,1);
 assert.ok(partial.gaps.some(g=>g.stream==='pagination'&&g.reason==='partial_pagination'));
 assert.equal('readAt' in partial,false);assert.equal(partial.asOf,page.asOf);
 await writeFile(join(dir,'pages.json'),JSON.stringify([{...terminal,pageCursor:null}]));
 await chronologyMain({_:['chronology','export'],tag:[],pages:'pages.json',out:'complete.json'},{cwd:dir,out:()=>{},fetchImpl:()=>assert.fail('offline export must not fetch')});
 const complete=JSON.parse(await readFile(join(dir,'complete.json'),'utf8'));
 assert.equal(complete.pagination.complete,true);assert.equal(complete.pagination.nextCursor,null);assert.equal('readAt' in complete,false);
});
