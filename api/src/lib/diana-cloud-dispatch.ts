import type { Env } from '../types';
import { pendingDianaMessages } from './diana-alarm';
import { igDeliveryKey } from './ig-dm-delivery';
import { dianaWorkWindow } from './diana-work-window.mjs';
import { readDianaCloudLock, releaseDianaCloud, reserveDianaCloud, recoverDianaCloudLock } from './diana-cloud-lock';

// Confirm the still-current original in Meta before allowing a legacy free-text
// needs_review into the narrow video recovery path. Network failures are not
// evidence that a message is safe to replay.
export async function latestOriginalRecoveryKind(env:Env,event:any):Promise<'video'|'text'|'unsupported'|null>{
 const started=Date.now(),signal=AbortSignal.timeout(4000);
 let outcome='meta_unavailable';
 try{
  const token=(env as any).META_IG_MESSAGING_TOKEN;
  if(!token){outcome='credential_unavailable';return null;}
  if(!event.cid||!event.message_id||event.event_id!=='message:'+event.message_id){outcome='invalid_event';return null;}
  const graph=async(path:string,key:string)=>{const r=await fetch('https://graph.facebook.com/v21.0/'+path,{headers:{Authorization:'Bearer '+key},signal});if(!r.ok)throw Error('meta_unavailable');const value=await r.json() as any;if(value?.error)throw Error('meta_unavailable');return value;};
  const page=await graph('1697038263872226?fields=access_token',token);if(!page.access_token){outcome='meta_unavailable';return null;}
  const original=await graph(encodeURIComponent(event.cid)+'?fields=messages.limit(1){id,from,message,is_unsupported,shares{link},attachments{mime_type,file_url,image_data,video_data}}',String(page.access_token));
  const message=original.messages?.data?.[0];
  if(!message?.id||!message?.from?.id){outcome='original_unavailable';return null;}
  if(String(message.id)!==event.message_id||['1697038263872226','17841466350261166'].includes(String(message.from.id))){outcome='stale';return null;}
  const attachments=message.attachments?.data;
  const video=Array.isArray(attachments)&&attachments.some((a:any)=>!!a.video_data||String(a.mime_type??'').startsWith('video/'));
  if(video){outcome='video';return 'video';}
  if(message.is_unsupported===true){outcome='unsupported';return 'unsupported';}
  if(typeof message.message==='string'&&message.message.trim()&&!message.is_unsupported&&(!Array.isArray(attachments)||attachments.length===0)&&!(message.shares?.data?.length)){outcome='text';return 'text';}
  if(!Array.isArray(attachments)){outcome='attachments_unavailable';return null;}
  outcome=attachments.length?'nonvideo':'no_attachments';return null;
 }catch{outcome=signal.aborted?'timeout':'meta_unavailable';return null;}
 finally{
  // Closed vocabulary only: never log event IDs, URLs, responses or errors.
  console.log(JSON.stringify({event:'diana_video_recovery_probe',outcome,elapsed_ms:Date.now()-started}));
 }
}
export async function latestOriginalIsVideo(env:Env,event:any):Promise<boolean>{return (await latestOriginalRecoveryKind(env,event))==='video';}

// Mark only a positively absent recovery workflow, preserving its exact ID.
// The caller leaves unknown/transport errors locked for review.
async function markMissingRecovery(env:Env,id:string,now:number,minAge:number){
 const row=await env.DB.prepare("SELECT key,value,updated_at FROM crm_sync_state WHERE key LIKE 'diana_video_recovery_result:%' AND json_valid(value) AND json_extract(value,'$.status')='queued' AND json_extract(value,'$.workflow_id')=?1 LIMIT 1").bind(id).first<{key:string;value:string;updated_at:number}>();
 if(!row||now-Number(row.updated_at)<minAge)return false;
 let value:any;try{value=JSON.parse(row.value);}catch{return false;}
 const next=JSON.stringify({...value,status:'create_missing',reason:'workflow_not_found',at:now});
 const changed=await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4').bind(row.key,next,now,row.value).run();
 if(!changed.meta.changes)return false;
 await releaseDianaCloud(env,{kind:'direct',id});
 await env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_cloud_active' AND value=?1").bind(id).run();
 return true;
}

// One durable workflow at a time, across metadata scans and connected machines.
// The Durable Object serializes dispatch; instance identity makes creation replay-safe.
export async function dispatchDianaCloud(env:Env,priorityEventId?:string, now=Date.now(), recoveryOnly=false) {
  if(!dianaWorkWindow(now).direct)return {dispatched:false,reason:'outside_direct_hours'};
  const claim=await env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
  if(claim&&Number(claim.updated_at)>Date.now()-180_000)return {dispatched:false,reason:'diana_machine_finishing'};
  const active=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_cloud_active'").first<{value:string}>();
  if(active){
    const finished=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_finished:'+active.value).first<{value:string}>();
    let finishedHere=false;
    try {const proof=JSON.parse(finished?.value??'null');finishedHere=proof?.kind==='direct'&&proof.id===active.value;} catch {}
    if(!finishedHere){
    try {
      const instance=await env.DIANA_CLOUD.get(active.value);
      const status=await instance.status();
      if(!['complete','errored','terminated'].includes(status.status))return {dispatched:false,reason:'diana_cloud_working',workflow_id:active.value};
      // Only a positively terminal workflow permits recovery after an abrupt
      // runtime failure. Never evict a live or unidentifiable owner by age.
      await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('diana_cloud_recovery:direct:'+active.value,JSON.stringify({owner:{kind:'direct',id:active.value},reason:'terminal_workflow_observed',status:status.status,checked_at:Date.now()}),Date.now()).run();
      await releaseDianaCloud(env,{kind:'direct',id:active.value});
    } catch(error) {
      // Only a positively identified missing instance permits replay of create.
      if(!/not found|does not exist|not exist/i.test(String((error as Error)?.message??error)))throw error;
      await markMissingRecovery(env,active.value,Date.now(),180_000);
    }
    }
  }
  const financial=(e:any)=>['payout_paid_notice','payout_failed_notice'].includes(e.task)&&e.payout_id&&String(e.event_id).startsWith('action:');
  const ownerChoice=(e:any)=>e.task==='owner_choice'&&e.question_id&&String(e.event_id).startsWith('action:');
  const waiting=(await pendingDianaMessages(env)).filter(e=>e.message_id&&(financial(e)||ownerChoice(e)||String(e.queue_key).startsWith('diana_round_alarm:')&&e.event_id==='message:'+e.message_id))
    .sort((a,b)=>Number(b.event_id===priorityEventId)-Number(a.event_id===priorityEventId)||Number(!!financial(b))-Number(!!financial(a))||Date.parse(b.at)-Date.parse(a.at));
  const recoveryCandidates:any[]=[];let mediaNext:number|null=null;
  for(const event of waiting){
    if(recoveryOnly&&event.event_id!==priorityEventId)continue;
    const known=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_event:'+event.event_id).first<{value:string}>();
    let deferred=false,mediaResume=false,mediaRetryAt=0,videoRecovery=false,recoveryCandidate=false,recoveryResume=false,recoveryRetry=false,recoveryFailureRetry=false,dataGuardRetry=false,recoveryPrevious='',recoveryId='';let recoveryAttempt=1;let recoveryKind:'video'|'text'|'unsupported'|null=null;
    if(known){try{const prior=JSON.parse(known.value);deferred=prior?.status==='deferred';
      if(prior?.status==='media_wait'&&Number.isFinite(Number(prior.retry_at))){mediaRetryAt=Number(prior.retry_at);if(now>=mediaRetryAt)mediaResume=true;else mediaNext=mediaNext===null?mediaRetryAt:Math.min(mediaNext,mediaRetryAt);}
      recoveryCandidate=String(event.queue_key).startsWith('diana_round_alarm:')&&prior?.status==='needs_review';
    }catch{}}
    if(recoveryCandidate&&!recoveryOnly){
      // Priority dispatch is on the scanner's critical path. Do not probe old
      // review cases there, and always offer fresh events before recovery.
      if(!priorityEventId)recoveryCandidates.push(event);
      continue;
    }
    if(recoveryCandidate&&recoveryOnly){recoveryKind=await latestOriginalRecoveryKind(env,event);videoRecovery=!!recoveryKind;}
    if(videoRecovery){
      // Only one dedicated attempt; never delete or rewrite the old receipt.
      let previous=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_video_recovery_result:'+event.event_id).first<{value:string}>();
      if(previous){
        let data:any;try{data=JSON.parse(previous.value);}catch{continue;}
        if(data?.status==='queued'&&/^direct-v1-[a-f0-9]{64}$/.test(String(data.workflow_id??''))){
          try{await(await env.DIANA_CLOUD.get(data.workflow_id)).status();continue;}
          catch(error){
            if(!/not found|does not exist|not exist/i.test(String((error as Error)?.message??error))||!await markMissingRecovery(env,data.workflow_id,Date.now(),180_000))continue;
            previous=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_video_recovery_result:'+event.event_id).first<{value:string}>();
            if(!previous)continue;try{data=JSON.parse(previous.value);}catch{continue;}
          }
        }
        const previousAttempt=Number(data.recovery_attempt??1);
        if(!Number.isInteger(previousAttempt)||previousAttempt<1||previousAttempt>3)continue;
        recoveryAttempt=previousAttempt;
        if(data?.status==='media_wait'&&Number.isFinite(Number(data.retry_at))){mediaRetryAt=Number(data.retry_at);if(now<mediaRetryAt){mediaNext=mediaNext===null?mediaRetryAt:Math.min(mediaNext,mediaRetryAt);continue;}mediaResume=true;recoveryResume=true;}
        else if(data?.status==='create_missing'&&/^direct-v1-[a-f0-9]{64}$/.test(String(data.workflow_id??''))){recoveryRetry=true;recoveryId=data.workflow_id;}
        else if(data?.status==='deferred'&&Number.isFinite(Number(data.at))&&dianaWorkWindow(Number(data.at)).date<dianaWorkWindow(now).date)recoveryResume=true;
        else if(data?.status==='needs_review'&&data.reason==='text_recovery_requires_separate_review'&&recoveryKind==='text'&&previousAttempt===1&&!data.deliveryKey){
          // This specific legacy guard returned before creating an outbox. The
          // original must still be latest, and any delivery or done marker stops replay.
          const delivery=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(igDeliveryKey(event.cid,new Date(event.at).toISOString())).first();
          const done=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_event_done:'+event.event_id).first();
          if(delivery||done)continue;
          const oldHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('video-recovery:'+event.event_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
          try{const status=await(await env.DIANA_CLOUD.get('direct-v1-'+oldHash)).status();if(status.status!=='complete')continue;}catch{continue;}
          recoveryFailureRetry=true;dataGuardRetry=true;recoveryAttempt=2;
        }
        else if(data?.status==='failed'&&data.reason==='recovery_technical_retryable'&&previousAttempt<3&&Number.isFinite(Number(data.at))&&now-Number(data.at)>=180_000&&/^direct-v1-[a-f0-9]{64}$/.test(String(data.workflow_id??''))){
          try{const status=await(await env.DIANA_CLOUD.get(data.workflow_id)).status();if(!['complete','errored','terminated'].includes(status.status))continue;}catch{continue;}
          recoveryFailureRetry=true;recoveryAttempt=previousAttempt+1;
        }else continue;
        recoveryPrevious=previous.value;
      }
    }
    if(known&&!deferred&&!mediaResume&&!videoRecovery)continue;
    const identity=videoRecovery?`video-recovery:${event.event_id}${mediaResume?':media:'+mediaRetryAt:recoveryResume?':resume:'+dianaWorkWindow(now).date:recoveryFailureRetry?':retry:'+recoveryAttempt:''}`:mediaResume?`${event.event_id}:media:${mediaRetryAt}`:deferred?`${event.event_id}:resume:${dianaWorkWindow(now).date}`:event.event_id;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const id=recoveryRetry?recoveryId:'direct-v1-'+hash;
    const previous=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_recovery:direct:'+id).first<{value:string}>();
    let terminal=false;try{terminal=JSON.parse(previous?.value??'null')?.reason==='terminal_workflow_observed';}catch{}
    if(terminal){
      await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind((videoRecovery?'diana_video_recovery_result:':'diana_cloud_event:')+event.event_id,JSON.stringify({status:'needs_review',reason:'terminal_workflow_without_verified_receipt',workflow_id:id}),Date.now()).run();
      continue;
    }
    if(!await reserveDianaCloud(env,{kind:'direct',id})){
      const recovery=await recoverDianaCloudLock(env);
      if(!recovery.released||!await reserveDianaCloud(env,{kind:'direct',id})){
        const owner=await readDianaCloudLock(env);
        return {dispatched:false,reason:'diana_cloud_locked',owner,recovery:recovery.reason};
      }
    }
    if(videoRecovery){
      if(dataGuardRetry)await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind('diana_recovery_skip_payout:'+event.event_id,'1',Date.now()).run();
      const marker=JSON.stringify({status:'queued',event_id:event.event_id,workflow_id:id,recovery:true,recovery_attempt:recoveryAttempt,at:Date.now()});
      const inserted=recoveryResume||recoveryRetry||recoveryFailureRetry
        ?await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4').bind('diana_video_recovery_result:'+event.event_id,marker,Date.now(),recoveryPrevious).run()
        :await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind('diana_video_recovery_result:'+event.event_id,marker,Date.now()).run();
      if(!inserted.meta.changes){await releaseDianaCloud(env,{kind:'direct',id});continue;}
    }
    // Write the exact instance ID before creation. A lost create acknowledgement
    // is recovered by get(id); never mint a second instance for the same event.
    await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_cloud_active',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(id,Date.now()).run();
    try { await env.DIANA_CLOUD.create({id,params:{cid:event.cid,message_id:event.message_id,event_id:event.event_id,handle:event.handle,at:event.at,
      ...(mediaResume?{mediaRetried:true}:{}),...(videoRecovery?{recovery:true,recoveryKind,recoveryAttempt,...(dataGuardRetry?{skipPayout:true}:{})}:financial(event)?{task:event.task,payout_id:event.payout_id}:ownerChoice(event)?{task:'owner_choice',question_id:String(event.question_id)}:{})}}); }
    catch(error){
      // A nonexistent instance is a real failed create, and leaves the pending
      // metadata untouched. A duplicate-ID response resolves to the same work.
      try {await (await env.DIANA_CLOUD.get(id)).status();}catch(statusError){
        if(videoRecovery&&/not found|does not exist|not exist/i.test(String((statusError as Error)?.message??statusError))&&await markMissingRecovery(env,id,Date.now(),0))
          return {dispatched:false,reason:'video_recovery_create_missing_retry_same_id'};
        throw error;
      }
    }
    return {dispatched:true,executor:'cloudflare_workflow',workflow_id:id,event_ids:[event.event_id]};
  }
  if(!priorityEventId&&!recoveryOnly&&recoveryCandidates.length){
    // One bounded probe per ordinary dispatch, rotating through all candidates.
    const cursorKey='diana_video_recovery_probe_cursor';
    const cursor=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(cursorKey).first<{value:string}>();
    const previous=recoveryCandidates.findIndex(e=>e.event_id===cursor?.value);
    const chosen=recoveryCandidates[(previous+1)%recoveryCandidates.length];
    await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(cursorKey,chosen.event_id,Date.now()).run();
    return dispatchDianaCloud(env,chosen.event_id,now,true);
  }
  if(mediaNext!==null)return {dispatched:false,reason:'media_retry_waiting',retry_at:mediaNext,pending:waiting.length};
  return {dispatched:false,reason:waiting.length?'cloud_events_await_review':'queue_empty',pending:waiting.length};
}
