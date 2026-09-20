import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {createBrowserEngine} from '../src/citations/browser/engine.js';
import {createProxyAdmission,createUrlProxySupplier,parseProxyUrl} from '../src/citations/browser/proxy-admission.js';
const secret='fixture-private-proxy-password';
const proxyUrl='http://fixture-user:'+secret+'@gateway.example:8080';
function fixture({env={},supplier,runError,launchError,eventError,receiptError}={}){
 let now=Date.parse('2026-09-20T00:00:00Z'),meter=0;
 const calls={launch:[],resolve:[],release:[],quarantine:[],acquire:0,events:[],receipts:[],contextClose:0,browserClose:0,displayClose:0};
 supplier??={async acquire(){calls.acquire++;return {id:'lease_'+calls.acquire,proxyUrl,expiresAt:new Date(now+1000).toISOString()};},async release(value){calls.release.push(value);},async quarantine(value){calls.quarantine.push(value);},async readMeter(){meter+=100;return {bytes:meter,costMicrousd:meter*2};}};
 const config={navigateToPrompt:async()=>{if(runError)throw runError;},waitForResponse:async()=>{},extractResponse:async()=> 'A fixture answer with enough source evidence text for this test.',extractSources:async()=>[]};
 const browser={async newContext(){return {route:async()=>{},close:async()=>{calls.contextClose++;},newPage:async()=>({setDefaultTimeout(){},screenshot:async()=>Buffer.from('fixture')})};},async close(){calls.browserClose++;if(runtime.browserCleanup)await runtime.browserCleanup();}};
 const runtime={proxySupplier:env.AGENTLINKOPS_BROWSER_EGRESS==='direct-diagnostic'?undefined:supplier,now:()=>now,supplierTimeoutMs:20,cleanupTimeoutMs:20,platform:'linux',onEgressReceipt:async row=>{calls.receipts.push(row);if(receiptError)throw Error(secret);},firefox:{async launch(options){calls.launch.push(options);if(launchError)throw launchError;return browser;}},async loadModule(path){
  if(path.endsWith('/providers/index.js'))return {PROVIDER_CONFIGS:{chatgpt:config}};
  if(path==='./providers.js')return {OWN_PROVIDER_CONFIGS:{}};
  if(path.endsWith('/domOps.js'))return {runPageDomOp:async()=>''};
  if(path.endsWith('/camoufox.js'))return {resolveCamoufoxLaunchOptions:async options=>{calls.resolve.push(options);if(runtime.prepare)await runtime.prepare();return {executablePath:'/fixture/firefox'};}};
  if(path.endsWith('/display.js'))return {detectDisplay:()=>false,ensureDisplay:async()=>({display:':992',cleanup:async()=>{calls.displayClose++;if(runtime.displayCleanup)await runtime.displayCleanup();}})};
  if(path==='node:fs/promises')return {readFile:async()=>{throw Error('no saved session');}};
  throw Error('Unexpected fixture module');
 }};
 const engine=createBrowserEngine({engineName:'chatgpt',env,runtime,onEvent:async value=>{calls.events.push(value);if(eventError==='hang')await new Promise(()=>{});if(eventError)throw Error(secret);}});
 return {engine,calls,supplier,browser,runtime,advance:ms=>{now+=ms;}};
}
const code=(promise,expected)=>assert.rejects(promise,error=>error.code===expected&&!error.message.includes(secret));

test('missing proxy denies before any module, display, browser or supplier work; explicit direct diagnostic works',async()=>{
 let loads=0;const engine=createBrowserEngine({engineName:'chatgpt',env:{},runtime:{loadModule:async()=>{loads++;throw Error('unexpected');}}});
 await code(engine.run({prompt:'fixture'}),'PROXY_REQUIRED');assert.equal(loads,0);
 const f=fixture({env:{AGENTLINKOPS_BROWSER_EGRESS:'direct-diagnostic'}});
 const result=await f.engine.run({prompt:'fixture'});assert.equal(f.calls.acquire,0);assert.equal(f.calls.launch[0].proxy,undefined);assert.equal(result.egressReceipt.egress,'direct-diagnostic');await f.engine.close();
 const direct=createProxyAdmission({engine:'chatgpt',env:{AGENTLINKOPS_BROWSER_EGRESS:'direct-diagnostic'}});await direct.begin();assert.equal(direct.proxy,undefined);
 const receipt=await direct.record({outcome:'unknown'});assert.equal(receipt.egress,'direct-diagnostic');assert.equal(receipt.meterState,'not_applicable');assert.equal(receipt.bytes,null);
 assert.throws(()=>createProxyAdmission({engine:'chatgpt',env:{AGENTLINKOPS_BROWSER_EGRESS:'direct-diagnostic',AGENTLINKOPS_PROXY_URL:proxyUrl}}),/cannot also/);
});

test('supplier lease is pinned into launch; epoch reuse, expiry relaunch and cumulative metering stay exact',async()=>{
 const f=fixture();const first=await f.engine.run({prompt:'fixture'});const second=await f.engine.run({prompt:'fixture'});
 assert.equal(f.calls.launch.length,1);assert.equal(f.calls.acquire,1);assert.equal(first.egressReceipt.bytes,100);assert.equal(second.egressReceipt.costMicrousd,200);
 assert.deepEqual(f.calls.launch[0].proxy,{server:'http://gateway.example:8080',username:'fixture-user',password:secret});
 f.advance(1001);await f.engine.run({prompt:'fixture'});assert.equal(f.calls.acquire,2);assert.equal(f.calls.launch.length,2);assert.equal(f.calls.release.length,1);
 await f.engine.close();assert.equal(f.calls.release.length,2);assert.equal(f.calls.browserClose,2);assert.equal(f.calls.displayClose,2);
 assert.ok(f.engine.getEgressReceipts().every(r=>r.meterState==='measured'));
 const safe=JSON.stringify(f.engine.getEgressReceipts())+f.calls.events.join('');assert.ok(!safe.includes(secret));assert.ok(!safe.includes('gateway.example'));assert.ok(!safe.includes('fixture-user'));
 const copy=f.engine.getEgressReceipts();copy[0].bytes=999;assert.equal(f.engine.getEgressReceipts()[0].bytes,100);
});

test('blocked provider quarantines and releases once; admission never falls back to direct or retries it',async()=>{
 const f=fixture({runError:Object.assign(Error(secret),{status:403})});await assert.rejects(f.engine.run({prompt:'fixture'}));
 assert.equal(f.calls.quarantine.length,1);assert.equal(f.calls.quarantine[0].reason,'blocked');assert.equal(f.calls.release.length,1);assert.equal(f.calls.browserClose,1);
 await code(f.engine.run({prompt:'retry'}),'PROXY_CUSTODY_UNAVAILABLE');assert.equal(f.calls.acquire,1);assert.equal(f.calls.launch.length,1);await f.engine.close();
});

test('generic extraction/setup failures are not invented blocks and close browser/display plus lease',async()=>{
 for(const options of [{runError:Error(secret)},{launchError:Error(secret)},{eventError:true}]){
  const f=fixture(options);await assert.rejects(f.engine.run({prompt:'fixture'}),error=>!error.message.includes(secret));
  assert.equal(f.calls.quarantine.length,0);assert.equal(f.calls.release.length,1);assert.equal(f.calls.displayClose,1);await f.engine.close();
 }
});

test('supplier, quarantine, release and receipt callback errors stay secret-safe and stop reuse',async()=>{
 const f=fixture();f.supplier.acquire=async()=>{throw Error(secret);};await code(f.engine.run({prompt:'fixture'}),'PROXY_ACQUIRE_FAILED');assert.equal(f.calls.launch.length,0);await code(f.engine.run({prompt:'retry'}),'PROXY_CUSTODY_UNAVAILABLE');
 const g=fixture({runError:Object.assign(Error('blocked'),{status:429})});g.supplier.quarantine=async()=>{throw Error(secret);};await code(g.engine.run({prompt:'fixture'}),'PROXY_QUARANTINE_FAILED');assert.equal(g.calls.release.length,1);assert.equal(g.calls.browserClose,1);
 const h=fixture();await h.engine.run({prompt:'fixture'});h.supplier.release=async()=>{throw Error(secret);};await code(h.engine.close(),'PROXY_RELEASE_FAILED');await code(h.engine.run({prompt:'retry'}),'PROXY_CUSTODY_UNAVAILABLE');
 const j=fixture({receiptError:true});await code(j.engine.run({prompt:'fixture'}),'PROXY_RECEIPT_FAILED');assert.equal(j.calls.release.length,1);assert.equal(j.calls.browserClose,1);assert.equal(j.engine.getEgressReceipts().length,2);
});

test('invalid/expired leases are released without browser launch; timed-out acquisition is retired when it arrives',async()=>{
 for(const lease of [{id:'bad',proxyUrl:'file:///secret',expiresAt:'2099-01-01T00:00:00Z'},{id:'old',proxyUrl,expiresAt:'2000-01-01T00:00:00Z'}]){
  const f=fixture();f.supplier.acquire=async()=>lease;await code(f.engine.run({prompt:'fixture'}),'PROXY_LEASE_INVALID');assert.equal(f.calls.launch.length,0);assert.equal(f.calls.release.length,1);
 }
 const f=fixture();let resolve;f.supplier.acquire=()=>new Promise(done=>{resolve=done;});await code(f.engine.run({prompt:'fixture'}),'PROXY_ACQUIRE_FAILED');
 resolve({id:'late',proxyUrl,expiresAt:'2099-01-01T00:00:00Z'});await new Promise(done=>setTimeout(done,1));assert.equal(f.calls.release.length,1);assert.equal(f.calls.launch.length,0);
});

test('absent, malformed, reset or failed meters remain unavailable rather than nominal dollars or zero',async()=>{
 for(const readMeter of [undefined,async()=>{throw Error(secret);},async()=>({bytes:-1,costMicrousd:0}),async()=>({bytes:10,costMicrousd:'0.03'})]){
  const f=fixture();f.supplier.readMeter=readMeter;const result=await f.engine.run({prompt:'fixture'});assert.equal(result.egressReceipt.meterState,'unavailable');assert.equal(result.egressReceipt.bytes,null);assert.equal(result.egressReceipt.costMicrousd,null);assert.equal(result.costEstimateUsd,0.03);await f.engine.close();
 }
 const f=fixture();let bytes=200;f.supplier.readMeter=async()=>({bytes:bytes-=100});const result=await f.engine.run({prompt:'fixture'});assert.equal(result.egressReceipt.meterState,'unavailable');await f.engine.close();
});

test('generic URL supplier does not invent a meter and quarantines the endpoint within its process',async()=>{
 let now=0;const supplier=createUrlProxySupplier({url:proxyUrl,now:()=>now});const lease=await supplier.acquire({engine:'fixture'});assert.equal(supplier.readMeter,undefined);await supplier.quarantine({engine:'fixture',leaseId:lease.id});await code(supplier.acquire({engine:'fixture'}),'PROXY_QUARANTINED');now=600001;await supplier.acquire({engine:'fixture'});
 for(const raw of ['http://proxy/a','http://proxy/?password='+secret,'ftp://proxy:12','not a URL','socks5://proxy'])assert.throws(()=>parseProxyUrl(raw),error=>!error.message.includes(secret));
 assert.deepEqual(parseProxyUrl('http://proxy.example'),{server:'http://proxy.example'});
});

test('overlapping samples and close cannot race lease ownership; a known proxy launch error quarantines',async()=>{
 const f=fixture(),first=f.engine.run({prompt:'fixture'});
 await code(f.engine.run({prompt:'overlap'}),'BROWSER_RUN_IN_PROGRESS');await code(f.engine.close(),'BROWSER_RUN_IN_PROGRESS');
 await first;assert.equal(f.calls.acquire,1);assert.equal(f.calls.launch.length,1);await f.engine.close();assert.equal(f.calls.release.length,1);
 const g=fixture({launchError:Error('net::ERR_PROXY_CONNECTION_FAILED '+secret)});await assert.rejects(g.engine.run({prompt:'fixture'}),error=>!error.message.includes(secret));assert.equal(g.calls.quarantine.length,1);assert.equal(g.calls.quarantine[0].reason,'connection_error');assert.equal(g.calls.release.length,1);
});

test('close owns the lock through cleanup and supplier release',async()=>{
 const f=fixture();await f.engine.run({prompt:'fixture'});let finish;
 f.runtime.browserCleanup=()=>new Promise(resolve=>{finish=resolve;});
 const closing=f.engine.close();await Promise.resolve();await Promise.resolve();
 await code(f.engine.run({prompt:'overlap'}),'BROWSER_RUN_IN_PROGRESS');await code(f.engine.close(),'BROWSER_RUN_IN_PROGRESS');
 finish();await closing;assert.equal(f.calls.release.length,1);assert.equal(f.calls.browserClose,1);
});

test('unconfirmed display/browser cleanup is bounded, quarantined, released with uncertainty and blocks reuse',{timeout:1000},async()=>{
 for(const component of ['displayCleanup','browserCleanup'])for(const hanging of [true,false]){
  const f=fixture();await f.engine.run({prompt:'fixture'});
  f.runtime[component]=()=>hanging?new Promise(()=>{}):Promise.reject(Error(secret));
  await code(f.engine.close(),'BROWSER_CLEANUP_UNCONFIRMED');assert.equal(f.calls.quarantine[0].reason,'cleanup_unconfirmed');assert.equal(f.calls.release[0].disposition,'quarantined');
  const receipt=f.engine.getEgressReceipts().at(-1);assert.equal(receipt.outcome,'cleanup_unconfirmed');assert.equal(receipt.meterState,'incomplete');
  await code(f.engine.run({prompt:'retry'}),'PROXY_CUSTODY_UNAVAILABLE');assert.equal(f.calls.launch.length,1);
 }
});

test('hanging event reporting is bounded and inspect(error) never reveals provider or callback secrets',{timeout:1000},async()=>{
 for(const options of [{eventError:'hang'},{runError:Error(secret)},{launchError:Error(secret)},{receiptError:true}]){
  const f=fixture(options);await assert.rejects(f.engine.run({prompt:'fixture'}),error=>!inspect(error).includes(secret));assert.equal(f.calls.release.length,1);
 }
});

test('meter or launch preparation cannot admit a lease that expired during awaits',async()=>{
 const f=fixture();f.supplier.readMeter=async()=>{f.advance(1001);return {bytes:0,costMicrousd:0};};
 await code(f.engine.run({prompt:'fixture'}),'PROXY_LEASE_EXPIRED');assert.equal(f.calls.launch.length,0);assert.equal(f.calls.release.length,1);
 const g=fixture();g.runtime.prepare=async()=>{g.advance(1001);};
 await code(g.engine.run({prompt:'fixture'}),'PROXY_LEASE_EXPIRED');assert.equal(g.calls.launch.length,0);assert.equal(g.calls.release.length,1);
});

test('failure and lease-expiry retirement retain the final measured cleanup interval',async()=>{
 const f=fixture({runError:Error('fixture failure')});await assert.rejects(f.engine.run({prompt:'fixture'}));assert.equal(f.engine.getEgressReceipts().at(-1).phase,'failure_cleanup');assert.equal(f.engine.getEgressReceipts().at(-1).bytes,100);
 const g=fixture();await g.engine.run({prompt:'fixture'});g.advance(1001);await g.engine.run({prompt:'fixture'});assert.ok(g.engine.getEgressReceipts().some(row=>row.phase==='lease_expiry'&&row.bytes===100));await g.engine.close();
});
