// DH-LAW-261018-10 and -12: the creator's status follows her payout, forward only.
// Every write of a payout status calls this, so no path can leave the status behind.
// Silent moves on a fresh payout event; the other side statuses are a person's decision.
// DH-LAW-261018-11: these words are retired and mean "no status". Old rows and the
// scouting write can still carry them, so every reader treats them as empty.
const RETIRED = ['new', 'sent', 'found', 'qualified', 'invited'];
const FROM = {
  cart: ['', ...RETIRED, 'replied', 'agreed', 'silent'],
  paid: ['', ...RETIRED, 'replied', 'agreed', 'cart', 'failed', 'silent'],
  failed: ['', ...RETIRED, 'replied', 'agreed', 'cart', 'silent'],
};

export function isRetiredStage(stage) {
  return RETIRED.includes(stage);
}

/** What a retired status shows: the payout facts decide, nothing is written. */
export function shownStage(stage, payouts = []) {
  if (!isRetiredStage(stage)) return stage;
  if (payouts.some((p) => p.status === 'paid' && p.konsol_payment_id)) return 'paid';
  if (payouts.some((p) => ['awaiting_approval', 'approved', 'sent'].includes(p.status))) return 'cart';
  return payouts.some((p) => p.status === 'failed') ? 'failed' : '';
}

// Owner 2026-11-02: after our transfer, «куда выложить» means the piece is already made.
// A bare «куда скинуть» can be a screenshot, so that verb needs the word for the video.
export function askedWhereToPost(text) {
  const t = String(text ?? '');
  return /куда\s+(?:[а-яё]+\s+){0,2}(?:выложить|выкладывать|залить|загрузить)/i.test(t)
    || /куда\s+(?:[а-яё]+\s+){0,2}(?:скинуть|отправить|прислать)\s+(?:[а-яё]+\s+){0,1}(?:ролик|видео)/i.test(t);
}

export function stageForPayoutStatus(status) {
  if (status === 'paid' || status === 'failed') return status;
  return ['awaiting_approval', 'approved', 'sent'].includes(status) ? 'cart' : null;
}

/** A failed status write never undoes the payout it follows; the reply lane still corrects it later. */
export function payoutStageStatement(db, creatorId, payoutStatus, now = Date.now()) {
  const stage = stageForPayoutStatus(payoutStatus);
  if (!creatorId || !stage) return null;
  const from = FROM[stage];
  return db.prepare(`UPDATE ugc_creators SET lifecycle_stage=?2, updated_at=?3
      WHERE id=?1 AND COALESCE(lifecycle_stage,'') IN (${from.map((_, i) => `?${i + 4}`).join(',')})`)
      .bind(creatorId, stage, now, ...from);
}

export async function followPayoutStage(db, creatorId, payoutStatus, now = Date.now()) {
  const statement = payoutStageStatement(db, creatorId, payoutStatus, now);
  if (!statement) return false;
  try {
    const r = await statement.run();
    return (r.meta?.changes ?? 0) > 0;
  } catch (error) {
    console.error('ugc_stage_follow_failed', creatorId, stageForPayoutStatus(payoutStatus), error instanceof Error ? error.message : String(error));
    return false;
  }
}
