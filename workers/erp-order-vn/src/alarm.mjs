export const NAME = 'erp-order-vn';
export const PREFIX = `${NAME}:`;
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

export async function expireAbandonedClaims(db, now) {
  const expiredBefore = new Date(now.getTime() - ABANDONED_AFTER_MS).toISOString();
  const result = await db.prepare(
    `UPDATE crm_sync_state
        SET value=json_set(value,
          '$.state','blocked',
          '$.finished_at',?,
          '$.note','Executor stopped reporting. Reconcile ERP and EasyInvoice before processing affected orders.',
          '$.evidence',json_array('alarm:claim-expired')),
          updated_at=?
      WHERE key LIKE ? AND json_extract(value,'$.state')='working'
        AND json_extract(value,'$.started_at') <= ?`,
  ).bind(now.toISOString(), Math.floor(now.getTime() / 1000), PREFIX + '%', expiredBefore).run();
  return result.meta.changes;
}
export function dayKey(now = new Date()) {
  return PREFIX + new Date(now.getTime() + 4 * 3600000).toISOString().slice(0, 10);
}
export function signal(now = new Date()) {
  return { name: NAME, target: 'tet', finance: 'justina-timber', state: 'pending',
    day: dayKey(now).slice(PREFIX.length), requested_at: now.toISOString() };
}
export function validEvidence(body) {
  return body && typeof body.note === 'string' && body.note.trim().length > 0
    && Array.isArray(body.evidence) && body.evidence.length > 0
    && body.evidence.every(x => typeof x === 'string' && x.trim().length > 0);
}
