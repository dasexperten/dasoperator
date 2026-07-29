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
import { runEmailRetention } from './lib/email-retention';
import { runBankStatementIngestion } from './lib/bank-statement-ingestion';
import { scheduleWbWeekly, scheduleOzonMonthly, tickMarketplacePull, rebuildPriorMonthSite, rebuildPriorMonthDasexpertenCom } from './lib/marketplace-pull';
import { runFboSync } from './marketplaces/fbo-sync';
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

  // Website CRM — hourly Stripe reconciliation (Phase 12.0, dasexperten.com).
  // Webhook /api/crm/website/webhook/stripe is the real-time path; this poll
  // catches anything it missed and sweeps refunds. No-op until
  // STRIPE_SECRET_KEY is set and /admin/migrate/crm-website has run.
  if (cron === '7 * * * *') {
    try {
      const { pollStripeOrders } = await import('./lib/crm-website');
      const r = await pollStripeOrders(env);
      console.log('[cron:crm-website-stripe] ' + JSON.stringify(r));
    } catch (e) {
      console.error('[cron:crm-website-stripe] failed:', e);
    }
    // Sweep abandoned carts: 'initiated' rows with no conversion after 6h.
    try {
      const { sweepAbandoned } = await import('./lib/crm-carts');
      const swept = await sweepAbandoned(env, 6 * 3600);
      if (swept) console.log(`[cron:crm-carts-sweep] abandoned=${swept}`);
    } catch (e) {
      console.error('[cron:crm-carts-sweep] failed:', e);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // TAMARA CARE LANE (Owner 2026-07-20) — every 3 hours
  // Reply/Q&A/customer-conversation craft owner: Tamara Haar only.
  // dasoperator-api HOSTS the jobs and STORES results; it is not the craft owner.
  // Cadence: 3h (was 20m WB + 6h feeds — too aggressive on marketplace APIs).
  // -------------------------------------------------------------------------

  // Ozon discount-request workflow: craft moved to Worker `tamara-haar`
  // (Owner 2026-07-21: Das Operator is dashboard/ERP only — it stores and
  // displays ready results in ozon_discount_tasks; the tamara-haar worker
  // runs the morning cron and writes here via its ERP_DB binding).

  // Marketplace feeds (every 3h @ :20): Ozon reviews + Ozon/WB questions → D1.
  // Owner 2026-07-27: these two triggers are GONE from wrangler.toml. The branches
  // stay only as a guard in case a legacy schedule lingers on an old deploy.
  if (cron === '20 */3 * * *' || cron === '40 */6 * * *') {
    // CUTOVER (Owner 2026-07-21, ERP = dashboard law): the care feeds sync
    // (Ozon reviews + Ozon/WB questions) moved to Worker `tamara-haar`
    // (fleet, Phase 1, same 20 */3 slot). This branch is a deliberate no-op
    // so the same Tamara token is not polled from two machines. Manual
    // fallback stays: POST /api/mp-feeds/sync (runMpFeedsSync).
    console.log('[cron:mp-feeds] no-op — feeds run on tamara-haar worker (Phase 1 cutover)');
    return;
  }

  // Ozon review draft-prep (every 3h @ :30, after feeds): drafts only → dasoperator UI.
  if (cron === '30 */3 * * *' || cron === '50 */6 * * *') {
    // RETIRED (Owner 2026-07-28): ERP writes nothing. Review answers are drafted
    // by worker `tamara-haar` (draft-engine.mjs). Trigger is gone from
    // wrangler.toml; this stays only as a guard against a stale schedule.
    console.log('[cron:ozon-review-prep] retired — tamara-haar drafts reviews');
    return;
  }

  // Monthly compaction (1st @ 03:00 UTC): roll resolved hot rows to R2, prune D1.
  // Canon (playbook / rules / scenarios / settings) is never touched.
  if (cron === '0 3 1 * *') {
    try {
      const r = await runEmailRetention(env);
      console.log('[cron:email-retention] ' + JSON.stringify(r));
    } catch (e) {
      console.error('[cron:email-retention] failed:', e);
    }
    return;
  }

  // Email archive harvest — every minute until done (temporary backfill job).
  if (cron === '* * * * *') {
    try {
      const { runHarvestTick, runCopyTick } = await import('./lib/email-harvest');
      const r = await runHarvestTick(env);
      console.log('[cron:email-harvest] ' + JSON.stringify(r));
      if ((r as any).skipped === 'done') {
        const cp = await runCopyTick(env);
        console.log('[cron:email-copy] ' + JSON.stringify(cp));
      }
    } catch (e) {
      console.error('[cron:email-harvest] failed:', e);
    }
    return;
  }

  // Email scenario tick — every 3h at :23 UTC ("Pochtalon Pechkin").
  // Marks run timestamps for enabled scenarios and is the hook where the
  // worker/hermes drafting pipeline plugs in (reads inbox -> playbook ->
  // drafts -> queues for Safety Gate). Drafting itself is wired separately.
  if (cron === '23 */3 * * *') {
    try {
      const n = Math.floor(Date.now() / 1000);
      const next = n + 3 * 3600;
      const res = await env.DB.prepare(
        'UPDATE email_scenarios SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE enabled = 1'
      ).bind(n, next, n).run();
      console.log(`[cron:email-scenarios] ticked ${res.meta.changes ?? 0} enabled scenarios`);
    } catch (e) {
      console.error('[cron:email-scenarios] failed:', e);
    }
    return;
  }

  // NOTE: the automatic Ozon → RUB price sync cron was removed by owner request.
  // RUB prices are OWNER-MANAGED and static — like every other currency, the
  // owner edits them by hand in the Geo Price Matrix and nothing may change them
  // automatically. The manual /api/pricing/sync-ozon endpoint still exists for a
  // deliberate one-off pull, but it runs on no schedule.

  if (cron === '0 12 * * *') {
    await runFxRefresh();
    // Storefront zonal pricing rates (EUR-based, 18 currencies) — separate keys
    // from the CBR store above. See lib/fx-pricing.ts.
    try {
      const { refreshPricingRates } = await import('./lib/fx-pricing');
      const r = await refreshPricingRates(env);
      console.log('[cron:fx-pricing] ' + JSON.stringify(r));
    } catch (e) {
      console.error('[cron:fx-pricing] failed:', e);
    }
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
    // [DISABLED 2026-05-29] Yandex Pay monthly aggregator removed — site sales
    // now come from the daily email-to-sale path (DASR-DAY-YYYYMMDD, built in
    // yandex-pay-sale.ts on each finance@pay.yandex.ru CSV). Re-enabling this
    // would double-count revenue. See cemented rule.
    // try { await rebuildPriorMonthSite(env); } catch (e) { console.error('[cron:site-rebuild] disabled-but-threw:', e); }

    // dasexperten.com (Stripe via Wio Bank) monthly settlement — still active.
    try {
      const r = await rebuildPriorMonthDasexpertenCom(env);
      console.log(`[cron:dascom-rebuild] complete: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:dascom-rebuild] failed:', e);
    }
    // [DISABLED 2026-05-29] Yandex FIFO re-attach removed with the monthly aggregator.
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

    // Nightly three-way reconcile: turn waiting F4 service invoices / acts into
    // operations (create if none, attach if exists). Anchored on invoice number
    // so it never duplicates the bank-created deal. Runs after ingestion so the
    // freshest docs are considered. (Aram spec, 2026-06-30.)
    console.log('[cron:inbox-reconcile] starting nightly deal reconcile');
    try {
      const { runInboxReconcile } = await import('./lib/inbox-reconcile');
      const rec = await runInboxReconcile(env);
      console.log(`[cron:inbox-reconcile] complete: ${JSON.stringify(rec)}`);
    } catch (e) {
      console.error('[cron:inbox-reconcile] failed:', e);
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

  // Marketplace STOCKS — Owner 2026-07-21/22 CUTOVER: Ozon+WB stock pulls are
  // owned exclusively by fleet Workers dasha-ozon / arina-wb (write
  // marketplace_stocks_* + marketplace_sync_log). This Worker MUST NOT pull
  // MP stocks on cron — dual writers overwrite specialist logs and paint the
  // dashboard red with the Operator key's missing stocks role (403).
  // Slot kept for auto-delivery only (reads ERP stock rows specialists wrote).
  if (cron === '0 */4 * * *') {
    await runMarketplaceSync(env); // no-op for MP stocks (see function body)
    try {
      const { runAutoDeliverySweep } = await import('./auto-delivery');
      const r = await runAutoDeliverySweep(env);
      console.log(`[cron:auto-delivery] scanned=${r.scanned} delivered=${r.delivered.length} skipped=${r.skipped.length}`);
    } catch (e) {
      console.error('[cron:auto-delivery] failed:', e);
    }
    return;
  }

  if (cron === '0 * * * *') {
    // Owner 2026-07-23: DO NOT hit WB feedbacks here.
    // Was: hourly POST /api/reviews/sweep-retries (up to 50 posts/hour) → "too many requests".
    // WB review answers run ONLY on 10 */3 (every 3h full backlog). Failed posts wait for next 3h tick.
    console.log('[cron:hourly] reviews-sweep DISABLED (Owner: WB care only every 3h)');
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

    // Owner 2026-07-29: turning a mirrored request into an operation was a
    // hand-run endpoint (mp_delivery only, 30 rows a call) and acceptance /
    // writeoff had no path at all. 135 of 217 requests sat unposted, June and
    // July at zero. Both now run right after the mirror, oldest first.
    for (const step of [
      { name: 'mp-delivery', path: '/api/external-requests/mp-delivery-backfill?limit=50' },
      { name: 'acc-wof', path: '/api/external-requests/import?limit=50' },
    ]) {
      console.log(`[cron:f4-sync] importing ${step.name}`);
      try {
        const r = await env.SELF.fetch(new Request(
          `https://internal${step.path}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        ));
        const out = await r.json() as { imported?: number; units?: number; results?: unknown[] };
        console.log(`[cron:f4-sync] ${step.name}: imported ${out.imported ?? 0}, units ${out.units ?? 0}`);
      } catch (e) {
        console.error(`[cron:f4-sync] ${step.name} import failed:`, e);
      }
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

  // Nightly web-analytics ingestion — 02:30 UTC (05:30 МСК).
  // Pulls yesterday from GA4 + Metrika + Clarity (+ Direct when configured)
  // into web_analytics_daily / web_behavior_snapshots. Clarity gets EXACTLY
  // one API call (10/day hard limit). Per-leg failures go through the
  // auto-healer inside runWebAnalyticsNightly; this catch is the backstop.
  if (cron === '30 2 * * *') {
    try {
      const { runWebAnalyticsNightly } = await import('./lib/web-analytics-sync');
      const r = await runWebAnalyticsNightly(env);
      console.log(`[cron:web-analytics] ${r.date}: ${r.legs.join(' | ')}`);
    } catch (e) {
      console.error('[cron:web-analytics] failed:', e);
      await reportCronFailure(env, 'web_analytics_nightly', e, { cron: '30 2 * * *' });
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

  // WB review auto-reply — Tamara lane every 3 hours (Owner 2026-07-20).
  // Was */20 — caused feedbacks-api rate limits. Craft owner = Tamara only;
  // results persist in dasoperator for the reviews UI. KV pause still works.
  // Owner 2026-07-27: trigger removed from wrangler.toml — ERP holds no WB token
  // since the reissue, so this lane was dead weight burning the per-seller quota.
  if (cron === '10 */3 * * *' || cron === '*/20 * * * *') {
    // Ignore legacy */20 if still registered briefly after deploy — only run
    // on the 3h tick once both exist (minute 10). On pure */20 deploys, still run.
    if (cron === '*/20 * * * *') {
      const m = new Date().getUTCMinutes();
      // If new 3h trigger is live, skip legacy 20m ticks entirely.
      // (Safe no-op when only */20 exists: we still need to run — so only skip
      // when minute is not a "would have been 3h-aligned" ... simpler: skip all
      // */20 after this deploy by checking env flag; without flag, skip */20 always
      // once code is deployed with 10 */3 — legacy trigger may fire until removed.)
      console.log('[cron:wb-auto-reply:tamara-lane] skip legacy */20 — use 10 */3 only');
      return;
    }
    if (env.CACHE) {
      const paused = await env.CACHE.get('wb-reviews:cron-paused');
      if (paused === '1') {
        console.log('[cron:wb-auto-reply:tamara-lane] paused via KV flag — skipping');
        return;
      }
    }
    console.log('[cron:wb-auto-reply:tamara-lane] tick start (every 3h; owner=Tamara)');
    try {
      const { runWbAutoReply } = await import('./lib/wb-reviews');
      const result = await runWbAutoReply(env, { maxReplies: 100, maxInspect: 300, pauseMsBetween: 1500 }); // Owner 2026-07-22: every 3h answer FULL backlog
      console.log(`[cron:wb-auto-reply:tamara-lane] ${JSON.stringify({
        owner: 'tamara-haar',
        replied: result.replied,
        skipped: result.ratingOnlySkipped,
        errors: result.errors.length,
        backlog: result.countTotal,
        today: result.countToday,
        throttled: (result as any).throttled ?? false,
      })}`);
    } catch (e) {
      console.error('[cron:wb-auto-reply:tamara-lane] failed:', e);
    }
    return;
  }

  if (cron === '*/10 * * * *') {
    try {
      const { runWatchdog } = await import('./lib/watchdog');
      const r = await runWatchdog(env);
      console.log(`[cron:watchdog] ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[cron:watchdog] failed:', e);
    }
    return;
  }

  // Daily digest — 03:00 UTC (06:00 MSK), generates morning briefing
  if (cron === '0 3 * * *') {
    console.log('[cron:daily-digest] starting');
    try {
      const r = await env.SELF.fetch(new Request(
        'https://internal/api/daily-digest',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      ));
      const text = await r.text();
      console.log(`[cron:daily-digest] HTTP ${r.status} body=${text.slice(0, 300)}`);
    } catch (e) {
      console.error('[cron:daily-digest] failed:', e);
    }
    return;
  }

  // 05:00 UTC slot: FBO cluster calc + site CRM sales.
  // Ozon/WB marketplace sales NO LONGER run here (Owner 2026-07-21 cutover →
  // dasha-ozon 22:00 UTC / arina-wb 22:15 UTC write marketplace_sales_*).
  if (cron === '0 5 * * *') {
    _ctx.waitUntil(runFboSync(env));
    await runMarketplaceSalesSync(env); // site CRM only; MP sales no-op inside
    return;
  }

  // Daily marketplace PULSE cache — 01:00 UTC (04:00 MSK)
  // Pre-caches the three pulse endpoints in KV so the home page loads instantly at 5 AM.
  if (cron === '0 1 * * *') {
    console.log('[cron:pulse-cache] starting daily pulse cache warm');
    try {
      const selfFetch = async (path: string) => {
        const r = await env.SELF.fetch(new Request(`https://internal${path}`));
        return r.ok ? await r.json<{ success: boolean; result: any }>() : null;
      };

      const [sales, spotlight, trend] = await Promise.all([
        selfFetch('/api/marketplaces/pulse/sales-today'),
        selfFetch('/api/marketplaces/pulse/sku-spotlight'),
        selfFetch('/api/marketplaces/pulse/daily-trend'),
      ]);

      if (env.CACHE) {
        if (sales?.result) await env.CACHE.put('pulse:sales-today', JSON.stringify(sales.result), { expirationTtl: 7200 });
        if (spotlight?.result) await env.CACHE.put('pulse:sku-spotlight', JSON.stringify(spotlight.result), { expirationTtl: 7200 });
        if (trend?.result) await env.CACHE.put('pulse:daily-trend', JSON.stringify(trend.result), { expirationTtl: 7200 });
        console.log('[cron:pulse-cache] cached 3 pulse endpoints');
      }
    } catch (e) {
      console.error('[cron:pulse-cache] failed:', e);
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
// Marketplace STOCKS sync — CUTOVER complete (Owner 2026-07-22)
// =============================================================================
//
// Ozon stocks  → fleet Worker dasha-ozon  (cron 0 */4, ERP_DB write)
// WB stocks    → fleet Worker arina-wb    (cron 0 */4, warehouse_remains)
// Das Operator = dashboard / store only. Do NOT re-enable selfFetch stocks
// without Owner. Manual POST /api/marketplaces/sync/ozon|wb remains break-glass.
// =============================================================================

async function runMarketplaceSync(_env: Env): Promise<void> {
  console.log(
    '[cron] marketplace STOCKS: Ozon+WB DISABLED (Owner 2026-07-22 — dasha-ozon / arina-wb own MP stocks). Auto-delivery may still run on this slot.'
  );
  // Ozon / WB MP stocks — NO-OP (Dasha + Arina). Do not re-enable without Owner.
}

// =============================================================================
// Marketplace SALES sync — daily at 05:00 UTC (slot retained for site CRM).
//
// Owner 2026-07-21 CUTOVER: Ozon + WB marketplace sales are owned exclusively
// by fleet Workers dasha-ozon / arina-wb (write marketplace_sales_* into ERP).
// This Worker MUST NOT pull Ozon/WB sales anymore — dual writers corrupt
// freshness and rate limits. Site (own-shop) sales stay here (CRM, not MP).
// Manual POST /api/marketplaces/sync/sales/* remains for break-glass only.
// =============================================================================
async function runMarketplaceSalesSync(env: Env): Promise<void> {
  console.log(
    '[cron] marketplace SALES: Ozon+WB DISABLED (Owner 2026-07-21 — dasha-ozon / arina-wb own MP sales). Site CRM sales only.'
  );

  // Ozon / WB MP sales — NO-OP (Dasha + Arina). Do not re-enable without Owner.
  // was: POST /api/marketplaces/sync/sales/ozon + /wb

  try {
    const r = await env.SELF.fetch(new Request('https://internal/api/crm/sync-site-sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    console.log(`[cron] site sales HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] site sales threw:', e);
  }

  console.log('[cron] marketplace SALES slot done (MP skipped; site CRM only)');
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
