import type { Env } from '../types';
import { konsolPhone, isFpsBankMemberId, maskPhoneWide } from './ugc-payouts.mjs';
import { payoutStageStatement } from './ugc-payout-stage.mjs';

// Diana supplies reviewed facts from originals; ERP does no chat interpretation.
// Save the approval row, protected requisites and source receipt in one transaction.
export async function prepareCreatorPayout(env: Pick<Env, 'DB'>, input: {
  verified: boolean; handle: string; conversation_id: string; cycle_message_id: string;
  source_message_ids: string[]; amount_minor: number; phone: string; first_name?: string | null;
  fps_bank_member_id: string; bank_ref: string;
}, now = Date.now()) {
  const handle = String(input.handle ?? '').replace(/^@/, '').toLowerCase();
  const phone = konsolPhone(input.phone);
  const sources = [...new Set(input.source_message_ids ?? [])];
  if (input.verified !== true || !/^[a-z0-9_.]{1,40}$/.test(handle) || !input.conversation_id ||
      !sources.length || sources.length > 20 || !sources.includes(input.cycle_message_id) ||
      !Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0 || !phone ||
      (input.first_name != null && (typeof input.first_name !== 'string' || input.first_name.length > 120)) ||
      !isFpsBankMemberId(input.fps_bank_member_id) || !input.bank_ref?.trim()) throw Error('verified_payout_facts_required');
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
  const id = open?.id ?? await stable('ugcpay',creatorId+':'+input.cycle_message_id);
  const proof = JSON.stringify({verified:true,payout_id:id,handle,conversation_id:input.conversation_id,
    source_message_ids:sources,cycle_message_id:input.cycle_message_id,source_at:lastAt,
    observed_amount_minor:input.amount_minor,reviewer:'diana-helios',checked_at:new Date(now).toISOString()});
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,created_at,updated_at)
      VALUES(?1,?2,'agreed',?3,?3) ON CONFLICT(id) DO NOTHING`).bind(creatorId,handle,now),
    env.DB.prepare(`INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,profile_url,source,created_at,updated_at)
      VALUES(?1,?2,'instagram',?3,?3,?4,'ugc_payout',?5,?5) ON CONFLICT(platform,normalized_handle) DO NOTHING`)
      .bind(profileId,creatorId,handle,'https://www.instagram.com/'+handle+'/',now),
    env.DB.prepare(`INSERT INTO ugc_payouts(id,creator_id,creator_platform_id,platform,handle,amount_minor,currency,status,
      payout_date,marketplace,phone_masked,bank_ref,fps_bank_member_id,product,note,created_by,created_at,updated_at)
      VALUES(?1,?2,?3,'instagram',?4,1,'RUB','awaiting_approval',?5,'ozon',?6,?7,?8,
      'TERMO 39°','Реквизиты проверены по исходной переписке. Ожидает одобрения Владельца.','diana-helios',?9,?9)
      ON CONFLICT(id) DO NOTHING`).bind(id,creatorId,profileId,handle,
        new Date(now+4*3600_000).toISOString().slice(0,10),maskPhoneWide(phone),input.bank_ref,input.fps_bank_member_id,now),
    env.DB.prepare(`UPDATE ugc_payouts SET phone_masked=?2,bank_ref=?3,fps_bank_member_id=?4,
      product='TERMO 39°',status='awaiting_approval',approved_at=NULL,approved_by=NULL,updated_at=?5
      WHERE id=?1 AND status IN ('awaiting_approval','approved') AND konsol_payment_id IS NULL AND execute_claim IS NULL`)
      .bind(id,maskPhoneWide(phone),input.bank_ref,input.fps_bank_member_id,now),
    env.DB.prepare(`INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,first_name,last_name,patronymic,created_at,updated_at)
      SELECT ?1,?2,?3,NULL,NULL,?4,?4 WHERE EXISTS(SELECT 1 FROM ugc_payouts WHERE id=?1 AND status='awaiting_approval' AND konsol_payment_id IS NULL AND execute_claim IS NULL)
      ON CONFLICT(payout_id) DO UPDATE SET fps_mobile_phone=excluded.fps_mobile_phone,first_name=excluded.first_name,
      last_name=NULL,patronymic=NULL,updated_at=excluded.updated_at`).bind(id,phone,input.first_name?.trim() || null,now),
    payoutStageStatement(env.DB,creatorId,'awaiting_approval',now)!,
    env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key,proof,now),
  ]);
  const saved = await env.DB.prepare(`SELECT p.id,p.status,p.amount_minor,p.phone_masked,p.bank_ref,
    r.first_name,r.fps_mobile_phone FROM ugc_payouts p JOIN ugc_payout_requisites r ON r.payout_id=p.id WHERE p.id=?1`)
    .bind(id).first<Record<string,unknown>>();
  if (!saved || saved.status !== 'awaiting_approval' || saved.amount_minor !== (open?.amount_minor ?? 1) ||
      saved.fps_mobile_phone !== phone || saved.bank_ref !== input.bank_ref ||
      saved.first_name !== (input.first_name?.trim() || null)) throw Error('payout_intake_readback_failed');
  const {fps_mobile_phone: _privatePhone, ...display} = saved;
  return display;
  } finally {
    await env.DB.batch([env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1 AND value=?2').bind(lockKey,lockToken)]);
  }
}
