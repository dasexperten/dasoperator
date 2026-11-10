import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {reelAssignment} from './lib/ugc-reel-store';
import {reelScope,reelPublicationProof} from './lib/ugc-reel-jobs.mjs';
import {diterWindow,START_INTERVAL_MS} from './lib/ugc-reel-store';

const CONSUMER='cloudflare-dieter-v1';
type Event={content_id:string;claim_id:string};
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
  if(await this.env.DB.prepare("SELECT key FROM crm_sync_state WHERE key='dieter_cloud_preflight_blocked'").first())return Response.json({ok:true,accepted:false,note:'preflight_blocked_after_three_failures'});
  const {now:inputNow,contentId=null}=await request.json() as {now?:number;contentId?:string|null};const now=inputNow??Date.now();
  if(!diterWindow(now))return Response.json({ok:true,accepted:false,note:'outside_window'});
  const busy=await this.env.DB.prepare("SELECT content_id,claim_id,consumer_id FROM ugc_reel_jobs WHERE status='working' LIMIT 1").first<any>();
  if(busy){
   if(busy.consumer_id===CONSUMER){
    const id='dieter-'+busy.claim_id;
    try{await(await this.env.DIETER_CLOUD.get(id)).status();}
    catch(e){if(!/not found|does not exist|not exist/i.test(String((e as Error).message)))throw e;
     await this.env.DIETER_CLOUD.create({id,params:{content_id:busy.content_id,claim_id:busy.claim_id}});}
   }
   return Response.json({ok:true,accepted:false,note:'working_job_exists'});
  }
  const pending=await this.env.DB.prepare("SELECT * FROM ugc_reel_jobs WHERE status='queued' AND attempts<3 AND (?1 IS NULL OR content_id=?1) ORDER BY requested_at,content_id LIMIT 1").bind(contentId).first<any>();
  if(!pending)return Response.json({ok:true,accepted:false,note:'empty'});
  const readiness=await preflightDieter(this.env); // A red job is never claimed for an unavailable runtime.
  if(readiness.activation_ready!==true)return Response.json({ok:true,accepted:false,note:'cloud_source_access_not_ready',reason:readiness.drive?.reason});
  if(!diterWindow(Date.now()))return Response.json({ok:true,accepted:false,note:'preflight_finished_outside_window'});
  const claim=crypto.randomUUID(),at=new Date(now).toISOString(),workflowId='dieter-'+claim;
  const accepted=await this.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='working',claim_id=?1,consumer_id=?2,started_at=?3,acknowledged_at=NULL,attempts=attempts+1,last_error=NULL,updated_at=?3
   WHERE content_id=?4 AND status='queued' AND attempts<3
   AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')
   AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE started_at>?5)`)
   .bind(claim,CONSUMER,at,pending.content_id,new Date(now-START_INTERVAL_MS).toISOString()).run();
  if(!accepted.meta.changes)return Response.json({ok:true,accepted:false,note:'busy_or_cooldown'});
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
  const assignment=await step.do('read-exact-assignment',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
   const job=await reelAssignment(this.env,CONSUMER,'https://dasoperator-api.dasexperten.workers.dev');
   if(!job||job.content_id!==input.content_id||job.claim_id!==input.claim_id)throw Error('dieter_exact_claim_missing');
   await this.env.DB.prepare("UPDATE ugc_reel_jobs SET acknowledged_at=?1 WHERE content_id=?2 AND claim_id=?3 AND consumer_id=?4 AND status='working'").bind(new Date().toISOString(),input.content_id,input.claim_id,CONSUMER).run();
   return job;
  });
  let error:string|null=null;
  for(let attempt=0;attempt<3;attempt++){
   const before=await step.do('read-result-'+attempt,()=>dieterOutcome(this.env,input));
   if(before.verified)return before;
   if(before.status!=='working')return before;
   const result=await step.do('native-dieter-'+attempt,{retries:{limit:0,delay:'1 second'},timeout:'18 minutes'},async()=>{
    if(!await mode(this.env))return {error:'cloud_disabled'};
    try{
     const result=await infer(this.env,'dieter-'+input.claim_id+'-'+attempt,{mode:attempt===0?'work':'reconcile',assignment});
     const key='dieter/cloud-round/'+input.claim_id+'/result-'+attempt+'.json';
     await this.env.DOCS.put(key,JSON.stringify(result));return {key};
    }catch(e){return {error:String((e as Error).message)};}
   });
   error=('error' in result?result.error:null)??null;
   if(error==='cloud_disabled')return {status:'paused',content_id:input.content_id};
  }
  return step.do('verify-saved-outcome',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
   const outcome=await dieterOutcome(this.env,input);
   if(outcome.verified)return outcome;
   if(outcome.status==='working')await this.env.DB.prepare("UPDATE ugc_reel_jobs SET status='queued',attempts=MAX(attempts,3),claim_id=NULL,consumer_id=NULL,acknowledged_at=NULL,last_error=?1,updated_at=?2 WHERE content_id=?3 AND status='working' AND claim_id=?4")
    .bind('Cloud round: '+(error??('unverified destinations: '+outcome.missing.join(', '))),new Date().toISOString(),input.content_id,input.claim_id).run();
   const final=await dieterOutcome(this.env,input);
   await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind('dieter_cloud_result:'+input.claim_id,JSON.stringify({...final,executor:'cloudflare_workflow',workflow_id:event.instanceId}),Date.now()).run();
   return final;
  });
 }
}
