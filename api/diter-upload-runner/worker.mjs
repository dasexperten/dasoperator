import { Container } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
const enc=new TextEncoder();
export class DieterRunner extends Container {
 defaultPort=8080;sleepAfter='20m';queue=Promise.resolve();
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 async contract(){return {version:'dieter-tools-v1',operations:['dieter_round'],managed_login_present:Boolean(this.env.SUBSCRIPTION_DOOR_KEY)};}
 async runtimeCheck(){return this.serial(async()=>{
  try{
   await this.startAndWaitForPorts({ports:8080,cancellationOptions:{instanceGetTimeoutMS:120000,portReadyTimeoutMS:120000}});
   const response=await this.containerFetch('http://container/runtime-check',{method:'GET'},8080);
   if(!response.ok)throw Error('runtime_check_failed');
   const value=await response.json();
   if(value.version!=='dieter-only-stdin-v1'||value.tools_ready!==true||value.dieter_stdin_safe!==true||value.process_alive!==true||value.model_invocations!==0)throw Error('runtime_check_failed');
   const health=await this.containerFetch('http://container/health',{method:'GET'},8080);
   if(!health.ok||await health.text()!=='ok')throw Error('runtime_check_failed');
   return Response.json({version:'dieter-only-stdin-v1',tools_ready:true,dieter_stdin_safe:true,process_alive:true,container_health_after:true,model_invocations:0});
  }catch{return Response.json({error:'runtime_check_failed'},{status:503});}
 });}
 async finishResult(requestId,fingerprint,result){
  delete result.auth;delete result.subscriptionDoorKey;
  if(result.privateEvents){
   const artifact='dieter/cloud-round/'+requestId+'/events.jsonl';
   await this.env.AUDIT.put(artifact,result.privateEvents,{httpMetadata:{contentType:'application/x-ndjson'}});
   delete result.privateEvents;result.auditArtifact=artifact;
  }
  if(result.error)return Response.json({error:result.error,diagnostic:result.diagnostic},{status:503});
  await this.ctx.storage.put('result:'+requestId,{fingerprint,result,at:Date.now()});
  const cached=await this.ctx.storage.list({prefix:'result:'});for(const [k,v] of cached)if(v.at<Date.now()-86400000)await this.ctx.storage.delete(k);
  return Response.json(result);
 }
 async readResult(requestId){return this.serial(async()=>{
  if(typeof requestId!=='string'||!requestId||requestId.length>512)return Response.json({error:'invalid_request'},{status:400});
  const previous=await this.ctx.storage.get('result:'+requestId);if(previous)return Response.json(previous.result);
  const intent=await this.ctx.storage.get('dieter-intent:'+requestId);
  if(!intent)return Response.json({error:'dieter_result_not_accepted'},{status:404});
  const response=await this.cachedContainerResult(requestId);if(!response)return Response.json({error:'dieter_outcome_unknown_reconcile_only'},{status:409});
  let result;try{result=await response.json();}catch{return Response.json({error:'native_runner_unavailable',diagnostic:{phase:'parse_request',code:'invalid_json'}},{status:503});}
  result.receipt={...result.receipt,container_health_verified:true};
  return this.finishResult(requestId,intent.fingerprint,result);
 });}
 async cachedContainerResult(requestId){
  const budgetKey='result-read-budget:'+requestId;const used=await this.ctx.storage.get(budgetKey)||0;
  if(used>=3)return null;await this.ctx.storage.put(budgetKey,used+1);
  try{const response=await this.containerFetch('http://container/result/'+encodeURIComponent(requestId),{method:'GET'},8080);return response.ok?response:null;}catch{return null;}
 }
 async infer(body){return this.serial(async()=>{
  if(!body.requestId||body.operation!=='dieter_round'||body.model!=='gpt-6.1-terra'||body.operation==='dieter_round'&&body.model!=='gpt-6.1-terra')return Response.json({error:'invalid_request',contract:'dieter-tools-v1',request_id_present:Boolean(body.requestId),operation_supported:body.operation==='dieter_round',model_supported:body.model==='gpt-6.1-terra'},{status:400});
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(body))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const cacheKey='result:'+body.requestId;const previous=await this.ctx.storage.get(cacheKey);
  if(previous){if(previous.fingerprint!==fingerprint)return Response.json({error:'request_id_conflict'},{status:409});return Response.json(previous.result);}
  const acted=body.operation==='dieter_round'&&body.execution?.mode!=='preflight';
  const intentKey='dieter-intent:'+body.requestId;
  const intent=acted?await this.ctx.storage.get(intentKey):null;
  if(intent&&intent.fingerprint!==fingerprint)return Response.json({error:'request_id_conflict'},{status:409});
  let containerReady=false;
  if(body.operation==='dieter_round'){
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
    console.log(JSON.stringify({dieter_runner:true,op:body.operation,req:String(body.requestId).slice(0,24),outcome:'container_not_ready',diagnostic}));
    return Response.json({error:'native_runner_unavailable',diagnostic},{status:503});
   }
  }
  if(!this.env.SUBSCRIPTION_DOOR_KEY)return Response.json({error:'subscription_auth_required'},{status:503});
  if(acted&&!intent)await this.ctx.storage.put(intentKey,{at:Date.now(),fingerprint});
  // Owner 2026-11-06: every call leaves one log line (operation, model, wait, run time, outcome) so an outage has a cause on record.
  const t0=Date.now();const log=(outcome,extra={})=>console.log(JSON.stringify({dieter_runner:true,op:body.operation,model:body.model,req:String(body.requestId).slice(0,24),run_ms:Date.now()-t0,outcome,...extra}));
  let response=intent?await this.cachedContainerResult(body.requestId):null;
  if(intent&&!response)return Response.json({error:'dieter_outcome_unknown_reconcile_only'},{status:409});
  if(!intent)try{response=await this.containerFetch(new Request('http://container/infer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,subscriptionDoorKey:this.env.SUBSCRIPTION_DOOR_KEY})}),8080);}catch{response=await this.cachedContainerResult(body.requestId);if(!response){const diagnostic={phase:'container_proxy',code:'http_unavailable'};log('container_fetch_threw',{diagnostic});return Response.json({error:'native_runner_unavailable',diagnostic},{status:503});}}
  if(!response.ok){
   const raw=await response.text();let diagnostic;
   try{const d=JSON.parse(raw).diagnostic;if(d&&['read_request','parse_request','native_initialization','write_response'].includes(d.phase)&&['ENOSPC','EACCES','ENOENT','EMFILE','invalid_json','request_too_large','invalid_request','subscription_auth_required','unclassified'].includes(d.code))diagnostic={phase:d.phase,code:d.code};}catch{}
   if(!diagnostic)diagnostic=/no container instance/i.test(raw)?{phase:'container_startup',code:'placement_unavailable'}:
    /not listening|port.*not ready/i.test(raw)?{phase:'container_startup',code:'port_not_ready'}:
    {phase:'container_proxy',code:response.status===409?'busy':'http_unavailable'};
   log('container_http_'+response.status,{diagnostic});return Response.json({error:'native_runner_unavailable',diagnostic},{status:503});
  }
  let result;try{result=await response.json();}catch{const cached=await this.cachedContainerResult(body.requestId);if(!cached)return Response.json({error:'native_runner_unavailable',diagnostic:{phase:'container_proxy',code:'http_unavailable'}},{status:503});try{result=await cached.json();}catch{return Response.json({error:'native_runner_unavailable',diagnostic:{phase:'parse_request',code:'invalid_json'}},{status:503});}}
  if(containerReady)result.receipt={...result.receipt,container_health_verified:true};
  log(result.error?'error':'ok',result.error?{error:result.error,diagnostic:result.diagnostic}:{});
  return this.finishResult(body.requestId,fingerprint,result);
 });}
}
export class DieterExecutionService extends WorkerEntrypoint {
 async fetch(request){
  const runner=this.env.RUNNER.getByName('subscription-singleton');
  if(request.method==='GET'&&new URL(request.url).pathname==='/contract')return Response.json(await runner.contract());
  if(request.method==='GET'){const match=new URL(request.url).pathname.match(/^\/result\/([^/]+)$/);if(match){let id;try{id=decodeURIComponent(match[1]);}catch{return Response.json({error:'invalid_request'},{status:400});}return runner.readResult(id);}}
  if(request.method!=='POST')return new Response('',{status:405});
  const body=await request.json();if(body.operation!=='dieter_round')return Response.json({error:'dieter_operation_required'},{status:400});
  return runner.infer(body);
 }
}
export default {
 async fetch(request,env){
  if(!env.ADMIN_KEY || request.headers.get('Authorization')!==`Bearer ${env.ADMIN_KEY}`)return new Response('',{status:404});
  const runner=env.RUNNER.getByName('subscription-singleton');
  if(request.method==='GET'&&new URL(request.url).pathname==='/runtime-check')return runner.runtimeCheck();
  if(request.method==='POST'&&new URL(request.url).pathname==='/smoke')return runner.infer(await request.json());
  return new Response('',{status:404});
 }
};
