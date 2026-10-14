import {ACQUISITION_LIMITS,PageAcquisitionError,boundedAcquisitionLimit} from './contracts.js';
import {withAbort} from './bytes.js';
import {recoveryEligibility,acquisitionState as stateOf,completedAcquisition as complete} from './policy.js';
export {recoveryEligibility} from './policy.js';

export const RECOVERY_METHODS = Object.freeze(['workers_http','node_http','node_browser','proxy_http']);
export const RECOVERY_REASONS = Object.freeze(['disabled','not_enrolled','unsupported','not_configured','unqualified','deadline','rate_limit','robots_override','custody_hold','busy','budget_exhausted','scope_revoked','complete','not_needed']);
const METHODS=new Set(RECOVERY_METHODS),REASONS=new Set(RECOVERY_REASONS);
const safeReason=value=>typeof value==='string'&&/^[a-z0-9_:.-]{1,100}$/u.test(value)?value:'acquisition_failed';
const STOP_PRIORITY={scope_revoked:10,deadline:9,rate_limit:8,robots_override:8,custody_hold:7,busy:6,budget_exhausted:6,unqualified:5,not_configured:4,not_enrolled:3,disabled:2,unsupported:1,not_needed:0};
const stop=(trace,reason)=>{if(reason!=='complete'&&(STOP_PRIORITY[reason]??0)>(STOP_PRIORITY[trace.terminationReason]??-1))trace.terminationReason=reason;};
const bodySummary=value=>value?.version===1&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=65536&&typeof value.complete==='boolean'
  &&typeof value.truncated==='boolean'&&/^[a-f0-9]{64}$/u.test(value.sha256??'')&&typeof value.looksLikeHtml==='boolean'
  ?{version:1,bytes:value.bytes,complete:value.complete,truncated:value.truncated,sha256:value.sha256,looksLikeHtml:value.looksLikeHtml}:undefined;
function diagnostics(item){
  const robots=Array.isArray(item.robotsHistory)?item.robotsHistory.slice(0,6).map(row=>({
    httpStatus:Number.isInteger(row?.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599?row.httpStatus:null,
    allowed:typeof row?.allowed==='boolean'?row.allowed:null,reason:row?.reason?safeReason(row.reason):null,
    ...(row?.overrideUsed===true?{overrideUsed:true}:{}),...(bodySummary(row?.bodyDiagnostic)?{bodyDiagnostic:bodySummary(row.bodyDiagnostic)}:{})})):undefined;
  const source=item.sourceResponse;
  return {...(robots?{robotsHistory:robots}:{}),...(source?{sourceResponse:{
    httpStatus:Number.isInteger(source.httpStatus)&&source.httpStatus>=100&&source.httpStatus<=599?source.httpStatus:null,
    contentType:typeof source.contentType==='string'&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(source.contentType)?source.contentType.slice(0,128):null,
    retryAfterSeconds:Number.isFinite(source.retryAfterSeconds)&&source.retryAfterSeconds>=0?Math.min(86400,Math.ceil(source.retryAfterSeconds)):null,
    challenge:source.challenge===true,...(bodySummary(source.bodyDiagnostic)?{bodyDiagnostic:bodySummary(source.bodyDiagnostic)}:{})}}:{})};
}

export function acquisitionBudget({signal,timeoutMs,deadlineAt,clock=Date.now}={}){
  const start=clock();
  if(!Number.isFinite(start)||(deadlineAt!=null&&!Number.isFinite(deadlineAt)))throw new PageAcquisitionError('acquisition_limits_invalid');
  const deadline=Math.min(start+boundedAcquisitionLimit(timeoutMs,ACQUISITION_LIMITS.timeoutMs,ACQUISITION_LIMITS.timeoutMs),deadlineAt??Infinity);
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted||deadline<=start)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,Math.max(0,deadline-start));
  return {signal:controller.signal,deadline,remaining:()=>Math.max(0,deadline-clock()),
    assert(){if(controller.signal.aborted||clock()>=deadline)throw new PageAcquisitionError('timeout');},
    close(){clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}};
}

/** Compact, credential-free diagnostics. Old version-one observations remain readable. */
export function recoverySummary(value){
  if(![1,2].includes(value?.version)||!Array.isArray(value.attempts)||value.attempts.length<1||value.attempts.length>(value.version===1?2:4)||!METHODS.has(value.selectedMethod))return undefined;
  const states=new Set(['present','changed','absent','unknown','source_unavailable','healthy','unavailable','blocked','deferred']);
  const attempts=[];
  for(const item of value.attempts){
    if(!item||!METHODS.has(item.method)||!states.has(item.state)||typeof item.complete!=='boolean'||!Number.isFinite(item.durationMs)||item.durationMs<0||item.durationMs>120000)return undefined;
    attempts.push({method:item.method,state:item.state,complete:item.complete,durationMs:Math.floor(item.durationMs),
      ...(typeof item.reason==='string'&&/^[a-z0-9_:.-]{1,100}$/u.test(item.reason)?{reason:item.reason}:{}),
      ...(value.version===2?diagnostics(item):{})});
  }
  if(value.version===1)return {version:1,selectedMethod:value.selectedMethod,attempts};
  if(!['customer_monitor','discovery','target','research','document','free'].includes(value.purpose)||!Array.isArray(value.routes)||value.routes.length>4
    ||!value.routes.every(r=>r&&METHODS.has(r.method)&&typeof r.available==='boolean'&&typeof r.admitted==='boolean'&&(r.reason===null||REASONS.has(r.reason)))
    ||!(value.terminationReason===null||REASONS.has(value.terminationReason)))return undefined;
  return {version:2,purpose:value.purpose,selectedMethod:value.selectedMethod,attempts,routes:value.routes.map(({method,available,admitted,reason})=>({method,available,admitted,reason})),terminationReason:value.terminationReason};
}

const attempt=(result,method,durationMs)=>({method,durationMs,state:stateOf(result),...(result?.reason?{reason:safeReason(result.reason)}:{}),complete:complete(result),
  ...(result?.robotsHistory?{robotsHistory:structuredClone(result.robotsHistory)}:{}),
  ...(result?.sourceResponse?{sourceResponse:structuredClone(result.sourceResponse)}:{})});
function admission(value,fallback){
  if(value?.available===true)return {available:true,reason:null};
  return {available:false,reason:REASONS.has(value?.reason)?value.reason:fallback};
}

/**
 * Owns the whole recovery ladder, never a deadline per route. Executors preserve their
 * producer's leases, quotas and actual capture receipts; this router grants none of them.
 * A shared source can recover unknown targets without overwriting already observed links.
 */
export async function runRecovery({executeDirect,directFailure,directMethod='workers_http',routes={},authorize=async()=>true,purpose='customer_monitor',options={},clock=Date.now}={}){
  if(typeof executeDirect!=='function')throw new TypeError('A direct acquisition executor is required.');
  if(!['workers_http','node_http'].includes(directMethod))throw new TypeError('A direct HTTP method is required.');
  const owner=acquisitionBudget({...options,clock}),traces=[];let selected,pending=null,directStarted=false;
  const settings=()=>({...options,signal:owner.signal,deadlineAt:owner.deadline,timeoutMs:Math.max(1,owner.remaining())});
  const finish=()=>{
    for(const [i,result] of selected.entries()){
      result.evidence??={};result.evidence.acquisition=traces[i];
      const receipts=Object.values(routes).flatMap(route=>Array.isArray(route?.receipts)?route.receipts:[]);
      if(receipts.length)result.evidence.acquisition.transportReceipts=structuredClone(receipts.slice(0,36));
    }
    return selected;
  };
  try{
    owner.assert();if(!await withAbort(Promise.resolve().then(()=>authorize({beforeDispatch:true})),owner.signal))throw new PageAcquisitionError('acquisition_scope_revoked');
    const started=clock();directStarted=true;selected=await withAbort(Promise.resolve().then(()=>executeDirect(settings())),owner.signal);
    if(!Array.isArray(selected))throw new PageAcquisitionError('acquisition_result_invalid');
    for(const result of selected)traces.push({version:2,purpose,selectedMethod:directMethod,attempts:[attempt(result,directMethod,clock()-started)],
      routes:[{method:directMethod,available:true,admitted:true,reason:null}],terminationReason:null});
    owner.assert();
    if(!await withAbort(Promise.resolve().then(()=>authorize({beforeDispatch:false})),owner.signal))throw new PageAcquisitionError('acquisition_scope_revoked');
    for(const method of ['node_http','node_browser','proxy_http']){
      if(method===directMethod)continue;
      const route=routes[method],cap=admission(route?.capability,typeof route?.execute==='function'?'not_configured':'disabled');
      let status=cap;
      if(cap.available&&typeof route?.execute!=='function')status={available:false,reason:'not_configured'};
      if(status.available&&typeof route?.admit==='function'&&selected.some(value=>recoveryEligibility(value,method).allowed)){
        if(owner.remaining()<=250)status={available:false,reason:'deadline'};
        else status=admission(await withAbort(Promise.resolve().then(()=>route.admit(settings())),owner.signal),'not_enrolled');
      }
      const indices=[];
      for(const [i,result] of selected.entries()){
        const eligibility=recoveryEligibility(result,method);
        const reason=!eligibility.allowed?eligibility.reason:!status.available?status.reason:owner.remaining()<=250?'deadline':null;
        traces[i].routes.push({method,available:status.available,admitted:reason===null,reason});
        if(reason===null)indices.push(i);
        else stop(traces[i],reason);
      }
      if(!indices.length)continue;
      if(!await withAbort(Promise.resolve().then(()=>authorize({beforeDispatch:true})),owner.signal))throw new PageAcquisitionError('acquisition_scope_revoked');
      owner.assert();
      if(owner.remaining()<=250){for(const i of indices){Object.assign(traces[i].routes.at(-1),{admitted:false,reason:'deadline'});stop(traces[i],'deadline');}continue;}
      const at=clock();pending={method,indices,at};
      let next,routeOwner;
      try{
        let routeSettings=settings();
        if(method==='node_browser'&&routes.proxy_http?.capability?.available===true&&typeof routes.proxy_http.execute==='function'){
          const proxyAdmission=typeof routes.proxy_http.admit==='function'?admission(await withAbort(Promise.resolve().then(()=>routes.proxy_http.admit(settings())),owner.signal),'not_enrolled'):{available:true};
          if(proxyAdmission.available){
            const duration=Math.min(10000,owner.remaining()-3000);
            if(duration<=250){for(const i of indices){Object.assign(traces[i].routes.at(-1),{admitted:false,reason:'deadline'});stop(traces[i],'deadline');}pending=null;continue;}
            routeOwner=acquisitionBudget({signal:owner.signal,deadlineAt:Math.min(owner.deadline,clock()+duration),timeoutMs:duration,clock});
            routeSettings={...routeSettings,signal:routeOwner.signal,deadlineAt:routeOwner.deadline,timeoutMs:duration,renderTimeoutMs:duration};
          }
        }
        next=await withAbort(Promise.resolve().then(()=>route.execute(routeSettings,selected,indices)),routeOwner?.signal??owner.signal);
      }catch(error){
        if(error?.reason!=='timeout'||!routeOwner||clock()<routeOwner.deadline||owner.signal.aborted||options.signal?.aborted)throw error;
        next=selected.map((value,i)=>indices.includes(i)?{...value,...(value.state?{state:'unknown'}:{outcome:'unavailable',html:null}),reason:'route_timeout',occurrences:[],
          evidence:{...value.evidence,complete:false,...(method==='node_browser'?{renderAttempt:{attempted:true,reason:'render_timeout'}}:{})}}:value);
      }finally{routeOwner?.close();}
      owner.assert();
      if(!Array.isArray(next)||next.length!==selected.length)throw new PageAcquisitionError('acquisition_result_invalid');
      if(!await withAbort(Promise.resolve().then(()=>authorize({beforeDispatch:false})),owner.signal))throw new PageAcquisitionError('acquisition_scope_revoked');
      owner.assert();
      for(const i of indices){selected[i]=next[i];traces[i].attempts.push(attempt(next[i],method,clock()-at));traces[i].selectedMethod=method;traces[i].terminationReason=null;}
      pending=null;
    }
    return finish();
  }catch(error){
    // A route deadline is an observed inability to finish, never absence. Owner
    // cancellation and producer revocation still reject without publishing a page.
    if(error?.reason!=='timeout'||options.signal?.aborted||clock()<owner.deadline)throw error;
    if(!selected&&typeof directFailure==='function'){
      selected=directFailure('timeout');
      if(!Array.isArray(selected))throw error;
      for(const result of selected)traces.push({version:2,purpose,selectedMethod:directMethod,attempts:[attempt(result,directMethod,0)],
        routes:[{method:directMethod,available:true,admitted:directStarted,reason:'deadline'}],terminationReason:'deadline'});
    }
    if(!selected||traces.length!==selected.length)throw error;
    if(pending)for(const i of pending.indices){
      selected[i]={...selected[i],...(selected[i].state?{state:'unknown'}:{outcome:'unavailable',html:null}),reason:'timeout',occurrences:[],
        evidence:{...selected[i].evidence,complete:false}};
      traces[i].attempts.push(attempt(selected[i],pending.method,clock()-pending.at));traces[i].selectedMethod=pending.method;
    }
    for(const [i,trace] of traces.entries()){
      const completed=complete(selected[i])||['present','absent','healthy','source_unavailable'].includes(stateOf(selected[i]));
      if(!completed)stop(trace,'deadline');
      for(const method of RECOVERY_METHODS.slice(1))if(!trace.routes.some(row=>row.method===method))
        trace.routes.push({method,available:routes[method]?.capability?.available===true,admitted:false,reason:completed?'complete':'deadline'});
    }
    return finish();
  }finally{owner.close();}
}
