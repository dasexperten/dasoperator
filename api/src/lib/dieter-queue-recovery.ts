// Owner 23.11.2026: recover the queue after runtime failures, never replay an
// uncertain upload. The failed claim stays held; only unrelated jobs resume.
import type {Env} from '../types';
import {sendOwnerTelegram} from './owner-telegram';

const STOP='dieter_cloud_runtime_stop', PREFLIGHT='dieter_cloud_preflight_blocked';
const NOTICE='dieter_queue_notice:', RECOVERY='dieter_queue_recovery:';
const RETRY_MS=3*60_000, MAX_ATTEMPTS=3;
async function row(env:Env,key:string){return env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<{value:string}>();}
function parse(raw:string){try{return JSON.parse(raw);}catch{return null;}}
async function once(env:Env,key:string,value:unknown,now:number){return env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,JSON.stringify(value),now).run();}
async function cas(env:Env,key:string,old:string,value:unknown,now:number){const r=await env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?').bind(JSON.stringify(value),now,key,old).run();return Boolean(r.meta.changes);}
const enabled=async(env:Env)=>(await row(env,'dieter_cloud_mode'))?.value==='enabled';
const validId=(id:unknown)=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
async function identity(key:string,raw:string){return key+':'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(x=>x.toString(16).padStart(2,'0')).join('');}

async function queueNotice(env:Env,id:string,text:string,now:number){
 await once(env,NOTICE+id,{state:'pending',attempts:0,next_at:now,text},now);
}
// Delivery failures have a durable three-attempt budget across ticks/restarts.
// A lost acknowledgement is not reported as delivered. A crashed in-flight send
// is never blindly repeated (Telegram itself has no idempotency key).
export async function flushDieterQueueNotices(env:Env,now=Date.now()){
 const rows=await env.DB.prepare("SELECT key,value FROM crm_sync_state WHERE key>=? AND key<? AND json_valid(value) AND json_extract(value,'$.state')='pending' AND json_extract(value,'$.attempts')<3 AND json_extract(value,'$.next_at')<=? ORDER BY updated_at LIMIT 3").bind(NOTICE,NOTICE+'\uffff',now).all<{key:string;value:string}>();
 let delivered=0;
 for(const old of rows.results??[]){
  const value=parse(old.value),sending={...value,state:'sending',attempts:value.attempts+1};
  if(!await cas(env,old.key,old.value,sending,now))continue;
  const ok=await sendOwnerTelegram(env,value.text);
  await cas(env,old.key,JSON.stringify(sending),{...sending,state:ok?'delivered':sending.attempts>=MAX_ATTEMPTS?'delivery_failed':'pending',next_at:now+RETRY_MS},now);
  if(ok)delivered++;
 }
 return {delivered};
}
export async function announceDieterRuntimeStop(env:Env,stop:any){
 if(!await enabled(env))return;
 const raw=JSON.stringify(stop),id=validId(stop?.claim_id)?stop.claim_id:await identity(STOP,raw);
 await queueNotice(env,id+':blocked','Шеф, исполнитель загрузки роликов прервался. Ролик с неизвестным результатом сохранён отдельно: повторно его не отправляю. Автоматически проверю исполнителя; остальные ролики продолжат по расписанию только после успешной проверки.',Date.now());
 await flushDieterQueueNotices(env);
}
export async function announceDieterPreflightStop(env:Env,reason='readiness_unavailable'){
 const now=Date.now();
 await once(env,PREFLIGHT,{reason,failed_attempts:1,at:new Date(now).toISOString(),automatic_retry:false},now);
 const blocked=(await row(env,PREFLIGHT))!;
 await queueNotice(env,await identity(PREFLIGHT,blocked.value)+':blocked','Шеф, очередь загрузки остановлена: исполнитель не подтвердил готовность или доступ к исходникам. Принятые отправки сохранены, повторных загрузок не будет. Требуется восстановить работу исполнителя.',now);
 await flushDieterQueueNotices(env,now);
}

type Readiness={ready?:boolean;activation_ready?:boolean;native_tools_verified?:boolean;drive?:{ready?:boolean};receipt?:{transport?:string;auth?:string;model?:string;mode?:string};checked_at?:string};
type Check=(claimId:string)=>Promise<Readiness>;
function ready(r:Readiness){return r?.ready===true&&r.activation_ready===true&&r.native_tools_verified===true&&r.drive?.ready===true&&r.receipt?.transport==='codex-native'&&r.receipt.auth==='subscription'&&r.receipt.model==='gpt-6.1-terra'&&r.receipt.mode==='preflight';}

export async function recoverDieterQueue(env:Env,check:Check,now=Date.now()){
 if(!await enabled(env))return {status:'disabled'};
 await flushDieterQueueNotices(env,now);
 const stopped=await row(env,STOP),blocked=await row(env,PREFLIGHT);
 if(!stopped&&!blocked)return {status:'healthy'};
 // Existing three failed preflights are already exhausted. Never grant a fourth
 // model/tool call merely because a clock or deployment restarted the watchdog.
 if(blocked){
  await announceDieterPreflightStop(env);
  await flushDieterQueueNotices(env,now);
  return {status:'blocked',reason:'preflight_attempts_exhausted'};
 }
 const stop=parse(stopped!.value);
 if(stop?.owner_hold||stop?.automatic_recovery===false)return {status:'owner_hold'};
 if(stop?.kind!=='runtime_incident_stop'||!validId(stop.claim_id)||!validId(stop.content_id)){
  await queueNotice(env,await identity(STOP,stopped!.value)+':blocked','Шеф, очередь загрузки остановлена, но данные сбоя неполны. Без безопасной проверки отправки не повторяю. Нужен разбор сохранённого состояния.',now);
  await flushDieterQueueNotices(env,now);return {status:'blocked',reason:'incident_identity_missing'};
 }
 const claim=stop.claim_id,key=RECOVERY+claim;
 // Preserve the exact failed job even if the process died between saving the
 // global stop and saving its individual hold. No counters/proofs are reset.
 await once(env,'dieter_cloud_execution_hold:'+stop.content_id,stop,now);
 const assignment=parse((await row(env,'dieter_cloud_assignment:'+claim))?.value??'');
 const workflowId=stop.continuation_id?parse((await row(env,'dieter_cloud_continuation:'+stop.continuation_id))?.value??'')?.workflow_id:assignment?.workflow_id;
 if(assignment?.claim_id!==claim||assignment.content_id!==stop.content_id||!validId(workflowId)){
  await queueNotice(env,claim+':blocked','Шеф, безопасное восстановление загрузки невозможно: не удалось подтвердить исходный проход. Ролик сохранён без повторной отправки; очередь остаётся остановленной.',now);
  await flushDieterQueueNotices(env,now);return {status:'blocked',reason:'assignment_unconfirmed'};
 }
 // Original native children/reconciliation may still be running after a lost
 // HTTP reply. An active/unknown workflow can never be bypassed by a new claim.
 let workflowStatus:string;
 try{workflowStatus=(await(await env.DIETER_CLOUD.get(workflowId)).status()).status;}catch{workflowStatus='unknown';}
 if(!['complete','errored','terminated'].includes(workflowStatus)){
  if(workflowStatus==='unknown'){
   await queueNotice(env,claim+':blocked','Шеф, не удалось подтвердить завершение прерванного прохода загрузки. Чтобы не создать дубли, новые отправки остановлены. Требуется проверить состояние исполнителя.',now);
   await flushDieterQueueNotices(env,now);
  }
  return {status:'waiting',reason:'original_workflow_not_terminal'};
 }
 if(await env.DB.prepare("SELECT content_id FROM ugc_reel_jobs WHERE status='working' LIMIT 1").first()){
  await queueNotice(env,claim+':blocked','Шеф, завершённый исполнитель оставил ролик в работе. Автоматически повторять его небезопасно; сохранённые отправки не трогаю. Требуется сверить состояние очереди.',now);
  await flushDieterQueueNotices(env,now);return {status:'blocked',reason:'active_claim_requires_reconciliation'};
 }
 await once(env,key,{state:'waiting',attempts:0,next_at:now,stop:stopped!.value,workflow_id:workflowId},now);
 const saved=(await row(env,key))!,state=parse(saved.value);
 if(state?.stop!==stopped!.value||!['waiting','checking','blocked','recovered'].includes(state?.state)||!Number.isInteger(state?.attempts)||state.attempts<0||state.attempts>MAX_ATTEMPTS){
  await queueNotice(env,claim+':blocked','Шеф, сохранённое состояние восстановления загрузки не прошло проверку. Очередь остаётся остановленной; повторных отправок не запускаю. Требуется разбор состояния.',now);
  await flushDieterQueueNotices(env,now);return {status:'blocked',reason:'invalid_recovery_state'};
 }
 if(state.state==='checking'){
  // A new handler seeing an unfinished durable probe must not reset its budget.
  await cas(env,key,saved.value,{...state,state:'blocked',reason:'probe_outcome_unknown'},now);
  await queueNotice(env,claim+':blocked','Шеф, проверка восстановления загрузки оборвалась без подтверждённого результата. Новые отправки не запускаю; очередь и принятые видео сохранены.',now);
  await flushDieterQueueNotices(env,now);return {status:'blocked',reason:'probe_outcome_unknown'};
 }
 if(['blocked','recovered'].includes(state.state)||state.attempts>=MAX_ATTEMPTS)return {status:'blocked',reason:state.reason??'attempts_exhausted'};
 if(state.next_at>now)return {status:'waiting',reason:'recovery_backoff'};
 const checking={...state,state:'checking',attempts:state.attempts+1,started_at:now};
 if(!await cas(env,key,saved.value,checking,now))return {status:'waiting',reason:'concurrent_check'};
 let readiness:Readiness|undefined,error='';
 try{readiness=await check(claim);}catch(e){error=String((e as Error)?.message??'');}
 if(!readiness||!ready(readiness)){
  const transient=error.includes('"error":"native_runner_unavailable"');
  const final=!transient||checking.attempts>=MAX_ATTEMPTS;
  await cas(env,key,JSON.stringify(checking),{...checking,state:final?'blocked':'waiting',next_at:now+RETRY_MS,reason:final?'readiness_not_confirmed':'runtime_unavailable'},now);
  await queueNotice(env,claim+':blocked','Шеф, восстановить загрузку пока не удалось: проверка исполнителя не прошла. Очередь и принятые видео сохранены. Допустимы только ограниченные проверки готовности; спорный ролик повторно не отправляется.',now);
  await flushDieterQueueNotices(env,now);return {status:final?'blocked':'waiting',reason:'readiness_not_confirmed',attempts:checking.attempts};
 }
 // Recheck every authority and active claim after the slow probe. Clearing a
 // superseding stop, a manual pause, or a different handler's result is forbidden.
 const current=(await row(env,key))?.value;
 if(current!==JSON.stringify(checking)||!await enabled(env))return {status:'blocked',reason:'recovery_authority_changed'};
 const deleted=await env.DB.prepare(`DELETE FROM crm_sync_state WHERE key=? AND value=?
  AND EXISTS(SELECT 1 FROM crm_sync_state WHERE key='dieter_cloud_mode' AND value='enabled')
  AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key='dieter_cloud_preflight_blocked')
  AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')
  AND EXISTS(SELECT 1 FROM crm_sync_state WHERE key=? AND value=?)`).bind(STOP,stopped!.value,key,current).run();
 if(!deleted.meta.changes)return {status:'blocked',reason:'recovery_compare_and_swap_failed'};
 await cas(env,key,current,{...checking,state:'recovered',completed_at:Date.now(),readiness,failed_job_held:true,provider_publish_calls:0},Date.now());
 await queueNotice(env,claim+':recovered','Шеф, исполнитель загрузки проверен, очередь восстановлена. Остальные ролики продолжат по прежнему расписанию. Ролик с неизвестным результатом оставлен отдельно, без повторной отправки.',now);
 await flushDieterQueueNotices(env,now);
 return {status:'recovered',failed_job_held:true,provider_publish_calls:0};
}
