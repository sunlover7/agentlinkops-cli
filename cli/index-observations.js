import {readFile,writeFile,open,rename,unlink,mkdir,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadConfig,ConfigError} from './config.js';
import {cloudConnection} from './connection.js';
import {createClient} from './client.js';
import {parseCsv} from './adapters/csv.js';
import {indexEvidenceReference,describeEvidenceReference} from '../src/evidence-reference.js';
import {indexReceiptResponse} from '../shared/index-observation-contract.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw new ConfigError(message);};
export const INDEX_CLI_HELP='agentlinkops index pull --watch-id ID [--limit 50] [--before ID] | import RECEIPTS.json | export [--out FILE] | csv URLS.csv [--out FILE] | check-csv URLS.csv --connection-id ID --request-id ID --out FILE';
function validate(row){
 if(row?.v!==1||! /^[\w-]{1,128}$/.test(row.project_id??'')||! /^[\w-]{1,128}$/.test(row.watch_id??''))fail('Invalid local index receipt scope');
 const receipt=indexReceiptResponse.parse(row.receipt);
 if(receipt.observation.checked_at!==receipt.observation.checkedAt||receipt.observation.observation_id!==receipt.observation.observationId||!Number.isFinite(Date.parse(receipt.observation.checkedAt)))fail('Index receipt observation identity mismatch');
 if(receipt.evidenceAvailable&&receipt.rawResponse==null)fail('Available index evidence requires an actual raw response');
 if(!receipt.evidenceAvailable&&receipt.rawResponse!==null)fail('Unavailable index evidence must not contain a raw body');
 if(receipt.evidenceAvailable&&sha(JSON.stringify(receipt.rawResponse))!==receipt.observation.evidenceSha256)fail('Index receipt payload hash mismatch');
 return {...row,receipt};
}
async function atomicOutput(path,text){await mkdir(dirname(path),{recursive:true});const temporary=`${path}.${crypto.randomUUID()}.tmp`;try{await writeFile(temporary,text,{flag:'wx'});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}}
async function boundedText(path){const info=await stat(path);if(info.size>32*1024*1024)fail('Index input exceeds 32 MiB; split the export');return readFile(path,'utf8');}
export async function readIndexReceipts(path){
 let text;try{text=await boundedText(path);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 return text.split('\n').filter(line=>line.trim()).map(line=>validate(JSON.parse(line)));
}
export async function saveIndexReceipts(path,rows){
 const checked=rows.map(validate);await mkdir(dirname(path),{recursive:true});let lock;
 try{lock=await open(`${path}.lock`,'wx');}catch(error){if(error.code==='EEXIST')fail('Index receipt writer already locked');throw error;}
 const temporary=`${path}.${crypto.randomUUID()}.tmp`;
 try{
  const existing=await readIndexReceipts(path),byId=new Map(existing.map(r=>[r.receipt.observation.id,r]));
  for(const row of checked){const id=row.receipt.observation.id,previous=byId.get(id);if(previous){
   if(previous.project_id!==row.project_id||previous.watch_id!==row.watch_id||JSON.stringify(previous.receipt.observation)!==JSON.stringify(row.receipt.observation))fail('Index receipt identity conflict');
   if(previous.receipt.evidenceAvailable&&!row.receipt.evidenceAvailable)continue;
  }byId.set(id,row);}
  const text=[...byId.values()].sort((a,b)=>a.receipt.observation.id.localeCompare(b.receipt.observation.id)).map(r=>JSON.stringify(r)).join('\n')+'\n';if(Buffer.byteLength(text)>32*1024*1024)fail('Local index receipts exceed 32 MiB; archive before importing more');
  await writeFile(temporary,text,{flag:'wx'});await rename(temporary,path);return {saved:checked.length,total:byId.size};
 }finally{await unlink(temporary).catch(()=>{});await lock.close();await unlink(`${path}.lock`);}
}
export function locateIndexReceipt(rows,receiptId){
 const row=rows.find(r=>r.receipt.observation.id===receiptId);if(!row)fail('No local index receipt matches this reference');
 const reference=indexEvidenceReference({receiptId});
 return {...row.receipt,projectId:row.project_id,watchId:row.watch_id,evidence_reference:reference,reference_resolution:describeEvidenceReference(reference),notes:['Retained index evidence describes the provider snapshot at its check date, not a live crawl.','This explicit local export survives hosted cancellation; hosted raw retention does not remove customer-owned copies.']};
}
export function indexRowsForUrl(rows,url){
 const latest=new Map();for(const row of rows){const o=row.receipt.observation;if(o.url!==url)continue;const previous=latest.get(o.source_key);if(!previous||o.checked_at>previous.checked_at||(o.checked_at===previous.checked_at&&o.id>previous.id))latest.set(o.source_key,{...o,locator:indexEvidenceReference({receiptId:o.id}),hosted_locator:indexEvidenceReference({receiptId:o.id,projectId:row.project_id,watchId:row.watch_id,storage:'hosted'})});}
 return [...latest.values()].sort((a,b)=>a.source_key.localeCompare(b.source_key));
}
const cell=value=>{const raw=String(value??''),safe=/^[\s]*[=+\-@]|^[\t\r]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;};
export function indexCsv(urls,receipts){
 const output=[['URL','Verdict','Reason','Check Date','Confidence','Backend','Evidence Reference']];
 for(const url of urls){const rows=indexRowsForUrl(receipts,url);if(!rows.length)output.push([url,'unknown','not_checked','','unknown','','']);else for(const row of rows)output.push([url,row.tier,row.reason,row.checked_at,row.confidence,row.backend,row.locator]);}
 return output.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
function csvInput(text){
 const [header,...rows]=parseCsv(text),urlAt=header?.findIndex(v=>['url','source_url'].includes(v.trim().toLowerCase())),watchAt=header?.findIndex(v=>v.trim().toLowerCase()==='watch_id');
 if(urlAt==null||urlAt<0||!rows.length||rows.length>100)fail('Index CSV requires URL or source_url and 1–100 rows');
 return rows.map(row=>{let url;try{url=new URL(row[urlAt]);}catch{fail('Invalid index CSV URL');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash)fail('Invalid index CSV URL');return {url:url.href,watchId:watchAt>=0?row[watchAt]:null};});
}
export async function indexMain(args,{cwd=process.cwd(),env=process.env,out=console.log,fetchImpl=globalThis.fetch}={}){
 const command=args._[1],config=await loadConfig({cwd}),path=config.paths.indexObservations;
 const allowed=new Set(['_','tag','out','watch-id','limit','before','connection-id','request-id']);if(args.tag?.length||Object.keys(args).some(key=>!allowed.has(key)))fail(INDEX_CLI_HELP);
 if(command==='import'){
  if(!args._[2])fail(INDEX_CLI_HELP);const parsed=JSON.parse(await boundedText(resolve(cwd,args._[2])));if(!Array.isArray(parsed)||parsed.length>100)fail('Import requires an array of at most 100 scoped index receipts');out(JSON.stringify(await saveIndexReceipts(path,parsed)));return 0;
 }
 if(command==='export'){const text=JSON.stringify(await readIndexReceipts(path),null,2);if(args.out){if(typeof args.out!=='string')fail('--out requires a file');await atomicOutput(resolve(cwd,args.out),text);}else out(text);return 0;}
 if(command==='csv'||command==='check-csv'){
  if(!args._[2])fail(INDEX_CLI_HELP);const input=csvInput(await boundedText(resolve(cwd,args._[2])));
  if(command==='check-csv'){
   if(typeof args['connection-id']!=='string'||typeof args.out!=='string'||typeof args['request-id']!=='string'||! /^[\x21-\x7e]{1,128}$/.test(args['request-id'])||input.some(r=>!r.watchId))fail('check-csv requires watch_id for every row, --connection-id, --request-id and --out');
   const connection=cloudConnection(config,env);if(!connection.projectId)fail('Connect this repository to a project first');const client=createClient({...connection,fetchImpl});
   // Validate every supplied URL/watch pairing before the first inspection.
   for(const row of input){const watch=await client.callCommand('get_link_watch',{watchId:row.watchId});if(watch.project_id!==connection.projectId||watch.source_url!==row.url)fail('CSV URL/watch scope mismatch; no inspection was started');}
   const batchKey=sha(JSON.stringify([connection.projectId,args['connection-id'],args['request-id'],input]));
   for(const row of input){const result=await client.callCommand('inspect_index_status',{connectionId:args['connection-id'],watchId:row.watchId,idempotencyKey:`csv-${sha(JSON.stringify([batchKey,row.watchId,row.url]))}`});await saveIndexReceipts(path,[{v:1,project_id:connection.projectId,watch_id:row.watchId,receipt:{observation:result.observation,rawResponse:result.rawResponse,evidenceAvailable:result.evidenceAvailable}}]);}
  }
  const csv=indexCsv(input.map(r=>r.url),await readIndexReceipts(path));if(args.out){if(typeof args.out!=='string')fail('--out requires a file');const target=resolve(cwd,args.out);await atomicOutput(target,csv);}else out(csv);return 0;
 }
 if(command==='pull'){
  if(typeof args['watch-id']!=='string')fail(INDEX_CLI_HELP);const limit=Number(args.limit??50);if(!Number.isInteger(limit)||limit<1||limit>100)fail('Index pull limit must be 1–100');
  const connection=cloudConnection(config,env);if(!connection.projectId)fail('Connect this repository to a project first');const client=createClient({...connection,fetchImpl});
  const page=await client.callCommand('list_index_observations',{projectId:connection.projectId,watchId:args['watch-id'],limit,...(args.before?{beforeId:args.before}:{})});const rows=[];
  for(const observation of page.observations)rows.push({v:1,project_id:connection.projectId,watch_id:args['watch-id'],receipt:await client.callCommand('get_index_observation',{projectId:connection.projectId,watchId:args['watch-id'],receiptId:observation.id})});
  out(JSON.stringify({...await saveIndexReceipts(path,rows),nextCursor:page.nextCursor}));return 0;
 }
 fail(INDEX_CLI_HELP);
}
