import {publicFetcher} from '../verifier/fetch.js';
import {ACQUISITION_LIMITS,CAPTURE_VERSION,PageAcquisitionError,sha256Bytes,decodedDigest,boundedAcquisitionLimit,validateCaptureReceipt} from './contracts.js';
import {validatePublicUrl} from '../verifier/url.js';
import {acquisitionBudget,runRecovery} from './recovery.js';
import {verifyRenderedLinks,unknownLinkObservation} from '../verifier/index.js';
import {unknownTargetObservation} from '../verifier/target.js';

const budget=acquisitionBudget;

/** A bounded capture primitive. Owner jobs retain storage, entitlement and verdict authority. */
export function createPageAcquisition({fetchImpl=globalThis.fetch,publicFetchSafe=false,beforeFetch,onRobots,clock=Date.now,userAgentContact='https://agentlinkops.com',transportId='workers_http',transportVersion='1'}={}){
  return {async acquire(url,{signal,timeoutMs=ACQUISITION_LIMITS.timeoutMs,maxBytes=ACQUISITION_LIMITS.maxBytes,deadlineAt=null,document=false,validators=null}={}){
    if(publicFetchSafe!==true)throw new PageAcquisitionError('public_fetch_not_configured');
    const checked=validatePublicUrl(url);if(!checked.valid)throw new PageAcquisitionError(`unsafe_url:${checked.reason}`);
    const byteCap=boundedAcquisitionLimit(maxBytes,ACQUISITION_LIMITS.maxBytes,ACQUISITION_LIMITS.maxBytes);
    const owner=budget({signal,timeoutMs,deadlineAt,clock});
    const trace={finalUrl:checked.url,httpStatus:null,redirects:[]};
    try{
      owner.assert();
      const result=await publicFetcher({fetchImpl,publicFetchSafe,beforeFetch,onRobots,maxBytes:byteCap,userAgentContact},owner.signal).source(checked.url,trace,{document,validators});
      owner.assert();
      if(result.notModified||!result.body)return {...result,trace,capture:null};
      const {body}=result;
      const capture={version:CAPTURE_VERSION,representation:document?'document':'raw_html',requestedUrl:checked.url,finalUrl:trace.finalUrl,httpStatus:trace.httpStatus,
        acquiredAt:new Date(clock()).toISOString(),body:{complete:true,truncated:false,bytes:body.bytes,sha256:await sha256Bytes(body.data??new Uint8Array(0)),decodedSha256:await decodedDigest(body.text),charset:body.charset??null},
        transport:{id:transportId,version:transportVersion,qualified:true},coverage:{mainDocument:true,iframes:false,shadowRoots:false}};
      owner.assert();
      return {...result,trace,capture:validateCaptureReceipt(capture)};
    }catch(error){error.acquisitionTrace=trace;throw error;}finally{owner.close();}
  }};
}

/** One logical observation, with a shared absolute budget across direct and alternate routes. */
export async function verifyWithAcquisition(inputs,options={},{verifyGroup,alternate=null,proxy=null,authorize=async()=>true,recoveryCapabilities={},renderAdmission,proxyAdmission,clock=Date.now}={}){
  const raw=settings=>({...settings,renderPage:undefined,compareRendered:false});
  const transport=(provider,method)=>({capability:recoveryCapabilities[method]??{available:!!provider,reason:'disabled'},receipts:provider?.receipts,
    execute:settings=>verifyGroup(inputs,{...raw(settings),fetchImpl:(url,requestOptions)=>provider.fetch(url,{...requestOptions,deadlineAt:settings.deadlineAt}),
      captureTransport:{id:method,version:'alo-public-node-v1'}})});
  return runRecovery({purpose:options.acquisitionPurpose??'customer_monitor',options,authorize,clock,
    directFailure:reason=>inputs.map(input=>input.sourceUrl===undefined?unknownTargetObservation(input,{now:options.now,reason}):unknownLinkObservation(input,{now:options.now,reason})),
    executeDirect:settings=>verifyGroup(inputs,raw(settings)),routes:{
      node_http:transport(alternate,'node_http'),proxy_http:{...transport(proxy,'proxy_http'),admit:proxyAdmission},
      node_browser:{capability:recoveryCapabilities.node_browser??{available:!!options.renderPage,reason:'disabled'},admit:renderAdmission,
        receipts:options.renderPage?.receipts,execute:async(settings,previous,indices)=>{
          const observed=await verifyRenderedLinks(indices.map(i=>inputs[i]),indices.map(i=>previous[i]),settings);
          const next=[...previous];indices.forEach((index,i)=>{next[index]=observed[i];});return next;
        }},
    }});
}
