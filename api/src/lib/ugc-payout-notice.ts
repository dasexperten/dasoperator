import type { Env } from '../types';

// Diana verifies the original conversation. ERP validates its archived identity,
// ownership and time, then saves the delivery fields and evidence together.
export async function recordPayoutNotice(env: Env, id: string, input: {
  verified?: boolean; message_id?: string; conversation_id?: string; evidence?: string; outcome?: 'delivered' | 'reviewed';
}) {
  if (input.verified !== true || !input.message_id || !input.conversation_id ||
      !input.evidence?.trim() || input.evidence.length > 2000) throw Error('verified_notice_evidence_required');
  const reviewed = input.outcome === 'reviewed';
  if (input.outcome && !['delivered','reviewed'].includes(input.outcome)) throw Error('invalid_notice_outcome');
  const row = await env.DB.prepare(`SELECT id,handle,status,paid_at,konsol_payment_id,notice_status,notice_message_id
    FROM ugc_payouts WHERE id=?1`).bind(id).first<Record<string, any>>();
  if (!row) throw Error('payout_not_found');
  if (row.status !== 'paid' || !row.konsol_payment_id) throw Error('confirmed_payment_required');
  if (row.notice_status === 'delivered' && row.notice_message_id !== input.message_id) throw Error('different_notice_already_recorded');
  const message = await env.DB.prepare(`SELECT id,created_at FROM ugc_ig_messages WHERE id=?1
    AND conversation_id=?2 AND (?4=1 OR direction='out') AND EXISTS (
      SELECT 1 FROM ugc_ig_messages incoming WHERE incoming.conversation_id=?2
      AND incoming.direction='in' AND LOWER(incoming.from_username)=?3)`)
    .bind(input.message_id,input.conversation_id,String(row.handle).replace(/^@/,'').toLowerCase(),reviewed ? 1 : 0)
    .first<{id:string;created_at:string}>();
  if (!message) throw Error('matching_original_message_archive_required');
  const sent = Date.parse(message.created_at), paid = Date.parse(row.paid_at);
  if (!Number.isFinite(sent) || !Number.isFinite(paid) || (!reviewed && sent < paid) || sent > Date.now()) throw Error('message_must_follow_payment');
  const at = new Date(sent).toISOString(), now = Date.now();
  const receipt = JSON.stringify({verified:true,outcome:reviewed?'reviewed':'delivered',payout_id:id,message_id:message.id,
    conversation_id:input.conversation_id,sent_at:at,evidence:input.evidence.trim(),reviewer:'diana-helios',checked_at:new Date(now).toISOString()});
  if (reviewed) {
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE ugc_payouts SET notice_status='reviewed',notice_error=?2,
        paid_notice_at=NULL,notice_at=NULL,notice_message_id=NULL,updated_at=?3
        WHERE id=?1 AND status='paid' AND konsol_payment_id=?4
        AND COALESCE(notice_status,'') <> 'delivered'`)
        .bind(id,input.evidence.trim(),now,row.konsol_payment_id),
      env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at)
        SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM ugc_payouts WHERE id=?4 AND notice_status='reviewed')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind('diana_payout_notice_verified:'+id,receipt,now,id),
    ]);
    if (!result[0]?.meta?.changes) throw Error('payout_changed_during_verification');
    return {id,notice_status:'reviewed',notice_message_id:null,notice_at:null};
  }
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE ugc_payouts SET notice_status='delivered',notice_error=NULL,
      notice_message_id=?2,notice_at=?3,paid_notice_at=?3,updated_at=?4
      WHERE id=?1 AND status='paid' AND konsol_payment_id=?5
      AND (notice_message_id IS NULL OR notice_message_id=?2)`)
      .bind(id,message.id,at,now,row.konsol_payment_id),
    env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at)
      SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM ugc_payouts WHERE id=?4
        AND notice_status='delivered' AND notice_message_id=?5)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind('diana_payout_notice_verified:'+id,receipt,now,id,message.id),
  ]);
  if (!result[0]?.meta?.changes) throw Error('payout_changed_during_verification');
  return {id,notice_status:'delivered',notice_message_id:message.id,notice_at:at};
}
