import {finishDieterUploads} from './lib/dieter-upload-completion';
import type {Env} from './types';
import type {WorkflowStep} from 'cloudflare:workers';
import type {TikTokSource} from './lib/dieter-tiktok';
import {runDieterTikTokApi} from './lib/dieter-tiktok';
import {reelPublicationProof,reelScope} from './lib/ugc-reel-jobs.mjs';
import {reconcileDieterRutubeStatus} from './lib/dieter-rutube-status';
import {saveDieterFlowTiming} from './lib/dieter-flow-timing';

export type TikTokTransportEvent={content_id:string;claim_id:string;transport:'tiktok';transport_id:string};
const definitionKey=(id:string)=>'dieter_tiktok_transport:'+id;
async function read(env:Env,key:string){const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<{value:string}>();return row?JSON.parse(row.value):null;}
async function stopped(env:Env){return Boolean(await env.DB.prepare("SELECT key FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked') LIMIT 1").first());}
async function putOnce(env:Env,key:string,value:unknown){return env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,JSON.stringify(value),Date.now()).run();}
function validArgs(a:TikTokSource){return typeof a.contentId==='string'&&typeof a.claimId==='string'&&/^[a-f0-9]{64}$/.test(a.sourceSha256)&&a.sourceAssetUrl===`https://org.dasexperten.com/assets/ugc/${a.sourceSha256}/original.mp4`&&Number.isFinite(a.sourceDurationSeconds)&&a.sourceDurationSeconds>0&&typeof a.sourceAuthor==='string'&&a.sourceAuthor.length>0&&typeof a.sourceDriveId==='string'&&a.sourceDriveId.length>0;}
async function authorizedJob(env:Env,args:TikTokSource,continuationId?:string){
 if(!validArgs(args))throw Error('dieter_tiktok_invalid_source');
 const job=await env.DB.prepare('SELECT j.*,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?').bind(args.contentId).first<any>();
 if(!job||!reelScope(job).active.includes('tiktok')||job.content_url!==args.sourceUrl)throw Error('dieter_tiktok_assignment_mismatch');
 if(job.status==='working'&&job.claim_id===args.claimId)return job;
 const c=continuationId?await read(env,'dieter_cloud_continuation:'+continuationId):null;
 const start=continuationId?await read(env,'dieter_cloud_continuation:'+continuationId+':started'):null;
 const prior=continuationId?await read(env,'dieter_cloud_result:'+args.claimId+':continuation:'+continuationId):null;
 if(job.status!=='queued'||job.attempts!==3||!c?.owner_authorized||!c?.runtime_accepted||!c?.side_effect_assessment_accepted||c.content_id!==args.contentId||c.claim_id!==args.claimId||c.next_work_ordinal!==3||c.remaining_work_after!==0||start?.workflow_id!==c.workflow_id||prior?.work_runtime_completed!==true)throw Error('dieter_tiktok_original_continuation_required');
 return job;
}
export async function scheduleDieterTikTokTransport(env:Env,args:TikTokSource,continuationId?:string,afterCodeRepair=false){
 if(await stopped(env))throw Error('dieter_tiktok_runtime_incident_stop');
 await authorizedJob(env,args,continuationId);
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(args.contentId+'\n'+args.claimId+'\n'+args.sourceSha256)))].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32);
 let workflowId='dieter-tiktok-'+hash;
 let definition={args,continuation_id:continuationId??null,workflow_id:workflowId,provider:'tiktok',model_calls:0,first_provider_action:true};
 const key=definitionKey(hash);await putOnce(env,key,definition);
 const existing=await read(env,key);
 if(JSON.stringify(existing.args)!==JSON.stringify(args)||existing.continuation_id!==(continuationId??null)||existing.provider!=='tiktok'||existing.model_calls!==0)throw Error('dieter_tiktok_immutable_transport_conflict');
 definition=existing;workflowId=definition.workflow_id;
 // An instance that failed before its first durable assignment did not send
 // a provider request. After a code repair, allow one bounded execution
 // recovery, while the immutable source/provider operation stays the same.
 let previousStatus:any;try{previousStatus=await(await env.DIETER_CLOUD.get(workflowId)).status();}catch{}
 const ledger=await read(env,`ugc-tiktok-business:${args.contentId}:${args.sourceSha256}`);
 const started=await read(env,key+':started')||await read(env,key+':execution:'+workflowId+':started');
 const result=await read(env,key+':result');
 const executionNumber=workflowId.endsWith('-recovery-2')?3:workflowId.endsWith('-recovery-1')?2:1;
 const beforeAssignment=previousStatus?.status==='errored'&&!started;
 const repairedBeforeProvider=afterCodeRepair&&(previousStatus?.status==='errored'||previousStatus?.status==='complete'&&result?.tiktok_status==='blocked');
 if(!ledger&&executionNumber<3&&(beforeAssignment&&executionNumber===1||repairedBeforeProvider)){
  const next={...definition,workflow_id:'dieter-tiktok-'+hash+'-recovery-'+executionNumber};
  await putOnce(env,key+':prior-execution:'+workflowId,{definition,status:'terminal_before_provider_intent',provider_intents:0,after_code_repair:afterCodeRepair});
  await env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?').bind(JSON.stringify(next),Date.now(),key,JSON.stringify(definition)).run();
  definition=await read(env,key);workflowId=definition.workflow_id;
 }
 const params:TikTokTransportEvent={content_id:args.contentId,claim_id:args.claimId,transport:'tiktok',transport_id:hash};
 try{await env.DIETER_CLOUD.create({id:workflowId,params});}
 catch(error){try{await(await env.DIETER_CLOUD.get(workflowId)).status();}catch{throw error;}}
 return {workflow_id:workflowId,transport_id:hash,model_calls:0};
}
export async function finalizeDieterApiPublication(env:Env,contentId:string,claimId:string){
 return finishDieterUploads(env,contentId,claimId);
}
export async function runDieterTikTokTransport(env:Env,input:TikTokTransportEvent,workflowId:string,step:WorkflowStep){
 const definition=await step.do('read-api-transport-assignment',{retries:{limit:0,delay:'1 second'},timeout:'1 minute'},async()=>{
  if(!/^[a-f0-9]{32}$/.test(input.transport_id))throw Error('dieter_tiktok_invalid_transport');
  const d=await read(env,definitionKey(input.transport_id));
  if(!d||d.provider!=='tiktok'||d.model_calls!==0||d.workflow_id!==workflowId||d.args.contentId!==input.content_id||d.args.claimId!==input.claim_id)throw Error('dieter_tiktok_transport_mismatch');
  if(await stopped(env))throw Error('dieter_tiktok_runtime_incident_stop');
  const job=await authorizedJob(env,d.args,d.continuation_id??undefined);
  const lease=definitionKey(input.transport_id)+':execution:'+workflowId+':started',value=JSON.stringify({workflow_id:workflowId,model_calls:0,at:new Date().toISOString()});
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND (status='queued' OR (status='working' AND claim_id=?))) AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working' AND content_id<>?) AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked')) ON CONFLICT(key) DO NOTHING`).bind(lease,value,Date.now(),input.content_id,input.claim_id,input.content_id),
   env.DB.prepare(`UPDATE ugc_reel_jobs SET status='working',claim_id=?,consumer_id='cloudflare-dieter-v1',acknowledged_at=COALESCE(acknowledged_at,?),updated_at=? WHERE content_id=? AND status='queued' AND attempts=3 AND EXISTS(SELECT 1 FROM crm_sync_state WHERE key=? AND json_extract(value,'$.workflow_id')=?) AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')`).bind(input.claim_id,new Date().toISOString(),new Date().toISOString(),input.content_id,lease,workflowId),
  ]);
  if((await read(env,lease))?.workflow_id!==workflowId)throw Error('dieter_tiktok_transport_lease_conflict');
  return {...d,requires_rutube:reelScope(job).active.includes('rutube')};
 });
 // This is one first provider action, never another native/LLM work call.
 let result=await step.do('tiktok-publish-once',{retries:{limit:0,delay:'1 second'},timeout:'3 minutes'},async()=>await stopped(env)?{status:'blocked' as const,code:'dieter_tiktok_runtime_incident_stop'}:runDieterTikTokApi(env,definition.args,'publish'));
 const completion=await step.do('complete-accepted-uploads',{retries:{limit:0,delay:'1 second'},timeout:'1 minute'},()=>finalizeDieterApiPublication(env,input.content_id,input.claim_id));
 const receipt={...completion,tiktok_status:result.status,...('code' in result?{code:result.code}:{}),model_calls:0,workflow_id:workflowId};
 await putOnce(env,definitionKey(input.transport_id)+':execution:'+workflowId+':result',receipt);
 const current=await read(env,definitionKey(input.transport_id));
 if(current?.workflow_id===workflowId)await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(definitionKey(input.transport_id)+':result',JSON.stringify(receipt),Date.now()).run();
 return receipt;
}
export async function awaitsDieterApiCompletion(env:Env,contentId:string,claimId:string){
 const row=await env.DB.prepare('SELECT j.*,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?').bind(contentId).first<any>();
 if(row?.status!=='working'||row.claim_id!==claimId)return false;
 const proofs=reelPublicationProof(JSON.parse(row.publications??'[]'),row.content_url);
 const missing=reelScope(row).active.filter((p:string)=>!proofs?.some(x=>x.platform===p));
 if(!missing.length||missing.some((p:string)=>!['rutube','tiktok'].includes(p)))return false;
 if(missing.includes('rutube')&&!await read(env,`ugc-rutube-pending:${contentId}:${claimId}`))return false;
 if(missing.includes('tiktok')){
  const ledger=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE substr(key,1,length(?))=? AND json_valid(value) AND json_extract(value,'$.identity.claimId')=? LIMIT 1").bind(`ugc-tiktok-business:${contentId}:`,`ugc-tiktok-business:${contentId}:`,claimId).first<{value:string}>();
  if(!ledger||!['accepted','verified'].includes(JSON.parse(ledger.value).state))return false;
 }
 return true;
}
