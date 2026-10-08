// Offline frozen chronology export. No hosted store, authentication, network or
// collection dependency belongs in the customer's CLI export closure.
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{name:'ChronologyExportError',status,code});};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const validIdentity=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const id=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\s\x00-\x1f\x7f]/u.test(v);
 const url=v=>{if(typeof v!=='string'||!v||v.length>4096)return false;try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
 return ['workspaceId','projectId','watchId'].every(k=>id(value[k]))&&url(value.sourceUrl)&&url(value.targetUrl)
  &&['exact','domain','subdomain','path'].includes(value.targetScope)&&(value.targetId===null||id(value.targetId))
  &&(value.localReference===null||typeof value.localReference==='string'&&value.localReference.length<=2048)
  &&value.matchBasis==='configured_target_url';
};
const compare=(a,b)=>a.sortAt>b.sortAt?-1:a.sortAt<b.sortAt?1:a.id>b.id?-1:a.id<b.id?1:0;
const sha256=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const baseItem=(stream,row,identity,observedAt,recordedAt,kind)=>({id:`${stream}:${row.id}`,rawId:row.id,stream,kind,identity,observedAt:iso(observedAt),recordedAt:iso(recordedAt),sortAt:iso(observedAt)??iso(recordedAt),state:null,reason:null,sourceKey:null,method:null,checkerVersion:null,evidence:{sha256:null,reference:null,expiresAt:null,availability:'not_checked'},data:{}});

// Export only a supplied frozen dataset. This function never reads current DB
// state or fills a missing origin with today's projection.
export async function freezeChronology(pages,{localItems=[]}={}){
 if(!Array.isArray(pages)||!pages.length||pages.length>10000||!Array.isArray(localItems)||localItems.length>10000)fail(400,'INVALID_CHRONOLOGY_EXPORT','Provide bounded chronology pages.');
 const first=pages[0];if(!validIdentity(first?.identity)||iso(first?.asOf)!==first.asOf||!/^[a-f0-9]{64}$/.test(first?.snapshotId??''))fail(400,'INVALID_CHRONOLOGY_EXPORT','A frozen page requires an exact placement identity, watermark and snapshot digest.');
 const byId=new Map();let continuous=first.pageCursor===null;
 for(let i=0;i<pages.length;i++){
  const page=pages[i];if(!page||page.schemaVersion!==1||page.snapshotId!==first.snapshotId||page.asOf!==first.asOf||JSON.stringify(page.identity)!==JSON.stringify(first.identity)||!Array.isArray(page.items))fail(400,'CHRONOLOGY_EXPORT_SCOPE_MISMATCH','Export pages must belong to one frozen placement read.');
  if(typeof page.hasMore!=='boolean'||(page.hasMore?typeof page.nextCursor!=='string'||!page.nextCursor||page.nextCursor.length>12000:page.nextCursor!==null))fail(400,'INVALID_CHRONOLOGY_EXPORT','Each frozen page must declare whether another page exists with a consistent continuation cursor.');
  if(i&&pages[i-1].nextCursor!==page.pageCursor)continuous=false;
  for(const row of page.items){if(!row||JSON.stringify(row.identity)!==JSON.stringify(first.identity))fail(400,'CHRONOLOGY_EXPORT_SCOPE_MISMATCH','Every retained row must belong to this exact frozen placement.');const previous=byId.get(row.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))fail(400,'CHRONOLOGY_EXPORT_CONFLICT','A frozen row changed between pages.');byId.set(row.id,row);}
 }
 for(const row of localItems){if(row.stream!=='local_submissions'||JSON.stringify(row.identity)!==JSON.stringify(first.identity)||!iso(row.sortAt)||row.sortAt>first.asOf)fail(400,'CHRONOLOGY_EXPORT_SCOPE_MISMATCH','Local submission context must match this placement and cutoff.');const previous=byId.get(row.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))fail(400,'CHRONOLOGY_EXPORT_CONFLICT','A local receipt identity changed.');byId.set(row.id,row);}
 const complete=continuous&&pages.at(-1).hasMore===false,coverage=JSON.parse(JSON.stringify(pages.at(-1).coverage));
 if(localItems.length)coverage.local_submissions={status:'available',reason:'validated_local_reported_receipts',hasMore:false,providerAuthenticity:'not_established'};
 const items=[...byId.values()].sort(compare),gaps=[];
 for(const [stream,origin] of Object.entries(coverage)){
  if(origin.status==='available'){const loaded=items.filter(row=>row.stream===stream);origin.loadedRange={newestAt:loaded[0]?.sortAt??null,oldestAt:loaded.at(-1)?.sortAt??null,itemCount:loaded.length};}
  if(origin.status!=='available'||origin.compactedBefore||origin.retentionFloor>0)gaps.push({stream,reason:origin.reason,...(origin.compactedBefore?{compactedBefore:origin.compactedBefore}:{}),...(origin.retentionFloor>0?{retentionFloor:origin.retentionFloor}:{})});
 }
 if(!complete)gaps.push({stream:'pagination',reason:'partial_pagination'});
 const data={schemaVersion:1,identity:first.identity,asOf:first.asOf,snapshotId:first.snapshotId,items,coverage,gaps,pagination:{complete,pageCount:pages.length,reason:complete?'all_loaded_pages':'partial_pagination',nextCursor:pages.at(-1).nextCursor??null},historyMeaning:first.historyMeaning};
 const frozen=JSON.parse(JSON.stringify(data));return {...frozen,contentHash:await sha256(JSON.stringify(frozen))};
}

// This is an offline normalization boundary, not server ingestion, collection or
// proof of provider authenticity. The hash uses the existing CLI receipt format.
export async function normalizeLocalSubmissions(rows,identity){
 if(!validIdentity(identity))fail(400,'INVALID_SUBMISSION_RECEIPT','An exact placement identity is required.');
 if(!Array.isArray(rows)||rows.length>10000)fail(400,'INVALID_SUBMISSION_RECEIPT','Provide bounded local submission receipts.');
 const fields=['v','id','project_id','url','channel','endpoint','submitted_at','http_status','evidence_sha256'],items=[],byId=new Map();
 for(const row of rows){
  if(!row||Object.keys(row).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(row,k))||row.v!==1||!/^[\w-]{1,128}$/.test(row.id??'')||!/^[\w-]{1,128}$/.test(row.project_id??'')||row.channel!=='indexnow'||row.endpoint!=='https://api.indexnow.org/indexnow'||iso(row.submitted_at)!==row.submitted_at||row.http_status!==null&&(!Number.isInteger(row.http_status)||row.http_status<100||row.http_status>599))fail(400,'INVALID_SUBMISSION_RECEIPT','Use the existing validated local submission format.');
  let url;try{url=new URL(row.url);}catch{fail(400,'INVALID_SUBMISSION_RECEIPT','The submission URL is invalid.');}if(url.href!==row.url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)fail(400,'INVALID_SUBMISSION_RECEIPT','The submission URL must be exact HTTP(S).');
  const body=Object.fromEntries(fields.filter(k=>k!=='evidence_sha256').map(k=>[k,row[k]]));if(await sha256(JSON.stringify(body))!==row.evidence_sha256)fail(400,'INVALID_SUBMISSION_RECEIPT','The local receipt hash does not match.');
  const key=`${row.project_id}:${row.id}`,previous=byId.get(key);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))fail(409,'SUBMISSION_IDENTITY_CONFLICT','A local submission ID has conflicting contents.');byId.set(key,row);if(previous||row.project_id!==identity.projectId||![identity.sourceUrl,identity.targetUrl].includes(row.url))continue;
  const item=baseItem('local_submissions',{id:key},identity,null,null,'reported_submission');items.push({...item,sortAt:row.submitted_at,reason:row.http_status===200?'received':row.http_status===202?'key_validation_pending':row.http_status===null?'unknown':'failed',method:'reported_indexnow_http_response',evidence:{...item.evidence,sha256:row.evidence_sha256,availability:'local_receipt'},data:{...row,subject:row.url===identity.sourceUrl?'source':'target',reportedSubmissionAt:row.submitted_at,sortTimeMeaning:'reported_submission_time',retrievedAt:null,providerAuthenticity:'not_established',participantIndexingVerified:false,causationEstablished:false}});
 }
 return items.sort(compare);
}
