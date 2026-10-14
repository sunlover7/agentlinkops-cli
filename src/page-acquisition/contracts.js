import {validatePublicUrl} from '../verifier/url.js';
import {recoveryEligibility} from './policy.js';

export const CAPTURE_VERSION = 1;
export const ACQUISITION_LIMITS = Object.freeze({maxBytes:2*1024*1024,documentBytes:10*1024*1024,robotsBytes:512*1024,maxRedirects:5,timeoutMs:20_000,maxAttempts:4});
export const PURPOSE_PROFILES = Object.freeze({
  placement:Object.freeze({representation:'raw_html',allowAlternate:true,allowRender:true}),
  target:Object.freeze({representation:'raw_html',allowAlternate:true,allowRender:false}),
  research:Object.freeze({representation:'raw_html',allowAlternate:false,allowRender:false}),
  document:Object.freeze({representation:'document',allowAlternate:false,allowRender:false}),
  free:Object.freeze({representation:'raw_html',allowAlternate:false,allowRender:false}),
});
export class PageAcquisitionError extends Error {
  constructor(reason){super(reason);this.name='PageAcquisitionError';this.reason=reason;}
}
const fail=reason=>{throw new PageAcquisitionError(reason);};
const hashPattern=/^[a-f0-9]{64}$/u;
export function boundedAcquisitionLimit(value,fallback,cap){
  if(value===undefined||value===null)return fallback;
  if(typeof value!=='number'||!Number.isFinite(value)||value<1)fail('acquisition_limits_invalid');
  return Math.min(Math.floor(value),cap);
}
const pin=value=>typeof value==='string'&&value.length>0&&value.length<=128&&value.trim()===value&&!/[\x00-\x20\x7f]/u.test(value);
const captureByteLimit=representation=>representation==='document'?ACQUISITION_LIMITS.documentBytes:ACQUISITION_LIMITS.maxBytes;
export async function sha256Bytes(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function decodedDigest(html){return sha256Bytes(new TextEncoder().encode(html));}

export function validateCaptureReceipt(receipt,{finalUrl,allowUnqualified=false}={}){
  if(!receipt||receipt.version!==CAPTURE_VERSION||!['raw_html','rendered_dom','document'].includes(receipt.representation)
    ||!validatePublicUrl(receipt.requestedUrl).valid||!validatePublicUrl(receipt.finalUrl).valid
    ||!Number.isInteger(receipt.httpStatus)||receipt.httpStatus<100||receipt.httpStatus>599
    ||typeof receipt.acquiredAt!=='string'||!Number.isFinite(Date.parse(receipt.acquiredAt))
    ||!receipt.body||typeof receipt.body.complete!=='boolean'||typeof receipt.body.truncated!=='boolean'
    ||!Number.isSafeInteger(receipt.body.bytes)||receipt.body.bytes<0||receipt.body.bytes>captureByteLimit(receipt.representation)||!hashPattern.test(receipt.body.sha256??'')
    ||!hashPattern.test(receipt.body.decodedSha256??'')||!receipt.transport||!pin(receipt.transport.id)
    ||!pin(receipt.transport.version)||typeof receipt.transport.qualified!=='boolean'
    ||(receipt.body.charset!==undefined&&receipt.body.charset!==null&&(typeof receipt.body.charset!=='string'||receipt.body.charset.length>64))
    ||!receipt.coverage||receipt.coverage.mainDocument!==true||typeof receipt.coverage.iframes!=='boolean'
    ||typeof receipt.coverage.shadowRoots!=='boolean')fail('capture_invalid');
  if(finalUrl&&finalUrl!==receipt.finalUrl)fail('capture_source_mismatch');
  if(!receipt.body.complete||receipt.body.truncated)fail('capture_incomplete');
  if(!allowUnqualified&&!receipt.transport.qualified)fail('capture_unqualified');
  if(receipt.body.charset!=null){try{new TextDecoder(receipt.body.charset,{fatal:true});}catch{fail('capture_invalid_charset');}}
  return structuredClone(receipt);
}
export async function validateDecodedCapture(receipt,html){
  const valid=validateCaptureReceipt(receipt);
  if(typeof html!=='string')fail('capture_digest_mismatch');
  const limit=captureByteLimit(valid.representation);
  // Supported legacy decoders cannot produce more UTF-16 units than consumed bytes;
  // their UTF-8 re-encoding can use up to three bytes per unit (e.g. Windows-1252).
  if(html.length>limit)fail('capture_decoded_too_large');
  const bytes=new TextEncoder().encode(html);
  if(bytes.byteLength>limit*3)fail('capture_decoded_too_large');
  if(await sha256Bytes(bytes)!==valid.body.decodedSha256)fail('capture_digest_mismatch');
  return valid;
}

export function acquisitionRouteEligible(results){
  return Array.isArray(results)&&results.length>0&&results.every(r=>recoveryEligibility(r,'node_http').allowed);
}

export function captureCacheKey({workspaceId,projectId,url,representation='raw_html',profileVersion='1',transportVersion,locale='en-US',viewport='none'}){
  if(![workspaceId,projectId,transportVersion].every(x=>typeof x==='string'&&x.length>0)||!validatePublicUrl(url).valid)fail('capture_cache_scope_invalid');
  // Tenant scope and representation are inseparable from artifact identity.
  return JSON.stringify([workspaceId,projectId,url,representation,profileVersion,transportVersion,locale,viewport]);
}
