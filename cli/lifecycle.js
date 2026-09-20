import {legacyCostPatch} from '../shared/lifecycle-money.js';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadConfig,ConfigError} from './config.js';
import {cloudConnection} from './connection.js';
import {createClient} from './client.js';
import * as C from '../shared/lifecycle-contract.js';
export const LIFECYCLE_CLI_HELP=`agentlinkops lifecycle get WATCH_ID
agentlinkops lifecycle update WATCH_ID --revision N --deal PATCH.json [--decimal-cost]
agentlinkops lifecycle clear WATCH_ID --revision N
agentlinkops lifecycle renew [--limit 100]
agentlinkops lifecycle report [--from YYYY-MM-DD] [--to YYYY-MM-DD]
Uses the connected project. Deal costs are integer currency minor units. Null clears a field; costMinor and currency must be set or cleared together. Clear removes deal metadata, not the watch. Renew retains due events without sending a message. --decimal-cost reads cost_amount as an exact decimal string and cost_currency using the supported currency scale. sync --lifecycle pulls a deal mirror without editing the ledger.`;
const fail=message=>{throw new ConfigError(message);};
const integer=(value,name)=>{if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail(`${name} requires a nonnegative integer`);return Number(value);};
export async function lifecycleMain(args,{cwd=process.cwd(),env=process.env,out=console.log,fetchImpl=globalThis.fetch}={}){
 if(args.help){out(LIFECYCLE_CLI_HELP);return 0;}
 const action=args._?.[1],allowed={get:[],update:['revision','deal','decimal-cost'],clear:['revision'],renew:['limit'],report:['from','to']}[action];
 if(!allowed||args.tag?.length||Object.keys(args).some(key=>!['_','tag',...allowed].includes(key)))fail(LIFECYCLE_CLI_HELP);
 const record=['get','update','clear'].includes(action);
 if(args._.length!==(record?3:2)||record&&(typeof args._[2]!=='string'||!args._[2]))fail(LIFECYCLE_CLI_HELP);
 const config=await loadConfig({cwd}),connection=cloudConnection(config,env);if(!connection.projectId)fail('Connect this repository to a project first');
 const input={projectId:connection.projectId};let name,schema,output;
 if(record)input.watchId=args._[2];
 if(action==='get'){name='get_link_lifecycle';schema=C.lifecycleGetInput;output=C.lifecycleOutput;}
 if(action==='update'||action==='clear'){
  name='update_link_lifecycle';schema=C.lifecycleUpdateInput;output=C.lifecycleOutput;input.revision=integer(args.revision,'--revision');
  if(action==='clear')input.deal=C.emptyDeal();else{
   if(typeof args.deal!=='string')fail('--deal requires a JSON patch file');const path=resolve(cwd,args.deal),info=await stat(path);if(!info.isFile()||info.size>16384)fail('Deal patch must be a JSON file of at most 16 KiB');
   try{input.deal=JSON.parse(await readFile(path,'utf8'));}catch{fail('Deal patch must contain valid JSON');}
   if(args['decimal-cost']){try{input.deal=legacyCostPatch(input.deal);}catch(e){fail(e.message);}}
   const patch=C.lifecyclePatch.safeParse(input.deal);if(!patch.success)fail('Invalid deal patch fields');
   if(('costMinor' in input.deal)!==('currency' in input.deal))fail('Set or clear costMinor and currency together');
  }
 }
 if(action==='renew'){name='record_lifecycle_renewals';schema=C.lifecycleRenewInput;output=C.lifecycleRenewOutput;if(args.limit!==undefined)input.limit=integer(args.limit,'--limit');}
 if(action==='report'){name='get_lifecycle_report';schema=C.lifecycleReportInput;output=C.lifecycleReportOutput;for(const key of ['from','to'])if(args[key]!==undefined)input[key]=args[key];}
 const parsed=schema.safeParse(input);if(!parsed.success)fail('Invalid lifecycle dates, fields or bounds');
 const result=await createClient({...connection,fetchImpl}).callCommand(name,parsed.data),checked=output.safeParse(result);if(!checked.success)fail('Invalid lifecycle service response');out(JSON.stringify(checked.data,null,2));return 0;
}
