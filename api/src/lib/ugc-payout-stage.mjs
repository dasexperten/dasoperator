// DH-LAW-261018-10 and -12: the creator's status follows her payout, forward only.
// Every write of a payout status calls this, so no path can leave the status behind.
// Silent moves on a fresh payout event; the other side statuses are a person's decision.
const FROM = {
  cart: ['', 'new', 'sent', 'replied', 'agreed', 'silent'],
  paid: ['', 'new', 'sent', 'replied', 'agreed', 'cart', 'failed', 'silent'],
  failed: ['', 'new', 'sent', 'replied', 'agreed', 'cart', 'silent'],
};

export function stageForPayoutStatus(status) {
  if (status === 'paid' || status === 'failed') return status;
  return ['awaiting_approval', 'approved', 'sent'].includes(status) ? 'cart' : null;
}

/** A failed status write never undoes the payout it follows; the reply lane still corrects it later. */
export async function followPayoutStage(db, creatorId, payoutStatus, now = Date.now()) {
  const stage = stageForPayoutStatus(payoutStatus);
  if (!creatorId || !stage) return false;
  const from = FROM[stage];
  try {
    const r = await db.prepare(`UPDATE ugc_creators SET lifecycle_stage=?2, updated_at=?3
      WHERE id=?1 AND COALESCE(lifecycle_stage,'') IN (${from.map((_, i) => `?${i + 4}`).join(',')})`)
      .bind(creatorId, stage, now, ...from).run();
    return (r.meta?.changes ?? 0) > 0;
  } catch (error) {
    console.error('ugc_stage_follow_failed', creatorId, stage, error instanceof Error ? error.message : String(error));
    return false;
  }
}
