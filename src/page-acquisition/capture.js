import {CAPTURE_VERSION} from './contracts.js';

/** Constructed only after the bounded reader has finished and both digests exist. */
export function capturedDocument(result,{requestedUrl,representation='raw_html',transportId='public_http',transportVersion='1',qualified=false,charset=null}={}){
  const evidence=result.evidence;
  if(!evidence||!Number.isSafeInteger(evidence.bytes)||!evidence.sha256||!evidence.decodedSha256)return null;
  return {version:CAPTURE_VERSION,representation,requestedUrl,finalUrl:result.finalUrl,httpStatus:result.httpStatus,
    acquiredAt:evidence.fetchedAt??result.checkedAt,
    body:{complete:true,truncated:false,bytes:evidence.bytes,sha256:evidence.sha256,decodedSha256:evidence.decodedSha256,charset},
    transport:{id:transportId,version:transportVersion,qualified},coverage:{mainDocument:true,iframes:false,shadowRoots:false}};
}
