import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {reelAssignment} from './lib/ugc-reel-store';
import {reelScope,reelPublicationProof} from './lib/ugc-reel-jobs.mjs';
import {diterWindow,START_INTERVAL_MS} from './lib/ugc-reel-store';
import {runDieterTikTokTransport,awaitsDieterApiCompletion,finalizeDieterApiPublication,type TikTokTransportEvent} from './dieter-tiktok-workflow';
import {reconcileDieterRutubeStatus} from './lib/dieter-rutube-status';

const CONSUMER='cloudflare-dieter-v1';
type Event={content_id:string;claim_id:string;continuation_id?:string;transport?:'tiktok';transport_id?:string};
const RUNTIME_STOP='dieter_cloud_runtime_stop';
const executionHold=(id:string)=>'dieter_cloud_execution_hold:'+id;
async function runtimeStopped(env:Env){
 if(await env.DB.prepare('SELECT key FROM crm_sync_state WHERE key=?').bind(RUNTIME_STOP).first())return true;
 return (await getRecord(env,'dieter_cloud_preflight_blocked'))?.kind==='runtime_incident_stop';
}
async function getRecord(env:Env,key:string){const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<{value:string}>();return row?JSON.parse(row.value):null;}
async function putRecord(env:Env,key:string,value:unknown){return env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING').bind(key,JSON.stringify(value),Date.now()).run();}
function safeNativeFailure(error:unknown){
 const message=String((error as Error)?.message??error);
 let source:any;try{source=JSON.parse(message.replace(/^dieter_native_runtime:/,''));}catch{}
 const allowed=['native_runner_unavailable','dieter_outcome_unknown_reconcile_only','request_id_conflict','subscription_auth_not_seeded','dieter_native_turn_incomplete'];
 const code=allowed.includes(source?.error)?source.error:/Durable Object reset/i.test(message)?'deployment_reset':'native_call_outcome_unknown';
 const d=source?.diagnostic;
 return {error:code,...(d&&['container_startup','container_proxy','read_request','parse_request','native_initialization','write_response'].includes(d.phase)&&['placement_unavailable','port_not_ready','health_not_ready','startup_unavailable','busy','http_unavailable','ENOSPC','EACCES','ENOENT','EMFILE','invalid_json','request_too_large','invalid_request','subscription_auth_required','unclassified'].includes(d.code)?{diagnostic:{phase:d.phase,code:d.code}}:{})};
}
async function stopRuntime(env:Env,input:Event,record:unknown){
 const value={kind:'runtime_incident_stop',...input,first_failure:record,automatic_retry:false,at:new Date().toISOString()};
 await putRecord(env,RUNTIME_STOP,value);
 // An uncertain work outcome cannot be bypassed by a later clock/claim even
 // after the shared runtime is repaired. Reconciliation retains this claim.
 await putRecord(env,executionHold(input.content_id),value);
}
async function activateContinuation(env:Env,input:Event,workflowId:string){
 const id=input.continuation_id;
 if(!id||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw Error('invalid_dieter_continuation');
 const key='dieter_cloud_continuation:'+id,c=await getRecord(env,key);
 if(!c||c.state!=='ready'||c.content_id!==input.content_id||c.claim_id!==input.claim_id||c.workflow_id!==workflowId||c.owner_authorized!==true||c.runtime_accepted!==true||c.side_effect_assessment_accepted!==true||c.raw_attempts!==3||c.observed_work_rpcs!==2||c.next_work_ordinal!==3||c.remaining_work_after!==0||!Array.isArray(c.previous_claim_ids)||c.previous_claim_ids.length!==2||new Set(c.previous_claim_ids).size!==2||c.previous_claim_ids.some((claim:unknown)=>typeof claim!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(claim))||!c.previous_claim_ids.includes(input.claim_id))throw Error('dieter_continuation_not_authorized');
 if(await runtimeStopped(env))throw Error('dieter_runtime_incident_stop');
 for(const previous of c.previous_claim_ids){
  const receipt=await getRecord(env,'dieter_cloud_assignment:'+previous);
  if(receipt?.content_id!==input.content_id||receipt?.claim_id!==previous)throw Error('dieter_continuation_history_mismatch');
 }
 const startKey=key+':started',ordinalKey='dieter_cloud_work_ordinal:'+input.content_id+':3';
 const start=JSON.stringify({workflow_id:workflowId,continuation_id:id,at:new Date().toISOString()});
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=?4 AND status='queued' AND attempts=3) AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working' OR started_at>?6) AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked',?5)) ON CONFLICT(key) DO NOTHING`).bind(startKey,start,Date.now(),input.content_id,ordinalKey,new Date(Date.now()-START_INTERVAL_MS).toISOString()),
  env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM crm_sync_state WHERE key=?4 AND json_extract(value,'$.workflow_id')=?5) ON CONFLICT(key) DO NOTHING`).bind(ordinalKey,start,Date.now(),startKey,workflowId),
  env.DB.prepare(`UPDATE ugc_reel_jobs SET status='working',claim_id=?1,consumer_id=?2,acknowledged_at=NULL,last_error=NULL,updated_at=?3 WHERE content_id=?4 AND status='queued' AND attempts=3 AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working') AND EXISTS(SELECT 1 FROM crm_sync_state WHERE key=?5 AND json_extract(value,'$.workflow_id')=?6) AND EXISTS(SELECT 1 FROM crm_sync_state WHERE key=?7 AND json_extract(value,'$.workflow_id')=?6) AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked'))`).bind(input.claim_id,CONSUMER,new Date().toISOString(),input.content_id,startKey,workflowId,ordinalKey),
 ]);
 const started=await getRecord(env,startKey),ordinal=await getRecord(env,ordinalKey);
 if(started?.workflow_id!==workflowId||ordinal?.workflow_id!==workflowId)throw Error('dieter_continuation_already_consumed');
 return c;
}
async function mode(env:Env){return (await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='dieter_cloud_mode'").first<{value:string}>())?.value==='enabled';}
async function infer(env:Env,requestId:string,execution:Record<string,unknown>){
 const response=await env.DIETER_SUBSCRIPTION.fetch('https://subscription.internal/infer',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({requestId,operation:'dieter_round',model:'gpt-6.1-terra',execution:{...execution,githubToken:(env as any).GITHUB_TOKEN,serviceSecret:env.EMAILER_SERVICE_SECRET,privateFiles:JSON.parse((env as any).DIETER_PRIVATE_FILES??'{}')}})});
 const result=await response.json<any>();
 if(!response.ok){
  const d=result.diagnostic;
  const diagnostic=d&&['container_startup','container_proxy','read_request','parse_request','native_initialization','write_response'].includes(d.phase)&&['placement_unavailable','port_not_ready','health_not_ready','startup_unavailable','busy','http_unavailable','ENOSPC','EACCES','ENOENT','EMFILE','invalid_json','request_too_large','invalid_request','subscription_auth_required','unclassified'].includes(d.code)?{phase:d.phase,code:d.code}:undefined;
  throw Error('dieter_native_runtime:'+JSON.stringify({error:result.error??response.status,diagnostic,contract:result.contract,request_id_present:result.request_id_present,operation_supported:result.operation_supported,model_supported:result.model_supported}));
 }
 return result;
}
export async function preflightDieter(env:Env,pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))){
 if(await runtimeStopped(env))throw Error('dieter_runtime_incident_stop');
 if(await env.DB.prepare("SELECT key FROM crm_sync_state WHERE key='dieter_cloud_preflight_blocked'").first())throw Error('dieter_preflight_blocked_after_three_failures');
 let result:any;
 // This read-only tool/source probe may recover a transient container HTTP
 // failure. Never apply this retry to a work/reconciliation call.
 for(let attempt=0;attempt<3;attempt++){
  try{result=await infer(env,'dieter-preflight-'+crypto.randomUUID(),{mode:'preflight'});break;}
  catch(error){
   if(!String((error as Error).message).includes('"error":"native_runner_unavailable"'))throw error;
   if(attempt===2){
    await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('dieter_cloud_preflight_blocked',?1,?2) ON CONFLICT(key) DO NOTHING").bind(JSON.stringify({reason:'native_runner_unavailable',failed_attempts:3,at:new Date().toISOString(),automatic_retry:false}),Date.now()).run();
    throw error;
   }
   await pause(1000);
  }
 }
 const readiness=JSON.parse(result.text);if(readiness.ready!==true)throw Error('dieter_runtime_not_ready');
 const receipt={...readiness,receipt:result.receipt,checked_at:new Date().toISOString()};
 await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('dieter_cloud_readiness',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(receipt),Date.now()).run();
 return receipt;
}

// Called through one Durable Object; all database acceptance predicates remain
// atomic as well. No new clock, ad hoc start or change to saved historical scope.
export class DieterWake {
 queue:Promise<unknown>=Promise.resolve();
 constructor(readonly state:DurableObjectState,readonly env:Env){}
 fetch(request:Request){const next=this.queue.then(()=>this.handle(request));this.queue=next.catch(()=>undefined);return next;}
 async handle(request:Request){
  const url=new URL(request.url);
  if(url.pathname==='/preflight')return Response.json({ok:true,...await preflightDieter(this.env)});
  if(url.pathname!=='/dispatch')return new Response('',{status:404});
  if(!await mode(this.env))return Response.json({ok:true,accepted:false,note:'cloud_disabled'});
  if(await runtimeStopped(this.env))return Response.json({ok:true,accepted:false,note:'runtime_incident_stop'});
  if(await this.env.DB.prepare("SELECT key FROM crm_sync_state WHERE key='dieter_cloud_preflight_blocked'").first())return Response.json({ok:true,accepted:false,note:'preflight_blocked_after_three_failures'});
  const {now:inputNow,contentId=null}=await request.json() as {now?:number;contentId?:string|null};const now=inputNow??Date.now();
  const onceKey=contentId?'dieter_manual_once:'+contentId:null;
  const once=onceKey?await getRecord(this.env,onceKey):null;
  const manual=Boolean(once&&once.content_id===contentId&&once.state==='ready'&&Date.parse(once.expires_at)>Date.now());
  if(!manual&&!diterWindow(now))return Response.json({ok:true,accepted:false,note:'outside_window'});
  const busy=await this.env.DB.prepare("SELECT content_id,claim_id,consumer_id FROM ugc_reel_jobs WHERE status='working' LIMIT 1").first<any>();
  if(busy){
   if(await getRecord(this.env,executionHold(busy.content_id)))return Response.json({ok:true,accepted:false,note:'execution_requires_reconciliation'});
   if(busy.consumer_id===CONSUMER){
    const id='dieter-'+busy.claim_id;
    try{await(await this.env.DIETER_CLOUD.get(id)).status();}
    catch(e){if(!/not found|does not exist|not exist/i.test(String((e as Error).message)))throw e;
     await this.env.DIETER_CLOUD.create({id,params:{content_id:busy.content_id,claim_id:busy.claim_id}});}
   }
   return Response.json({ok:true,accepted:false,note:'working_job_exists'});
  }
  const pending=await this.env.DB.prepare("SELECT * FROM ugc_reel_jobs WHERE status='queued' AND attempts<3 AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key='dieter_cloud_execution_hold:'||ugc_reel_jobs.content_id) AND (?1 IS NULL OR content_id=?1) ORDER BY requested_at,content_id LIMIT 1").bind(contentId).first<any>();
  if(!pending)return Response.json({ok:true,accepted:false,note:'empty'});
  const readiness=await preflightDieter(this.env); // A red job is never claimed for an unavailable runtime.
  if(readiness.activation_ready!==true)return Response.json({ok:true,accepted:false,note:'cloud_source_access_not_ready',reason:readiness.drive?.reason});
  if(!manual&&!diterWindow(Date.now()))return Response.json({ok:true,accepted:false,note:'preflight_finished_outside_window'});
  if(await runtimeStopped(this.env))return Response.json({ok:true,accepted:false,note:'runtime_incident_stop'});
  const claim=crypto.randomUUID(),at=new Date(now).toISOString(),workflowId='dieter-'+claim;
  const accepted=await this.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='working',claim_id=?1,consumer_id=?2,started_at=?3,acknowledged_at=NULL,attempts=attempts+1,last_error=NULL,updated_at=?3
   WHERE content_id=?4 AND status='queued' AND attempts<3
   AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')
   AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked') OR key='dieter_cloud_execution_hold:'||?4)
   AND (?6=0 OR EXISTS(SELECT 1 FROM crm_sync_state WHERE key=?7 AND json_extract(value,'$.state')='ready' AND json_extract(value,'$.expires_at')>?3))
   AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE started_at>?5)`)
   .bind(claim,CONSUMER,at,pending.content_id,new Date(now-START_INTERVAL_MS).toISOString(),manual?1:0,onceKey).run();
  if(!accepted.meta.changes)return Response.json({ok:true,accepted:false,note:'busy_or_cooldown'});
  if(manual)await this.env.DB.prepare("UPDATE crm_sync_state SET value=json_set(value,'$.state','consumed','$.claim_id',?),updated_at=? WHERE key=? AND json_extract(value,'$.state')='ready'").bind(claim,Date.now(),onceKey).run();
  // Exact instance identity is recoverable if create acknowledgement is lost.
  await this.env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING").bind('dieter_cloud_assignment:'+claim,JSON.stringify({workflow_id:workflowId,content_id:pending.content_id,claim_id:claim}),Date.now()).run();
  try{await this.env.DIETER_CLOUD.create({id:workflowId,params:{content_id:pending.content_id,claim_id:claim}});}
  catch(error){try{await(await this.env.DIETER_CLOUD.get(workflowId)).status();}catch{throw error;}}
  return Response.json({ok:true,accepted:true,executor:'cloudflare_workflow',workflow_id:workflowId,content_id:pending.content_id});
 }
}

export async function dieterOutcome(env:Env,event:Event){
 const row=await env.DB.prepare('SELECT * FROM ugc_reel_jobs WHERE content_id=?1').bind(event.content_id).first<any>();
 if(!row)throw Error('dieter_job_missing');
 if(['working','published'].includes(row.status)&&row.claim_id!==event.claim_id)throw Error('dieter_claim_changed');
 const proofs=reelPublicationProof(JSON.parse(row.publications??'[]'),(await env.DB.prepare('SELECT content_url FROM ugc_content WHERE id=?1').bind(event.content_id).first<{content_url:string}>())?.content_url??'');
 const missing=reelScope(row).active.filter((p:string)=>!proofs?.some(x=>x.platform===p));
 return {status:row.status,verified:row.status==='published'&&missing.length===0,missing,attempts:row.attempts,last_error:row.last_error};
}
export class DieterCloudWorkflow extends WorkflowEntrypoint<Env,Event>{
 async run(event:WorkflowEvent<Event>,step:WorkflowStep){
  const input=event.payload;
  if(input.transport==='tiktok')return runDieterTikTokTransport(this.env,input as TikTokTransportEvent,event.instanceId,step);
  const assignment=await step.do('read-exact-assignment',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
   const continuation=input.continuation_id?await activateContinuation(this.env,input,event.instanceId):null;
   const job=await reelAssignment(this.env,CONSUMER,'https://dasoperator-api.dasexperten.workers.dev');
   if(!job||job.content_id!==input.content_id||job.claim_id!==input.claim_id)throw Error('dieter_exact_claim_missing');
   await this.env.DB.prepare("UPDATE ugc_reel_jobs SET acknowledged_at=?1 WHERE content_id=?2 AND claim_id=?3 AND consumer_id=?4 AND status='working'").bind(new Date().toISOString(),input.content_id,input.claim_id,CONSUMER).run();
   return continuation?{...job,continuation,task:job.task+'\nCONTROLLED CONTINUATION: this is the third and final work call for this original content, after verified runtime repair and independent seven-platform inventory review. Keep the existing claim, raw attempts and clocks. Recheck each destination inventory and any known pending IDs immediately BEFORE its first provider intent; reuse existing verified posts. A match or uncertain response permits reconciliation only on that destination, while independently safe destinations continue. Save each provider ID and ERP proof immediately. Never repeat an ambiguous upload. No fourth work call. The source remains the archived full original. Create/read back the current exact-claim caption plan before publication, including exact source credit in the Facebook description.'}:job;
  });
  const executionKey=input.continuation_id?input.claim_id+':continuation:'+input.continuation_id:input.claim_id;
  work:for(let attempt=0;attempt<(input.continuation_id?2:3);attempt++){
   const before=await step.do('read-result-'+attempt,()=>dieterOutcome(this.env,input));
   if(before.verified||before.status!=='working')break;
   if(attempt>0&&await awaitsDieterApiCompletion(this.env,input.content_id,input.claim_id)){
    // Known provider IDs are being finalized by API-only Workflows. Release
    // the model/container and wait for saved public proof, not another LLM.
    for(let wait=0;wait<3;wait++){
     if(wait>0)await step.sleep('api-completion-wait-'+wait,'2 minutes');
     await step.do('api-known-provider-reconcile-'+wait,{retries:{limit:0,delay:'1 second'},timeout:'1 minute'},async()=>{
      if(await getRecord(this.env,`ugc-rutube-pending:${input.content_id}:${input.claim_id}`))await reconcileDieterRutubeStatus(this.env,{contentId:input.content_id,claimId:input.claim_id});
      return finalizeDieterApiPublication(this.env,input.content_id,input.claim_id);
     });
     const after=await step.do('api-completion-result-'+wait,()=>dieterOutcome(this.env,input));
     if(after.verified||after.status!=='working')break work;
    }
    const pending={status:'awaiting_api_completion',publication_verified:false,content_id:input.content_id,claim_id:input.claim_id,model_calls_after_work:0,executor:'cloudflare_workflow'};
    await putRecord(this.env,'dieter_cloud_api_pending:'+executionKey,pending);return pending;
   }
   const action=await step.do('native-dieter-'+attempt,{retries:{limit:0,delay:'1 second'},timeout:'18 minutes'},async()=>{
    const actionMode=attempt===0?'work':'reconcile';
    const requestId=input.continuation_id?'dieter-continuation-'+input.continuation_id+'-'+attempt:'dieter-'+input.claim_id+'-'+attempt;
    const prefix='dieter_cloud_attempt:'+executionKey+':'+attempt;
    const previous=await getRecord(this.env,prefix+':outcome');
    if(previous){
     // Recover the crash gap after an outcome was committed but before its
     // shared stop/claim hold was saved. Returning a cache entry must not
     // reopen the same uncertain action through a subsequent clock.
     if(previous.outcome!=='completed')await stopRuntime(this.env,input,previous);
     return previous;
    }
    if(!await mode(this.env))return {outcome:'paused'};
    if(actionMode==='work'&&(await runtimeStopped(this.env)||!input.continuation_id&&await getRecord(this.env,executionHold(input.content_id))))return {outcome:'blocked'};
    const identity={...input,mode:actionMode,request_id:requestId,index:attempt};
    const accepted=await putRecord(this.env,prefix+':intent',{...identity,started_at:new Date().toISOString()});
    let result:any;
    if(!accepted.meta.changes){
     // A step restart cannot repeat an unknown action. Only subsequent
     // deterministic read-only reconciliation modes may call the runtime.
     result={...identity,outcome:'unknown',error:'native_call_outcome_unknown'};
    }else{
     try{
      const native=await infer(this.env,requestId,{mode:actionMode,assignment});
      const key='dieter/cloud-round/'+executionKey+'/result-'+attempt+'.json';
      await this.env.DOCS.put(key,JSON.stringify(native));
      result={...identity,outcome:'completed',key};
     }catch(error){result={...identity,outcome:'runtime_error',...safeNativeFailure(error)};}
    }
    const record={...result,completed_at:new Date().toISOString()};
    if(record.outcome!=='completed')await stopRuntime(this.env,input,record);
    await putRecord(this.env,prefix+':outcome',record);
    return record;
   });
   if(['paused','blocked'].includes(action.outcome)){
    const result={status:action.outcome,content_id:input.content_id,claim_id:input.claim_id,publication_verified:false,runtime_completed:false,material_result:'not_assessed',continuation_required:true,next_allowed_mode:'reconcile',retry_work:false,executor:'cloudflare_workflow'};
    await putRecord(this.env,'dieter_cloud_blocked:'+input.claim_id,result);
    return result;
   }
  }
  return step.do('verify-saved-outcome',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
   const records=[];
   for(let index=0;index<3;index++){
    const record=await getRecord(this.env,'dieter_cloud_attempt:'+executionKey+':'+index+':outcome');
    if(record)records.push(record);
   }
   const firstWorkFailure=records.find(record=>record.mode==='work'&&record.outcome!=='completed')??null;
   const firstFailure=firstWorkFailure??records.find(record=>record.outcome!=='completed')??null;
   const outcome=await dieterOutcome(this.env,input);
   if(!outcome.verified&&outcome.status==='working'){
    const reason=firstFailure?'Cloud runtime: '+firstFailure.error+'; reconciliation did not verify publication':'Cloud execution incomplete; missing verified destinations: '+outcome.missing.join(', ');
    // attempts counts accepted claims only. Read-only reconciliation modes
    // never manufacture further publication attempts or blame the material.
    await this.env.DB.prepare("UPDATE ugc_reel_jobs SET status='queued',claim_id=NULL,consumer_id=NULL,acknowledged_at=NULL,last_error=?1,updated_at=?2 WHERE content_id=?3 AND status='working' AND claim_id=?4")
     .bind(reason,new Date().toISOString(),input.content_id,input.claim_id).run();
   }
   const final=await dieterOutcome(this.env,input);
   const result={...final,publication_verified:final.verified,
    runtime_completed:records.some(record=>record.outcome==='completed'),
    work_runtime_completed:records.some(record=>record.mode==='work'&&record.outcome==='completed'),
    reconciliation_completed:records.some(record=>record.mode==='reconcile'&&record.outcome==='completed'),
    execution_result:final.verified?'publication_verified':firstFailure?'runtime_error':'incomplete',
    runtime_incident_present:Boolean(firstFailure),
    material_result:final.verified?'published':firstFailure?'not_assessed':'unverified',
    first_work_failure:firstWorkFailure,first_runtime_failure:firstFailure,
    actions:records,continuation_id:input.continuation_id,executor:'cloudflare_workflow',workflow_id:event.instanceId};
   await putRecord(this.env,'dieter_cloud_result:'+executionKey,result);
   return result;
  });
 }
}
