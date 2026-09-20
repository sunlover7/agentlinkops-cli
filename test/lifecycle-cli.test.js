import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lifecycleMain} from '../cli/lifecycle.js';
import {emptyDeal} from '../shared/lifecycle-contract.js';
async function setup(t){const cwd=await mkdtemp(join(tmpdir(),'lifecycle-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(join(cwd,'.agentlinkops'));await writeFile(join(cwd,'.agentlinkops/config.json'),JSON.stringify({cloud:{origin:'https://fixture.example',workspaceId:'ws'},project:{id:'p'}}));return cwd;}
test('lifecycle CLI sends exact scoped JSON, preserves zero and explicitly clears metadata',async t=>{
 const cwd=await setup(t),calls=[],out=[];let revision=0,deal=emptyDeal();const fetchImpl=async(url,options)=>{const a=JSON.parse(options.body);calls.push({url,a});assert.equal(options.headers['X-Workspace-ID'],'ws');assert.equal(options.redirect,'error');assert.equal(a.projectId,'p');if(url.endsWith('update_link_lifecycle')){revision++;deal={...deal,...a.deal};}return Response.json({projectId:'p',watchId:'w',revision,deal,createdAt:null,updatedAt:null});};
 const deps={cwd,env:{AGENTLINKOPS_TOKEN:'fixture-only'},out:value=>out.push(JSON.parse(value)),fetchImpl};
 await writeFile(join(cwd,'deal.json'),JSON.stringify({costMinor:0,currency:'JPY',expiresOn:'2026-10-01',contactRef:'crm_one'}));
 await lifecycleMain({_ :['lifecycle','update','w'],revision:'0',deal:'deal.json'},deps);assert.equal(out[0].deal.costMinor,0);assert.equal(out[0].deal.currency,'JPY');assert.equal(calls[0].a.revision,0);
 await lifecycleMain({_ :['lifecycle','get','w']},deps);assert.equal(calls[1].a.watchId,'w');
 await lifecycleMain({_ :['lifecycle','clear','w'],revision:'1'},deps);assert.deepEqual(calls[2].a.deal,emptyDeal());assert.equal(out[2].deal.costMinor,null);
});
test('lifecycle CLI validates malformed/private fields and money before any HTTP call',async t=>{
 const cwd=await setup(t);let calls=0;const deps={cwd,env:{AGENTLINKOPS_TOKEN:'fixture-only'},out:()=>{},fetchImpl:async()=>{calls++;throw Error('unexpected');}};
 for(const patch of [{costMinor:12.5,currency:'USD'},{costMinor:1},{costMinor:1,currency:'XXX'},{contactRef:'person@example.com'},{contactLabel:'person@example.com'},{expiresOn:'2026-02-30'},{extra:'unknown'}]){await writeFile(join(cwd,'bad.json'),JSON.stringify(patch));await assert.rejects(lifecycleMain({_ :['lifecycle','update','w'],revision:'0',deal:'bad.json'},deps));}
 await assert.rejects(lifecycleMain({_ :['lifecycle','report'],from:'2026-10-01',to:'2026-09-01'},deps));await assert.rejects(lifecycleMain({_ :['lifecycle','renew'],limit:'101'},deps));await assert.rejects(lifecycleMain({_ :['lifecycle','get','w'],'project-id':'elsewhere'},deps));assert.equal(calls,0);
});
test('explicit legacy decimal adapter sends exact minor units and refuses excess precision before HTTP',async t=>{
 const cwd=await setup(t),calls=[];const deps={cwd,env:{AGENTLINKOPS_TOKEN:'fixture-only'},out:()=>{},fetchImpl:async(url,options)=>{const a=JSON.parse(options.body);calls.push(a);return Response.json({projectId:'p',watchId:'w',revision:1,deal:{...emptyDeal(),...a.deal},createdAt:null,updatedAt:null});}};
 await writeFile(join(cwd,'decimal.json'),JSON.stringify({cost_amount:'0.001',cost_currency:'KWD'}));
 await lifecycleMain({_ :['lifecycle','update','w'],revision:'0',deal:'decimal.json','decimal-cost':true},deps);assert.deepEqual(calls[0].deal,{costMinor:1,currency:'KWD'});
 await writeFile(join(cwd,'decimal.json'),JSON.stringify({cost_amount:'0.001',cost_currency:'USD'}));
 await assert.rejects(lifecycleMain({_ :['lifecycle','update','w'],revision:'0',deal:'decimal.json','decimal-cost':true},deps));assert.equal(calls.length,1);
});
