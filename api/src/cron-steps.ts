// =============================================================================
// Model-free steps split out of the ERP's mixed timers ("*/2", "*/15", "0 0").
// Each one is started by its own erp-* worker through /internal/cron.
// The model steps (invoice intake, bank statement parsing, Telegram inbox) stay
// in scheduled.ts on the ERP's own timers.
// =============================================================================

import type { Env } from './types';
import { cronPollPerfReports } from './scheduled';

type Step = (env: Env) => Promise<string>;

async function ruTrack(env: Env): Promise<string> {
  if (!env.RU_ADMIN_TOKEN) return 'skipped: RU_ADMIN_TOKEN not set';
  // Our own .ru storefront talks to Ozon and sends the one "Д" letter (lock on its side).
  const res = await fetch('https://dasexperten.ru/api/order/track.php', {
    method: 'POST',
    headers: { 'X-Sync-Token': env.RU_ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const j = (await res.json().catch(() => null)) as { checked?: number; results?: Array<{ mail_shipped?: boolean | null }> } | null;
  const mails = (j?.results ?? []).filter((r) => r.mail_shipped === true).length;
  const now = Date.now();
  const sql = `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  await env.DB.batch([
    env.DB.prepare(sql).bind('ru_track:last_try_at', String(now), now),
    env.DB.prepare(sql).bind('ru_track:last_status', res.ok ? `ok checked=${j?.checked ?? '?'} mails=${mails}` : `http_${res.status}`, now),
    ...(res.ok ? [env.DB.prepare(sql).bind('ru_track:last_ok_at', String(now), now)] : []),
  ]);
  if (!res.ok) throw new Error(`track.php http_${res.status}`);
  return `checked=${j?.checked ?? '?'} mails=${mails}`;
}

export const STEPS: Record<string, Step> = {
  'erp-ozon-ads-poll': async (env) => {
    await cronPollPerfReports(env);
    return 'Ozon Performance reports polled';
  },
  'erp-mail-snapshot': async (env) => {
    const { snapshotPass } = await import('./lib/mail-index-sync');
    const r = await snapshotPass(env, { max: 4 });
    return JSON.stringify({ pending: r.pending, wrote: r.wrote, ms: r.ms });
  },
  'erp-promo-refill': async (env) => {
    const { runPromoRefillSweep } = await import('./routes/marketplaces-promos');
    return JSON.stringify(await runPromoRefillSweep(env));
  },
  'erp-marketplace-pull': async (env) => {
    const { tickMarketplacePull } = await import('./lib/marketplace-pull');
    return JSON.stringify((await tickMarketplacePull(env)) ?? { idle: true });
  },
  'erp-mail-index': async (env) => {
    const { sweepMailIndex } = await import('./lib/mail-index-sync');
    const r = await sweepMailIndex(env, { max: 6 });
    if (!r.ok) throw new Error(`mail index sweep failed ${JSON.stringify(r).slice(0, 300)}`);
    return JSON.stringify({ boxes: r.boxes, changed: r.changed, upserted: r.upserted, ms: r.ms });
  },
  'erp-ru-track': ruTrack,
  'erp-ru-orders': async (env) => {
    if (!env.RU_FEED_TOKEN) return 'skipped: RU_FEED_TOKEN not set';
    const { syncRuOrders } = await import('./lib/crm-orders-sync');
    const r = await syncRuOrders(env);
    if (!r.ok) throw new Error(`ru orders mirror: ${r.error ?? 'failed'}`);
    const { warmKitAggregate } = await import('./routes/crm');
    const w = await warmKitAggregate(env);
    return `${r.upserted}/${r.total} v${r.feed_version ?? '?'} · aggregate ${w.orders} orders`;
  },
  'erp-loyalty-keys': async (env) => {
    if (!env.RU_FEED_TOKEN) return 'skipped: RU_FEED_TOKEN not set';
    const { resolveLoyaltyKeys } = await import('./lib/loyalty-key-map');
    const m = await resolveLoyaltyKeys(env);
    if (!m.ok) throw new Error(`loyalty key map: ${m.error ?? 'failed'}`);
    return `asked ${m.asked}, matched ${m.matched}, remaining ${m.remaining}`;
  },
  'erp-inbox-reconcile': async (env) => {
    const { runInboxReconcile } = await import('./lib/inbox-reconcile');
    return JSON.stringify(await runInboxReconcile(env));
  },
  'erp-marketplace-fifo': async (env) => {
    const { runMarketplaceFifoAll } = await import('./lib/marketplace-fifo-allocator');
    const res = await runMarketplaceFifoAll(env);
    return res.map((r) => `${r.partner_id}: ${r.payments_processed} pmts → ${r.allocations_created} allocs`).join('; ') || 'nothing to allocate';
  },
};
