// Owner 2026-11-05: a human changes a blogger's status by double click in the ERP.
// Diana must see that the status was changed by hand, take it as her own miss, and learn from it.
// The record lives in crm_sync_state under manual_stage:<creator_id> (no migration needed).

export const MANUAL_STAGE_PREFIX = 'manual_stage:';
export const manualStageKey = (creatorId) => `${MANUAL_STAGE_PREFIX}${creatorId}`;

// Returns the record to store, or null when nothing was changed by hand.
export function buildManualStage({ from, to, by, at }) {
  const before = String(from ?? '');
  const after = String(to ?? '');
  if (before === after) return null;
  return { from: before, to: after, by: by ?? null, at, reviewed_at: null };
}

export function parseManualStage(raw) {
  try {
    const value = JSON.parse(String(raw ?? ''));
    if (!value || typeof value !== 'object') return null;
    if (typeof value.to !== 'string' || typeof value.at !== 'number') return null;
    return {
      from: typeof value.from === 'string' ? value.from : '',
      to: value.to,
      by: typeof value.by === 'string' ? value.by : null,
      at: value.at,
      reviewed_at: typeof value.reviewed_at === 'number' ? value.reviewed_at : null,
    };
  } catch {
    return null;
  }
}

// A new manual change after Diana's review opens a new review.
export function markReviewed(record, at) {
  if (!record) return null;
  return { ...record, reviewed_at: at };
}
