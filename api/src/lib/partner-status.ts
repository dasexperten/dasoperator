// Partner CRM status from operations and contracts: active (op in last year) · sleeping · potential.
import type { Env } from '../types';
export async function runPartnerStatusRecalc(env: Pick<Env, 'DB'>): Promise<number> {
  const oneYearAgo = Math.floor(Date.now() / 1000) - 31_536_000;
  console.log(`[cron] partner status recalc starting (threshold ${new Date(oneYearAgo * 1000).toISOString()})`);

  try {
    const result = await env.DB.prepare(`
      UPDATE partners
      SET crm_status = CASE
        WHEN EXISTS (
          SELECT 1 FROM operations o
          WHERE o.partner_id = partners.id
            AND o.deleted_at IS NULL
            AND o.operation_date >= ?
        ) THEN 'active'
        WHEN EXISTS (
          SELECT 1 FROM operations o
          WHERE o.partner_id = partners.id
            AND o.deleted_at IS NULL
        ) THEN 'sleeping'
        WHEN EXISTS (
          SELECT 1 FROM contracts c
          WHERE c.partner_id = partners.id
            AND c.deleted_at IS NULL
        ) THEN 'potential'
        ELSE 'sleeping'
      END
      WHERE deleted_at IS NULL
        AND crm_status != 'lead'
    `).bind(oneYearAgo).run();

    console.log(`[cron] partner status recalc done — ${result.meta.changes ?? 0} partners updated`);
    return result.meta.changes ?? 0;
  } catch (e) {
    console.error('[cron] partner status recalc FAILED:', e);
    throw e;
  }
}
