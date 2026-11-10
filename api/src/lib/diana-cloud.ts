// Diana's execution, hosted by ERP. Owner 10.11.2026: the whole Direct cycle in Cloudflare.
// Model decisions use the complete Diana profile through native subscription inference.
// Payment preparation/execution remains in its existing independent lane.
import type { Env } from '../types';
import { archiveIgMessage } from './ig-dm-archive';
import { incomingScreenshots } from './ig-dm-attachments';
import { prepareDianaContext } from './diana-context.mjs';
import { subscriptionInfer } from './diana-subscription.mjs';
import { checkSubscriptionImages } from './diana-subscription-vision.mjs';
import { guardReply, JSON_SPEC, SCENARIO_CARDS, OZON_CARD_PHOTO } from './ig-dm-reply-guard.mjs';
import { deliverIgReply, acknowledgeIgDelivery, igDeliveryKey } from './ig-dm-delivery';
import { sendIgDirect } from './ig-dm-watch';
import { acknowledgeDianaEvent } from './diana-alarm';
import { mapKonsolStatus } from './ugc-payouts.mjs';
import { recordPayoutNotice } from './ugc-payout-notice';
import { ingestCreatorPayouts } from './ugc-payout-source';
import { prepareCreatorPayout } from './ugc-payout-intake';

export type DianaCloudEvent = { cid: string; message_id: string; event_id: string; handle?: string; at: string; dryRun?: boolean;
  task?:'payout_paid_notice'|'payout_failed_notice'|'round';payout_id?:string;round_slot?:string;creator_id?:string };
const PAGE = '1697038263872226', BRAND = '17841466350261166';
const GRAPH = 'https://graph.facebook.com/v21.0';
const PREFIX = 'diana/cloud-direct/v1/';
export const cloudEventKey = (event: DianaCloudEvent) => (event.dryRun?'diana_cloud_preview:':'diana_cloud_event:') + event.event_id;
export async function stateRead(env: Env, key: string): Promise<any> {
  const row = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export async function stateWrite(env: Env, key: string, value: unknown) {
  await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind(key, JSON.stringify(value), Date.now()).run();
}
async function modeCheck(env: Env, event?: DianaCloudEvent) {
  if (event?.dryRun === true) return;
  if (await stateRead(env, 'diana_cloud_mode') !== 'enabled') throw Error('diana_cloud_paused');
  const claim = await env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
  if (claim && Number(claim.updated_at) > Date.now() - 180_000) throw Error('diana_machine_still_working');
}
export async function cloudGraph(path: string, token: string) {
  const response = await fetch(GRAPH + path, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw Error('diana_meta_read_http_' + response.status);
  const data = await response.json() as any;
  if (data.error) throw Error('diana_meta_read_rejected');
  return data;
}
async function pageToken(env: Env) {
  const token = (env as any).META_IG_MESSAGING_TOKEN;
  if (!token) throw Error('diana_meta_not_configured');
  const page = await cloudGraph('/' + PAGE + '?fields=access_token', token);
  if (!page.access_token) throw Error('diana_page_token_missing');
  return String(page.access_token);
}
async function put(env: Env, key: string, value: unknown) {
  await env.DOCS.put(key, JSON.stringify(value), { httpMetadata: {contentType:'application/json'} });
  if (!await env.DOCS.head(key)) throw Error('diana_cloud_artifact_not_saved');
  return key;
}
async function get(env: Env, key: string): Promise<any> {
  if (!key.startsWith(PREFIX)) throw Error('invalid_cloud_artifact');
  const object = await env.DOCS.get(key);
  if (!object) throw Error('diana_cloud_artifact_missing');
  return object.json();
}
export async function artifactPrefix(event: DianaCloudEvent) {
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode((event.dryRun?'preview:':'')+event.event_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  return PREFIX + hash + '/';
}

/** Read the originals, including every page, rather than the metadata wake payload. */
export async function readCloudConversation(env: Env, event: DianaCloudEvent) {
  await modeCheck(env,event);
  const token = await pageToken(env);
  const fields = 'id,created_time,from,message,is_unsupported,shares{link},attachments{mime_type,file_url,image_data,video_data}';
  let path = '/' + encodeURIComponent(event.cid) + '/messages?fields=' + fields + '&limit=100';
  const originals: any[] = [], cursors = new Set<string>();
  while (path) {
    const page = await cloudGraph(path, token);
    if (!Array.isArray(page.data)) throw Error('diana_original_messages_missing');
    originals.push(...page.data);
    const after = page.paging?.next ? page.paging?.cursors?.after : null;
    if (!after) break;
    if (!page.data.length || cursors.has(after)) throw Error('diana_original_pagination_incomplete');
    cursors.add(after);
    path = '/' + encodeURIComponent(event.cid) + '/messages?fields=' + fields + '&limit=100&after=' + encodeURIComponent(after);
  }
  const newest = originals[0];
  if (!newest?.id || !newest.from?.id) throw Error('diana_original_identity_missing');
  if (!event.task && String(newest.id) !== event.message_id) return {status:'superseded'};
  if (!event.task && [BRAND,PAGE].includes(String(newest.from.id))) return {status:'superseded'};
  const sender=event.task==='round'?originals.find(m=>m.from?.id&&![BRAND,PAGE].includes(String(m.from.id))):event.task?originals.find(m=>String(m.id)===event.message_id):newest;
  if(!sender?.from?.id || [BRAND,PAGE].includes(String(sender.from.id)))throw Error('diana_original_sender_missing');
  const handle = String(sender.from.username ?? event.handle ?? '').toLowerCase().replace(/^@/,'');
  if (!/^[a-z0-9_.]{1,30}$/.test(handle)) throw Error('diana_creator_handle_missing');
  const seen = new Date().toISOString();
  for (const message of originals) await archiveIgMessage(env,event.cid,message,seen,0);
  const history = originals.slice().reverse().map(m=>({id:String(m.id),direction:[BRAND,PAGE].includes(String(m.from.id))?'out':'in',
    text: m.message || m.shares?.data?.map((s:any)=>s.link).join('\n') || '',attachments_json:JSON.stringify(m.attachments?.data??[]),
    unsupported:m.is_unsupported===true,created_at:new Date(m.created_time).toISOString()}));
  let creator = await env.DB.prepare("SELECT c.* FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform IN ('instagram','other') AND p.normalized_handle=?1 ORDER BY CASE WHEN p.platform='instagram' THEN 0 ELSE 1 END LIMIT 1")
    .bind(handle).first<any>();
  if (!creator && !event.dryRun && event.task!=='round') {
    // Same deterministic creator identity as Diana's original Direct intake.
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('instagram:'+handle)))].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24);
    const cid='ugc_'+digest,pid='ugcp_'+digest,now=Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,created_at,updated_at) VALUES(?1,?2,'replied',?3,?3) ON CONFLICT(id) DO NOTHING").bind(cid,handle,now),
      env.DB.prepare("INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,profile_url,source,created_at,updated_at) VALUES(?1,?2,'instagram',?3,?3,?4,'ugc_dm',?5,?5) ON CONFLICT(platform,normalized_handle) DO NOTHING")
        .bind(pid,cid,handle,'https://www.instagram.com/'+handle+'/',now),
    ]);
    creator=await env.DB.prepare('SELECT * FROM ugc_creators WHERE id=?1').bind(cid).first<any>();
  }
  if (!creator) {
    if(!event.dryRun)throw Error('diana_creator_not_registered');
    creator={id:null,normalized_handle:handle,lifecycle_stage:null};
  }
  if(event.task==='round'&&event.creator_id!==creator.id)throw Error('round_creator_identity_mismatch');
  const payouts = (await env.DB.prepare('SELECT id,amount_minor,status,product,paid_at,failed_at,sent_at,created_at,konsol_payment_id,konsol_status,konsol_error,notice_status,notice_message_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC')
    .bind(creator.id).all()).results??[];
  if(event.task&&event.task!=='round'){
    const payout=payouts.find((p:any)=>p.id===event.payout_id) as any;
    if(!payout)throw Error('cloud_payout_source_missing');
    const paid=event.task==='payout_paid_notice';
    if(paid?(payout.status!=='paid'||!payout.konsol_payment_id||mapKonsolStatus(payout.konsol_status)!=='paid'||!Number.isFinite(Date.parse(payout.paid_at))):
      (payout.status!=='failed'||mapKonsolStatus(payout.konsol_status)==='paid'||!Number.isFinite(Date.parse(payout.failed_at))))throw Error('cloud_payout_outcome_not_confirmed');
  }
  const plans = (await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND json_valid(value) AND json_extract(value,'$.conversationId')=?1")
    .bind(event.cid).all<{value:string}>()).results?.map(r=>JSON.parse(r.value))??[];
  const ownerDecision = await stateRead(env,'ig_owner_decision:'+event.cid);
  const lastIncoming=history.filter(m=>m.direction==='in').at(-1);
  const key = await put(env,(await artifactPrefix(event))+'source.json',{event,handle,recipient:String(sender.from.id),latestId:String(newest.id),at:lastIncoming?.created_at??new Date(sender.created_time).toISOString(),
    creator,payouts,plans,history,ownerDecision:ownerDecision?.at===event.at?ownerDecision:null});
  return {status:'ready',key};
}

/** All large/private artifacts stay in private R2; Workflow step outputs contain only keys. */
export async function prepareCloudDecision(env: Env, key: string) {
  const source = await get(env,key);
  await modeCheck(env,source.event);
  const lastOut = source.history.map((m:any)=>m.direction).lastIndexOf('out');
  const current = source.history.slice(lastOut+1);
  if (current.some((m:any)=>m.unsupported)) return {status:'needs_review',reason:'meta_attachment_unavailable'};
  const task = JSON.stringify({task:source.event.task==='round'?'Review this paid, ordered, creation or posted creator for the scheduled round. Read the entire original conversation, do not initiate video reminders, scouting, or duplicate any action. If an action needs a browser or other unavailable tool, escalate and state the reason. If no message is appropriate return no reply with the actual observation.':source.event.task?`ERP confirmed ${source.event.task} for payout ${source.event.payout_id}. Read the original conversation and the exact confirmed payout. Write Diana's notice once and the next appropriate collaboration step. If the notice is already in the original conversation, or later conversation proves this historical step is obsolete, return no reply and explain the evidence. Do not reopen old orders, repeat a notice or blame the creator's bank without its confirmed rejection. This is a notice only, never a new transfer.`:'Write the next Diana Direct decision for this original conversation. This is incoming chat handling only, not scouting or proactive reminders.',
    handle:source.handle,creator:source.creator,payouts:source.payouts,delivery_plans:source.plans,owner_decision:source.ownerDecision,history:source.history});
  const prepared = await prepareDianaContext({task,githubToken:(env as any).GITHUB_TOKEN??'',infer:subscriptionInfer(env,'context')});
  const screenshots = await incomingScreenshots(env,source.history,source.at);
  if (screenshots.currentUnavailable) throw Error('current_image_unavailable');
  const imageCheck = screenshots.images.length ? await checkSubscriptionImages({images:screenshots.images,policy:prepared.imagePolicy,task,infer:subscriptionInfer(env,'image')}) : null;
  const system = prepared.system + '\n' + JSON_SPEC + `\nAdd payout_requisites_detected: true if this incoming message contains any actual bank, phone or recipient payment details, including incomplete details; otherwise false. Cloud execution facts: tools are performed by this workflow, never claim an action already happened. All payout registration and transfers are a separate ERP process. Do not confirm requisites were saved unless the supplied payout row proves it. Current creator stage and manual decisions are authoritative. Existing card delivery receipts are authoritative: do not re-send cards already delivered. An order screenshot is required before scenario cards. Acknowledgements can require no reply; explain that decision in reason. If this requires a browser or a consultation not in these sources, escalate without pretending the tool ran. Image evidence: ${JSON.stringify(imageCheck)}. Unavailable historical images: ${screenshots.unreadable}. Do not guess absent facts.`;
  const contextKey=await put(env,(await artifactPrefix(source.event))+'context.json',{sourceKey:key,system,task,receipt:prepared.receipt,imageCheck});
  await stateWrite(env,'diana_context:'+source.event.cid,{...prepared.receipt,at:source.at,executor:'cloudflare_workflow',image_check:imageCheck});
  return {status:'ready',key:contextKey};
}

export async function draftCloudDecision(env: Env, key: string) {
  const prepared = await get(env,key), source = await get(env,prepared.sourceKey);
  await modeCheck(env,source.event);
  const result = await subscriptionInfer(env,'reply')([{role:'system',content:prepared.system},{role:'user',content:prepared.task}],{model:'gpt-6.1-terra'});
  let parsed;
  try { parsed=JSON.parse(result.text); } catch { throw Error('diana_cloud_invalid_decision'); }
  if (!parsed || typeof parsed.escalate!=='boolean' || typeof parsed.reason!=='string' || !(parsed.reply===null || typeof parsed.reply==='string')
    || !(parsed.replies===null || Array.isArray(parsed.replies)&&parsed.replies.every((p:unknown)=>typeof p==='string'))) throw Error('diana_cloud_invalid_decision');
  const incoming=source.history.filter((m:any)=>m.direction==='in');
  const guarded=guardReply(result.text,{paid:source.payouts.some((p:any)=>p.status==='paid'&&p.konsol_payment_id),inCount:incoming.length,
    lastIn:incoming.slice(-2).map((m:any)=>m.text).join('\n'),ownerDecided:!!source.ownerDecision});
  const decision={...guarded,payoutRequisitesDetected:parsed.payout_requisites_detected===true || /(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/.test(String(incoming.at(-1)?.text??''))};
  const draftKey=await put(env,(await artifactPrefix(source.event))+'decision.json',{sourceKey:prepared.sourceKey,decision,receipt:result.receipt});
  return {key:draftKey,status:decision.escalate?'needs_review':decision.reply?'reply':'no_reply'};
}

export async function deliverCloudDecision(env: Env, key: string) {
  const draft=await get(env,key), source=await get(env,draft.sourceKey), decision=draft.decision;
  await modeCheck(env,source.event);
  if(source.event.dryRun)return {status:'preview',decisionKey:key,decision:decision.reply?'reply':decision.escalate?'needs_review':'no_reply',reason:decision.reason};
  const existingNotice=source.event.task&&source.event.task!=='round'?source.payouts.find((p:any)=>p.id===source.event.payout_id):null;
  if(existingNotice?.notice_status==='delivered'){
    if(!existingNotice.notice_message_id)throw Error('cloud_existing_notice_receipt_missing');
    const original=await cloudGraph('/'+encodeURIComponent(existingNotice.notice_message_id)+'?fields=id,from,created_time,message',await pageToken(env));
    if(String(original.id)!==existingNotice.notice_message_id||![BRAND,PAGE].includes(String(original.from?.id))||!source.history.some((m:any)=>m.id===String(original.id)))throw Error('cloud_existing_notice_not_verified');
    return {status:'no_reply',reason:'Existing delivery receipt reopened in original conversation.',existingNoticeId:String(original.id)};
  }
  if (decision.escalate) return {status:'needs_review',reason:decision.reason};
  const actionId=source.event.task?source.event.event_id:undefined;
  const deliveryKey=igDeliveryKey(source.event.cid,source.at,actionId);
  if((await stateRead(env,deliveryKey))?.status==='complete')return {status:'delivered',deliveryKey};
  const currentCreator=await env.DB.prepare('SELECT * FROM ugc_creators WHERE id=?1').bind(source.creator.id).first<any>();
  const currentPayouts=(await env.DB.prepare('SELECT id,amount_minor,status,product,paid_at,failed_at,sent_at,created_at,konsol_payment_id,konsol_status,konsol_error,notice_status,notice_message_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC')
    .bind(source.creator.id).all()).results??[];
  if(currentCreator?.updated_at!==source.creator.updated_at || JSON.stringify(currentPayouts)!==JSON.stringify(source.payouts))return {status:'needs_review',reason:'erp_facts_changed_during_inference'};
  if (!decision.reply) return {status:'no_reply',reason:decision.reason};
  const cards=[...(decision.sendCards?SCENARIO_CARDS:[]),...(decision.sendOzonPhoto?[OZON_CARD_PHOTO]:[])];
  // A payment action has its own immutable outbox; it must never reuse the plan
  // already delivered for the incoming message which originally supplied details.
  const result=await deliverIgReply(env,{conversationId:source.event.cid,incomingAt:source.at,handle:source.handle,...(actionId?{actionId}:{}),
    parts:decision.parts??[decision.reply],cards},async (boundEnv,handle,text,opts)=>{
      await modeCheck(env);
      const token=await pageToken(env);
      const live=await cloudGraph('/'+encodeURIComponent(source.event.cid)+'?fields=messages.limit(1){id,from,created_time}',token);
      const latest=live.messages?.data?.[0];
      const plan=await stateRead(env,deliveryKey);
      const receipts=(plan?.items??[]).filter((x:any)=>x.status==='sent').map((x:any)=>x.messageId);
      if (!latest || !(String(latest.id)===source.latestId || receipts.includes(String(latest.id)))) return {ok:false,delivery:'not_sent',error:'conversation_changed_before_send'};
      const recipient=await boundEnv.DB.prepare("SELECT from_id FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1 AND from_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
        .bind(handle).first<{from_id:string}>();
      if (recipient?.from_id!==source.recipient) return {ok:false,delivery:'not_sent',error:'recipient_identity_changed'};
      // Automated model replies never use the HUMAN_AGENT exception.
      return sendIgDirect(boundEnv,handle,text,{...(opts.imageUrl?{imageUrl:opts.imageUrl}:{})});
    });
  if (result.status!=='complete') return {status:'needs_review',reason:result.error??result.status,deliveryKey,
    retryable:result.status==='pending'&&/rate limit|too many requests/i.test(result.error??'')};
  return {status:'delivered',deliveryKey};
}

// Diana's decision starts payout intake for this one original conversation.
// Intake independently verifies the original messages, cart and existing payout.
export async function handoffCloudPayout(env: Env, key: string) {
  const draft=await get(env,key), source=await get(env,draft.sourceKey), r=draft.decision.requisites;
  await modeCheck(env,source.event);
  if (source.event.dryRun || source.event.task || draft.decision.refused || draft.decision.escalate)
    return {status:'not_applicable'};
  if(!r && draft.decision.payoutRequisitesDetected){
    // The payout intake validates and records the original without creating an
    // executable row. Values not independently verified are left incomplete.
    const pending=await prepareCreatorPayout(env,{verified:true,handle:source.handle,conversation_id:source.event.cid,
      cycle_message_id:source.event.message_id,source_message_ids:[source.event.message_id],amount_minor:1,
      phone:'',first_name:null,fps_bank_member_id:'',bank_ref:''});
    if(pending.registered!==false)throw Error('partial_payout_intake_must_not_register');
    await stateWrite(env,'diana_payout_signal:'+source.event.event_id,{status:'incomplete',conversation_id:source.event.cid,
      message_id:source.event.message_id,event_id:source.event.event_id,missing_fields:pending.missing_fields,at:Date.now()});
    return {status:'partial'};
  }
  if(!r)return {status:'not_applicable'};
  const result=await ingestCreatorPayouts(env,{conversation_id:source.event.cid,message_id:source.event.message_id,
    phone:r.phone,bank:r.bank,first_name:r.first_name,amount_minor:r.amount_minor,
    originals:source.history.map((m:any)=>({id:m.id,direction:m.direction,text:m.text}))});
  if(typeof result==='number')throw Error('payout_target_result_invalid');
  return {status:result.registered?'registered':'pending_or_existing',payout_id:result.payout_id};
}

export async function executeCloudPayout(env: Env, payoutId:string, event:DianaCloudEvent) {
  const {executeUgcPayout}=await import('./ugc-payout-store');
  const result=await executeUgcPayout(env,payoutId,async()=>{
    const live=await cloudGraph('/'+encodeURIComponent(event.cid)+'?fields=messages.limit(1){id,from,created_time}',await pageToken(env));
    const latest=live.messages?.data?.[0];
    return !!latest && String(latest.id)===event.message_id && ![BRAND,PAGE].includes(String(latest.from?.id));
  });
  if(!result.ok)throw Error('payout_execution_'+String(result.code??'failed'));
  return {status:'submitted_or_already_exists',payout_id:payoutId};
}

/** Completion requires Meta original readback for every send receipt and ERP readback. */
export async function completeCloudEvent(env: Env,event: DianaCloudEvent,outcome: any) {
  if (event.dryRun) {await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now(),dry_run:true});return outcome;}
  if (outcome.status==='superseded') { await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now()});return outcome; }
  if (!['delivered','no_reply'].includes(outcome.status)) {
    await stateWrite(env,'ig_reply_escalated:'+event.cid,{at:event.at,handle:event.handle,status:'needs_review',kind:'technical',reason:outcome.reason??'cloud_execution_review'});
    await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now()});return outcome;
  }
  if (outcome.status==='delivered') {
    const plan=await stateRead(env,outcome.deliveryKey);
    if (plan?.status!=='complete') throw Error('cloud_delivery_not_complete');
    const token=await pageToken(env);
    for (const item of plan.items) {
      if (item.status!=='sent'||!item.messageId) throw Error('cloud_delivery_receipt_missing');
      const original=await cloudGraph('/'+encodeURIComponent(item.messageId)+'?fields=id,from,created_time,message,attachments{mime_type,file_url,image_data}',token);
      if (String(original.id)!==item.messageId || ![BRAND,PAGE].includes(String(original.from?.id))) throw Error('cloud_delivery_not_verified');
      await archiveIgMessage(env,event.cid,original,new Date().toISOString(),0);
      const saved=await env.DB.prepare("SELECT id FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2 AND direction='out'").bind(item.messageId,event.cid).first();
      if (!saved) throw Error('cloud_outgoing_archive_not_verified');
    }
    await acknowledgeIgDelivery(env,outcome.deliveryKey);
  }
  // Preserve manual edits and newer payout-driven stages while advancing the
  // same creator only from the snapshot Diana actually read.
  const base=await artifactPrefix(event);
  const draft=await get(env,base+'decision.json'),source=await get(env,draft.sourceKey),decision=draft.decision;
  if(event.task&&event.task!=='round'&&event.payout_id){
    const expected=source.payouts.find((p:any)=>p.id===event.payout_id);
    const current=await env.DB.prepare('SELECT status,konsol_payment_id,konsol_status,paid_at,failed_at,notice_message_id FROM ugc_payouts WHERE id=?1').bind(event.payout_id).first<any>();
    if(!current||['status','konsol_payment_id','konsol_status','paid_at','failed_at'].some(k=>current[k]!==expected[k])||outcome.existingNoticeId&&current.notice_message_id!==outcome.existingNoticeId)throw Error('cloud_payout_changed_before_completion');
    const plan=outcome.deliveryKey?await stateRead(env,outcome.deliveryKey):null;
    const messageId=outcome.existingNoticeId??(outcome.status==='delivered'?plan?.items?.[0]?.messageId:source.history.at(-1)?.id);
    const evidence='Diana cloud workflow read the original conversation. '+(decision.reason||'Confirmed notification delivered and original Meta receipts reopened.');
    if(!messageId)throw Error('cloud_payout_notice_source_missing');
    if(event.task==='payout_paid_notice'){
      await recordPayoutNotice(env,event.payout_id,{verified:true,message_id:messageId,conversation_id:event.cid,evidence,
        outcome:outcome.status==='delivered'||outcome.existingNoticeId?'delivered':'reviewed'});
    }else if(!outcome.existingNoticeId){
      const payout=source.payouts.find((p:any)=>p.id===event.payout_id);
      const original=await env.DB.prepare('SELECT id,created_at FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2')
        .bind(messageId,event.cid).first<{id:string;created_at:string}>();
      if(!original || outcome.status==='delivered'&&Date.parse(original.created_at)<Date.parse(payout.failed_at))throw Error('cloud_failed_notice_not_verified');
      const receipt={verified:true,outcome:outcome.status==='delivered'?'delivered':'reviewed',payout_id:event.payout_id,message_id:messageId,conversation_id:event.cid,evidence,executor:'cloudflare_workflow'};
      const status=outcome.status==='delivered'?'delivered':'reviewed',sentAt=outcome.status==='delivered'?original.created_at:null;
      const changed=await env.DB.batch([
        env.DB.prepare('UPDATE ugc_payouts SET notice_status=?2,notice_message_id=?3,notice_at=?4,paid_notice_at=?4,notice_error=NULL,updated_at=?5 WHERE id=?1 AND status=\'failed\' AND failed_at=?6 AND konsol_payment_id IS ?7 AND (notice_message_id IS NULL OR notice_message_id=?3)')
          .bind(event.payout_id,status,outcome.status==='delivered'?messageId:null,sentAt,Date.now(),payout.failed_at,payout.konsol_payment_id),
        env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM ugc_payouts WHERE id=?4 AND notice_status=?5) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
          .bind('diana_payout_notice_verified:'+event.payout_id,JSON.stringify(receipt),Date.now(),event.payout_id,status)
      ]);
      if(!changed[0]?.meta?.changes)throw Error('cloud_failed_payout_changed');
    }
    const saved=await env.DB.prepare('SELECT notice_status FROM ugc_payouts WHERE id=?1').bind(event.payout_id).first<{notice_status:string}>();
    if(!['delivered','reviewed'].includes(saved?.notice_status??''))throw Error('cloud_payout_notice_not_saved');
  }
  if(source.creator.id){
    const target=decision.refused?'refused':decision.sendCards&&outcome.status==='delivered'?'creation':decision.agreed?'agreed':null;
    if(target){
      const allowed=target==='creation'?['paid','ordered']:['','new','sent','found','qualified','invited','replied','agreed'];
      if(allowed.includes(source.creator.lifecycle_stage??''))await env.DB.prepare('UPDATE ugc_creators SET lifecycle_stage=?2,updated_at=?3 WHERE id=?1 AND lifecycle_stage IS ?4 AND updated_at IS ?5')
        .bind(source.creator.id,target,Date.now(),source.creator.lifecycle_stage??null,source.creator.updated_at??null).run();
    }
    if(decision.refused){
      const open=(await env.DB.prepare("SELECT id FROM ugc_payouts WHERE creator_id=?1 AND status IN ('awaiting_approval','approved') AND execute_claim IS NULL AND konsol_payment_id IS NULL")
        .bind(source.creator.id).all<{id:string}>()).results??[];
      for(const payout of open)await stateWrite(env,'payout_hold:'+payout.id,{reason:'blogger_refused',event_id:event.event_id,at:new Date().toISOString()});
    }
  }
  const proof={event_id:event.event_id,message_id:event.message_id,cid:event.cid,verified:true,executor:'cloudflare_workflow',outcome:outcome.status,
    proof:outcome.deliveryKey??outcome.reason,checked_at:new Date().toISOString()};
  await stateWrite(env,'diana_event_done:'+event.event_id,proof);
  const readback=await stateRead(env,'diana_event_done:'+event.event_id);
  if (!readback?.verified||readback.event_id!==event.event_id) throw Error('cloud_completion_not_saved');
  // A new alarm may have replaced this one; its exact identity must remain open.
  if(event.task!=='round')await acknowledgeDianaEvent(env,event);
  await stateWrite(env,cloudEventKey(event),{...proof,status:'complete'});
  return {status:'complete',outcome:outcome.status};
}
