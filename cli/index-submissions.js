import {readFile,writeFile,open,rename,unlink,mkdir,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigError} from './config.js';
import {indexEvidenceReference} from '../src/evidence-reference.js';
const fail=message=>{throw new ConfigError(message);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value);
const fields=['v','id','project_id','url','channel','endpoint','submitted_at','http_status','evidence_sha256'];
export const SUBMISSION_NOTE='Imported submission records describe reported HTTP responses. Hashes check local integrity, not provider authenticity. Later Google observations do not verify indexing by an IndexNow participant or show that submission caused indexing.';
export function validateSubmission(row){
 if(!row||Object.keys(row).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(row,k))||row.v!==1||!id(row.id)||!id(row.project_id)||row.channel!=='indexnow'||row.endpoint!=='https://api.indexnow.org/indexnow')fail('Invalid IndexNow submission receipt');
 let url;try{url=new URL(row.url);}catch{fail('Invalid submission URL');}
 if(typeof row.url!=='string'||url.href!==row.url||!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash)fail('Submission URL must be exact HTTP(S) without credentials or fragment');
 if(typeof row.submitted_at!=='string'||!Number.isFinite(Date.parse(row.submitted_at))||new Date(row.submitted_at).toISOString()!==row.submitted_at)fail('Submission date must be an ISO UTC timestamp');
 if(row.http_status!==null&&(!Number.isInteger(row.http_status)||row.http_status<100||row.http_status>599))fail('Invalid submission HTTP status');
 const body=Object.fromEntries(fields.filter(k=>k!=='evidence_sha256').map(k=>[k,row[k]]));
 if(row.evidence_sha256!==digest(body))fail('Submission receipt hash mismatch');
 return {...body,evidence_sha256:row.evidence_sha256};
}
export async function boundedSubmissionText(path){const info=await stat(path);if(info.size>32*1024*1024)fail('Submission input exceeds 32 MiB');return readFile(path,'utf8');}
export async function readSubmissions(path){try{return (await boundedSubmissionText(path)).split('\n').filter(line=>line.trim()).map(line=>validateSubmission(JSON.parse(line)));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
export async function saveSubmissions(path,rows){
 if(!Array.isArray(rows)||rows.length>100)fail('Import requires at most 100 submission receipts');
 const checked=rows.map(validateSubmission);await mkdir(dirname(path),{recursive:true});let lock;
 try{lock=await open(`${path}.lock`,'wx');}catch(error){if(error.code==='EEXIST')fail('Submission receipt writer already locked');throw error;}
 const tmp=`${path}.${crypto.randomUUID()}.tmp`;
 try{
  const current=await readSubmissions(path),byId=new Map(current.map(r=>[`${r.project_id}:${r.id}`,r]));
  for(const row of checked){const key=`${row.project_id}:${row.id}`,old=byId.get(key);if(old&&JSON.stringify(old)!==JSON.stringify(row))fail('Submission receipt identity conflict');byId.set(key,row);}
  const text=[...byId.values()].sort((a,b)=>a.project_id.localeCompare(b.project_id)||a.submitted_at.localeCompare(b.submitted_at)||a.id.localeCompare(b.id)).map(r=>JSON.stringify(r)).join('\n')+'\n';
  if(Buffer.byteLength(text)>32*1024*1024)fail('Submission receipts exceed 32 MiB; archive before importing more');
  await writeFile(tmp,text,{flag:'wx'});await rename(tmp,path);return {imported:checked.length,total:byId.size};
 }finally{await unlink(tmp).catch(()=>{});await lock.close();await unlink(`${path}.lock`);}
}
export function reconcileSubmissions(submissions,observations,projectId){
 if(!id(projectId))fail('A valid --project-id is required');
 return {v:1,project_id:projectId,note:SUBMISSION_NOTE,submissions:submissions.filter(r=>r.project_id===projectId).map(validateSubmission).map(row=>{
  const subsequent=observations.filter(r=>r.project_id===projectId&&r.receipt.observation.url===row.url&&Date.parse(r.receipt.observation.checked_at)>Date.parse(row.submitted_at)).map(r=>{
   const o=r.receipt.observation;return {watch_id:r.watch_id,observation_id:o.id,checked_at:o.checked_at,backend:o.backend,source_key:o.source_key,tier:o.tier,reason:o.reason,confidence:o.confidence,evidence_sha256:o.evidenceSha256,evidence_available:r.receipt.evidenceAvailable,evidence_reference:indexEvidenceReference({receiptId:o.id}),relationship:'observation_after_submission',participant_indexing_verified:false,causation_established:false};
  }).sort((a,b)=>a.checked_at.localeCompare(b.checked_at)||a.observation_id.localeCompare(b.observation_id));
  return {...row,outcome:row.http_status===200?'received':row.http_status===202?'key_validation_pending':row.http_status===null?'unknown':'failed',observations:subsequent,verification:'not_established'};
 })};
}
const cell=value=>{const raw=String(value??''),safe=/^[\s]*[=+\-@]|^[\t\r]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;};
export function submissionCsv(report){
 const rows=[['Project','Submission ID','URL','Submitted At','HTTP Status','Submission Outcome','Submission Hash','Observation ID','Watch ID','Backend','Source','Check Date','Verdict','Reason','Confidence','Evidence Available','Observation Hash','Evidence Reference','Participant Indexing Verified','Causation Established','Reading Note']];
 for(const s of report.submissions)for(const o of s.observations.length?s.observations:[null])rows.push([report.project_id,s.id,s.url,s.submitted_at,s.http_status,s.outcome,s.evidence_sha256,o?.observation_id,o?.watch_id,o?.backend,o?.source_key,o?.checked_at,o?.tier??'unknown',o?.reason??'no_later_observation',o?.confidence??'unknown',o?.evidence_available??false,o?.evidence_sha256,o?.evidence_reference,false,false,report.note]);
 return rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
