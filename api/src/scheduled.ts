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

          const csv = await dlResp.text();
          
          // Parse and update CPC
          const skuMap = await refreshOzonSkuMap(env);
          const cpcBySku = parseCpcCsv(csv, skuMap);

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
function parseCpcCsv(csv: string, skuMap: Map<number, any>): Map<string, number> {
  const result = new Map<string, number>();
  const lines = csv.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return result;

  const headers = lines[0].split(';').map((h) => h.replace(/^\ufeff/, '').replace(/^"|"$/g, '').trim().toLowerCase());
  const skuCol = headers.findIndex((h) => h.includes('sku') || h.includes('товар') || h === 'id');
  const spentCol = headers.findIndex((h) => h.includes('moneyspent') || h.includes('расход') || h.includes('потрачено'));

  if (skuCol < 0 || spentCol < 0) {
    console.error('[parseCpcCsv] columns not found. headers=' + JSON.stringify(headers));
    return result;
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';').map((c) => c.replace(/^"|"$/g, '').trim());
    const ozonSkuStr = cols[skuCol];
    const spentStr = cols[spentCol];
    if (!ozonSkuStr || !spentStr) continue;
    const ozonSku = parseInt(ozonSkuStr, 10);
    if (Number.isNaN(ozonSku)) continue;
    const spent = parseFloat(spentStr.replace(',', '.').replace(/\s/g, ''));
    if (Number.isNaN(spent) || spent <= 0) continue;
    const mapped = skuMap.get(ozonSku);
    if (!mapped || !mapped.catalog_sku) continue;
    const sku = mapped.catalog_sku;
    const cur = result.get(sku) || 0;
    result.set(sku, cur + Math.round(spent * 100));
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
  const skuMap = new Map<number, any>();
  const apiResp = await fetch('https://api-seller.ozon.ru/v2/product/list', {
    method: 'POST',
    headers: {
      'Client-Id': '374116',
      'Api-Key': '4ac8181b-4cd8-4b4a-964d-905e39cc9b42',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 1000 }),
  });
  if (!apiResp.ok) throw new Error(`product/list HTTP ${apiResp.status}`);
  const data = await apiResp.json<{ result: { items: any[] } }>();
  for (const item of data.result?.items || []) {
    const ozonSku = item.fbo_sku || item.fbs_sku;
    const offerId = item.offer_id;
    if (ozonSku && offerId) {
      skuMap.set(ozonSku, { catalog_sku: offerId.toLowerCase() });
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
    await runMarketplaceSync();
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

const SELF_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

async function runMarketplaceSync(): Promise<void> {
  console.log('[cron] marketplace sync starting');

  // Stocks first — they are the priority for the Warehouses page.
  try {
    const r = await fetch(`${SELF_BASE}/api/marketplaces/sync/ozon`, { method: 'POST' });
    console.log(`[cron] ozon stocks HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] ozon stocks threw:', e);
  }

  await new Promise((r) => setTimeout(r, 2000));

  try {
    const r = await fetch(`${SELF_BASE}/api/marketplaces/sync/wb`, { method: 'POST' });
    console.log(`[cron] wb stocks HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] wb stocks threw:', e);
  }

  // Sales — only every 4 hours (UTC 00/04/08/12/16/20). WB has a strict
  // 1 req/min rate limit, so we run sales after stocks, with a long pause
  // between Ozon sales and WB sales.
  const hour = new Date().getUTCHours();
  if (hour % 4 !== 0) {
    console.log(`[cron] skipping sales sync (hour=${hour}, runs at 0/4/8/12/16/20 UTC)`);
    console.log('[cron] marketplace sync done');
    return;
  }

  await new Promise((r) => setTimeout(r, 5000));

  try {
    const r = await fetch(`${SELF_BASE}/api/marketplaces/sync/sales/ozon`, { method: 'POST' });
    console.log(`[cron] ozon sales HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] ozon sales threw:', e);
  }

  // Big gap before WB sales — both stocks and sales hit statistics-api which
  // has the strict 1 req/min limit. Wait at least 90 seconds.
  await new Promise((r) => setTimeout(r, 90_000));

  try {
    const r = await fetch(`${SELF_BASE}/api/marketplaces/sync/sales/wb`, { method: 'POST' });
    console.log(`[cron] wb sales HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] wb sales threw:', e);
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
