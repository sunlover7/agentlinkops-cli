import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatgptCitationState, extractChatgptSources } from '../src/citations/browser/chatgpt-citations.js';
import { PROVIDER_MODEL_RESPONSE_SELECTORS, CHATGPT_ANONYMOUS_RESPONSE_SELECTOR } from '../src/citations/browser/shims/utils.js';
import { PROVIDER_MODEL_RESPONSE_SELECTORS as legacy } from '../src/citations/browser/gen/utils/agent-constants.js';

const visibleNode=()=>({isConnected:true,getBoundingClientRect:()=>({width:30,height:20}),getAttribute:()=>null});
const group = (urls = [], buttons = false) => ({
  ...visibleNode(),
  querySelectorAll: selector => { assert.equal(selector, 'a[href]'); return urls.map(url => ({...visibleNode(),href:url,textContent:'Evidence source'})); },
  querySelector: selector => { assert.equal(selector, 'button, [role="button"]'); return buttons ? {} : null; },
});
function state(groups, {missing = false, hidden = false, pending = false} = {}) {
  const root = {isConnected:true,getBoundingClientRect:()=>({width:hidden?0:600,height:300}),innerText:'A fixture assistant answer with enough text to qualify as a scoped response.',
    matches:()=>false,
    getAttribute: key => key==='aria-busy' && pending ? 'true' : null,
    querySelectorAll: selector => {assert.equal(selector,'[role="group"][aria-label="Sources"]');return groups;}};
  const previous = {document:globalThis.document,window:globalThis.window,HTMLElement:globalThis.HTMLElement};
  globalThis.HTMLElement=class {static [Symbol.hasInstance](value){return typeof value?.getBoundingClientRect==='function';}};
  globalThis.document = {querySelectorAll: selector => {assert.equal(selector,PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt.join(', '));return missing?[]:[root];}};
  globalThis.window = {getComputedStyle:()=>({visibility:'visible',display:'block'})};
  try{return readChatgptCitationState(PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt);}
  finally{for(const key of ['document','window','HTMLElement']){if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];}}
}
test('shared ChatGPT selector keeps legacy boundaries and adds a response-only anonymous LI',()=>{
  assert.deepEqual(PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt.slice(0,-1),legacy.chatgpt);
  assert.equal(PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt.at(-1),CHATGPT_ANONYMOUS_RESPONSE_SELECTOR);
  assert.match(CHATGPT_ANONYMOUS_RESPONSE_SELECTOR,/ol\[aria-label="Conversation"\] > li/);
  for(const boundary of ['Response actions','Copy response','Copy message','contenteditable','textarea'])assert.ok(CHATGPT_ANONYMOUS_RESPONSE_SELECTOR.includes(boundary));
});
test('anonymous button-only and partially resolved source groups remain unknown',async()=>{
  for(const groups of [[group([],true)],[group(['https://example.com/source'],true)],[group(['https://example.com/source']),group([],true)]]){
    const observed=state(groups);assert.equal(observed.unresolved,true);let fallback=0;
    await assert.rejects(extractChatgptSources({evaluate:async()=>observed},async()=>{fallback++;return [];}),e=>e.code==='CITATION_EXTRACTION_UNAVAILABLE');
    assert.equal(fallback,0);
  }
});
test('malformed, credential-bearing and non-HTTP source URLs cannot become confirmed absence',async()=>{
  for(const url of ['not a URL','javascript:alert(1)','https://user:secret@example.com/']){
    const observed=state([group([url])]);assert.equal(observed.unresolved,true);assert.deepEqual(observed.sources,[]);
    await assert.rejects(extractChatgptSources({evaluate:async()=>observed},async()=>[]),e=>e.code==='CITATION_EXTRACTION_UNAVAILABLE'&&!String(e).includes('secret'));
  }
});
test('only fully resolved scoped source groups are returned and duplicates collapse',async()=>{
  const observed=state([group(['https://example.com/source']),group(['https://example.com/source'])]);
  assert.equal(observed.unresolved,false);
  const result=await extractChatgptSources({evaluate:async()=>observed},async()=>{throw Error('must not inspect page-wide sources');});
  assert.deepEqual(result,[{url:'https://example.com/source',title:'Evidence source'}]);
});
test('missing, hidden or pending assistant cannot become a source-free observation',async()=>{
  for(const options of [{missing:true},{hidden:true},{pending:true}]){
    const observed=state([],options);assert.equal(observed.found,false);
    await assert.rejects(extractChatgptSources({evaluate:async()=>observed},async()=>[]),{code:'CITATION_EXTRACTION_UNAVAILABLE'});
  }
});
test('recognized response without anonymous source groups keeps legacy source extraction',async()=>{
  const page={evaluate:async()=>state([])};let calls=0;
  assert.deepEqual(await extractChatgptSources(page,async actual=>{calls++;assert.equal(actual,page);return [{url:'https://legacy.example/source'}];}),[{url:'https://legacy.example/source'}]);
  assert.equal(calls,1);
  await assert.rejects(extractChatgptSources(page,async()=>{throw Error('legacy unavailable');}),/legacy unavailable/);
});
test('source-free anonymous response never falls back to old page-wide citation controls',async()=>{
  let called=0;
  const page={evaluate:async()=>({found:true,anonymous:true,groups:0,unresolved:false,sources:[]})};
  assert.deepEqual(await extractChatgptSources(page,async()=>{called++;return [{url:'https://old.example/'}];}),[]);
  assert.equal(called,0);
});

function controlledPanel({result={status:'unavailable'},clickError,hasButton=true}={}){
  const calls={clicks:0,polls:0,waits:0,disposed:0};
  const page={evaluate:async()=>({found:true,anonymous:true,unresolved:true,panelEligible:true}),
    evaluateHandle:async(fn,input)=>{
      assert.equal(fn,readChatgptCitationState);assert.equal(input.prepare,true);
      return {getProperty:async name=>{assert.equal(name,'button');return {asElement:()=>hasButton?{click:async options=>{assert.deepEqual(options,{timeout:3000});calls.clicks++;if(clickError)throw clickError;}}:null,dispose:async()=>{calls.disposed++;}};},
        evaluate:async fn=>fn({inspect:()=>{calls.polls++;return result;}}),dispose:async()=>{calls.disposed++;}};
    },waitForTimeout:async ms=>{assert.equal(ms,250);calls.waits++;}};
  return {page,calls};
}
test('controlled panel makes one normal bounded click and preserves full live URLs',async()=>{
  const source={url:'https://example.com/source?ref=answer#cited-section',title:'Cited title'};
  const h=controlledPanel({result:{status:'resolved',sources:[source,source]}});
  assert.deepEqual(await extractChatgptSources(h.page,async()=>{throw Error('must not use global fallback');}),[source]);
  assert.deepEqual(h.calls,{clicks:1,polls:3,waits:2,disposed:2});
});
test('pointer failure is secret-safe and never triggers force, fallback or another click',async()=>{
  const h=controlledPanel({clickError:Error('credential-sentinel')});
  await assert.rejects(extractChatgptSources(h.page,async()=>[]),e=>e.code==='CITATION_EXTRACTION_UNAVAILABLE'&&!String(e).includes('credential-sentinel')&&!e.cause);
  assert.deepEqual(h.calls,{clicks:1,polls:0,waits:0,disposed:2});
});
test('unavailable controlled panel stops immediately; render polling has a finite bound',async()=>{
  for(const status of ['unavailable','pending']){
    const h=controlledPanel({result:{status}});
    await assert.rejects(extractChatgptSources(h.page,async()=>[]),{code:'CITATION_EXTRACTION_UNAVAILABLE'});
    assert.equal(h.calls.clicks,1);assert.equal(h.calls.disposed,2);
    assert.equal(h.calls.polls,status==='pending'?12:1);assert.equal(h.calls.waits,status==='pending'?12:0);
  }
});
test('missing verified footer handle refuses interaction and still disposes handles',async()=>{
  const h=controlledPanel({hasButton:false});
  await assert.rejects(extractChatgptSources(h.page,async()=>[]),{code:'CITATION_EXTRACTION_UNAVAILABLE'});
  assert.deepEqual(h.calls,{clicks:0,polls:0,waits:0,disposed:2});
});
