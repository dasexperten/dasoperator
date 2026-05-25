// =============================================================================
// Cron handler — dispatches by cron expression (wrangler.toml [triggers])
//
// "0 12 * * *"   — daily FX refresh from CBR (Phase 2.0c-2b)
// "0 * * * *"    — hourly marketplace stock refresh from Ozon + WB (Phase 6.0b)
//
// Marketplace sync calls go through self-fetch to the worker's own POST
// endpoints, so cron and manual triggers share the exact same code path.
// =============================================================================

import type { Env } from './types';
import { todayUtcDate, refreshFxFromCbr } from './lib/fx-cbr';
import { storeSnapshot } from './lib/fx-store';
import { runInboxIngestion } from './lib/inbox-ingestion';
import { runBankStatementIngestion } from './lib/bank-statement-ingestion';
import { scheduleWbWeekly, scheduleOzonMonthly, tickMarketplacePull, rebuildPriorMonthSite, rebuildPriorMonthDasexpertenCom } from './lib/marketplace-pull';
import { reportCronFailure } from './lib/auto-healer';


// =============================================================================
// CRON: Create Performance API report (every 6 hours)
// =============================================================================
async function cronCreatePerfReport(env: Env) {
  try {
    if (!env.OZON_PERF_CLIENT_ID || !env.OZON_PERF_CLIENT_SECRET) {
      console.log('[cron:perf-create] credentials not configured, skip');
      return;
    }

    const token = await getOzonPerfToken(env);
    
    // Fetch active SKU-bearing campaigns
    const campResp = await fetch('https://api-performance.ozon.ru/api/client/campaign', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!campResp.ok) {
      throw new Error(`campaigns HTTP ${campResp.status}`);
    }
    const campData = await campResp.json<{ list: any[] }>();
    const skuTypes = new Set(['SKU', 'SEARCH_PROMO', 'BRAND_SHELF', 'ACTION']);
    const campaigns = (campData.list || [])
      .filter((c) => c.state === 'CAMPAIGN_STATE_RUNNING' && skuTypes.has(c.advObjectType))
      .map((c) => c.id);

    if (campaigns.length === 0) {
      console.log('[cron:perf-create] no active SKU campaigns, skip');
      return;
    }

    const today = new Date();
    const dateTo = isoDate(today);
    const from = new Date(today.getTime() - PERIOD_DAYS * 24 * 3600_000);
    const dateFrom = isoDate(from);

    // Create async report
    const createResp = await fetch('https://api-performance.ozon.ru/api/client/statistics/json', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaigns,
        dateFrom,
        dateTo,
        groupBy: 'NO_GROUP_BY',
      }),
    });

    if (!createResp.ok) {
      throw new Error(`create report HTTP ${createResp.status}`);
    }

    const createData = await createResp.json<{ UUID: string }>();
    const uuid = createData.UUID;
    if (!uuid) throw new Error('No UUID returned');

    // Store in perf_reports
    await env.DB.prepare(
      'INSERT INTO perf_reports (uuid, created_at, status) VALUES (?, ?, ?)'
    ).bind(uuid, Math.floor(Date.now() / 1000), 'pending').run();

    console.log(`[cron:perf-create] created report ${uuid}, campaigns=${campaigns.length}`);
  } catch (e) {
    console.error('[cron:perf-create] failed:', e);
  }
}

// =============================================================================
// CRON: Poll Performance API reports (every 2 minutes)
// =============================================================================
async function cronPollPerfReports(env: Env) {
  try {
    if (!env.OZON_PERF_CLIENT_ID || !env.OZON_PERF_CLIENT_SECRET) {
      return;
    }

    const token = await getOzonPerfToken(env);

    // Fetch pending reports, mark stale if older than 30 minutes
    const now = Math.floor(Date.now() / 1000);
    const staleThreshold = now - 30 * 60;

    await env.DB.prepare(
      "UPDATE perf_reports SET status = 'stale', error_message = 'report timeout 30min' WHERE status = 'pending' AND created_at < ?"
    ).bind(staleThreshold).run();

    const pending = await env.DB.prepare(
      "SELECT uuid, created_at FROM perf_reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
    ).all<{ uuid: string; created_at: number }>();

    if (!pending.results || pending.results.length === 0) {
      return;
    }

    console.log(`[cron:perf-poll] checking ${pending.results.length} pending reports`);

    for (const report of pending.results) {
      try {
        const pollResp = await fetch(`https://api-performance.ozon.ru/api/client/statistics/${report.uuid}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!pollResp.ok) {
          console.log(`  ${report.uuid} poll HTTP ${pollResp.status}`);
          continue;
        }

        const pollData = await pollResp.json<{ state: string; link?: string }>();
        
        await env.DB.prepare(
          'UPDATE perf_reports SET checked_at = ? WHERE uuid = ?'
        ).bind(now, report.uuid).run();

        if (pollData.state === 'OK' && pollData.link) {
          // Download and process
          const downloadUrl = `https://api-performance.ozon.ru${pollData.link}`;
          const dlResp = await fetch(downloadUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
          });

          if (!dlResp.ok) {
            throw new Error(`download HTTP ${dlResp.status}`);
          }

          const reportJson = await dlResp.text();
          
          // Parse and update CPC
          const skuMap = await refreshOzonSkuMap(env);
          const cpcBySku = parseCpcJson(reportJson, skuMap);

          const stmts: D1PreparedStatement[] = [];
          for (const [sku, kopecks] of cpcBySku.entries()) {
            stmts.push(
              env.DB.prepare(
                `UPDATE marketplace_sales_ozon
                 SET cost_per_click_rub = ?,
                     expenses_total_rub = ? + cost_per_order_rub + stars_promo_rub + brand_commission_rub + reviews_cost_rub + stars_membership_rub + acquiring_rub
                 WHERE base_sku = ?`
              ).bind(kopecks, kopecks, sku)
            );
          }

          if (stmts.length > 0) {
            await env.DB.batch(stmts);
          }

          await env.DB.prepare(
            "UPDATE perf_reports SET status = 'ok', downloaded_at = ?, skus_updated = ? WHERE uuid = ?"
          ).bind(now, cpcBySku.size, report.uuid).run();

          console.log(`  ${report.uuid} OK, updated ${cpcBySku.size} SKUs`);
        } else if (pollData.state && pollData.state.includes('ERR')) {
          await env.DB.prepare(
            "UPDATE perf_reports SET status = 'error', error_message = ? WHERE uuid = ?"
          ).bind(JSON.stringify(pollData), report.uuid).run();
          console.log(`  ${report.uuid} ERROR: ${pollData.state}`);
        } else {
          console.log(`  ${report.uuid} state=${pollData.state}, waiting...`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await env.DB.prepare(
          "UPDATE perf_reports SET status = 'error', error_message = ? WHERE uuid = ?"
        ).bind(msg, report.uuid).run();
        console.error(`  ${report.uuid} threw:`, e);
      }
    }
  } catch (e) {
    console.error('[cron:perf-poll] failed:', e);
  }
}

// Helper copied from marketplaces-extras.ts
function parseCpcJson(json: string, skuMap: Map<number, any>): Map<string, number> {
  // Ozon Performance API now returns JSON instead of CSV (confirmed 2026-05-09).
  // Shape: { "<campaignId>": { title, report: { rows: [{ sku, clicks, moneySpent, ... }, ...] } }, ... }
  // Numbers use comma as decimal separator (European format).
  // Skip search_query rows where sku is empty (campaign-summary lines).
  const result = new Map<string, number>();
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.error('[parseCpcJson] not valid JSON, len=' + json.length + ' first120=' + json.slice(0, 120));
    return result;
  }

  if (!parsed || typeof parsed !== 'object') return result;

  for (const campaignId of Object.keys(parsed)) {
    const body = parsed[campaignId];
    const rows = body?.report?.rows;
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const skuRaw = row?.sku;
      const moneyRaw = row?.moneySpent;
      if (!skuRaw || !moneyRaw) continue;

      const ozonSku = parseInt(String(skuRaw), 10);
      if (Number.isNaN(ozonSku) || ozonSku <= 0) continue;

      const moneyStr = String(moneyRaw).replace(',', '.').replace(/\s/g, '');
      const spent = parseFloat(moneyStr);
      if (Number.isNaN(spent) || spent <= 0) continue;

      const mapped = skuMap.get(ozonSku);
      if (!mapped || !mapped.catalog_sku) continue;

      const sku = mapped.catalog_sku;
      const cur = result.get(sku) || 0;
      result.set(sku, cur + Math.round(spent * 100));
    }
  }

  return result;
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

const PERIOD_DAYS = 7;

// Helper to get Performance API token (duplicated from extras)
async function getOzonPerfToken(env: Env): Promise<string> {
  const req = await fetch('https://api-performance.ozon.ru/api/client/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.OZON_PERF_CLIENT_ID,
      client_secret: env.OZON_PERF_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!req.ok) throw new Error(`token HTTP ${req.status}`);
  const data = await req.json<{ access_token: string }>();
  return data.access_token;
}

// Helper to refresh SKU map (duplicated from extras)
async function refreshOzonSkuMap(env: Env): Promise<Map<number, any>> {
  // 2-step build (revised 2026-05-09):
  //   Step 1: /v3/product/list — get all offer_ids
  //   Step 2: /v3/product/info/list — for each offer_id, get the Ozon SKU
  //           (the numeric `sku` field, NOT `id` which is product_id).
  // Performance API reports use Ozon SKU as the row identifier, so we map
  //   ozon_sku → offer_id.toLowerCase() (= our catalog_sku / base_sku).
  // Both `item.sku` and entries in `item.sources[].sku` are collected because
  //   a product can have multiple variants/quants, each with its own SKU.
  const skuMap = new Map<number, any>();

  // Step 1: paginate /v3/product/list to gather offer_ids
  const offerIds: string[] = [];
  let lastId = '';
  for (let page = 0; page < 5; page++) {
    const apiResp = await fetch('https://api-seller.ozon.ru/v3/product/list', {
      method: 'POST',
      headers: {
        'Client-Id': '374116',
        'Api-Key': '4ac8181b-4cd8-4b4a-964d-905e39cc9b42',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 }),
    });
    if (!apiResp.ok) throw new Error(`product/list HTTP ${apiResp.status}`);
    const data = await apiResp.json<{
      result: { items: Array<{ product_id: number; offer_id: string }>; last_id?: string }
    }>();
    const items = data.result?.items || [];
    for (const item of items) {
      if (item.offer_id) offerIds.push(item.offer_id);
    }
    if (items.length < 1000) break;
    lastId = data.result?.last_id ?? '';
    if (!lastId) break;
  }

  if (offerIds.length === 0) return skuMap;

  // Step 2: /v3/product/info/list batch (limit 1000 per call)
  const BATCH = 1000;
  for (let i = 0; i < offerIds.length; i += BATCH) {
    const slice = offerIds.slice(i, i + BATCH);
    const infoResp = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
      method: 'POST',
      headers: {
        'Client-Id': '374116',
        'Api-Key': '4ac8181b-4cd8-4b4a-964d-905e39cc9b42',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ offer_id: slice, product_id: [], sku: [] }),
    });
    if (!infoResp.ok) throw new Error(`product/info/list HTTP ${infoResp.status}`);
    const infoData = await infoResp.json<{
      items: Array<{
        offer_id: string;
        sku?: number;
        sources?: Array<{ sku?: number }>;
      }>
    }>();
    for (const item of infoData.items || []) {
      const offer = (item.offer_id || '').toLowerCase();
      if (!offer) continue;
      if (item.sku) skuMap.set(item.sku, { catalog_sku: offer });
      for (const src of item.sources || []) {
        if (src?.sku) skuMap.set(src.sku, { catalog_sku: offer });
      }
    }
  }

  return skuMap;
}


export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const cron = event.cron;
  console.log(`[cron] tick: ${cron}`);

  if (cron === '0 12 * * *') {
    await runFxRefresh();
    await runPartnerStatusRecalc(env);
    return;
  }

  // WB weekly realization schedule — Thursday 04:00 UTC (07:00 МСК)
  // WB publishes Mon-Sun reports for the previous week on Thursdays.
  if (cron === '0 4 * * 4') {
    console.log('[cron:mp-pull-schedule:wb] starting weekly WB realization schedule');
    try {
      const r = await scheduleWbWeekly(env);
      console.log(`[cron:mp-pull-schedule:wb] result: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:mp-pull-schedule:wb] failed:', e);
    }
    // After WB sale ops are created, attach parked bank_tx via FIFO
    try {
      const { runMarketplaceFifoForPartner } = await import('./lib/marketplace-fifo-allocator');
      const fifoResult = await runMarketplaceFifoForPartner(env, 'wb');
      console.log(`[cron:mp-fifo:wb] result: ${JSON.stringify(fifoResult)}`);
    } catch (e) {
      console.error('[cron:mp-fifo:wb] failed:', e);
    }
    return;
  }

  // Ozon monthly transaction schedule — 5th of each month, 03:00 UTC (06:00 МСК)
  // Schedules a pull task for the previous calendar month.
  if (cron === '0 3 5 * *') {
    console.log('[cron:mp-pull-schedule:ozon] starting monthly Ozon transaction schedule');
    try {
      const r = await scheduleOzonMonthly(env);
      console.log(`[cron:mp-pull-schedule:ozon] result: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:mp-pull-schedule:ozon] failed:', e);
    }
    // After Ozon monthly sale op is created, attach parked bank_tx via FIFO
    try {
      const { runMarketplaceFifoForPartner } = await import('./lib/marketplace-fifo-allocator');
      const fifoResult = await runMarketplaceFifoForPartner(env, 'ozon');
      console.log(`[cron:mp-fifo:ozon] result: ${JSON.stringify(fifoResult)}`);
    } catch (e) {
      console.error('[cron:mp-fifo:ozon] failed:', e);
    }
    return;
  }



  // First Wednesday of each month at 04:00 UTC (06:00 МСК) — rebuild Yandex Pay monthly settlement
  // Runs on day 1-7 with weekday=Wed → guaranteed to fire exactly once per month, on first Wed
  if (cron === '0 4 1-7 * 3') {
    console.log('[cron:site-rebuild] starting Yandex Pay monthly rebuild for previous calendar month');
    try {
      const r = await rebuildPriorMonthSite(env);
      console.log(`[cron:site-rebuild] complete: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:site-rebuild] failed:', e);
    }
    // Also rebuild dasexperten.com (Stripe via Wio Bank) for the same prior month
    try {
      const r = await rebuildPriorMonthDasexpertenCom(env);
      console.log(`[cron:dascom-rebuild] complete: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:dascom-rebuild] failed:', e);
    }
    // After Yandex Pay monthly sale op is rebuilt, attach parked bank_tx via FIFO
    try {
      const { runMarketplaceFifoForPartner } = await import('./lib/marketplace-fifo-allocator');
      const fifoResult = await runMarketplaceFifoForPartner(env, 'яндекс_пей_продажи_с_нашего_сайта');
      console.log(`[cron:mp-fifo:yandex] result: ${JSON.stringify(fifoResult)}`);
    } catch (e) {
      console.error('[cron:mp-fifo:yandex] failed:', e);
    }
    return;
  }

  // Daily inbox ingestion at 00:00 UTC = 03:00 МСК
  if (cron === '0 0 * * *') {
    console.log('[cron:inbox] starting daily invoice ingestion');
    try {
      const stats = await runInboxIngestion(env);
      console.log(`[cron:inbox] complete: ${JSON.stringify(stats)}`);
    } catch (e) {
      console.error('[cron:inbox] failed:', e);
    }

    // Also run bank statement ingestion for active sources
    console.log('[cron:bank-statements] starting daily bank statement ingestion');
    try {
      const bankStats = await runBankStatementIngestion(env);
      console.log(`[cron:bank-statements] complete: ${JSON.stringify(bankStats)}`);
    } catch (e) {
      console.error('[cron:bank-statements] failed:', e);
    }

    // After fresh bank tx are pulled, run FIFO allocator across all marketplace partners
    console.log('[cron:mp-fifo] starting daily marketplace FIFO allocator');
    try {
      const { runMarketplaceFifoAll } = await import('./lib/marketplace-fifo-allocator');
      const fifoResults = await runMarketplaceFifoAll(env);
      const summary = fifoResults.map(r => `${r.partner_id}: ${r.payments_processed} pmts → ${r.allocations_created} allocs (${r.ops_fully_closed.length} closed)`).join('; ');
      console.log(`[cron:mp-fifo] complete: ${summary}`);
    } catch (e) {
      console.error('[cron:mp-fifo] failed:', e);
    }
    return;
  }

  // Create Performance API report every 6 hours at :05
  if (cron === '5 */6 * * *') {
    console.log('[cron:perf-create] starting');
    await cronCreatePerfReport(env);
    console.log('[cron:perf-create] done');
    return;
  }

  // Poll Performance API reports every 2 minutes
  if (cron === '*/2 * * * *') {
    await cronPollPerfReports(env);
    return;
  }

  if (cron === '0 * * * *') {
    await runMarketplaceSync(env);
    // Right after stocks are refreshed, scan for shipments that can be
    // auto-delivered. Marketplace sync writes new stock totals; this checks
    // them against pending shipped operations.
    try {
      const { runAutoDeliverySweep } = await import('./auto-delivery');
      const r = await runAutoDeliverySweep(env);
      console.log(`[cron:auto-delivery] scanned=${r.scanned} delivered=${r.delivered.length} skipped=${r.skipped.length}`);
    } catch (e) {
      console.error('[cron:auto-delivery] failed:', e);
    }
    // Retry WB review replies that previously hit rate limit and whose
    // next_attempt_at has now elapsed. Idempotent — calls own endpoint.
    try {
      const r = await env.SELF.fetch(new Request(
        'https://internal/api/reviews/sweep-retries',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      ));
      const out = await r.json() as { ok?: boolean; reset?: number; sent?: number; failed?: number };
      console.log(`[cron:reviews-sweep] reset=${out.reset ?? 0} sent=${out.sent ?? 0} failed=${out.failed ?? 0}`);
    } catch (e) {
      console.error('[cron:reviews-sweep] failed:', e);
    }
    return;
  }

  // F4 Lyubertsy fulfillment / Skladbot WMS — stock snapshot + requests mirror sync.
  // Runs every 6 hours at :30 (03:30, 09:30, 15:30, 21:30 МСК), offset from
  // Performance API (:05) and Modulbank (:15) to avoid clustering.
  // Both calls are idempotent.
  if (cron === '30 */6 * * *') {
    console.log('[cron:f4-sync] starting Skladbot stock snapshot');
    try {
      const r = await env.SELF.fetch(new Request(
        'https://internal/api/external-stocks/sync',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      ));
      const out = await r.json() as { success: boolean; result?: { synced?: Array<{ warehouse_id: string; rows: number; provider: string }> }; errors?: unknown[] };
      if (out.success && out.result?.synced) {
        for (const s of out.result.synced) {
          console.log(`[cron:f4-sync] ${s.warehouse_id} ${s.provider}: ${s.rows} rows`);
        }
      } else {
        console.error('[cron:f4-sync] sync returned errors:', JSON.stringify(out.errors));
      }
    } catch (e) {
      console.error('[cron:f4-sync] stock sync failed:', e);
    }

    console.log('[cron:f4-sync] starting Skladbot requests mirror');
    try {
      const r = await env.SELF.fetch(new Request(
        'https://internal/api/external-requests/sync',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      ));
      const out = await r.json() as { success: boolean; result?: { synced: number; total: number; errors: string[] }; errors?: unknown[] };
      if (out.success && out.result) {
        console.log(`[cron:f4-sync] requests: ${out.result.synced}/${out.result.total} synced, ${out.result.errors.length} errors`);
      } else {
        console.error('[cron:f4-sync] requests sync returned errors:', JSON.stringify(out.errors));
      }
    } catch (e) {
      console.error('[cron:f4-sync] requests sync failed:', e);
    }
    return;
  }

  // Hourly Modulbank pull-sync — safety net against missed webhooks.
  // Pulls last 3 days of transactions across all DEE accounts; idempotent
  // (UNIQUE constraint on company_bank_account_id + external_id treats
  // duplicates as updates, not inserts).
  if (cron === '15 * * * *') {
    console.log('[cron:modulbank-pull] starting hourly safety-net sync');
    try {
      const today = new Date();
      const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 3600_000);
      const from = threeDaysAgo.toISOString().slice(0, 10);
      const till = today.toISOString().slice(0, 10);
      const r = await env.SELF.fetch(new Request(
        `https://internal/api/banks/modulbank/sync-history`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, till }),
        }
      ));
      const text = await r.text();
      console.log(`[cron:modulbank-pull] HTTP ${r.status} body=${text.slice(0, 300)}`);

      // Surface per-account errors hidden inside a 200 response body to auto-healer
      if (r.ok) {
        try {
          const parsed = JSON.parse(text) as { result?: { summary?: Array<{ account_id?: string; error?: string }> } };
          const errored = parsed?.result?.summary?.filter((s) => s?.error) ?? [];
          for (const item of errored) {
            await reportCronFailure(
              env,
              `modulbank_sync:${item.account_id ?? 'unknown'}`,
              new Error(item.error ?? 'unknown error'),
              { cron: '15 * * * *', payload: item },
            );
          }
        } catch (parseErr) {
          // Non-JSON body — likely 5xx from worker itself
          await reportCronFailure(env, 'modulbank_sync', new Error(`sync-history HTTP ${r.status}: ${text.slice(0, 300)}`), { cron: '15 * * * *' });
        }
      } else {
        await reportCronFailure(env, 'modulbank_sync', new Error(`sync-history HTTP ${r.status}: ${text.slice(0, 300)}`), { cron: '15 * * * *' });
      }
    } catch (e) {
      console.error('[cron:modulbank-pull] failed:', e);
      await reportCronFailure(env, 'modulbank_sync', e, { cron: '15 * * * *' });
    }
    return;
  }

  if (cron === '*/15 * * * *') {
    console.log('[cron:tg-inbox] starting Telegram inbox ingestion');
    try {
      const { runInboxIngestionTelegram } = await import('./lib/inbox-ingestion-telegram');
      const stats = await runInboxIngestionTelegram(env);
      console.log(`[cron:tg-inbox] complete: ${JSON.stringify(stats)}`);
    } catch (e) {
      console.error('[cron:tg-inbox] failed:', e);
    }

    console.log('[cron:promo-refill] starting Ozon promo auto-refill sweep');
    try {
      const { runPromoRefillSweep } = await import('./routes/marketplaces-promos');
      const stats = await runPromoRefillSweep(env);
      console.log(`[cron:promo-refill] complete: ${JSON.stringify(stats)}`);
    } catch (e) {
      console.error('[cron:promo-refill] failed:', e);
    }
    // Also tick marketplace pull pipeline (process 1 pending task)
    try {
      const r = await tickMarketplacePull(env);
      if (r) console.log(`[cron:mp-pull-tick] ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:mp-pull-tick] failed:', e);
    }
    return;
  }

  // Nightly rematch sweep — 2:00 UTC (6:00 Yerevan).
  // Re-runs auto-match on all unmatched bank_transactions from last 180 days.
  // Catches old transactions that became matchable after new partners,
  // operations, or classifier rules were added during the day.
  if (cron === '0 2 * * *') {
    console.log('[cron:bank-rematch-nightly] starting nightly auto-match retry + rebalance');
    try {
      const { retryUnmatchedTransactions, rebalanceMisattributedMatches } =
        await import('./lib/bank-auto-match');
      const retryStats = await retryUnmatchedTransactions(env);
      console.log(`[cron:bank-rematch-nightly] retry: ${JSON.stringify(retryStats)}`);
      const rebalanceStats = await rebalanceMisattributedMatches(env);
      console.log(`[cron:bank-rematch-nightly] rebalance: ${JSON.stringify(rebalanceStats)}`);
    } catch (e) {
      console.error('[cron:bank-rematch-nightly] failed:', e);
    }
    return;
  }

  // WB review auto-reply — every 20 minutes (Phase: Reviews v1).
  // Why 20min:
  //   - WB feedbacks-api in penalty mode = 1 request / 446–681s (~8–11min).
  //   - 20min = 1200s gives >2x safety margin above any retry window WB asks.
  //   - The further we stay above WB's required retry, the faster WB exits
  //     the penalty mode and restores burst=10 / reset=29s normal limit.
  //
  // maxReplies=30: in normal mode this drains the backlog of 500+ in ~4 hours.
  // In penalty mode we'll bail out at the second request and try again next tick.
  if (cron === '*/20 * * * *') {
    // KV-flag emergency stop: when WB account is in a deep penalty mode that
    // doesn't recover, set 'wb-reviews:cron-paused' = '1' to halt all cron
    // ticks completely. Removing the flag re-enables ticks.
    if (env.CACHE) {
      const paused = await env.CACHE.get('wb-reviews:cron-paused');
      if (paused === '1') {
        console.log('[cron:wb-auto-reply] paused via KV flag — skipping');
        return;
      }
    }
    console.log('[cron:wb-auto-reply] tick start');
    try {
      const { runWbAutoReply } = await import('./lib/wb-reviews');
      const result = await runWbAutoReply(env, { maxReplies: 30, maxInspect: 300, pauseMsBetween: 1500 });
      console.log(`[cron:wb-auto-reply] ${JSON.stringify({
        replied: result.replied,
        skipped: result.ratingOnlySkipped,
        errors: result.errors.length,
        backlog: result.countTotal,
        today: result.countToday,
        throttled: (result as any).throttled ?? false,
      })}`);
    } catch (e) {
      console.error('[cron:wb-auto-reply] failed:', e);
    }
    return;
  }

    console.warn(`[cron] no handler for cron expression: ${cron}`);

  // FX refresh — daily, internal libs, no self-fetch needed
  async function runFxRefresh(): Promise<void> {
    const date = todayUtcDate();
    console.log(`[cron] FX refresh starting for ${date}`);
    const snapshot = await refreshFxFromCbr(date);
    if (!snapshot) {
      console.error(`[cron] FX refresh FAILED for ${date} — CBR unreachable. Stale snapshot retained.`);
      return;
    }
    await storeSnapshot(env.FX, snapshot);
    console.log(`[cron] FX refresh complete for ${date}, ${Object.keys(snapshot.rates).length} rates cached`);
  }
}

// =============================================================================
// Marketplace hourly sync
// =============================================================================
//
// Cloudflare Workers cannot resolve their own external hostname during a
// scheduled event (no Request context to derive base URL from). We hit the
// public worker URL directly — DNS/Cloudflare routing handles the rest.
//
// Order matters: Ozon first (no rate-limit issue), then WB (1 req/min).
// If Ozon fails, we still try WB. Errors are logged inside each endpoint
// to marketplace_sync_log — no need to throw here, the log is the source
// of truth for /marketplaces page.
// =============================================================================

async function runMarketplaceSync(env: Env): Promise<void> {
  console.log('[cron] marketplace sync starting (via env.SELF binding)');

  // Use the SELF service binding instead of public *.workers.dev.
  // Cloudflare blocks Worker→same-account-Worker via the public URL
  // with error 1042; service bindings bypass this restriction.
  const selfFetch = (path: string) =>
    env.SELF.fetch(new Request(`https://internal${path}`, { method: 'POST' }));

  // Stocks first — they are the priority for the Warehouses page.
  try {
    const r = await selfFetch('/api/marketplaces/sync/ozon');
    console.log(`[cron] ozon stocks HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] ozon stocks threw:', e);
  }

  await new Promise((r) => setTimeout(r, 2000));

  // WB stocks — only every 4 hours (UTC 00/04/08/12/16/20). WB's
  // statistics-api supplier/stocks endpoint enforces a ~1 req per 3-4 hour
  // budget on our tier; hourly hits returned 429 in ~72% of attempts and
  // produced no fresher data. Aligning the schedule with the real rate limit
  // eliminates the error log and keeps Ozon stocks refreshing hourly as before.
  const hourForWb = new Date().getUTCHours();
  if (hourForWb % 4 === 0) {
    try {
      const r = await selfFetch('/api/marketplaces/sync/wb');
      console.log(`[cron] wb stocks HTTP ${r.status}`);
    } catch (e) {
      console.error('[cron] wb stocks threw:', e);
    }
  } else {
    console.log(`[cron] skipping WB stocks (hour=${hourForWb}, runs at 0/4/8/12/16/20 UTC due to WB rate limit)`);
  }

  // Sales — every hour. WB statistics-api has a 1 req/min rate limit;
  // we make exactly one WB sales call per cron tick, with a 90-second pause
  // after Ozon sales, which keeps us well under the limit. Ozon sales and
  // Site sales (Retail CRM) have no rate limit and can run hourly without
  // friction. WB stocks alone is gated to every 4 hours (above) because
  // its own endpoint has a ~1 req per 3-4 hour budget.

  await new Promise((r) => setTimeout(r, 5000));

  try {
    const r = await selfFetch('/api/marketplaces/sync/sales/ozon');
    console.log(`[cron] ozon sales HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] ozon sales threw:', e);
  }

  // Big gap before WB sales — both stocks and sales hit statistics-api which
  // has the strict 1 req/min limit. Wait at least 90 seconds.
  await new Promise((r) => setTimeout(r, 90_000));

  try {
    const r = await selfFetch('/api/marketplaces/sync/sales/wb');
    console.log(`[cron] wb sales HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] wb sales threw:', e);
  }

  // Site sales — Retail CRM API isn't rate-limited like WB statistics-api,
  // so no extra sleep needed before this call.
  try {
    const req = new Request('https://internal/api/crm/sync-site-sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),  // defaults to last 2 days
    });
    const r = await env.SELF.fetch(req);
    console.log(`[cron] site sales HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] site sales threw:', e);
  }

  console.log('[cron] marketplace sync done');
}



// =============================================================================
// Daily partner crm_status recalc — runs alongside FX refresh at 12:00 UTC.
// Pure SQL, no network, runs in well under 1s.
//
// Rules:
//   - operation last 365d  → active
//   - any operation         → sleeping
//   - contract, no ops      → potential
//   - else                  → sleeping
//
// Skips partners with crm_status='lead'. Lead is set only on UI creation,
// and survives until the partner gets its first contract or operation.
// =============================================================================
async function runPartnerStatusRecalc(env: Env): Promise<void> {
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
  } catch (e) {
    console.error('[cron] partner status recalc FAILED:', e);
  }
}
