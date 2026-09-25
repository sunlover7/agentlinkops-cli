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

test('unrecognized anonymous controls are counted by tag and sanitized role, never content', async () => {
  const el = (tagName, role = null) => ({ tagName, getAttribute: key => key === 'role' ? role : null, href: 'https://secret.example/token', textContent: 'page text' });
  const kept = el('BUTTON'); const strays = [el('A'), el('A'), el('SUP'), el('DIV', 'button'), el('SPAN', 'Evil Role<script>'), kept];
  const extra = Array.from({ length: 12 }, (_, i) => el(`X${i}`));
  const root = { isConnected: true, getBoundingClientRect: () => ({ width: 600, height: 300 }), matches: () => true, getAttribute: () => null,
    innerText: 'A fixture assistant answer with enough text to qualify as a scoped response.',
    querySelector: selector => { assert.equal(selector, '[role="group"][aria-label="Response actions"]'); return { contains: node => node === kept }; },
    querySelectorAll: selector => selector === '[role="group"][aria-label="Sources"]' ? [] : [...strays, ...extra] };
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  globalThis.HTMLElement = class { static [Symbol.hasInstance](value) { return typeof value?.getBoundingClientRect === 'function'; } };
  globalThis.document = { querySelectorAll: () => [root] };
  globalThis.window = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  let result;
  try { result = readChatgptCitationState(PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt); }
  finally { for (const key of ['document', 'window', 'HTMLElement']) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key]; } }
  assert.equal(result.unresolved, true); assert.equal(result.panelEligible, false);
  assert.deepEqual(Object.entries(result.strayKinds).slice(0, 4), [['a', 2], ['sup', 1], ['div[button]', 1], ['span[other]', 1]]);
  assert.equal(Object.keys(result.strayKinds).length, 10, 'at most ten kinds; the response-actions button is excluded');
  assert.ok(!JSON.stringify(result.strayKinds).match(/secret|token|page text|script/));

  const page = { evaluate: async () => ({ found: true, anonymous: true, groups: 0, unresolved: true, panelEligible: false, sources: [], strayKinds: { a: 2, sup: 1 } }) };
  await assert.rejects(extractChatgptSources(page, async () => []), error => error.code === 'CITATION_EXTRACTION_UNAVAILABLE' && error.strayKinds.a === 2 && error.strayKinds.sup === 1);
});

test('a ChatGPT failure message in the assistant turn is not an answer', async () => {
  const { isChatgptFailureMessage } = await import('../src/citations/browser/chatgpt-citations.js');
  const observed = '#### ChatGPT said:\n\nSomething went wrong. If this issue persists please contact us through our help center at help.openai.com.';
  assert.equal(isChatgptFailureMessage(observed), true, 'the exact turn recorded on 2026-09-25');
  assert.equal(isChatgptFailureMessage('There was an error generating a response'), true);
  assert.equal(isChatgptFailureMessage("You've reached our limit of messages per hour."), true);
  const quoting = `Backlink monitoring tracks links to your site. If something went wrong with a link, you find out. ${'Detail. '.repeat(60)}`;
  assert.equal(isChatgptFailureMessage(quoting), false, 'a real answer that mentions a failure is kept');
  assert.equal(isChatgptFailureMessage(`Something went wrong. ${'More text. '.repeat(50)}`), false, 'long turns are never treated as failures');
  assert.equal(isChatgptFailureMessage(''), false); assert.equal(isChatgptFailureMessage(null), false);
});

function payloadAnswer({ inlinePayload, groupPayload, extra = false }) {
  const node = extra => ({ isConnected: true, getBoundingClientRect: () => ({ width: 30, height: 20 }), parentElement: null, hidden: false, ...extra });
  const button = (payload, extra = {}) => node({ tagName: 'BUTTON', closest: () => null, getAttribute: key => (key === 'data-assistant-sources-payload' ? payload : key === 'aria-label' ? extra.label ?? null : null), ...extra });
  const inline = [button(inlinePayload), button(JSON.stringify([{ attribution: 'semrush.com', title: 'Semrush', url: 'https://www.semrush.com/?utm_source=chatgpt.com' }]))];
  const pill = button(groupPayload, { label: 'Ahrefs, 2 sources' });
  const copy = node({ tagName: 'BUTTON', closest: selector => (selector === 'pre' ? {} : null), getAttribute: () => null });
  const table = node({ tagName: 'BUTTON', closest: () => null, getAttribute: key => (key === 'data-table-copy-state' ? 'idle' : key === 'aria-label' ? 'Copy table' : null) });
  const entity = node({ tagName: 'BUTTON', closest: () => null, getAttribute: key => ({ 'data-content-reference-type': 'entity', 'data-assistant-entity-reference': '', 'data-assistant-entity-payload': '{"category":"company"}' })[key] ?? null });
  const unknownControl = node({ tagName: 'BUTTON', closest: () => null, getAttribute: key => (key === 'data-content-reference-type' ? 'carousel' : null) });
  const group = node({ getAttribute: () => null, contains: el => el === pill,
    querySelectorAll: selector => (selector === 'a[href]' ? [] : [pill]), querySelector: selector => (selector === 'button, [role="button"]' ? pill : null) });
  const root = node({ matches: () => true, innerText: 'A fixture assistant answer with enough text to qualify as a scoped response.', getAttribute: () => null,
    querySelector: () => ({ contains: () => false }),
    querySelectorAll: selector => selector === '[role="group"][aria-label="Sources"]' ? [group] : selector === '[data-assistant-sources-payload]' ? [...inline, pill] : [...inline, pill, copy, table, entity, ...(extra ? [unknownControl] : [])] });
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  globalThis.HTMLElement = class { static [Symbol.hasInstance](value) { return typeof value?.getBoundingClientRect === 'function'; } };
  globalThis.document = { querySelectorAll: () => [root] };
  globalThis.window = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  try { return readChatgptCitationState(PROVIDER_MODEL_RESPONSE_SELECTORS.chatgpt); }
  finally { for (const key of ['document', 'window', 'HTMLElement']) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key]; } }
}
test('current anonymous citations are read from their sources payload; copy and entity controls are not citations', () => {
  const grouped = JSON.stringify([{ attribution: 'Ahrefs', sourceIndex: 0, title: 'Backlinks alerts', url: 'https://ahrefs.com/academy/how-to-use-ahrefs/alerts/backlinks?utm_source=chatgpt.com' },
    { attribution: 'Ahrefs Help Center', isSupporting: true, sourceIndex: 1, title: 'How to monitor', url: 'https://help.ahrefs.com/en/articles/2110721?utm_source=chatgpt.com' }]);
  const state = payloadAnswer({ inlinePayload: JSON.stringify([{ attribution: 'ahrefs.com', title: 'Ahrefs', url: 'https://ahrefs.com/?utm_source=chatgpt.com' }]), groupPayload: grouped });
  assert.equal(state.unresolved, false); assert.deepEqual(state.strayKinds, {});
  assert.deepEqual(state.sources.map(source => new URL(source.url).hostname).sort(), ['ahrefs.com', 'ahrefs.com', 'help.ahrefs.com', 'www.semrush.com']);
  assert.equal(state.sources.find(source => source.url.includes('academy')).title, 'Backlinks alerts');
});
test('a malformed or credential-bearing sources payload leaves the answer unknown', () => {
  const ok = JSON.stringify([{ url: 'https://ahrefs.com/' }]);
  assert.equal(payloadAnswer({ inlinePayload: '[{"url":', groupPayload: ok }).unresolved, true);
  assert.equal(payloadAnswer({ inlinePayload: JSON.stringify([{ url: 'https://user:pass@evil.example/' }]), groupPayload: ok }).unresolved, true);
  assert.equal(payloadAnswer({ inlinePayload: JSON.stringify([{ title: 'no url' }]), groupPayload: ok }).unresolved, true);
  assert.equal(payloadAnswer({ inlinePayload: JSON.stringify([]), groupPayload: ok }).unresolved, true);
});

test('an unrecognized control beside readable payload citations still leaves the answer unknown', () => {
  const ok = JSON.stringify([{ url: 'https://ahrefs.com/' }]);
  const state = payloadAnswer({ inlinePayload: ok, groupPayload: ok, extra: true });
  assert.equal(state.unresolved, true); assert.deepEqual(state.strayKinds, { button: 1 });
});
