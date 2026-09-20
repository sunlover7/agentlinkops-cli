import {open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadConfig,ConfigError} from './config.js';
import {cloudConnection} from './connection.js';
import {createClient,CloudError} from './client.js';
import * as C from '../shared/disavow-contract.js';

export const DISAVOW_USAGE='disavow list|history|propose --kind domain|url --value VALUE|import FILE|export [--out FILE]|approve|reject|delete --rule-id ID --revision N [--project-id ID]';
const bad=message=>{throw new ConfigError(message);};
export async function disavowMain(args,{cwd=process.cwd(),env=process.env,fetchImpl=globalThis.fetch,out=console.log}={}){
 const action=args._[1];if(!action||action==='help'){out(DISAVOW_USAGE);return 0;}
 const schemas={list:C.disavowListInput,history:C.disavowHistoryInput,propose:C.disavowProposeInput,import:C.disavowImportInput,export:C.disavowProjectInput,approve:C.disavowReviewInput,reject:C.disavowReviewInput,delete:C.disavowDeleteInput};
 const names={list:'list_disavow_rules',history:'list_disavow_exports',propose:'propose_disavow_rule',import:'import_disavow_rules',export:'export_disavow_rules',approve:'review_disavow_rule',reject:'review_disavow_rule',delete:'delete_disavow_rule'};
 if(!schemas[action])bad(DISAVOW_USAGE);
 const options={list:['limit','cursor','status'],history:['limit','cursor'],propose:['kind','value','comment'],import:[],export:['out'],approve:['rule-id','revision'],reject:['rule-id','revision'],delete:['rule-id','revision']}[action];
 if(Object.keys(args).some(key=>!['_','tag','json','project-id',...options].includes(key))||args.tag?.length||args._.length!==(action==='import'?3:2))bad(DISAVOW_USAGE);
 const config=await loadConfig({cwd}),connection=cloudConnection(config,env),projectId=args['project-id']??connection.projectId;
 let input={projectId};
 if(action==='list'||action==='history')input={...input,...(args.limit===undefined?{}:{limit:Number(args.limit)}),...(args.cursor===undefined?{}:{cursor:args.cursor}),...(args.status===undefined?{}:{status:args.status})};
 if(action==='propose')input={...input,kind:args.kind,value:args.value,source:'agent_proposal',status:'proposed',...(args.comment===undefined?{}:{comments:[`# ${args.comment}`]})};
 if(['approve','reject','delete'].includes(action))input={...input,ruleId:args['rule-id'],revision:Number(args.revision),...(action==='delete'?{}:{decision:action})};
 if(action==='import'){
  const file=await open(resolve(cwd,args._[2]),'r');try{if((await file.stat()).size>C.DISAVOW_LIMITS.importBytes)bad('Disavow import exceeds 160 KiB.');input.text=await file.readFile('utf8');}finally{await file.close();}
 }
 const parsed=schemas[action].safeParse(input);if(!parsed.success)bad(`Invalid ${action} arguments. ${DISAVOW_USAGE}`);
 const client=createClient({...connection,fetchImpl});
 // Reserve both local artifacts before creating a remote export receipt. Existing
 // customer files are never replaced and a path error cannot consume an export.
 let target,receiptFile,targetPath,receiptPath,received=false;
 if(action==='export'&&args.out!==undefined){
  if(typeof args.out!=='string'||!args.out)bad('--out requires a file path.');
  targetPath=resolve(cwd,args.out);receiptPath=`${targetPath}.receipt.json`;
  target=await open(targetPath,'wx');try{receiptFile=await open(receiptPath,'wx');}catch(error){await target.close();await unlink(targetPath);throw error;}
 }
 try{
  const result=await client.callCommand(names[action],parsed.data);
  if(action==='export'){
   const checked=C.disavowExportOutput.parse(result);
   if(createHash('sha256').update(checked.text).digest('hex')!==checked.receipt.sha256||Buffer.byteLength(checked.text)!==checked.receipt.byte_length)throw new CloudError('INVALID_RESPONSE',502);
   received=true;
   if(target){await target.writeFile(checked.text,'utf8');await receiptFile.writeFile(JSON.stringify(checked.receipt,null,2)+'\n','utf8');out(JSON.stringify({file:targetPath,receiptFile:receiptPath,receipt:checked.receipt}));}
   else out(JSON.stringify(checked));
  }else out(JSON.stringify(result));
  return 0;
 }catch(error){
  if(error.code==='HUMAN_ADMIN_REQUIRED')throw new ConfigError('Approve, reject or delete this rule in Disavow using the signed-in owner/admin console. Agent credentials cannot approve rules.');
  if(received)out(JSON.stringify({error:{code:'DISAVOW_ARTIFACT_WRITE_FAILED',message:'The hosted export receipt exists. Inspect export history before retrying; local output may be incomplete.'}}));
  throw error;
 }finally{
  await target?.close();await receiptFile?.close();
  if(target&&!received){await unlink(targetPath).catch(()=>{});await unlink(receiptPath).catch(()=>{});}
 }
}
