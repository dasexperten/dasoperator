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

export type DianaCloudEvent = { cid: string; message_id: string; event_id: string; handle?: string; at: string; dryRun?: boolean };
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
  if (String(newest.id) !== event.message_id) return {status:'superseded'};
  if ([BRAND,PAGE].includes(String(newest.from.id))) return {status:'superseded'};
  const handle = String(newest.from.username ?? event.handle ?? '').toLowerCase().replace(/^@/,'');
  if (!/^[a-z0-9_.]{1,30}$/.test(handle)) throw Error('diana_creator_handle_missing');
  const seen = new Date().toISOString();
  for (const message of originals) await archiveIgMessage(env,event.cid,message,seen,0);
  const history = originals.slice().reverse().map(m=>({id:String(m.id),direction:[BRAND,PAGE].includes(String(m.from.id))?'out':'in',
    text: m.message || m.shares?.data?.map((s:any)=>s.link).join('\n') || '',attachments_json:JSON.stringify(m.attachments?.data??[]),
    unsupported:m.is_unsupported===true,created_at:new Date(m.created_time).toISOString()}));
  let creator = await env.DB.prepare("SELECT c.* FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform IN ('instagram','other') AND p.normalized_handle=?1 ORDER BY CASE WHEN p.platform='instagram' THEN 0 ELSE 1 END LIMIT 1")
    .bind(handle).first<any>();
  if (!creator && !event.dryRun) {
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
  const payouts = (await env.DB.prepare('SELECT id,amount_minor,status,product,paid_at,sent_at,created_at,konsol_payment_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC')
    .bind(creator.id).all()).results??[];
  const plans = (await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND json_valid(value) AND json_extract(value,'$.conversationId')=?1")
    .bind(event.cid).all<{value:string}>()).results?.map(r=>JSON.parse(r.value))??[];
  const ownerDecision = await stateRead(env,'ig_owner_decision:'+event.cid);
  const key = await put(env,(await artifactPrefix(event))+'source.json',{event,handle,recipient:String(newest.from.id),at:new Date(newest.created_time).toISOString(),
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
  const task = JSON.stringify({task:'Write the next Diana Direct decision for this original conversation. This is incoming chat handling only, not scouting or proactive reminders.',
    handle:source.handle,creator:source.creator,payouts:source.payouts,delivery_plans:source.plans,owner_decision:source.ownerDecision,history:source.history});
  const prepared = await prepareDianaContext({task,githubToken:(env as any).GITHUB_TOKEN??'',infer:subscriptionInfer(env,'context')});
  const screenshots = await incomingScreenshots(env,source.history,source.at);
  if (screenshots.currentUnavailable) throw Error('current_image_unavailable');
  const imageCheck = screenshots.images.length ? await checkSubscriptionImages({images:screenshots.images,policy:prepared.imagePolicy,task,infer:subscriptionInfer(env,'image')}) : null;
  const system = prepared.system + '\n' + JSON_SPEC + `\nCloud execution facts: tools are performed by this workflow, never claim an action already happened. All payout registration and transfers are a separate ERP process. Do not confirm requisites were saved unless the supplied payout row proves it. Current creator stage and manual decisions are authoritative. Existing card delivery receipts are authoritative: do not re-send cards already delivered. An order screenshot is required before scenario cards. Acknowledgements can require no reply; explain that decision in reason. If this requires a browser or a consultation not in these sources, escalate without pretending the tool ran. Image evidence: ${JSON.stringify(imageCheck)}. Unavailable historical images: ${screenshots.unreadable}. Do not guess absent facts.`;
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
  const decision=guardReply(result.text,{paid:source.payouts.some((p:any)=>p.status==='paid'&&p.konsol_payment_id),inCount:incoming.length,
    lastIn:incoming.slice(-2).map((m:any)=>m.text).join('\n'),ownerDecided:!!source.ownerDecision});
  const draftKey=await put(env,(await artifactPrefix(source.event))+'decision.json',{sourceKey:prepared.sourceKey,decision,receipt:result.receipt});
  return {key:draftKey,status:decision.escalate?'needs_review':decision.reply?'reply':'no_reply'};
}

export async function deliverCloudDecision(env: Env, key: string) {
  const draft=await get(env,key), source=await get(env,draft.sourceKey), decision=draft.decision;
  await modeCheck(env,source.event);
  if(source.event.dryRun)return {status:'preview',decisionKey:key,decision:decision.reply?'reply':decision.escalate?'needs_review':'no_reply',reason:decision.reason};
  if (decision.escalate) return {status:'needs_review',reason:decision.reason};
  if (!decision.reply) return {status:'no_reply',reason:decision.reason};
  const currentCreator=await env.DB.prepare('SELECT * FROM ugc_creators WHERE id=?1').bind(source.creator.id).first<any>();
  const currentPayouts=(await env.DB.prepare('SELECT id,amount_minor,status,product,paid_at,sent_at,created_at,konsol_payment_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC')
    .bind(source.creator.id).all()).results??[];
  if(currentCreator?.updated_at!==source.creator.updated_at || JSON.stringify(currentPayouts)!==JSON.stringify(source.payouts))return {status:'needs_review',reason:'erp_facts_changed_during_inference'};
  const cards=[...(decision.sendCards?SCENARIO_CARDS:[]),...(decision.sendOzonPhoto?[OZON_CARD_PHOTO]:[])];
  const deliveryKey=igDeliveryKey(source.event.cid,source.at);
  const result=await deliverIgReply(env,{conversationId:source.event.cid,incomingAt:source.at,handle:source.handle,
    parts:decision.parts??[decision.reply],cards},async (boundEnv,handle,text,opts)=>{
      await modeCheck(env);
      const token=await pageToken(env);
      const live=await cloudGraph('/'+encodeURIComponent(source.event.cid)+'?fields=messages.limit(1){id,from,created_time}',token);
      const latest=live.messages?.data?.[0];
      const plan=await stateRead(env,deliveryKey);
      const receipts=(plan?.items??[]).filter((x:any)=>x.status==='sent').map((x:any)=>x.messageId);
      if (!latest || !(String(latest.id)===source.event.message_id || receipts.includes(String(latest.id)))) return {ok:false,delivery:'not_sent',error:'conversation_changed_before_send'};
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
  await acknowledgeDianaEvent(env,event);
  await stateWrite(env,cloudEventKey(event),{...proof,status:'complete'});
  return {status:'complete',outcome:outcome.status};
}
