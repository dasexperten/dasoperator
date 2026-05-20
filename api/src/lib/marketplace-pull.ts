// =============================================================================
// Marketplace auto-pull pipeline — Phase 8.0
//
// Async paginated fetch from WB and Ozon APIs, staging in D1, then building
// monthly/weekly operations + line_items + marketplace_pnl_lines rows.
//
// Two crons coordinate this:
//   1. Schedule cron — creates pending tasks when reports become available
//      - WB Mon 03:00 UTC (06:00 МСК) for last completed Mon-Sun week
//      - Ozon 5th of month 03:00 UTC (06:00 МСК) for full prev month
//   2. Process cron — picks one pending task per tick, advances pagination
//      - Reuses the existing */15 cron (or any minute-tick cron)
//      - Stays well under WB's 1 req/min rate limit
//
// Tasks transition: pending → fetching → fetched → building → done
// On error: status='error', retry_count++, next_attempt_at += backoff
// =============================================================================

import type { Env } from '../types';

const WB_REALIZATION_URL = 'https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod';

// -----------------------------------------------------------------------------
// SCHEDULE: Called by weekly/monthly cron to create pending tasks
// -----------------------------------------------------------------------------

export async function scheduleWbWeekly(env: Env, asOf?: Date): Promise<{ taskId: string; periodFrom: string; periodTo: string } | null> {
  const now = asOf || new Date();
  // WB publishes Mon-Sun reports. Last completed week ended on prev Sunday.
  const dow = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceSunday = dow === 0 ? 7 : dow;
  const sunday = new Date(now);
  sunday.setUTCDate(sunday.getUTCDate() - daysSinceSunday);
  const monday = new Date(sunday);
  monday.setUTCDate(monday.getUTCDate() - 6);
  const periodFrom = monday.toISOString().slice(0, 10);
  const periodTo = sunday.toISOString().slice(0, 10);

  // Check if task for this period already exists
  const existing = await env.DB.prepare(
    'SELECT id FROM marketplace_pull_tasks WHERE marketplace=? AND task_type=? AND period_to=? AND status NOT IN (?, ?)'
  ).bind('wb', 'realization', periodTo, 'error', 'done').first();
  if (existing) {
    console.log(`[mp-pull:schedule:wb] task already exists for ${periodTo}`);
    return null;
  }

  const taskId = `pull_wb_${periodTo.replace(/-/g, '')}_${Math.random().toString(36).slice(2, 8)}`;
  const now_ts = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO marketplace_pull_tasks (
       id, marketplace, task_type, period_from, period_to,
       status, next_attempt_at, created_at
     ) VALUES (?, 'wb', 'realization', ?, ?, 'pending', ?, ?)`
  ).bind(taskId, periodFrom, periodTo, now_ts, now_ts).run();

  console.log(`[mp-pull:schedule:wb] task created: ${taskId} for ${periodFrom}..${periodTo}`);
  return { taskId, periodFrom, periodTo };
}

export async function scheduleOzonMonthly(env: Env, asOf?: Date): Promise<{ taskId: string; periodFrom: string; periodTo: string } | null> {
  const now = asOf || new Date();
  // Schedule for previous calendar month
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0..11 of current month → prev month = m-1
  const prevMonth = m === 0 ? 11 : m - 1;
  const prevYear = m === 0 ? y - 1 : y;
  const periodFrom = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();
  const periodTo = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const existing = await env.DB.prepare(
    'SELECT id FROM marketplace_pull_tasks WHERE marketplace=? AND task_type=? AND period_to=? AND status NOT IN (?, ?)'
  ).bind('ozon', 'transaction', periodTo, 'error', 'done').first();
  if (existing) {
    console.log(`[mp-pull:schedule:ozon] task already exists for ${periodTo}`);
    return null;
  }

  const taskId = `pull_ozn_${periodTo.replace(/-/g, '')}_${Math.random().toString(36).slice(2, 8)}`;
  const now_ts = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO marketplace_pull_tasks (
       id, marketplace, task_type, period_from, period_to,
       status, next_attempt_at, created_at
     ) VALUES (?, 'ozon', 'transaction', ?, ?, 'pending', ?, ?)`
  ).bind(taskId, periodFrom, periodTo, now_ts, now_ts).run();

  console.log(`[mp-pull:schedule:ozon] task created: ${taskId} for ${periodFrom}..${periodTo}`);
  return { taskId, periodFrom, periodTo };
}

// -----------------------------------------------------------------------------
// TICK: Process one pending/fetching task per call
// -----------------------------------------------------------------------------

export async function tickMarketplacePull(env: Env): Promise<{ taskId?: string; action?: string; rows?: number } | null> {
  const now_ts = Math.floor(Date.now() / 1000);

  // Pick oldest due task that isn't terminal
  const task = await env.DB.prepare(
    `SELECT * FROM marketplace_pull_tasks 
     WHERE status IN ('pending', 'fetching', 'fetched')
       AND next_attempt_at <= ?
     ORDER BY next_attempt_at ASC
     LIMIT 1`
  ).bind(now_ts).first<any>();

  if (!task) {
    return null;
  }

  console.log(`[mp-pull:tick] processing ${task.id} status=${task.status} marketplace=${task.marketplace}`);

  if (task.status === 'pending' || task.status === 'fetching') {
    // Fetch one page
    if (task.marketplace === 'wb' && task.task_type === 'realization') {
      return await tickWbRealization(env, task);
    }
    if (task.marketplace === 'ozon' && task.task_type === 'transaction') {
      return await tickOzonTransaction(env, task);
    }
  }
  if (task.status === 'fetched') {
    // Build operation from staging
    return await buildFromStaging(env, task);
  }
  return null;
}

async function tickWbRealization(env: Env, task: any): Promise<{ taskId: string; action: string; rows: number }> {
  const token = env.WB_API_TOKEN;
  if (!token) throw new Error('WB_API_TOKEN not configured');

  // Build URL: dateFrom, dateTo, limit, rrdid pagination
  const url = new URL(WB_REALIZATION_URL);
  url.searchParams.set('dateFrom', task.period_from);
  url.searchParams.set('dateTo', task.period_to);
  url.searchParams.set('limit', '100000'); // WB max
  if (task.pagination_token) {
    url.searchParams.set('rrdid', task.pagination_token);
  }

  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': token },
  });

  if (resp.status === 429) {
    // Rate limited — back off 70s and retry
    const next_ts = Math.floor(Date.now() / 1000) + 70;
    await env.DB.prepare(
      'UPDATE marketplace_pull_tasks SET next_attempt_at=?, last_error=? WHERE id=?'
    ).bind(next_ts, '429 rate limit', task.id).run();
    return { taskId: task.id, action: 'rate_limited', rows: 0 };
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    const retryCount = (task.retry_count || 0) + 1;
    if (retryCount > 5) {
      await env.DB.prepare(
        'UPDATE marketplace_pull_tasks SET status=?, last_error=?, retry_count=? WHERE id=?'
      ).bind('error', `HTTP ${resp.status}: ${errBody.slice(0, 300)}`, retryCount, task.id).run();
      return { taskId: task.id, action: 'failed', rows: 0 };
    }
    const next_ts = Math.floor(Date.now() / 1000) + 120 * retryCount;
    await env.DB.prepare(
      'UPDATE marketplace_pull_tasks SET next_attempt_at=?, last_error=?, retry_count=? WHERE id=?'
    ).bind(next_ts, `HTTP ${resp.status}`, retryCount, task.id).run();
    return { taskId: task.id, action: 'http_error', rows: 0 };
  }

  const rows = await resp.json() as any[];
  console.log(`[mp-pull:wb-realization] fetched ${rows.length} rows for ${task.id}`);

  // Save to staging
  if (rows.length > 0) {
    const stmts: any[] = [];
    for (const r of rows) {
      const id = String(r.rrd_id);
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO wb_realization_staging 
         (id, task_id, sa_name, op_name, sale_date, qty, retail, wb_realiz, wb_fee, payout,
          delivery, penalty, rebill, storage, deduction, acceptance, raw_json) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, task.id,
        String(r.sa_name || '').trim().toLowerCase(),
        r.supplier_oper_name || '',
        r.sale_dt || r.order_dt || '',
        r.quantity || 0,
        r.retail_price || 0,
        r.retail_amount || 0,
        r.ppvz_vw || 0,
        r.ppvz_for_pay || 0,
        r.delivery_rub || 0,
        r.penalty || 0,
        r.rebill_logistic_cost || 0,
        r.storage_fee || 0,
        r.deduction || 0,
        r.acceptance || 0,
        JSON.stringify(r)
      ));
    }
    // Batch up to 50 at a time
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  const pages_done = (task.pages_done || 0) + 1;
  const rows_collected = (task.rows_collected || 0) + rows.length;

  if (rows.length === 0 || rows.length < 100000) {
    // Done fetching
    await env.DB.prepare(
      `UPDATE marketplace_pull_tasks 
       SET status='fetched', pages_done=?, rows_collected=?, next_attempt_at=?
       WHERE id=?`
    ).bind(pages_done, rows_collected, Math.floor(Date.now() / 1000), task.id).run();
    return { taskId: task.id, action: 'fetch_complete', rows: rows.length };
  }

  // More pages — store last rrdid, wait 70s for next tick
  const lastRrdId = String(rows[rows.length - 1].rrd_id);
  const next_ts = Math.floor(Date.now() / 1000) + 70;
  await env.DB.prepare(
    `UPDATE marketplace_pull_tasks 
     SET status='fetching', pagination_token=?, pages_done=?, rows_collected=?, next_attempt_at=?
     WHERE id=?`
  ).bind(lastRrdId, pages_done, rows_collected, next_ts, task.id).run();

  return { taskId: task.id, action: 'page_fetched', rows: rows.length };
}

async function tickOzonTransaction(env: Env, task: any): Promise<{ taskId: string; action: string; rows: number }> {
  const clientId = env.OZON_CLIENT_ID;
  const apiKey = env.OZON_API_KEY;
  if (!clientId || !apiKey) throw new Error('Ozon credentials not configured');

  // Ozon transaction/list: pageSize=1000, paginated by page
  const page = task.pagination_token ? parseInt(task.pagination_token) : 1;
  const resp = await fetch('https://api-seller.ozon.ru/v3/finance/transaction/list', {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        date: {
          from: `${task.period_from}T00:00:00Z`,
          to: `${task.period_to}T23:59:59Z`,
        },
        transaction_type: 'all',
      },
      page,
      page_size: 1000,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    const retryCount = (task.retry_count || 0) + 1;
    if (retryCount > 5) {
      await env.DB.prepare(
        'UPDATE marketplace_pull_tasks SET status=?, last_error=?, retry_count=? WHERE id=?'
      ).bind('error', `HTTP ${resp.status}: ${errBody.slice(0, 300)}`, retryCount, task.id).run();
      return { taskId: task.id, action: 'failed', rows: 0 };
    }
    const next_ts = Math.floor(Date.now() / 1000) + 120 * retryCount;
    await env.DB.prepare(
      'UPDATE marketplace_pull_tasks SET next_attempt_at=?, last_error=?, retry_count=? WHERE id=?'
    ).bind(next_ts, `HTTP ${resp.status}`, retryCount, task.id).run();
    return { taskId: task.id, action: 'http_error', rows: 0 };
  }

  const data = await resp.json() as any;
  const operations = data.result?.operations || [];
  console.log(`[mp-pull:ozon-transaction] page ${page} fetched ${operations.length} ops for ${task.id}`);

  if (operations.length > 0) {
    const stmts: any[] = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const id = `${task.id}_${page}_${i}_${op.operation_id || i}`;
      // Each operation may have multiple items
      const items = op.items || [];
      const sku = items[0]?.sku || items[0]?.offer_id || '';
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO ozon_transaction_staging
         (id, task_id, op_type, op_date, sku, amount, accruals_for_sale,
          commission_amount, delivery_charge, return_delivery_charge,
          sale_commission, services_amount, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, task.id,
        op.operation_type || '',
        op.operation_date || '',
        String(sku).toLowerCase(),
        op.amount || 0,
        op.accruals_for_sale || 0,
        op.commission_amount || 0,
        op.delivery_charge || 0,
        op.return_delivery_charge || 0,
        op.sale_commission || 0,
        (op.services || []).reduce((s: number, x: any) => s + (x.price || 0), 0),
        JSON.stringify(op)
      ));
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  const pages_done = (task.pages_done || 0) + 1;
  const rows_collected = (task.rows_collected || 0) + operations.length;
  const pageCount = data.result?.page_count || 1;

  if (page >= pageCount || operations.length === 0) {
    // Done fetching
    await env.DB.prepare(
      `UPDATE marketplace_pull_tasks 
       SET status='fetched', pages_done=?, rows_collected=?, next_attempt_at=?
       WHERE id=?`
    ).bind(pages_done, rows_collected, Math.floor(Date.now() / 1000), task.id).run();
    return { taskId: task.id, action: 'fetch_complete', rows: operations.length };
  }

  // More pages
  await env.DB.prepare(
    `UPDATE marketplace_pull_tasks 
     SET status='fetching', pagination_token=?, pages_done=?, rows_collected=?, next_attempt_at=?
     WHERE id=?`
  ).bind(String(page + 1), pages_done, rows_collected, Math.floor(Date.now() / 1000) + 5, task.id).run();

  return { taskId: task.id, action: 'page_fetched', rows: operations.length };
}

// -----------------------------------------------------------------------------
// BUILD: Aggregate staging data into operation + line_items + pnl_lines
// -----------------------------------------------------------------------------

async function buildFromStaging(env: Env, task: any): Promise<{ taskId: string; action: string; rows: number }> {
  if (task.marketplace === 'wb') {
    return await buildWbFromStaging(env, task);
  }
  if (task.marketplace === 'ozon') {
    return await buildOzonFromStaging(env, task);
  }
  return { taskId: task.id, action: 'unsupported', rows: 0 };
}

async function buildWbFromStaging(env: Env, task: any): Promise<{ taskId: string; action: string; rows: number }> {
  await env.DB.prepare("UPDATE marketplace_pull_tasks SET status='building' WHERE id=?").bind(task.id).run();

  // Aggregate per SKU (only rows with sa_name; pool rows have empty sa_name)
  const stagingRows = await env.DB.prepare(
    'SELECT * FROM wb_realization_staging WHERE task_id=?'
  ).bind(task.id).all<any>();

  const perSku: Map<string, any> = new Map();
  const pool = { storage: 0, deduction: 0, penalty: 0 };

  for (const r of stagingRows.results) {
    const sa = (r.sa_name || '').trim();
    const op = r.op_name || '';
    if (sa) {
      const cur = perSku.get(sa) || {
        qty: 0, retail: 0, gross: 0, commission: 0, payout: 0,
        delivery: 0, penalty: 0, acceptance: 0, rebill: 0,
      };
      cur.payout += r.payout || 0;
      cur.delivery += r.delivery || 0;
      cur.penalty += r.penalty || 0;
      cur.acceptance += r.acceptance || 0;
      cur.rebill += r.rebill || 0;
      cur.commission += r.wb_fee || 0;
      if (op === 'Продажа') {
        cur.qty += r.qty || 0;
        cur.retail += r.retail || 0;
        cur.gross += r.wb_realiz || 0;
      }
      perSku.set(sa, cur);
    } else {
      pool.storage += r.storage || 0;
      pool.deduction += r.deduction || 0;
      pool.penalty += r.penalty || 0;
    }
  }

  // Compute totals + NET per SKU
  let totalPayout = 0;
  for (const [, d] of perSku) totalPayout += d.payout;

  // Get catalog
  const catalogRows = await env.DB.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all<{ id: string }>();
  const catalog = new Set(catalogRows.results.map(r => r.id));

  // Build lines (filtered to catalog)
  const lines: any[] = [];
  let opTotal = 0;
  for (const [sku, d] of perSku) {
    if (d.qty <= 0) continue;
    if (!catalog.has(sku)) continue;
    const share = totalPayout > 0 ? d.payout / totalPayout : 0;
    const storageShare = pool.storage * share;
    const advertShare = pool.deduction * share;
    const penaltyPoolShare = pool.penalty * share;
    const direct = d.delivery + d.penalty + d.acceptance - d.rebill;
    const netTotal = d.payout - direct - storageShare - advertShare - penaltyPoolShare;
    const netPer = Math.round(netTotal / d.qty);
    opTotal += d.qty * netPer;
    lines.push({
      sku, qty: d.qty, retail: d.retail, gross: d.gross, commission: d.commission, payout: d.payout,
      logistics: d.delivery, penalty: d.penalty, acceptance: d.acceptance, rebill: d.rebill,
      storage_share: storageShare, advert_share: advertShare, net_total: netTotal, net_per: netPer,
    });
  }

  // Create operation
  const refDate = task.period_to.replace(/-/g, '').slice(2);
  const opId = `op_wb_${refDate}_weekly`;
  const reference = `WB-${refDate}-WEEKLY`;
  const opDate = Math.floor(new Date(task.period_to + 'T23:59:59Z').getTime() / 1000);
  const now_ts = Math.floor(Date.now() / 1000);

  // Check if operation already exists — replace if so
  const existing = await env.DB.prepare('SELECT id FROM operations WHERE id=?').bind(opId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM marketplace_pnl_lines WHERE operation_id=?').bind(opId).run();
    await env.DB.prepare('DELETE FROM line_items WHERE operation_id=?').bind(opId).run();
    await env.DB.prepare('DELETE FROM operations WHERE id=?').bind(opId).run();
  }

  await env.DB.prepare(
    `INSERT INTO operations (
       id, operation_date, operation_type, partner_id, our_company_id,
       warehouse_from_id, warehouse_to_id, status, currency,
       total_amount, contract_id, notes,
       created_at, updated_at, reference, vat_rate, delivery_status, operation_track, default_document_language
     ) VALUES (?, ?, 'sale', 'wb', 'dee', 'wb', NULL, 'delivered', 'RUB', ?, 'placeholder_wb_rub', ?, ?, ?, ?, 0, 'delivered', 'goods', 'RU')`
  ).bind(
    opId, opDate, opTotal,
    `WB weekly realization PnL — ${task.period_from} → ${task.period_to}. Auto-pull via task ${task.id}.`,
    now_ts, now_ts, reference
  ).run();

  // line_items + marketplace_pnl_lines
  const liStmts: any[] = [];
  const pnlStmts: any[] = [];
  for (const l of lines) {
    const lineAmount = l.qty * l.net_per;
    liStmts.push(env.DB.prepare(
      `INSERT INTO line_items (id, operation_id, product_id, item_description, qty, cartons, inner_boxes,
       unit_price, discount_pct, unit_price_after_disc, line_amount, currency, line_usd_equiv, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, 'RUB', NULL, ?, ?)`
    ).bind(`li_wb_${refDate}_${l.sku}`, opId, l.sku, l.sku, l.qty, l.net_per, l.net_per, lineAmount, now_ts, now_ts));

    pnlStmts.push(env.DB.prepare(
      `INSERT INTO marketplace_pnl_lines (id, operation_id, marketplace, product_id, qty, retail_amount,
       gross_amount, commission, payout, logistics, penalty, acceptance, rebill_logistic, additional_payment,
       storage_share, advert_share, net_total, net_per, period_from, period_to, created_at)
       VALUES (?, ?, 'wb', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `mp_wb_${refDate}_${l.sku}`, opId, l.sku, l.qty, l.retail, l.gross, l.commission, l.payout,
      l.logistics, l.penalty, l.acceptance, l.rebill,
      l.storage_share, l.advert_share, l.net_total, l.net_per,
      task.period_from, task.period_to, now_ts
    ));
  }
  if (liStmts.length > 0) await env.DB.batch(liStmts);
  if (pnlStmts.length > 0) await env.DB.batch(pnlStmts);

  // Mark task done
  await env.DB.prepare(
    `UPDATE marketplace_pull_tasks SET status='done', operation_id=?, completed_at=? WHERE id=?`
  ).bind(opId, now_ts, task.id).run();

  console.log(`[mp-pull:build-wb] ${reference} created with ${lines.length} SKU, total=${opTotal} RUB`);
  return { taskId: task.id, action: 'built', rows: lines.length };
}

async function buildOzonFromStaging(env: Env, task: any): Promise<{ taskId: string; action: string; rows: number }> {
  // Ozon transaction/list aggregation is more complex (categorize op_types, link to SKU via items).
  // For now mark as built but defer the actual per-SKU aggregation — this requires the full
  // operation_type → category mapping established yesterday. Will fully implement in next iteration.
  await env.DB.prepare("UPDATE marketplace_pull_tasks SET status='building' WHERE id=?").bind(task.id).run();
  
  // TODO: Implement Ozon aggregation using the OP_LOGISTICS / OP_ADVERTISING / OP_RETURNS / OP_ORDERS
  // mapping from yesterday's pipeline. For now mark as 'error' with a note so we know it ran but
  // didn't produce an operation.
  await env.DB.prepare(
    "UPDATE marketplace_pull_tasks SET status='error', last_error=? WHERE id=?"
  ).bind('Ozon staging build not yet implemented — staging rows collected, manual aggregation needed', task.id).run();
  return { taskId: task.id, action: 'ozon_build_deferred', rows: 0 };
}


// ═══════════════════════════════════════════════════════════════════════════
// rebuildPriorMonthSite — Yandex Pay monthly settlement rebuild
// Scheduled for first Wednesday of every month at 04:00 UTC (06:00 МСК).
// Aggregates all Yandex Pay bank_tx for the PREVIOUS calendar month into the
// existing DASR-YYYYMM operation (creates one if missing), and matches each
// bank_tx to that operation.
// INN 9705212635 = ООО ФИНАНСОВЫЕ И ПЛАТЕЖНЫЕ ТЕХНОЛОГИИ (Yandex Pay processor).
// INN 7736207543 = ООО ЯНДЕКС (occasionally used).
// ═══════════════════════════════════════════════════════════════════════════

const SITE_PARTNER_ID = 'яндекс_пей_продажи_с_нашего_сайта';
const YANDEX_PAY_INNS = ['9705212635', '7736207543'];

export interface RebuildSiteResult {
  target_month: string;          // YYYY-MM
  bank_tx_count: number;
  total_amount: number;
  operation_id: string;
  operation_reference: string;
  payments_created: number;
}

export async function rebuildPriorMonthSite(env: Env): Promise<RebuildSiteResult> {
  // Target = calendar month BEFORE today (UTC)
  const now = new Date();
  const targetYear = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const targetMonthIdx = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
  const targetMonth = String(targetMonthIdx + 1).padStart(2, '0');
  const targetYM = `${targetYear}-${targetMonth}`;

  // Range in unix seconds: [startOfMonth, startOfNextMonth)
  const startTs = Math.floor(Date.UTC(targetYear, targetMonthIdx, 1) / 1000);
  const endTs = Math.floor(Date.UTC(targetYear, targetMonthIdx + 1, 1) / 1000);

  // Fetch all bank_tx in that month from Yandex Pay
  const innList = YANDEX_PAY_INNS.map(() => '?').join(',');
  const txnsResult = await env.DB.prepare(
    `SELECT id, executed_at, amount, currency
     FROM bank_transactions
     WHERE contragent_inn IN (${innList})
       AND direction = 'incoming'
       AND deleted_at IS NULL
       AND executed_at >= ?
       AND executed_at < ?
     ORDER BY executed_at`
  ).bind(...YANDEX_PAY_INNS, startTs, endTs).all<{
    id: string; executed_at: number; amount: number; currency: string;
  }>();

  const txns = txnsResult.results;
  const totalMinor = txns.reduce((s, t) => s + (t.amount || 0), 0);
  // RUB stored in kopecks → convert to major units
  const totalAmount = Math.round(totalMinor) / 100;

  // Reference DASR-YYYYMM
  const reference = `DASR-${targetYear}${targetMonth}`;

  // Upsert operation
  const existing = await env.DB.prepare(
    `SELECT id FROM operations WHERE reference = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(reference).first<{ id: string }>();

  const nowTs = Math.floor(Date.now() / 1000);
  let operationId: string;

  if (existing) {
    operationId = existing.id;
    await env.DB.prepare(
      `UPDATE operations
       SET total_amount = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      totalAmount,
      `[CONSOLIDATED — Yandex Pay monthly] dasexperten.ru — ${targetYM} — ${txns.length} payments, total ${totalAmount.toFixed(2)} RUB (rebuilt on ${new Date().toISOString().slice(0, 10)})`,
      nowTs,
      operationId
    ).run();
  } else {
    operationId = `op_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO operations (
        id, operation_date, operation_type, partner_id, our_company_id,
        status, currency, total_amount, notes,
        reference, delivery_status, operation_track, created_at, updated_at
      ) VALUES (?, ?, 'sale', ?, 'dee', 'issued', 'RUB', ?, ?, ?, 'delivered', 'goods', ?, ?)`
    ).bind(
      operationId, startTs, SITE_PARTNER_ID, totalAmount,
      `[CONSOLIDATED — Yandex Pay monthly] dasexperten.ru — ${targetYM} — ${txns.length} payments, total ${totalAmount.toFixed(2)} RUB`,
      reference, nowTs, nowTs
    ).run();
  }

  // First unmatch and remove old payments for this operation (to rebuild clean)
  await env.DB.prepare(
    `UPDATE bank_transactions
     SET matched_operation_id = NULL, matched_payment_id = NULL, matched_at = NULL, match_method = NULL
     WHERE matched_operation_id = ?`
  ).bind(operationId).run();
  await env.DB.prepare(
    `UPDATE payments SET deleted_at = ? WHERE operation_id = ? AND deleted_at IS NULL`
  ).bind(nowTs, operationId).run();

  // Create payments + link bank_tx
  let paymentsCreated = 0;
  for (const tx of txns) {
    const amtMajor = tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount;
    const paymentId = `pay_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                               payment_date, type, direction, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)`
      ).bind(
        paymentId, SITE_PARTNER_ID, 'placeholder_yandex_pay_rub', operationId,
        amtMajor, tx.currency, tx.executed_at,
        `[AUTO-MATCH yandex-pay-monthly] bank_tx ${tx.id} → ${reference}`,
        nowTs, nowTs
      ),
      env.DB.prepare(
        `UPDATE bank_transactions
         SET matched_operation_id = ?, matched_payment_id = ?, matched_at = ?,
             match_method = 'matched_by_yandex_pay_monthly', matched_by = 'system_auto', updated_at = ?
         WHERE id = ?`
      ).bind(operationId, paymentId, nowTs, nowTs, tx.id),
    ]);
    paymentsCreated++;
  }

  return {
    target_month: targetYM,
    bank_tx_count: txns.length,
    total_amount: totalAmount,
    operation_id: operationId,
    operation_reference: reference,
    payments_created: paymentsCreated,
  };
}
