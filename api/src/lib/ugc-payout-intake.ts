import type { Env } from '../types';
import { konsolPhone, isFpsBankMemberId, maskPhoneWide } from './ugc-payouts.mjs';
import { confirmedCartAmount } from './ugc-cart-amount.mjs';
import { decideCart } from './ugc-cart-decision.mjs';
import { payoutStageStatement } from './ugc-payout-stage.mjs';

// Explicit reviewed intake and the narrow deterministic payout scanner share this save boundary.
// Save the approval row, protected requisites and source receipt in one transaction.
export async function prepareCreatorPayout(env: Pick<Env, 'DB'>, input: {
  verified: boolean; handle: string; conversation_id: string; cycle_message_id: string;
  source_message_ids: string[]; amount_minor: number; phone: string; first_name?: string | null;
  fps_bank_member_id: string; bank_ref: string;
  cart_review?: {source_message_id:string;amount_minor:number};
}, now = Date.now()) {
  const handle = String(input.handle ?? '').replace(/^@/, '').toLowerCase();
  const phone = konsolPhone(input.phone);
  const sources = [...new Set(input.source_message_ids ?? [])];
  if (input.verified !== true || !/^[a-z0-9_.]{1,40}$/.test(handle) || !input.conversation_id ||
      !sources.length || sources.length > 20 || !sources.includes(input.cycle_message_id) ||
      !Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0) throw Error('verified_payout_facts_required');
  const missing: string[] = [];
  if (!phone) missing.push('phone');
  if (typeof input.first_name !== 'string' || !input.first_name.trim() || input.first_name.length > 120) missing.push('first_name');
  if (!isFpsBankMemberId(input.fps_bank_member_id) || typeof input.bank_ref !== 'string' || !input.bank_ref.trim()) missing.push('bank');
  let firstAt = Infinity, lastAt = 0, incoming = false;
  for (const id of sources) {
    const message = await env.DB.prepare(`SELECT direction,from_username,created_at FROM ugc_ig_messages
      WHERE id=?1 AND conversation_id=?2`).bind(id, input.conversation_id)
      .first<{direction:string;from_username:string;created_at:string}>();
    if (!message) throw Error('original_message_archive_required');
    const at = Date.parse(message.created_at);
    if (!Number.isFinite(at) || at > now) throw Error('invalid_original_message_time');
    if (message.direction === 'in') {
      if (message.from_username?.toLowerCase() !== handle) throw Error('source_creator_mismatch');
      incoming = true; firstAt = Math.min(firstAt, at); lastAt = Math.max(lastAt, at);
    }
  }
  if (!incoming) throw Error('creator_source_required');
  const lockKey = 'diana_payout_intake_lock:' + handle;
  const lockToken = crypto.randomUUID();
  const lock = await env.DB.batch([env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE crm_sync_state.updated_at<?4`).bind(lockKey,lockToken,now,now-300_000)]);
  if (Number(lock[0]?.meta?.changes ?? 0) !== 1) throw Error('payout_intake_busy_retry');
  try {
  async function stable(prefix: string, value: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return prefix + '_' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('').slice(0,24);
  }
  const profile = await env.DB.prepare(`SELECT id,creator_id FROM ugc_creator_platforms
    WHERE platform='instagram' AND normalized_handle=?1`).bind(handle).first<{id:string;creator_id:string}>();
  const creatorId = profile?.creator_id ?? await stable('ugc','instagram:'+handle);
  const profileId = profile?.id ?? await stable('ugcp','instagram:'+handle);
  const key = 'diana_payout_intake:' + creatorId;
  const receipt = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
  if (receipt) {
    const previous = JSON.parse(receipt.value);
    if (Number(previous.source_at) > lastAt) throw Error('newer_payment_details_already_saved');
  }
  const settled = await env.DB.prepare(`SELECT id FROM ugc_payouts WHERE creator_id=?1
    AND (status IN ('sent','paid') OR konsol_payment_id IS NOT NULL OR execute_claim IS NOT NULL)
    AND COALESCE(paid_at,sent_at,payout_date || 'T00:00:00Z')>=?2 LIMIT 1`)
    .bind(creatorId,new Date(firstAt).toISOString()).first();
  if (settled) throw Error('payment_already_handed_over_for_this_conversation');
  const open = await env.DB.prepare(`SELECT id,amount_minor FROM ugc_payouts WHERE creator_id=?1
    AND status IN ('awaiting_approval','approved') AND konsol_payment_id IS NULL AND execute_claim IS NULL
    ORDER BY updated_at DESC LIMIT 1`).bind(creatorId).first<{id:string;amount_minor:number}>();
  const context = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_context:'+input.conversation_id).first<{value:string}>();
  const latestImage = await env.DB.prepare("SELECT MAX(created_at) at FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in' AND attachments_json IS NOT NULL AND attachments_json NOT IN ('[]','{}','null','') AND json_valid(attachments_json) AND json_type(attachments_json)='array' AND json_array_length(attachments_json)>0").bind(input.conversation_id).first<{at:string}>();
  let imageCheck; try { imageCheck=JSON.parse(context?.value ?? '{}').image_check; } catch {}
  let cartAmount=confirmedCartAmount(imageCheck,latestImage?.at);
  const cartReceipt=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('ugc_cart_review:'+input.conversation_id).first<{value:string}>();
  let structuredCart:any=null;
  if(cartReceipt){
    cartAmount=null;
    try{
      const proof=JSON.parse(cartReceipt.value);
      const latestIncoming=await env.DB.prepare("SELECT MAX(created_at) at FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in'").bind(input.conversation_id).first<{at:string}>();
      const sameTime=(a:string|null|undefined,b:string|null|undefined)=>!a&&!b||Boolean(a&&b&&Date.parse(a)===Date.parse(b));
      const decision=decideCart(proof.checks??[],proof.quote);
      if(proof.version===1&&proof.conversation_id===input.conversation_id&&sameTime(proof.latest_image_at,latestImage?.at)&&sameTime(proof.latest_incoming_at,latestIncoming?.at)&&decision.status==='confirmed'&&decision.amount_minor===proof.amount_minor){
        const source=await env.DB.prepare('SELECT direction,from_username,created_at FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2').bind(decision.source_message_id,input.conversation_id).first<{direction:string;from_username:string;created_at:string}>();
        if(source?.direction==='in'&&source.from_username?.toLowerCase()===handle){cartAmount=decision.amount_minor;structuredCart={receipt_key:'ugc_cart_review:'+input.conversation_id,authority:decision.authority,source_message_id:decision.source_message_id,amount_minor:decision.amount_minor};}
      }
    }catch{} // Invalid/stale receipt remains unconfirmed, never a guessed number.
  }
  if(input.cart_review){
    const review=input.cart_review;
    if(!Number.isSafeInteger(review.amount_minor)||review.amount_minor<5000||review.amount_minor>99900)throw Error('invalid_verified_cart_amount');
    const source=await env.DB.prepare("SELECT created_at FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2 AND direction='in' AND json_valid(attachments_json) AND json_type(attachments_json)='array' AND json_array_length(attachments_json)>0").bind(review.source_message_id,input.conversation_id).first<{created_at:string}>();
    if(!source||!latestImage?.at||Date.parse(source.created_at)!==Date.parse(latestImage.at))throw Error('verified_cart_must_be_current_original');
    cartAmount=review.amount_minor;
  }
  // Never create a financial row from the one-kopeck 'unknown' sentinel.
  // Preserve an existing Owner amount; current-cart review remains the existing
  // amount authority. A raw observed/parser number is not a replacement for it.
  const amount = open && Number.isSafeInteger(open.amount_minor) && open.amount_minor >= 5000
    ? open.amount_minor : cartAmount;
  if (amount == null || !Number.isSafeInteger(amount) || amount < 5000) missing.unshift('amount_minor');
  if (missing.length) {
    // Durable, deduplicated metadata for review. This is NOT a sent message or
    // an executable Diana task: the consumer must re-read originals before asking.
    const pendingKey = 'diana_payout_intake_pending:' + creatorId + ':' + input.cycle_message_id;
    const pending = JSON.stringify({version:1,status:'needs_clarification',dispatch_status:'not_dispatched',
      conversation_id:input.conversation_id,cycle_message_id:input.cycle_message_id,
      source_message_ids:sources,source_at:lastAt,missing_fields:missing,
      observed_amount_minor:amount ?? null});
    const write = await savePendingClarification(env.DB,pendingKey,pending,now);
    if (!write) throw Error('payout_intake_clarification_not_verified');
    return {outcome:'clarification_required',registered:false,missing_fields:missing,
      dispatch_status:'not_dispatched'};
  }
  const id = open?.id ?? await stable('ugcpay',creatorId+':'+input.cycle_message_id);
  const pendingKey = 'diana_payout_intake_pending:' + creatorId + ':' + input.cycle_message_id;
  const proof = JSON.stringify({verified:true,payout_id:id,handle,conversation_id:input.conversation_id,
    source_message_ids:sources,cycle_message_id:input.cycle_message_id,source_at:lastAt,
    observed_amount_minor:input.amount_minor,verified_cart:input.cart_review??structuredCart,reviewer:'diana-helios',checked_at:new Date(now).toISOString()});
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,created_at,updated_at)
      VALUES(?1,?2,'agreed',?3,?3) ON CONFLICT(id) DO NOTHING`).bind(creatorId,handle,now),
    env.DB.prepare(`INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,profile_url,source,created_at,updated_at)
      VALUES(?1,?2,'instagram',?3,?3,?4,'ugc_payout',?5,?5) ON CONFLICT(platform,normalized_handle) DO NOTHING`)
      .bind(profileId,creatorId,handle,'https://www.instagram.com/'+handle+'/',now),
    env.DB.prepare(`INSERT INTO ugc_payouts(id,creator_id,creator_platform_id,platform,handle,amount_minor,currency,status,
      payout_date,marketplace,phone_masked,bank_ref,fps_bank_member_id,product,note,created_by,created_at,updated_at)
      VALUES(?1,?2,?3,'instagram',?4,?10,'RUB','awaiting_approval',?5,'ozon',?6,?7,?8,
      'TERMO 39°','Реквизиты проверены по исходной переписке. Ожидает одобрения Владельца.','diana-helios',?9,?9)
      ON CONFLICT(id) DO NOTHING`).bind(id,creatorId,profileId,handle,
        new Date(now+4*3600_000).toISOString().slice(0,10),maskPhoneWide(phone!),input.bank_ref,input.fps_bank_member_id,now,amount),
    env.DB.prepare(`UPDATE ugc_payouts SET phone_masked=?2,bank_ref=?3,fps_bank_member_id=?4,
      amount_minor=CASE WHEN amount_minor=1 THEN ?6 ELSE amount_minor END,product='TERMO 39°',status='awaiting_approval',approved_at=NULL,approved_by=NULL,updated_at=?5
      WHERE id=?1 AND status IN ('awaiting_approval','approved') AND konsol_payment_id IS NULL AND execute_claim IS NULL`)
      .bind(id,maskPhoneWide(phone!),input.bank_ref,input.fps_bank_member_id,now,amount),
    env.DB.prepare(`INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,first_name,last_name,patronymic,created_at,updated_at)
      SELECT ?1,?2,?3,NULL,NULL,?4,?4 WHERE EXISTS(SELECT 1 FROM ugc_payouts WHERE id=?1 AND status='awaiting_approval' AND konsol_payment_id IS NULL AND execute_claim IS NULL)
      ON CONFLICT(payout_id) DO UPDATE SET fps_mobile_phone=excluded.fps_mobile_phone,first_name=excluded.first_name,
      last_name=NULL,patronymic=NULL,updated_at=excluded.updated_at`).bind(id,phone,input.first_name?.trim() || null,now),
    payoutStageStatement(env.DB,creatorId,'awaiting_approval',now)!,
    env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key,proof,now),
    env.DB.prepare(`UPDATE crm_sync_state SET value=json_set(value,'$.status','resolved'),updated_at=?2
      WHERE key=?1 AND json_valid(value) AND json_extract(value,'$.status')='needs_clarification'
        AND json_extract(value,'$.dispatch_status')='not_dispatched' AND json_extract(value,'$.source_at')<=?3`).bind(pendingKey,now,lastAt),
  ]);
  const saved = await env.DB.prepare(`SELECT p.id,p.status,p.amount_minor,p.phone_masked,p.bank_ref,
    r.first_name,r.fps_mobile_phone FROM ugc_payouts p JOIN ugc_payout_requisites r ON r.payout_id=p.id WHERE p.id=?1`)
    .bind(id).first<Record<string,unknown>>();
  if (!saved || saved.status !== 'awaiting_approval' || saved.amount_minor !== amount ||
      saved.fps_mobile_phone !== phone || saved.bank_ref !== input.bank_ref ||
      saved.first_name !== (input.first_name?.trim() || null)) throw Error('payout_intake_readback_failed');
  const {fps_mobile_phone: _privatePhone, ...display} = saved;
  return display;
  } finally {
    await env.DB.batch([env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1 AND value=?2').bind(lockKey,lockToken)]);
  }
}

// Existing crm_sync_state boundary only; no raw name, phone or bank is stored here.
async function savePendingClarification(db: Env['DB'], key: string, value: string, now: number) {
  const result = await db.batch<{value:string}>([
    db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      WHERE crm_sync_state.value<>excluded.value AND json_valid(crm_sync_state.value)
        AND (json_extract(crm_sync_state.value,'$.status')='needs_clarification'
          OR (json_extract(crm_sync_state.value,'$.status')='resolved'
            AND json_extract(crm_sync_state.value,'$.source_at')<json_extract(excluded.value,'$.source_at')))
        AND json_extract(crm_sync_state.value,'$.dispatch_status')='not_dispatched'
        AND json_extract(crm_sync_state.value,'$.source_at')<=json_extract(excluded.value,'$.source_at')`).bind(key,value,now),
    db.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key),
  ]);
  return result.length===2 && result.every(row=>row.success===true)
    && [0,1].includes(Number(result[0]?.meta?.changes)) && result[1]?.results?.[0]?.value===value;
}
