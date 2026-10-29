// =============================================================================
// Model-free steps split out of the ERP's mixed timers ("*/2", "*/15", "0 0").
// Each one is started by its own erp-* worker through /internal/cron.
// The model steps (invoice intake, bank statement parsing, Telegram inbox) stay
// in scheduled.ts on the ERP's own timers.
// =============================================================================

import type { Env } from './types';
import { cronPollPerfReports } from './scheduled';

type Step = (env: Env) => Promise<string>;

function ugcStepError(step: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${step}: ${reason.replace(/\s+/g, ' ').trim().slice(0, 160) || 'failed'}`;
}

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

// Dasha's storefront jobs (moved 2026-09-18) run on the ERP's own .ru admin token and
// Ozon seller key: the vault copy of the storefront token is stale (403).
function storefrontEnv(env: Env): Record<string, unknown> {
  return { ...env, SITE_SYNC_TOKEN: env.RU_ADMIN_TOKEN };
}

export const STEPS: Record<string, Step> = {
  'erp-blogger-id': async (env) => {
    const { refreshBloggerProfiles } = await import('./lib/ugc-blogger-profiles');
    return JSON.stringify(await refreshBloggerProfiles(env));
  },
  // Owner 2026-10-16: the UGC routines are ERP workers of their own («должно быть ERP-UGC worker»).
  // Each timer fires every minute; runAdaptiveLane keeps the 3 / 15 / 30-minute rule (DH-LAW-261015-01).
  // Direct: read new messages, then Diana's answers (the model runs here in the ERP, never in the worker).
  'erp-ugc-direct': async (env) => {
    const { runAdaptiveLane } = await import('./lib/adaptive-runner');
    const { igDmWatch, igDmHasNew } = await import('./lib/ig-dm-watch');
    const { igDmReply } = await import('./lib/ig-dm-reply');
    return runAdaptiveLane(env, 'ig_dm', async (e) => {
      const read = await igDmWatch(e).catch((err) => { throw new Error(ugcStepError('read', err)); });
      const answered = await igDmReply(e).catch((err) => ({ replied: 0, escalated: 0, errors: 1, error: ugcStepError('reply', err) }));
      const failures: string[] = [];
      if (!read.ok) failures.push(ugcStepError('read', read.error ?? 'incomplete'));
      // Escalations are business review, not execution failures. A partial
      // reply pass with errors is still failed even if other replies succeeded.
      if (answered.errors > 0) failures.push('error' in answered ? answered.error : ugcStepError('reply', `${answered.errors} processing failures`));
      // Owner 2026-10-19: «если активность на чате была, каждые 3 минуты». A blogger waiting for us
      // (an answer to retry, requisites with no payout yet) is activity, not silence.
      const waiting = await e.DB.prepare(
        `SELECT COUNT(*) n FROM crm_sync_state WHERE key LIKE 'ig_reply_escalated:%' AND json_extract(value,'$.status')='retry' AND updated_at > ?1`
      ).bind(Date.now() - 2 * 3_600_000).first<{ n: number }>().catch((err) => { throw new Error(ugcStepError('waiting replies', err)); });
      const deferred = 'deferred' in answered ? Number(answered.deferred) : 0;
      const waitingOnUs = Math.max(Number(waiting?.n ?? 0), deferred);
      // Put the diagnostic first: the run journal keeps only the first 1000 characters.
      return { ok: failures.length === 0, error: failures.length ? failures.join('; ') : undefined,
        activity: read.activity || answered.replied > 0 || waitingOnUs > 0,
        stored: read.stored, incoming: read.incoming, replied: answered.replied, escalated: answered.escalated, errors: answered.errors, waitingOnUs, deferred };
    }, Date.now(), igDmHasNew);
  },
  // Konsol/content only. Creator profiles have their own erp-blogger-id timer.
  'erp-ugc-payouts': async (env) => {
    const { runAdaptiveLane } = await import('./lib/adaptive-runner');
    const { ugcPayoutSweep } = await import('./lib/ugc-payout-store');
    const { refreshContentMetrics } = await import('./lib/ugc-diagnose');
    return runAdaptiveLane(env, 'ugc_payouts', async (e) => {
      const refreshed = await ugcPayoutSweep(e);
      // Owner 2026-10-19: the incident control runs inside this tick, gated to once an hour; its work is not lane activity.
      await import('./lib/ugc-incident-control').then((m) => m.incidentControl(e)).catch(() => undefined);
      const { captureDmLinks } = await import('./lib/ugc-dm-links');
      const links = await captureDmLinks(e).catch((err) => ({ added: 0, error: ugcStepError('links', err) }));
      const content = await refreshContentMetrics(e).catch((err) => ({ read: 0, removed: 0, error: err instanceof Error ? (err.message || err.name) : (String(err) || 'failed') }));
      const failures: string[] = [];
      if ('error' in links) failures.push(links.error);
      // The metrics reader may return some successful rows plus an error.
      if (content.error) failures.push(ugcStepError('content', content.error));
      // Owner 2026-10-19: a payout waiting to go out keeps the payouts lane on 3 minutes too.
      const open = await e.DB.prepare(`SELECT COUNT(*) n FROM ugc_payouts WHERE status IN ('awaiting_approval','approved','sent')`).first<{ n: number }>().catch((err) => { throw new Error(ugcStepError('open payouts', err)); });
      const openPayouts = Number(open?.n ?? 0);
      return { ok: failures.length === 0, error: failures.length ? failures.join('; ') : undefined,
        activity: refreshed > 0 || links.added > 0 || content.read + content.removed > 0 || openPayouts > 0, refreshed, openPayouts, links, content };
    });
  },
  // Owner 2026-10-14: one evening message on UGC payouts — count, sum, own RUB left.
  'erp-ugc-payout-summary': async (env) => {
    const { ugcPayoutEvening } = await import('./lib/ugc-payout-store');
    return ugcPayoutEvening(env);
  },
  'erp-site-stock': async (env) => {
    // @ts-expect-error plain JS module
    const { syncOzonStocksToSite } = await import('./lib/site-stock-sync.mjs');
    const r = await syncOzonStocksToSite(storefrontEnv(env));
    if (!r || r.ok === false) throw new Error(String(r?.error ?? 'no result'));
    return JSON.stringify(r).slice(0, 600);
  },
  'erp-site-order-retry': async (env) => {
    // @ts-expect-error plain JS module
    const { syncOzonOrdersOnSite } = await import('./lib/site-order-sync.mjs');
    const r = await syncOzonOrdersOnSite(storefrontEnv(env));
    if (!r || r.ok === false) throw new Error(String(r?.error ?? 'no result'));
    return JSON.stringify(r).slice(0, 600);
  },
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
    const result = await runPromoRefillSweep(env);
    if (result.errors.length) throw new Error(`promo refill: ${result.errors.length} errors; ${result.errors[0]}`);
    return JSON.stringify(result);
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
    // Own-site orders paid via T-Kassa → TBANK-YYYYMM sale operations (Owner 2026-10-07).
    let tb = '';
    try {
      const { rebuildTbankSiteSales } = await import('./lib/tbank-site-sale');
      const months = await rebuildTbankSiteSales(env);
      tb = ' · tbank ' + months.filter((x) => x.operation_id).map((x) => `${x.operation_reference}:${x.orders}`).join(',');
    } catch (e) {
      tb = ` · tbank failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
    // STRIPE-YYYYMM lines follow their latest .com order (Owner 2026-10-08).
    try {
      const { refreshStripeMonthDates } = await import('./lib/stripe-month-date');
      const n = await refreshStripeMonthDates(env);
      if (n) tb += ` · stripe dates ${n}`;
    } catch (e) {
      tb += ` · stripe dates failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
    return `${r.upserted}/${r.total} v${r.feed_version ?? '?'} · aggregate ${w.orders} orders${tb}`;
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
