// Local proxy custody. Supplier callbacks perform no work until browser admission.
// Meter values are supplier-observed cumulative counters, never nominal estimates.
import {createHash,randomUUID} from 'node:crypto';
import {EngineError} from '../adapter.js';
const digest=value=>createHash('sha256').update(value).digest('hex');
const quarantines=new Map();
const safeInteger=value=>Number.isSafeInteger(value)&&value>=0;
const failure=(code,message)=>Object.assign(new EngineError(message),{code});
export function parseProxyUrl(raw){
 try{
  if(typeof raw!=='string'||raw.length>8192)throw Error();
  const url=new URL(raw);
  if(!['http:','https:','socks5:'].includes(url.protocol)||!url.hostname||url.search||url.hash||(url.pathname&&url.pathname!=='/')||(url.protocol==='socks5:'&&!url.port))throw Error();
  const username=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
  if(/[\r\n\0]/.test(username+password))throw Error();
  return {server:`${url.protocol}//${url.hostname}${url.port?':'+url.port:''}`,...(username?{username}:{}),...(password?{password}:{})};
 }catch{throw failure('PROXY_CONFIGURATION_INVALID','The browser proxy configuration is invalid.');}
}
export function createUrlProxySupplier({url,now=()=>Date.now()}={}){
 const key=typeof url==='string'?digest(url):null;
 return {
  async acquire({engine}){
   if(!url)throw failure('PROXY_REQUIRED','Configure a proxy before browser measurement, or explicitly select direct-diagnostic egress.');
   parseProxyUrl(url);
   if((quarantines.get(engine+key)??0)>now())throw failure('PROXY_QUARANTINED','The browser proxy is quarantined.');
   return {id:randomUUID(),proxyUrl:url,expiresAt:new Date(now()+10*60*1000).toISOString()};
  },
  async quarantine({engine,reason}){quarantines.set(engine+key,reason==='cleanup_unconfirmed'?Infinity:now()+10*60*1000);},
  async release(){},
 };
}
// Only explicit structured signals identify a block. Empty answers/selector errors
// do not establish a proxy problem, and arbitrary exception text is never retained.
export function proxyFailureReason(error){
 for(const value of [error,error?.cause]){
  if(value?.status===403||value?.failureType==='bot_detection')return 'blocked';
  if(value?.status===429||value?.failureType==='rate_limited')return 'rate_limited';
  if(['ERR_PROXY_CONNECTION_FAILED','ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(value?.code)||value?.failureType==='connection_error'||/\bERR_PROXY_CONNECTION_FAILED\b/.test(String(value?.message??'')))return 'connection_error';
 }
 return null;
}
export function createProxyAdmission({engine,env={},supplier,now=()=>Date.now(),onReceipt=()=>{},timeoutMs=5000}={}){
 const mode=env.AGENTLINKOPS_BROWSER_EGRESS??'proxy-required';
 if(!['proxy-required','direct-diagnostic'].includes(mode))throw failure('PROXY_POLICY_INVALID','Choose proxy-required or direct-diagnostic browser egress.');
 if(mode==='direct-diagnostic'&&(supplier||env.AGENTLINKOPS_PROXY_URL))throw failure('PROXY_POLICY_CONFLICT','Direct diagnostics cannot also configure a proxy.');
 const injected=Boolean(supplier);
 supplier??=createUrlProxySupplier({url:env.AGENTLINKOPS_PROXY_URL,now});
 let lease=null,baseline=null,poisoned=false;const receipts=[];
 async function bounded(action,code){
  let timer;
  try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error()),timeoutMs);})]);}
  catch{throw failure(code,'Browser proxy custody failed. No direct fallback was attempted.');}
  finally{clearTimeout(timer);}
 }
 async function meter(){
  if(!lease||typeof supplier.readMeter!=='function')return null;
  try{
   const value=await bounded(()=>supplier.readMeter({engine,leaseId:lease.id}),'PROXY_METER_UNAVAILABLE');
   if(!value||!safeInteger(value.bytes)||!(value.costMicrousd===null||value.costMicrousd===undefined||safeInteger(value.costMicrousd)))return null;
   return {bytes:value.bytes,costMicrousd:value.costMicrousd??null};
  }catch{return null;}
 }
 async function release(){
  if(!lease)return;
  const previous=lease;lease=null;baseline=null;
  try{await bounded(()=>supplier.release({engine,leaseId:previous.id,disposition:poisoned?'quarantined':'clean'}),'PROXY_RELEASE_FAILED');}
  catch(error){poisoned=true;throw error;}
 }
 return {
  get proxy(){return lease?.proxy;},
  get expired(){return lease&&Date.parse(lease.expiresAt)<=now();},
  assertReady(){
   if(poisoned)throw failure('PROXY_CUSTODY_UNAVAILABLE','Browser proxy custody needs operator review.');
   if(mode==='proxy-required'&&(!lease||Date.parse(lease.expiresAt)<=now()))throw failure('PROXY_LEASE_EXPIRED','The browser proxy lease has expired.');
  },
  async begin(){
   if(poisoned)throw failure('PROXY_CUSTODY_UNAVAILABLE','Browser proxy custody needs operator review.');
   if(mode==='direct-diagnostic')return;
   if(!injected&&!env.AGENTLINKOPS_PROXY_URL)throw failure('PROXY_REQUIRED','Configure a proxy before browser measurement, or explicitly select direct-diagnostic egress.');
   if(lease){if(Date.parse(lease.expiresAt)<=now())throw failure('PROXY_LEASE_EXPIRED','The browser proxy lease has expired.');return;}
   if(!['acquire','release','quarantine'].every(name=>typeof supplier?.[name]==='function'))throw failure('PROXY_SUPPLIER_INVALID','The browser proxy supplier is incomplete.');
   let acquired;
   const acquiring=Promise.resolve().then(()=>supplier.acquire({engine}));
   try{acquired=await bounded(()=>acquiring,'PROXY_ACQUIRE_FAILED');}
   catch(error){
    poisoned=true;
    // A timed-out acquisition can resolve later; retire that lease without launching.
    acquiring.then(value=>{if(typeof value?.id==='string')return bounded(()=>supplier.release({engine,leaseId:value.id}),'PROXY_RELEASE_FAILED');}).catch(()=>{});
    throw error;
   }
   try{
    if(!acquired||typeof acquired.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(acquired.id)||typeof acquired.expiresAt!=='string'||!Number.isFinite(Date.parse(acquired.expiresAt))||Date.parse(acquired.expiresAt)<=now())throw Error();
    lease={id:acquired.id,expiresAt:acquired.expiresAt,proxy:parseProxyUrl(acquired.proxyUrl)};
   }catch{
    poisoned=true;
    if(acquired&&typeof acquired.id==='string')await bounded(()=>supplier.release({engine,leaseId:acquired.id}),'PROXY_RELEASE_FAILED').catch(()=>{});
    throw failure('PROXY_LEASE_INVALID','The browser proxy lease is invalid.');
   }
   baseline=await meter();
   if(Date.parse(lease.expiresAt)<=now()){poisoned=true;await release();throw failure('PROXY_LEASE_EXPIRED','The browser proxy lease has expired.');}
  },
  async record({outcome,reason=null,phase='sample'}){
   const current=await meter(),valid=baseline&&current&&current.bytes>=baseline.bytes;
   const bytes=valid?current.bytes-baseline.bytes:null;
   const costMicrousd=valid&&baseline.costMicrousd!==null&&current.costMicrousd!==null&&current.costMicrousd>=baseline.costMicrousd?current.costMicrousd-baseline.costMicrousd:null;
   const row=Object.freeze({version:1,sequence:receipts.length+1,engine,egress:mode,phase,outcome,reason,leaseHash:lease?digest(lease.id):null,observedAt:new Date(now()).toISOString(),meterState:outcome==='cleanup_unconfirmed'?'incomplete':mode==='direct-diagnostic'?'not_applicable':bytes===null?'unavailable':costMicrousd===null?'bytes_only':'measured',bytes,costMicrousd});
   baseline=current;receipts.push(row);
   try{await bounded(()=>onReceipt({...row}),'PROXY_RECEIPT_FAILED');}catch(error){poisoned=true;throw error;}
   return {...row};
  },
  async quarantine(reason){
   // Stop this engine instance even if an external supplier cannot quarantine.
   poisoned=true;
   if(!lease)return;
   await bounded(()=>supplier.quarantine({engine,leaseId:lease.id,reason}),'PROXY_QUARANTINE_FAILED');
  },
  release,
  receipts:()=>receipts.map(row=>({...row})),
 };
}
