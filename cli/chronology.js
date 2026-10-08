import {readFile,writeFile,mkdir,copyFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {loadConfig,ConfigError} from './config.js';
import {cloudConnection} from './connection.js';
import {createClient} from './client.js';
import {freezeChronology,normalizeLocalSubmissions} from '../shared/monitoring-chronology-export.js';
const help='agentlinkops chronology pull --watch-id ID [--limit 50] [--cursor TOKEN] [--all] [--out NEW_FILE] | export --pages FILE [--submissions FILE] [--out NEW_FILE]';
async function output(value,args,{cwd,out}){
 const text=JSON.stringify(value,null,2)+'\n';
 if(!args.out){out(text.trimEnd());return;}
 if(typeof args.out!=='string'||!args.out.trim())throw new ConfigError('--out requires a file');
 const path=resolve(cwd,args.out),temp=`${path}.${crypto.randomUUID()}.tmp`;
 await mkdir(dirname(path),{recursive:true});
 try{await writeFile(temp,text,{flag:'wx',mode:0o600});await copyFile(temp,path,constants.COPYFILE_EXCL);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 out(`wrote ${path}`);
}
export async function chronologyMain(args,{cwd=process.cwd(),env=process.env,fetchImpl=globalThis.fetch,out=console.log}={}){
 const command=args._[1],allowed=new Set(['_','tag','watch-id','limit','cursor','all','out','pages','submissions']);
 if(args._.length!==2||args.tag?.length||Object.keys(args).some(key=>!allowed.has(key)))throw new ConfigError(help);
 if(command==='export'){
  if(typeof args.pages!=='string'||args['watch-id']!==undefined||args.limit!==undefined||args.cursor!==undefined||args.all!==undefined)throw new ConfigError(help);
  const input=JSON.parse(await readFile(resolve(cwd,args.pages),'utf8')),pages=Array.isArray(input)?input:[input];
  const localItems=args.submissions?await normalizeLocalSubmissions(JSON.parse(await readFile(resolve(cwd,args.submissions),'utf8')),pages[0]?.identity):[];
  await output(await freezeChronology(pages,{localItems}),args,{cwd,out});return 0;
 }
 if(command!=='pull'||typeof args['watch-id']!=='string'||args.pages!==undefined||args.submissions!==undefined||args.all!==undefined&&args.all!==true)throw new ConfigError(help);
 const limit=Number(args.limit??50);if(!Number.isInteger(limit)||limit<1||limit>100||args.cursor===true)throw new ConfigError(help);
 const config=await loadConfig({cwd}),connection=cloudConnection(config,env);
 if(!connection.projectId)throw new ConfigError('Connect this project before reading hosted chronology.');
 const client=createClient({...connection,fetchImpl}),pages=[];let cursor=args.cursor;
 do{
  const page=await client.callCommand('get_placement_chronology',{watchId:args['watch-id'],limit,...(cursor?{cursor}: {})});
  if(page.identity?.projectId!==connection.projectId||page.identity?.watchId!==args['watch-id']||connection.workspaceId&&page.identity?.workspaceId!==connection.workspaceId)throw new ConfigError('Chronology identity does not match the connected project and selected watch.');
  pages.push(page);cursor=page.nextCursor;
  if(pages.length===100&&args.all&&cursor)throw new ConfigError('Chronology exceeds the 100-page read bound. Pull explicit pages and export their qualified partial dataset.');
 }while(args.all&&cursor);
 await output(args.all?await freezeChronology(pages):pages[0],args,{cwd,out});return 0;
}
