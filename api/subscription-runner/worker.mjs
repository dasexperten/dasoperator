import { Container } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
const enc=new TextEncoder();
async function key(secret){return crypto.subtle.importKey('raw',Uint8Array.from(atob(secret),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function seal(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret),enc.encode(JSON.stringify(value)));return {iv:[...iv],data:[...new Uint8Array(data)]};}
async function unseal(value,secret){return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},await key(secret),new Uint8Array(value.data))));}
export class CodexRunner extends Container {
 defaultPort=8080;sleepAfter='20m';queue=Promise.resolve();
 async seed(auth){return this.serial(async()=>{if(await this.ctx.storage.get('auth'))throw Error('auth_already_seeded');if(auth?.auth_mode!=='chatgpt'||!auth.tokens?.refresh_token)throw Error('managed_chatgpt_auth_required');await this.ctx.storage.put('auth',await seal(auth,this.env.AUTH_KEY));return {seeded:true};});}
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 async contract(){return {version:'dieter-tools-v1',operations:['image','context','reply','dieter_round'],managed_login_present:Boolean(await this.ctx.storage.get('auth'))};}
 async runtimeCheck(){return this.serial(async()=>{
  try{
   await this.startAndWaitForPorts({ports:8080,cancellationOptions:{instanceGetTimeoutMS:120000,portReadyTimeoutMS:120000}});
   const response=await this.containerFetch('http://container/runtime-check',{method:'GET'},8080);
   if(!response.ok)throw Error('runtime_check_failed');
   const value=await response.json();
   if(value.version!=='stdin-safety-v1'||value.tools_ready!==true||value.dieter_stdin_safe!==true||value.diana_stdin_safe!==true||value.process_alive!==true||value.model_invocations!==0)throw Error('runtime_check_failed');
   const health=await this.containerFetch('http://container/health',{method:'GET'},8080);
   if(!health.ok||await health.text()!=='ok')throw Error('runtime_check_failed');
   return Response.json({version:'stdin-safety-v1',tools_ready:true,dieter_stdin_safe:true,diana_stdin_safe:true,process_alive:true,container_health_after:true,model_invocations:0});
  }catch{return Response.json({error:'runtime_check_failed'},{status:503});}
 });}
 async infer(body){return this.serial(async()=>{
  if(!body.requestId||!['image','context','reply','dieter_round','video_frames'].includes(body.operation)||!['gpt-6-luna','gpt-6.1-terra'].includes(body.model)||body.operation==='dieter_round'&&body.model!=='gpt-6.1-terra')return Response.json({error:'invalid_request',contract:'dieter-tools-v1',request_id_present:Boolean(body.requestId),operation_supported:['image','context','reply','dieter_round','video_frames'].includes(body.operation),model_supported:['gpt-6-luna','gpt-6.1-terra'].includes(body.model)},{status:400});
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(body))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const cacheKey='result:'+body.requestId;const previous=await this.ctx.storage.get(cacheKey);
  if(previous){if(previous.fingerprint!==fingerprint)return Response.json({error:'request_id_conflict'},{status:409});return Response.json(previous.result);}
  const acted=body.operation==='dieter_round'&&body.execution?.mode!=='preflight';
  const intentKey='dieter-intent:'+body.requestId;
  if(acted&&await this.ctx.storage.get(intentKey))return Response.json({error:'dieter_outcome_unknown_reconcile_only'},{status:409});
  let containerReady=false;
  {
   // Diana Direct and Dieter both require readiness before native inference.
   // The SDK's implicit placement wait is only 8s. Actual rollouts have
   // returned "no container instance" while the replacement was provisioning.
   // Wait for placement/ports and a real HTTP health response before any model
   // call. A preflight does not guarantee the next service call still has a
   // placed instance. Apply this once before work/reconciliation too, before
   // the durable intent; never replay an inference or upload.
   try{
    await this.startAndWaitForPorts({ports:8080,cancellationOptions:{instanceGetTimeoutMS:120000,portReadyTimeoutMS:120000}});
    const health=await this.containerFetch('http://container/health',{method:'GET'},8080);
    if(!health.ok||await health.text()!=='ok')throw Error('health_not_ready');
    containerReady=true;
   }catch(error){
    const message=String(error?.message??error),code=/no container instance/i.test(message)?'placement_unavailable':/not listening|port/i.test(message)?'port_not_ready':/health_not_ready/.test(message)?'health_not_ready':'startup_unavailable';
    const diagnostic={phase:'container_startup',code};
    console.log(JSON.stringify({diana_runner:true,op:body.operation,req:String(body.requestId).slice(0,24),outcome:'container_not_ready',diagnostic}));
    return Response.json({error:'native_runner_unavailable',diagnostic},{status:503});
   }
  }
  const encrypted=await this.ctx.storage.get('auth');if(!encrypted)return Response.json({error:'subscription_auth_not_seeded'},{status:503});
  const auth=await unseal(encrypted,this.env.AUTH_KEY);
  if(acted)await this.ctx.storage.put(intentKey,{at:Date.now(),fingerprint});
  // Owner 2026-11-06: every call leaves one log line (operation, model, wait, run time, outcome) so an outage has a cause on record.
  const t0=Date.now();const log=(outcome,extra={})=>console.log(JSON.stringify({diana_runner:true,op:body.operation,model:body.model,req:String(body.requestId).slice(0,24),run_ms:Date.now()-t0,outcome,...extra}));
  let response;try{response=await this.containerFetch(new Request('http://container/infer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,auth})}),8080);}catch(e){log('container_fetch_threw',{error:String(e?.message??e).slice(0,200)});throw e;}
  if(!response.ok){
   const raw=await response.text();let diagnostic;
   try{const d=JSON.parse(raw).diagnostic;if(d&&['read_request','parse_request','native_initialization','write_response'].includes(d.phase)&&['ENOSPC','EACCES','ENOENT','EMFILE','invalid_json','request_too_large','invalid_request','subscription_auth_required','unclassified'].includes(d.code))diagnostic={phase:d.phase,code:d.code};}catch{}
   if(!diagnostic)diagnostic=/no container instance/i.test(raw)?{phase:'container_startup',code:'placement_unavailable'}:
    /not listening|port.*not ready/i.test(raw)?{phase:'container_startup',code:'port_not_ready'}:
    {phase:'container_proxy',code:response.status===409?'busy':'http_unavailable'};
   log('container_http_'+response.status,{diagnostic});return Response.json({error:'native_runner_unavailable',diagnostic},{status:503});
  }
  const result=await response.json();
  if(containerReady)result.receipt={...result.receipt,container_health_verified:true};
  log(result.error?'error':'ok',result.error?{error:result.error,diagnostic:result.diagnostic}:{});
  // Persist native refresh before returning. Never expose the credential to callers.
  if(result.auth)await this.ctx.storage.put('auth',await seal(result.auth,this.env.AUTH_KEY));
  delete result.auth;
  if(result.privateEvents){
   const artifact='dieter/cloud-round/'+body.requestId+'/events.jsonl';
   await this.env.AUDIT.put(artifact,result.privateEvents,{httpMetadata:{contentType:'application/x-ndjson'}});
   delete result.privateEvents;result.auditArtifact=artifact;
  }
  if(result.error)return Response.json({error:result.error,diagnostic:result.diagnostic},{status:503});
  if(body.operation==='video_frames')return Response.json(result); // Large private frames never enter durable result cache.
  await this.ctx.storage.put(cacheKey,{fingerprint,result,at:Date.now()});
  const cached=await this.ctx.storage.list({prefix:'result:'});for(const [k,v] of cached)if(v.at<Date.now()-86400000)await this.ctx.storage.delete(k);
  return Response.json(result);
 });}
}
// Diana Direct owns the inference capability. Preserve the legacy entrypoint
// during staged rollout; the managed auth singleton remains shared with Dieter.
export class DirectInferenceService extends WorkerEntrypoint {
 async fetch(request){if(request.method!=='POST')return new Response('',{status:405});const body=await request.json();if(body.operation==='dieter_round')return Response.json({error:'use_dieter_execution_service'},{status:400});return this.env.RUNNER.getByName('subscription-singleton').infer(body);}
}
export class InferenceService extends DirectInferenceService {}
// A distinct internal capability for tool execution, sharing the same managed
// native login. Diana's inference entrypoint remains extraction/replies only.
export class DieterExecutionService extends WorkerEntrypoint {
 async fetch(request){
  const runner=this.env.RUNNER.getByName('subscription-singleton');
  if(request.method==='GET'&&new URL(request.url).pathname==='/contract')return Response.json(await runner.contract());
  if(request.method!=='POST')return new Response('',{status:405});
  const body=await request.json();if(body.operation!=='dieter_round')return Response.json({error:'dieter_operation_required'},{status:400});
  return runner.infer(body);
 }
}
export default {
 async fetch(request,env){
  if(!env.ADMIN_KEY || request.headers.get('Authorization')!==`Bearer ${env.ADMIN_KEY}`)return new Response('',{status:404});
  const runner=env.RUNNER.getByName('subscription-singleton');
  if(request.method==='POST'&&new URL(request.url).pathname==='/auth'){try{return Response.json(await runner.seed(await request.json()));}catch{return Response.json({error:'auth_seed_rejected'},{status:409});}}
  if(request.method==='GET'&&new URL(request.url).pathname==='/runtime-check')return runner.runtimeCheck();
  if(request.method==='POST'&&new URL(request.url).pathname==='/smoke')return runner.infer(await request.json());
  return new Response('',{status:404});
 }
};
