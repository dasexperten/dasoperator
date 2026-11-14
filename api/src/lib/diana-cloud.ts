// Diana's execution, hosted by ERP. Owner 10.11.2026: the whole Direct cycle in Cloudflare.
// Model decisions use the complete Diana profile through native subscription inference.
// Payment preparation/execution remains in its existing independent lane.
import type { Env } from '../types';
import { archiveIgMessage } from './ig-dm-archive';
import { incomingScreenshots, imageUrls } from './ig-dm-attachments';
import { prepareDianaContext } from './diana-context.mjs';
import { subscriptionInfer } from './diana-subscription.mjs';
import { checkSubscriptionImages } from './diana-subscription-vision.mjs';
import { currentVideos, extractCurrentVideoFrames } from './diana-video.mjs';
import { compareVideoPayoutEvidence } from './diana-video-verify.mjs';
import { checkVideoFrames } from './diana-video-vision.mjs';
import { guardReply, JSON_SPEC, SCENARIO_CARDS, OZON_CARD_PHOTO } from './ig-dm-reply-guard.mjs';
import { deliverIgReply, acknowledgeIgDelivery, igDeliveryKey } from './ig-dm-delivery';
import { sendIgDirect, refreshIgAttachments, IG_UNSUPPORTED } from './ig-dm-watch';
import { acknowledgeDianaEvent } from './diana-alarm';
import { mapKonsolStatus } from './ugc-payouts.mjs';
import { recordPayoutNotice } from './ugc-payout-notice';
import { ingestCreatorPayouts } from './ugc-payout-source';
import { prepareCreatorPayout } from './ugc-payout-intake';
import {prepareReviewPlan} from './diana-review-plan';
import {latestRequisites} from './ugc-latest-requisites.mjs';
import {sellerAnswerForBasket,SELLER_QUESTION} from './ugc-seller-followup.mjs';
import {summarizeImageChecks} from './diana-image-check.mjs';
import {publicationLinks} from './ugc-publication-links.mjs';
import {dianaWorkWindow} from './diana-work-window.mjs';

export type DianaCloudEvent = { cid: string; message_id: string; event_id: string; handle?: string; at: string; dryRun?: boolean;
  task?:'payout_paid_notice'|'payout_failed_notice'|'round'|'owner_choice';recovery?:boolean;recoveryKind?:'video'|'text'|'unsupported';recoveryAttempt?:number;mediaRetried?:boolean;skipPayout?:boolean;payout_id?:string;round_slot?:string;creator_id?:string;question_id?:string };
const PAGE = '1697038263872226', BRAND = '17841466350261166';
const GRAPH = 'https://graph.facebook.com/v21.0';
const PREFIX = 'diana/cloud-direct/v1/';
export const cloudEventKey = (event: DianaCloudEvent) => (event.dryRun?'diana_cloud_preview:':event.recovery?'diana_video_recovery_result:':'diana_cloud_event:') + event.event_id;
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
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode((event.dryRun?'preview:':event.recovery?'video-recovery:':'')+event.event_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
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
  let sender=event.task==='round'?originals.find(m=>m.from?.id&&![BRAND,PAGE].includes(String(m.from.id))):event.task?originals.find(m=>String(m.id)===event.message_id):newest;
  if(!event.task&&(String(newest.id)!==event.message_id||[BRAND,PAGE].includes(String(newest.from.id)))){
    // A prior part may already have been sent just before the cutoff. Resume
    // only if the newest original is exactly one of this immutable plan's
    // confirmed sent parts and no later incoming exists.
    const state=await stateRead(env,cloudEventKey(event));
    const original=originals.find(m=>String(m.id)===event.message_id);
    const latestIncoming=originals.find(m=>m.from?.id&&![BRAND,PAGE].includes(String(m.from.id)));
    const rows=(await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND json_valid(value) AND json_extract(value,'$.conversationId')=?1")
      .bind(event.cid).all<{value:string}>()).results??[];
    const matches=rows.some(row=>{try{const p=JSON.parse(row.value);return original&&Date.parse(p.incomingAt)===Date.parse(original.created_time)&&
      (p.items??[]).some((i:any)=>i.status==='sent'&&String(i.messageId)===String(newest.id));}catch{return false;}});
    if(state?.status!=='deferred'||!original||String(latestIncoming?.id)!==event.message_id||!matches)return {status:'superseded'};
    sender=original;
  }
  if(!sender?.from?.id || [BRAND,PAGE].includes(String(sender.from.id)))throw Error('diana_original_sender_missing');
  const handle = String(sender.from.username ?? event.handle ?? '').toLowerCase().replace(/^@/,'');
  if (!/^[a-z0-9_.]{1,30}$/.test(handle)) throw Error('diana_creator_handle_missing');
  const seen = new Date().toISOString();
  for (const message of originals) await archiveIgMessage(env,event.cid,message,seen,0);
  // Re-open only recent unreadable originals; never guess missing content.
  // Limit Meta work so one conversation cannot hold the whole Direct lane.
  let repairs=0;
  for(const message of originals){
    if([BRAND,PAGE].includes(String(message.from?.id)))break;
    if(message.is_unsupported!==true||repairs>=3)continue;repairs++;
    try{
      const fresh=await refreshIgAttachments(env,String(message.id));
      if(!fresh||fresh===IG_UNSUPPORTED)continue;
      const attachments=JSON.parse(fresh);if(!Array.isArray(attachments)||!attachments.length)continue;
      message.attachments={data:attachments};message.is_unsupported=false;message.recovered_media=true;
    }catch{} // Exact media stays pending if Meta cannot return it.
  }
  const history = originals.slice().reverse().map(m=>({id:String(m.id),direction:[BRAND,PAGE].includes(String(m.from.id))?'out':'in',
    from_id:String(m.from?.id??''),from_username:String(m.from?.id??'')===String(sender.from.id)?handle:String(m.from?.username??''),text: m.message || m.shares?.data?.map((s:any)=>s.link).join('\n') || '',attachments_json:JSON.stringify(m.attachments?.data??[]),
    unsupported:m.is_unsupported===true,recovered_media:m.recovered_media===true,created_at:new Date(m.created_time).toISOString()}));
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
  if(event.task&&event.task!=='round'&&event.task!=='owner_choice'){
    const payout=payouts.find((p:any)=>p.id===event.payout_id) as any;
    if(!payout)throw Error('cloud_payout_source_missing');
    const paid=event.task==='payout_paid_notice';
    if(paid?(payout.status!=='paid'||!payout.konsol_payment_id||mapKonsolStatus(payout.konsol_status)!=='paid'||!Number.isFinite(Date.parse(payout.paid_at))):
      (payout.status!=='failed'||mapKonsolStatus(payout.konsol_status)==='paid'||!Number.isFinite(Date.parse(payout.failed_at))))throw Error('cloud_payout_outcome_not_confirmed');
  }
  const plans = (await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND json_valid(value) AND json_extract(value,'$.conversationId')=?1")
    .bind(event.cid).all<{value:string}>()).results?.map(r=>JSON.parse(r.value))??[];
  if(event.recovery){
    const original=history.find(m=>m.id===event.message_id&&m.direction==='in');
    if(!original)return {status:'needs_review',reason:'video_recovery_original_missing'};
    // Even a pending plan may later be resumed by another worker. Never
    // create a competing recovery plan for the same incoming message.
    if(plans.some((p:any)=>Date.parse(p.incomingAt)===Date.parse(original.created_at)))return {status:'needs_review',reason:'video_recovery_previous_delivery_exists_or_unknown'};
  }
  // Owner: a clear, standalone confirmation of receipt advances to creation;
  // an older inaccessible attachment does not invalidate that confirmation.
  // Do not infer what was received from a longer or negated statement.
  const receiptText=String(sender.message??'').trim();
  const confirmsOrder=/^(?:я\s+)?(?:заказала|заказал|оформила\s+заказ|оформил\s+заказ)[\s.!👍🏼✅🙏🙂😊]*$/iu.test(receiptText);
  const confirmsReceipt=/^(?:я\s+)?(?:забрала|забрал|получила|получил|забрала\s+товар|забрал\s+товар|получила\s+товар|получил\s+товар|товар\s+получила|товар\s+получил|товар\s+забрала|товар\s+забрал)[\s.!👍✅🙏🙂😊]*$/iu.test(receiptText);
  if(!event.dryRun&&!event.task&&(confirmsReceipt||confirmsOrder)&&!sender.is_unsupported&&creator.id&&['','new','found','qualified','sent','invited','replied','agreed','cart','paid','ordered','silent'].includes(creator.lifecycle_stage??'')){
    const next=Date.now();const changed=await env.DB.prepare(`UPDATE ugc_creators SET lifecycle_stage=?2,updated_at=?3 WHERE id=?1 AND lifecycle_stage IS ?4 AND updated_at IS ?5
      AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||?1 AND json_valid(value) AND json_type(value,'$.to')='text' AND json_type(value,'$.at') IN ('integer','real'))`)
      .bind(creator.id,'creation',next,creator.lifecycle_stage??null,creator.updated_at??null).run();
    const reread=await env.DB.prepare('SELECT * FROM ugc_creators WHERE id=?1').bind(creator.id).first<any>();
    if(!reread)throw Error('receipt_creator_unavailable');
    if(Number(changed.meta.changes)===1&&(reread.lifecycle_stage!=='creation'||Number(reread.updated_at)!==next))throw Error('receipt_stage_not_verified');
    creator=reread;
    const receiptKey='diana_creator_progress:'+event.event_id;
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(receiptKey,JSON.stringify({event_id:event.event_id,message_id:event.message_id,conversation_id:event.cid,creator_id:creator.id,status:'verified',confirmation_kind:confirmsReceipt?'received':'ordered',stage_updated:Number(changed.meta.changes)===1,at:next}),next).run();
  }
  const ownerDecision = await stateRead(env,'ig_owner_decision:'+event.cid);
  let ownerChoice:any=null;
  if(event.task==='owner_choice'){
    if(!/^\d{1,30}$/.test(String(event.question_id??'')))throw Error('owner_choice_question_invalid');
    ownerChoice=await stateRead(env,'ig_hard:'+event.question_id);
    if(!ownerChoice||ownerChoice.cid!==event.cid||String(ownerChoice.handle??'').toLowerCase()!==handle||!ownerChoice.choice||
       !ownerChoice.options||!Array.isArray(ownerChoice.options[ownerChoice.choice]))throw Error('owner_choice_source_unverified');
    if(ownerChoice.answered_at)throw Error('owner_choice_already_answered');
    const original=history.find(m=>m.id===event.message_id&&m.direction==='in');
    if(!original||Date.parse(String(ownerChoice.at??''))!==Date.parse(original.created_at))throw Error('owner_choice_original_changed');
  }
  const lastIncoming=history.filter(m=>m.direction==='in').at(-1);
  const key = await put(env,(await artifactPrefix(event))+'source.json',{event,handle,recipient:String(sender.from.id),latestId:String(newest.id),at:lastIncoming?.created_at??new Date(sender.created_time).toISOString(),
    creator,payouts,plans,history,ownerChoice,ownerDecision:ownerDecision?.at===event.at?ownerDecision:null});
  return {status:'ready',key};
}

/** All large/private artifacts stay in private R2; Workflow step outputs contain only keys. */
export async function prepareCloudDecision(env: Env, key: string) {
  const source = await get(env,key);
  await modeCheck(env,source.event);
  const lastOut = source.history.map((m:any)=>m.direction).lastIndexOf('out');
  const current = source.history.slice(lastOut+1);
  const unreadable=current.filter((m:any)=>m.direction==='in'&&m.unsupported);let partialReceiptReply=false;
  if(unreadable.length&&!source.event.dryRun){
    // Preserve every missing original independently of whether a later text is
    // answered. Never claim to know what that inaccessible attachment contains.
    for(const item of unreadable){
      if(!item.id)throw Error('unreadable_media_identity_missing');
      const mediaKey='diana_unreadable_media:'+item.id;
      await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(mediaKey,JSON.stringify({status:'needs_review',reason:'meta_attachment_unavailable',conversation_id:source.event.cid,message_id:item.id,event_id:source.event.event_id,at:Date.now()}),Date.now()).run();
    }
    // A readable requisites message is a distinct original from a following
    // inaccessible attachment. Signal intake only; never submit a transfer.
    const details=[...current].reverse().find((m:any)=>m.direction==='in'&&!m.unsupported&&m.from_id===source.recipient&&/(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/.test(String(m.text??'')));
    if(details&&!source.event.task){
      const pending=await prepareCreatorPayout(env,{verified:true,handle:source.handle,conversation_id:source.event.cid,cycle_message_id:details.id,
        source_message_ids:[details.id],amount_minor:1,phone:'',first_name:null,fps_bank_member_id:'',bank_ref:''});
      if(pending.registered!==false)throw Error('partial_payout_intake_must_not_register');
      await stateWrite(env,'diana_payout_signal:'+source.event.event_id,{status:'incomplete',conversation_id:source.event.cid,
        message_id:details.id,latest_message_id:source.event.message_id,event_id:source.event.event_id,missing_fields:pending.missing_fields,at:Date.now()});
      const saved=await stateRead(env,'diana_payout_signal:'+source.event.event_id);
      if(saved?.status!=='incomplete'||saved.message_id!==details.id||saved.latest_message_id!==source.event.message_id)throw Error('partial_payout_signal_not_verified');
      const verifiedText=latestRequisites(current.filter((m:any)=>m.direction==='in'&&!m.unsupported&&m.from_id===source.recipient));
      partialReceiptReply=!!verifiedText&&verifiedText.cycle_message_id===details.id;

    }
  }
  const newestCurrent=current.at(-1);
  // A later independently readable text must not wait for an older attachment.
  // Only an unreadable newest message with no text gets the three-minute retry.
  const newestNeedsMediaRetry=!!newestCurrent&&newestCurrent.direction==='in'&&newestCurrent.unsupported&&!String(newestCurrent.text??'').trim();
  if(unreadable.length&&newestNeedsMediaRetry&&!source.event.dryRun&&!source.event.mediaRetried){
    // Defer this conversation only. The workflow returns and releases the
    // shared lock; a later workflow re-fetches the exact Meta originals.
    const retryKey='diana_media_retry:'+source.event.event_id;
    const first={status:'waiting',event_id:source.event.event_id,conversation_id:source.event.cid,message_id:source.event.message_id,media_ids:unreadable.map((m:any)=>m.id),retry_at:Date.now()+180_000};
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(retryKey,JSON.stringify(first),Date.now()).run();
    const saved=await stateRead(env,retryKey);if(saved?.event_id!==source.event.event_id||!Number.isFinite(Number(saved.retry_at)))throw Error('media_retry_not_saved');
    return {status:'media_wait',reason:'media_retry_scheduled',retry_at:Number(saved.retry_at)};
  }
  const latestReadable=current.at(-1);
  const priorVideoThanks=source.history.some((m:any)=>m.direction==='out'&&/спасибо[^.!?]{0,50}(?:видео|ролик)/iu.test(String(m.text??'')));
  const recognizedVideo=priorVideoThanks||(source.creator?.id?await env.DB.prepare("SELECT id FROM ugc_content WHERE creator_id=?1 AND product_status='identified' LIMIT 1").bind(source.creator.id).first<{id:string}>():null);
  const friendlyAfterVideo=!!recognizedVideo&&latestReadable?.direction==='in'&&!latestReadable.unsupported&&/^(?:спасибо(?:\s+большое)?|благодарю|вам\s+тоже|хорошего\s+(?:дня|вечера)|взаимно)[\s.!🙏🙂😊❤️]*$/iu.test(String(latestReadable.text??'').trim());
  const latestText=String(latestReadable?.text??'');
  const discovered=current.filter((m:any)=>m.direction==='in'&&!m.unsupported).flatMap((m:any)=>publicationLinks(String(m.text??'')).map((link:any)=>({...link,source_message_id:m.id})));
  const publicationNotice=discovered.length>0&&/(?:опубликовал|выложил|разместил|публикац|тик\s*ток|tiktok)/iu.test(latestText);
  if(publicationNotice&&!source.event.dryRun){
    const key='diana_publication_pending:'+source.event.event_id;
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(key,JSON.stringify({status:'pending',verified:false,event_id:source.event.event_id,conversation_id:source.event.cid,message_id:source.event.message_id,links:discovered.map((l:any)=>({url:l.url,platform:l.platform,source_message_id:l.source_message_id})),at:Date.now()}),Date.now()).run();
    const saved=await stateRead(env,key);if(saved?.verified!==false||saved.event_id!==source.event.event_id)throw Error('publication_pending_not_saved');
  }
  const senderQuestion=latestReadable?.direction==='in'&&!latestReadable.unsupported&&/^(?:подскажите[,\s]*)?от\s+кого\s+(?:(?:был|приш[её]л|поступил)\s+)?(?:перевод|плат[её]ж)[\s?!.,]*$/iu.test(String(latestReadable.text??'').trim());
  if(senderQuestion&&!source.event.dryRun){const key='diana_sender_reconciliation:'+source.event.event_id;await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(key,JSON.stringify({status:'needs_reconciliation',reason:'sender_not_confirmed',event_id:source.event.event_id,message_id:source.event.message_id,conversation_id:source.event.cid,at:Date.now()}),Date.now()).run();const saved=await stateRead(env,key);if(saved?.message_id!==source.event.message_id)throw Error('sender_reconciliation_not_saved');}
  const orderConfirmed=latestReadable?.direction==='in'&&!latestReadable.unsupported&&/^(?:я\s+)?(?:заказала|заказал|оформила\s+заказ|оформил\s+заказ)[\s.!👍🏼✅🙏🙂😊]*$/iu.test(String(latestReadable.text??'').trim());
  const failedPayouts=source.payouts.filter((p:any)=>p.status==='failed'&&p.id);
  const priorPaymentClaim=[...source.history].reverse().find((m:any)=>m.direction==='out'&&/(?:получил(?:ось|ась)\s+оплатить|оплатили|перевели)/i.test(String(m.text??'')));
  const reconciliationPending=!!orderConfirmed&&failedPayouts.length>0&&!!priorPaymentClaim;
  if(reconciliationPending&&!source.event.dryRun){
    const conflictKey='diana_payout_reconciliation:'+source.event.event_id;
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(conflictKey,JSON.stringify({status:'needs_reconciliation',reason:'provider_failed_prior_outgoing_payment_claim',conversation_id:source.event.cid,event_id:source.event.event_id,source_message_id:source.event.message_id,prior_outgoing_message_id:priorPaymentClaim.id,payout_ids:failedPayouts.map((p:any)=>p.id),at:Date.now()}),Date.now()).run();
    const saved=await stateRead(env,conflictKey);if(saved?.status!=='needs_reconciliation'||saved.source_message_id!==source.event.message_id)throw Error('payment_reconciliation_not_saved');
  }
  const latestCurrent=current.at(-1);
  // Only a later explicit, readable text may be addressed independently.
  // An inaccessible newest message is left pending, with any text signal saved.
  if(unreadable.length&&!partialReceiptReply&&(!latestCurrent||latestCurrent.direction!=='in'||(!String(latestCurrent.text??'').trim()&&!latestCurrent.recovered_media)))return {status:'needs_review',reason:'meta_attachment_unavailable'};
  let videos:any[]=[];
  try { videos=currentVideos(current); } catch { return {status:'needs_review',reason:'video_metadata_or_url_unavailable'}; }
  if(source.event.recoveryKind==='text'&&!source.event.dryRun){
    // Preserve the older unresolved review separately before a new reply can
    // acknowledge this message. Never replace the original event receipt.
    const key='diana_text_recovery_unresolved:'+source.event.event_id;
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(key,JSON.stringify({status:'needs_review',reason:'prior_review_preserved',event_id:source.event.event_id,message_id:source.event.message_id,conversation_id:source.event.cid,at:Date.now()}),Date.now()).run();
  }
  const task = JSON.stringify({task:source.event.task==='round'?'Review this paid, ordered, creation or posted creator for the scheduled round. Read the entire original conversation, do not initiate video reminders, scouting, or duplicate any action. If an action needs a browser or other unavailable tool, escalate and state the reason. If no message is appropriate return no reply with the actual observation.':source.event.task==='owner_choice'?'The Owner selected the attached exact option for this original conversation. Follow that decision in Diana’s voice; never invent or modify its terms. If the conversation changed or the choice cannot safely be applied, escalate instead of sending.':source.event.task?`ERP confirmed ${source.event.task} for payout ${source.event.payout_id}. Read the original conversation and the exact confirmed payout. Write Diana's notice once and the next appropriate collaboration step. If the notice is already in the original conversation, or later conversation proves this historical step is obsolete, return no reply and explain the evidence. Do not reopen old orders, repeat a notice or blame the creator's bank without its confirmed rejection. This is a notice only, never a new transfer.`:'Write the next Diana Direct decision for this original conversation. This is incoming chat handling only, not scouting or proactive reminders.',
    handle:source.handle,creator:source.creator,payouts:source.payouts,delivery_plans:source.plans,owner_decision:source.ownerChoice??source.ownerDecision,history:source.history});
  const prepared = await prepareDianaContext({task,githubToken:(env as any).GITHUB_TOKEN??'',infer:subscriptionInfer(env,'context')});
  const screenshots = await incomingScreenshots(env,source.history,source.at);
  if (screenshots.currentUnavailable) throw Error('current_image_unavailable');
  let videoCheck:any=null, verifiedVideo:any=null;
  if(videos.length){
    let frames:any[];
    try{frames=await extractCurrentVideoFrames(env,videos);}catch{return {status:'needs_review',reason:'video_download_or_frame_extraction_unavailable'};}
    try{videoCheck=await checkVideoFrames({images:frames,policy:prepared.imagePolicy,task:'Inspect original video frames. Confirm our product only when the product identity is visibly clear. Precisely read any phone, amount, recipient name and bank; identify every unreadable character. Never infer missing characters or combine conflicting details. Do not assess video quality or publication.',infer:subscriptionInfer(env,'image')});}
    catch{return {status:'needs_review',reason:'video_frame_analysis_unavailable'};}
    const evidenceKey=await put(env,(await artifactPrefix(source.event))+'video-evidence.json',{sourceMessageIds:videos.map((v:any)=>v.messageId),frames,videoCheck,sampled:true});
    const checks=videoCheck?.checks??[];
    const finance=checks.some((c:any)=>Object.values(c.requisites??{}).some(Boolean)||(c.unresolved_required??[]).some((v:string)=>['holder_name','bank','phone','card','amount','contradictory_evidence'].includes(v)));
    if(finance){
      // Independently re-open the exact original message, download and decode
      // again, and compare bytes and recognised fields. This is evidence only:
      // the existing payout intake still owns cart/claim/transfer decisions.
      let verification:any={verified:false,reason:'video_original_recheck_unavailable'}, recheckStage='original_read', recheckFailed=false;
      try{
        const original=await cloudGraph('/'+encodeURIComponent(source.event.message_id)+'?fields=id,from,attachments{mime_type,file_url,image_data,video_data}',await pageToken(env));
        if(String(original.id)!==source.event.message_id||String(original.from?.id)!==source.recipient)throw Error('video_original_identity_mismatch');
        const fresh=currentVideos([{id:String(original.id),direction:'in',attachments_json:JSON.stringify(original.attachments?.data??[])}]);
        if(fresh.length!==1||videos.length!==1)throw Error('video_original_count_mismatch');
        recheckStage='frame_extraction';
        const secondFrames=await extractCurrentVideoFrames(env,fresh);
        recheckStage='vision';
        const secondCheck=await checkVideoFrames({images:secondFrames,policy:prepared.imagePolicy,task:'Independently read this exact original video frame. Return exact phone, amount, name and bank only if every character is visible; mark uncertainty and contradictions. Never infer missing symbols.',infer:subscriptionInfer(env,'image')});
        verification=compareVideoPayoutEvidence({frames,checks},{frames:secondFrames,checks:secondCheck.checks},source.event.message_id);
        recheckStage='evidence_storage';
        await put(env,(await artifactPrefix(source.event))+'video-recheck.json',{sourceMessageId:source.event.message_id,frames:secondFrames,videoCheck:secondCheck,verification});
      }catch{recheckFailed=true;}
      // Signal the existing payout intake against the original message, but do
      // not promote model output into financial facts without source verification.
      if(!source.event.dryRun&&!source.event.task){
        const pending=await prepareCreatorPayout(env,{verified:true,handle:source.handle,conversation_id:source.event.cid,
          cycle_message_id:source.event.message_id,source_message_ids:[source.event.message_id],amount_minor:1,
          phone:'',first_name:null,fps_bank_member_id:'',bank_ref:''});
        if(pending.registered!==false)throw Error('partial_payout_intake_must_not_register');
        await stateWrite(env,'diana_payout_signal:'+source.event.event_id,{status:'incomplete',conversation_id:source.event.cid,
          message_id:source.event.message_id,event_id:source.event.event_id,missing_fields:pending.missing_fields,evidenceKey,at:Date.now()});
      }
      if(recheckFailed&&!source.event.dryRun){
        // No error text, URLs or personal data in the operational receipt.
        // Retry later without holding the global Direct lock, at most twice.
        const retryKey='diana_video_recheck_retry:'+source.event.event_id;
        const previous=await stateRead(env,retryKey);const count=Number(previous?.count??0)+1;
        await stateWrite(env,retryKey,{count,stage:recheckStage,status:count<3?'waiting':'exhausted',at:Date.now()});
        if(count<3)return {status:'media_wait',reason:'video_recheck_'+recheckStage+'_unavailable',retry_at:Date.now()+180_000,evidenceKey};
        return {status:'needs_review',reason:'video_recheck_'+recheckStage+'_unavailable',evidenceKey};
      }
      if(!verification.verified)return {status:'needs_review',reason:'video_requisites_need_verified_payout_source',evidenceKey,videoSourceVerified:false};
      verifiedVideo={message_id:source.event.message_id};
    }
    if(!verifiedVideo&&!checks.some((c:any)=>c.product==='yes'&&c.observed?.product_name))return {status:'needs_review',reason:'video_product_not_confirmed_in_sampled_frames',evidenceKey};
    // A short thank-you can be delivered independently. Preserve an explicit
    // separate review item because sparse frames cannot exclude payment details.
    if(!verifiedVideo&&!source.event.dryRun)await stateWrite(env,'diana_video_pending:'+source.event.event_id,{status:'needs_review',reason:'video_payment_coverage_unverified',event_id:source.event.event_id,message_id:source.event.message_id,conversation_id:source.event.cid,evidenceKey,at:Date.now()});
  }
  let imageCheck = screenshots.images.length ? await checkSubscriptionImages({images:screenshots.images,policy:prepared.imagePolicy,task,infer:subscriptionInfer(env,'image')}) : null;
  let sellerQuestion=false,sellerProvided=false;
  const basket=[...(imageCheck?.checks??[])].reverse().find((c:any)=>c.kind==='basket'&&c.product==='yes'&&c.amount==='yes');
  if(basket?.kind==='basket'&&basket.product==='yes'&&basket.amount==='yes'&&basket.seller==='unknown'&&!source.event.task){
    const answer=sellerAnswerForBasket(source.history,{created_at:basket.label?.match(/сообщения (\S+), вложение/)?.[1]},prepared.imagePolicy,source.handle);
    if(answer){sellerProvided=true;basket.seller=answer.registry_match?'yes':'unknown';basket.seller_evidence='creator_answer';basket.observed={...basket.observed,seller_name:answer.name};basket.unresolved_required=(basket.unresolved_required??[]).filter((v:string)=>v!=='seller');basket.seller_source=answer;imageCheck=summarizeImageChecks(imageCheck.checks);}
    else sellerQuestion=true;
  }
  const system = prepared.system + (recognizedVideo?'\nA prior original company message already thanked the creator for her video, or a product proof exists. For a friendly unrelated message, reply warmly and do not prompt publication unless a real current next step requires it.':'') + (sellerProvided?'\nThe creator has supplied the seller name in the original chat. Treat it as her statement, never invent a seller or claim an unverified registry match. Do not ask for additional proof of the seller name; continue the conversation.':'') + (source.event.recoveryKind==='text'?'\nThis is a separate answer to the latest explicit readable message. The older review remains unresolved. Answer only what is independently supported by verified current programme rules; never repeat an old unconfirmed claim or promise, and escalate if the current rules do not establish the answer.':'') + (unreadable.length?'\nAn earlier incoming attachment is inaccessible. Do not describe, infer, confirm, or claim to have seen it. Address only the latest readable text if independently answerable from verified current rules; otherwise escalate. The unreadable attachment remains separately pending.':'') + '\n' + JSON_SPEC + `\nAdd payout_requisites_detected: true if this incoming message contains any actual bank, phone or recipient payment details, including incomplete details; otherwise false. Cloud execution facts: tools are performed by this workflow, never claim an action already happened. All payout registration and transfers are a separate ERP process. Do not confirm requisites were saved unless the supplied payout row proves it. Current creator stage and manual decisions are authoritative. Existing card delivery receipts are authoritative: do not re-send cards already delivered. An order screenshot is required before scenario cards. Acknowledgements can require no reply; explain that decision in reason. If this requires a browser or a consultation not in these sources, escalate without pretending the tool ran. Image evidence: ${JSON.stringify(imageCheck)}. Unavailable historical images: ${screenshots.unreadable}. Do not guess absent facts.`;
  const contextKey=await put(env,(await artifactPrefix(source.event))+'context.json',{sourceKey:key,system,task,receipt:prepared.receipt,imageCheck,videoCheck,verifiedVideo,unreadableMedia:unreadable.length>0,partialReceiptReply,reconciliationPending,senderQuestion,sellerQuestion,sellerProvided,friendlyAfterVideo,publicationNotice});
  await stateWrite(env,'diana_context:'+source.event.cid,{...prepared.receipt,at:source.at,executor:'cloudflare_workflow',image_check:imageCheck});
  return {status:'ready',key:contextKey};
}

export async function draftCloudDecision(env: Env, key: string) {
  const prepared = await get(env,key), source = await get(env,prepared.sourceKey);
  await modeCheck(env,source.event);
  const previous=await stateRead(env,cloudEventKey(source.event));
  const oldDraft=(await artifactPrefix(source.event))+'decision.json';
  if(previous?.status==='deferred'&&await env.DOCS.head(oldDraft))return {key:oldDraft,status:'resume'};
  if(prepared.videoCheck&&!prepared.verifiedVideo) {prepared.system += '\nThe original video visibly shows our product. Reply only with a short thanks for the video. Do not assess quality or publication, or imply publication approval.';}
  let result = await subscriptionInfer(env,'reply')([{role:'system',content:prepared.system},{role:'user',content:prepared.task}],{model:'gpt-6.1-terra'});
  let parsed;
  try { parsed=JSON.parse(result.text); } catch { throw Error('diana_cloud_invalid_decision'); }
  if (!parsed || typeof parsed.escalate!=='boolean' || typeof parsed.reason!=='string' || !(parsed.reply===null || typeof parsed.reply==='string')
    || !(parsed.replies===null || Array.isArray(parsed.replies)&&parsed.replies.every((p:unknown)=>typeof p==='string'))) throw Error('diana_cloud_invalid_decision');
  const incoming=source.history.filter((m:any)=>m.direction==='in');
  let guarded=guardReply(result.text,{paid:source.payouts.some((p:any)=>p.status==='paid'&&p.konsol_payment_id),inCount:incoming.length,
    lastIn:incoming.slice(-2).map((m:any)=>m.text).join('\n'),ownerDecided:!!(source.ownerChoice??source.ownerDecision)});
  let learningUncertainty:string|null=null;
  // A model's ordinary uncertainty is not itself an Owner gate. Ask for one
  // safe answer grounded in current facts; the same mandatory guard still
  // blocks refunds, commercial decisions and unconfirmed financial claims.
  if(guarded.escalate&&!/Owner decides/i.test(String(guarded.reason??''))&&!source.event.task&&String(incoming.at(-1)?.text??'').trim()){
    learningUncertainty=String(guarded.reason??'uncertainty').slice(0,200);
    try{
      const retry=await subscriptionInfer(env,'reply')([{role:'system',content:prepared.system+'\nAnswer the latest readable message using only confirmed facts. Write only to the blogger, in Diana’s voice. Never mention files, tools, systems, availability, internal steps or what can or cannot be prepared, and never refer to the blogger in the third person. The Ozon card photo is always available: if she asks for the card, a photo or how to find the paste, set send_ozon_photo=true with a short text such as «Вот она) Наберите на Ozon: энзимная зубная паста.». Do not invent payment, sender, product or terms; if a decision is truly necessary, escalate.'},{role:'user',content:prepared.task}],{model:'gpt-6.1-terra'});
      const retryParsed=JSON.parse(retry.text);
      if(retryParsed&&typeof retryParsed.escalate==='boolean'&&typeof retryParsed.reason==='string'&&(retryParsed.reply===null||typeof retryParsed.reply==='string')&&(retryParsed.replies===null||Array.isArray(retryParsed.replies)&&retryParsed.replies.every((p:unknown)=>typeof p==='string'))){
        const checked=guardReply(retry.text,{paid:source.payouts.some((p:any)=>p.status==='paid'&&p.konsol_payment_id),inCount:incoming.length,lastIn:incoming.slice(-2).map((m:any)=>m.text).join('\n'),ownerDecided:!!(source.ownerChoice??source.ownerDecision)});
        // Owner 2026-11-14 (like.you11111 got «Файл недоступен, поэтому ответ блогеру подготовить нельзя»):
        // an internal note is not a reply; a retry that talks about the blogger or the machinery stays escalated.
        const leak=/блогер|файл|недоступ|подготовить ответ|ответ подготов|\bERP\b|систем[аеуы]/iu.test(String(checked.reply??''));
        if(!checked.escalate&&checked.reply&&!leak){guarded=checked;parsed=retryParsed;result=retry;}
      }
    }catch{} // Original review remains durable when no safe answer is available.
  }
  const decision:any={...guarded,learningUncertainty,payoutRequisitesDetected:!!guarded.requisites || parsed.payout_requisites_detected===true || /(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/.test(String(incoming.at(-1)?.text??''))};
  const ownerDecisionRequired=/Owner decides/i.test(String(decision.reason??''));
  if(prepared.friendlyAfterVideo&&!source.event.task&&!ownerDecisionRequired&&!decision.refused){decision.reply='Спасибо! Очень приятно 😊';decision.parts=[decision.reply];decision.escalate=false;decision.reason='friendly_followup_after_recognized_video';decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;}
  if(prepared.publicationNotice&&!source.event.task&&!ownerDecisionRequired&&!decision.refused){decision.reply='Спасибо, что поделились ссылками!';decision.parts=[decision.reply];decision.escalate=false;decision.reason='publication_links_pending_verification';decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;}

  // The Owner explicitly accepted the creator's seller answer as the next
  // conversational step; do not claim registry verification or payment.
  if(prepared.sellerProvided&&decision.escalate&&!source.event.task&&!ownerDecisionRequired&&!decision.refused&&/продав(?:ец|ц)|seller/iu.test(String(decision.reason??''))){
    decision.learningUncertainty=decision.reason;decision.reply='Спасибо, что уточнили!';decision.parts=[decision.reply];decision.escalate=false;decision.reason='seller_answer_acknowledged';decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;decision.requisites=null;decision.payoutRequisitesDetected=false;
  }
  if(prepared.sellerQuestion&&!source.event.task&&!ownerDecisionRequired&&!decision.refused){
    decision.reply=SELLER_QUESTION;decision.parts=[decision.reply];decision.escalate=false;decision.reason='seller_name_required';decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;decision.payoutRequisitesDetected=!!decision.requisites||decision.payoutRequisitesDetected;decision.requisites=null;
  }
  if(prepared.senderQuestion&&!source.event.task&&!ownerDecisionRequired&&!decision.refused){decision.reply='Пока не могу подтвердить отправителя перевода.';decision.parts=[decision.reply];decision.escalate=false;decision.reason='sender_not_confirmed';decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;decision.payoutRequisitesDetected=false;decision.requisites=null;}
  if(prepared.reconciliationPending&&!source.event.task&&!ownerDecisionRequired&&!decision.refused){
    decision.reply='Спасибо, что сообщили! Когда получите товар, напишите, пожалуйста.';decision.parts=[decision.reply];decision.escalate=false;decision.reason='payment_reconciliation_pending';decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;decision.payoutRequisitesDetected=false;decision.requisites=null;
  }
  if(prepared.partialReceiptReply&&!ownerDecisionRequired&&!decision.refused&&!source.event.task){
    decision.escalate=false;decision.reason='partial_payout_signal_saved';decision.reply='Спасибо! Передали реквизиты в обработку.';decision.parts=[decision.reply];decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;
  }
  if(prepared.videoCheck&&!prepared.verifiedVideo&&!decision.escalate&&!decision.payoutRequisitesDetected&&!source.event.task){
    decision.reply='Спасибо за видео!';decision.parts=[decision.reply];decision.sendCards=false;decision.sendOzonPhoto=false;decision.agreed=false;decision.refused=false;
  }
  const draftKey=await put(env,(await artifactPrefix(source.event))+'decision.json',{sourceKey:prepared.sourceKey,contextKey:key,decision,receipt:result.receipt,verifiedVideo:prepared.verifiedVideo,unreadableMedia:prepared.unreadableMedia,partialReceiptReply:prepared.partialReceiptReply,reconciliationPending:prepared.reconciliationPending,senderQuestion:prepared.senderQuestion,sellerQuestion:prepared.sellerQuestion,restoredMedia:source.history.some((m:any)=>m.id===source.event.message_id&&m.recovered_media),friendlyAfterVideo:prepared.friendlyAfterVideo,publicationNotice:prepared.publicationNotice,textRecovery:source.event.recoveryKind==='text'||source.event.recoveryKind==='unsupported'&&!!String(source.history.find((m:any)=>m.id===source.event.message_id)?.text??'').trim(),videoThanks:!!prepared.videoCheck&&!prepared.verifiedVideo});
  return {key:draftKey,status:decision.escalate?'needs_review':decision.reply?'reply':'no_reply'};
}

export async function deliverCloudDecision(env: Env, key: string, now:()=>number=Date.now) {
  const draft=await get(env,key), source=await get(env,draft.sourceKey), decision=draft.decision;
  await modeCheck(env,source.event);
  if(source.event.recovery&&(source.event.recoveryKind==='text'||source.event.recoveryKind==='unsupported'&&draft.textRecovery)){
    if(!draft.textRecovery||decision.sendCards||decision.sendOzonPhoto||decision.refused)return {status:'needs_review',reason:'text_recovery_requires_separate_review'};
  }else if(source.event.recovery&&source.event.recoveryKind==='unsupported'&&draft.partialReceiptReply){
    if(decision.reply!=='Спасибо! Передали реквизиты в обработку.'||decision.parts?.length!==1||decision.parts[0]!==decision.reply||decision.sendCards||decision.sendOzonPhoto)return {status:'needs_review',reason:'partial_receipt_reply_not_verified'};
  }else if(source.event.recovery&&source.event.recoveryKind==='unsupported'&&draft.restoredMedia&&!draft.unreadableMedia){
    // Exact original was recovered and passed through the normal vision/guard path.
  }else if(source.event.recovery&&(!draft.videoThanks||decision.reply!=='Спасибо за видео!'||decision.parts?.length!==1||decision.parts[0]!==decision.reply||decision.sendCards||decision.sendOzonPhoto))return {status:'needs_review',reason:'video_recovery_only_verified_thanks_allowed'};
  if(source.event.dryRun)return {status:'preview',decisionKey:key,decision:decision.reply?'reply':decision.escalate?'needs_review':'no_reply',reason:decision.reason};
  if(source.event.task!=='round'&&!dianaWorkWindow(now()).direct)return {status:'deferred',reason:'outside_direct_hours'};
  const existingNotice=source.event.task&&source.event.task!=='round'&&source.event.task!=='owner_choice'?source.payouts.find((p:any)=>p.id===source.event.payout_id):null;
  if(existingNotice?.notice_status==='delivered'){
    if(!existingNotice.notice_message_id)throw Error('cloud_existing_notice_receipt_missing');
    const original=await cloudGraph('/'+encodeURIComponent(existingNotice.notice_message_id)+'?fields=id,from,created_time,message',await pageToken(env));
    if(String(original.id)!==existingNotice.notice_message_id||![BRAND,PAGE].includes(String(original.from?.id))||!source.history.some((m:any)=>m.id===String(original.id)))throw Error('cloud_existing_notice_not_verified');
    return {status:'no_reply',reason:'Existing delivery receipt reopened in original conversation.',existingNoticeId:String(original.id)};
  }
  if (decision.escalate) return {status:'needs_review',reason:decision.reason};
  const actionId=source.event.task?source.event.event_id:undefined;
  const deliveryKey=igDeliveryKey(source.event.cid,source.at,actionId);
  if((await stateRead(env,deliveryKey))?.status==='complete')return {status:'delivered',deliveryKey,decisionKey:key};
  const currentCreator=await env.DB.prepare('SELECT * FROM ugc_creators WHERE id=?1').bind(source.creator.id).first<any>();
  const currentPayouts=(await env.DB.prepare('SELECT id,amount_minor,status,product,paid_at,failed_at,sent_at,created_at,konsol_payment_id,konsol_status,konsol_error,notice_status,notice_message_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC')
    .bind(source.creator.id).all()).results??[];
  if(currentCreator?.updated_at!==source.creator.updated_at || JSON.stringify(currentPayouts)!==JSON.stringify(source.payouts))return {status:'needs_review',reason:'erp_facts_changed_during_inference'};
  if(source.event.task==='owner_choice'){
    const current=await stateRead(env,'ig_hard:'+source.event.question_id);
    if(!current||current.answered_at||current.choice!==source.ownerChoice?.choice||current.decision_at!==source.ownerChoice?.decision_at)
      return {status:'needs_review',reason:'owner_choice_changed'};
    if(!decision.reply)return {status:'needs_review',reason:'owner_choice_not_executed'};
  }
  if (!decision.reply) return {status:'no_reply',reason:decision.reason};
  const cards=[...(decision.sendCards?SCENARIO_CARDS:[]),...(decision.sendOzonPhoto?[OZON_CARD_PHOTO]:[])];
  // A payment action has its own immutable outbox; it must never reuse the plan
  // already delivered for the incoming message which originally supplied details.
  const result=await deliverIgReply(env,{conversationId:source.event.cid,incomingAt:source.at,handle:source.handle,...(actionId?{actionId}:{}),
    parts:decision.parts??[decision.reply],cards,...(source.event.recovery?{exactPlan:true}:{})},async (boundEnv,handle,text,opts)=>{
      await modeCheck(env);
      if(source.event.task!=='round'&&!dianaWorkWindow(now()).direct)return {ok:false,delivery:'not_sent',error:'outside_direct_hours'};
      if(source.event.task==='owner_choice'){
        const current=await stateRead(env,'ig_hard:'+source.event.question_id);
        if(!current||current.answered_at||current.choice!==source.ownerChoice?.choice||current.decision_at!==source.ownerChoice?.decision_at)
          return {ok:false,delivery:'not_sent',error:'owner_choice_changed'};
      }
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
  if(result.status==='pending'&&result.error==='outside_direct_hours')return {status:'deferred',reason:'outside_direct_hours',deliveryKey};
  if (result.status!=='complete') return {status:'needs_review',reason:result.error??result.status,deliveryKey,
    retryable:result.status==='pending'&&/rate limit|too many requests/i.test(result.error??'')};
  return {status:'delivered',deliveryKey,decisionKey:key};
}

// Diana's decision starts payout intake for this one original conversation.
// Intake independently verifies the original messages, cart and existing payout.
export async function handoffCloudPayout(env: Env, key: string) {
  const draft=await get(env,key), source=await get(env,draft.sourceKey), r=draft.decision.requisites;
  await modeCheck(env,source.event);
  if (source.event.dryRun || source.event.task || source.event.skipPayout || (source.event.recovery && await stateRead(env,'diana_recovery_skip_payout:'+source.event.event_id)) || draft.decision.refused)
    return {status:'not_applicable'};
  if(draft.reconciliationPending||draft.senderQuestion)return {status:'not_applicable'}; // Never retry a disputed prior transfer.
  if(draft.unreadableMedia)return {status:'partial'}; // Unknown media may contain corrections; no transfer.
  if(draft.verifiedVideo){
    if(draft.decision.escalate)return {status:'not_applicable'};
    const result=await ingestCreatorPayouts(env,{conversation_id:source.event.cid,message_id:source.event.message_id,
      phone:'',bank:'',first_name:'',amount_minor:1,video:true,recovery:source.event.recovery===true,
      originals:source.history.map((m:any)=>({id:m.id,direction:m.direction,text:m.text}))});
    if(typeof result==='number')throw Error('payout_target_result_invalid');
    return {status:result.registered?'registered':'pending_or_existing',payout_id:result.payout_id,recipient:source.recipient};
  }
  if((!r || draft.decision.escalate) && draft.decision.payoutRequisitesDetected){
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
    image:source.history.some((m:any)=>{if(m.id!==source.event.message_id||m.direction!=='in')return false;try{return imageUrls(m.attachments_json).length>0;}catch{return false;}}),
    originals:source.history.map((m:any)=>({id:m.id,direction:m.direction,text:m.text}))});
  if(typeof result==='number')throw Error('payout_target_result_invalid');
  return {status:result.registered?'registered':'pending_or_existing',payout_id:result.payout_id,recipient:source.recipient};
}

// Keep an ambiguous transfer locked for reconciliation, while permitting a
// separate neutral answer to an actual readable question. Never assert payment.
export async function prepareUncertainPayoutReply(env:Env,key:string,payoutId:string){
 const draft=await get(env,key),source=await get(env,draft.sourceKey);await modeCheck(env,source.event);
 const current=source.history.find((m:any)=>m.id===source.event.message_id&&m.direction==='in');
 const marker='diana_payout_reconciliation:'+source.event.event_id;
 await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(marker,JSON.stringify({status:'needs_reconciliation',reason:'provider_outcome_unknown',event_id:source.event.event_id,message_id:source.event.message_id,conversation_id:source.event.cid,payout_ids:[payoutId],at:Date.now()}),Date.now()).run();
 const saved=await stateRead(env,marker);if(saved?.event_id!==source.event.event_id)throw Error('payment_reconciliation_not_saved');
 if(source.event.task||current?.unsupported||!String(current?.text??'').includes('?'))return {status:'needs_review',reason:'payment_outcome_unknown'};
 const decision={...draft.decision,reply:'Спасибо за сообщение! Мы уточним информацию.',parts:['Спасибо за сообщение! Мы уточним информацию.'],escalate:false,reason:'payment_outcome_unknown',sendCards:false,sendOzonPhoto:false,agreed:false,refused:false,requisites:null,payoutRequisitesDetected:false,learningUncertainty:'payment_outcome_unknown'};
 const next=await put(env,(await artifactPrefix(source.event))+'payment-uncertain-decision.json',{...draft,decision,reconciliationPending:true});
 return {status:'reply',key:next};
}

// Compatibility for durable workflow callbacks recorded before the manual-only
// cutover. Fail closed: never contact the provider or claim a payout.
export async function executeCloudPayout(_env: Env, _payoutId:string, _event:DianaCloudEvent, _recipient:string): Promise<never> {
  throw Error('payout_execution_owner_approval_required');
}

/** Completion requires Meta original readback for every send receipt and ERP readback. */
export async function completeCloudEvent(env: Env,event: DianaCloudEvent,outcome: any) {
  if (event.dryRun) {await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now(),dry_run:true});return outcome;}
  if(outcome.status==='media_wait'){await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now()});return outcome;}
  if(outcome.status==='deferred') {await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now()});return outcome;}
  if (outcome.status==='superseded') { await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now()});return outcome; }
  if (!['delivered','no_reply'].includes(outcome.status)) {
    await stateWrite(env,'ig_reply_escalated:'+event.cid,{at:event.at,handle:event.handle,status:'needs_review',kind:'technical',reason:outcome.reason??'cloud_execution_review'});
    await stateWrite(env,cloudEventKey(event),{...outcome,event_id:event.event_id,at:Date.now()});
    // Durable owner intent prevents duplicate questions if an acknowledgement is lost.
    // The prepared plan survives even when the owner channel is unavailable.
    await prepareReviewPlan(env,event,outcome);
    return outcome;
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
  const actualDecisionKey=outcome.decisionKey===base+'payment-uncertain-decision.json'?outcome.decisionKey:base+'decision.json';
  const draft=await get(env,actualDecisionKey),source=await get(env,draft.sourceKey),decision=draft.decision;
  if(event.task==='owner_choice'){
    if(outcome.status!=='delivered')throw Error('owner_choice_delivery_not_verified');
    const key='ig_hard:'+event.question_id;
    const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
    const current=row?JSON.parse(row.value):null;
    if(!current||current.choice!==source.ownerChoice?.choice||current.decision_at!==source.ownerChoice?.decision_at ||
       current.answered_at&&current.delivery_key!==outcome.deliveryKey)throw Error('owner_choice_changed_before_completion');
    if(!current.answered_at){
      const updated={...current,answered_at:new Date().toISOString(),delivery_key:outcome.deliveryKey};
      const changes=await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
        .bind(key,JSON.stringify(updated),Date.now(),row!.value).run();
      if(Number(changes.meta.changes)!==1)throw Error('owner_choice_changed_before_completion');
    }
    const saved=await stateRead(env,key);if(!saved?.answered_at||saved.delivery_key!==outcome.deliveryKey)throw Error('owner_choice_not_saved');
  }
  if(event.task&&event.task!=='round'&&event.task!=='owner_choice'&&event.payout_id){
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
  if(outcome.status==='delivered'){
    // Capture what actually reached Meta, not merely the proposed model draft.
    // This is a pending Owner review, never a claim that training occurred.
    const plan=await stateRead(env,outcome.deliveryKey);
    if(plan?.status!=='complete'||!Array.isArray(plan.items)||!plan.items.length||plan.items.some((i:any)=>i.status!=='sent'||!i.messageId))throw Error('learning_delivery_receipt_missing');
    const evidenceKey=await put(env,base+'learning-observation.json',{event_id:event.event_id,message_id:event.message_id,sourceKey:draft.sourceKey,contextKey:draft.contextKey??null,decisionKey:actualDecisionKey,deliveryKey:outcome.deliveryKey,
      original_message_ids:source.history.map((m:any)=>m.id),unreadable_message_ids:source.history.filter((m:any)=>m.unsupported).map((m:any)=>m.id),decision_reason:decision.reason??null,learning_uncertainty:decision.learningUncertainty??null,
      sent:plan.items.map((i:any)=>({message_id:i.messageId,text:i.text??null,image_url:i.imageUrl??null})),status:'pending_owner_review'});
    const observationKey='diana_learning_observation:'+event.event_id;
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(observationKey,JSON.stringify({status:'pending_owner_review',event_id:event.event_id,message_id:event.message_id,evidenceKey,deliveryKey:outcome.deliveryKey,at:Date.now()}),Date.now()).run();
    const saved=await stateRead(env,observationKey);if(saved?.evidenceKey!==evidenceKey||saved?.deliveryKey!==outcome.deliveryKey)throw Error('learning_observation_not_verified');
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
