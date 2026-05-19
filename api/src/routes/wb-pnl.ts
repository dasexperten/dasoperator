/**
 * WB PnL — Worker cron processor and admin endpoints.
 *
 * Architecture:
 *   - wb_pnl_tasks: queue of 85 tasks (17 realization + 68 advert batches), seeded once
 *   - wb_pnl_realization_rows: raw rows from reportDetailByPeriod
 *   - wb_pnl_advert_nm: per-nmId per-day spend from /adv/v3/fullstats
 *
 * Cron every 5 minutes picks ONE pending task per tick (WB rate limits ~1 req/min),
 * does the HTTP call, writes results, marks task done.
 *
 * After all 85 tasks done, POST /api/wb-pnl/build-operations builds operations
 * + line_items mirroring the Ozon monthly pattern but weekly.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const wbPnl = new Hono<{ Bindings: Env }>();

// ----------------------------------------------------------------------------
// Task processor — picks ONE pending task, executes, updates
// ----------------------------------------------------------------------------

export async function processNextWbPnlTask(env: Env): Promise<{ task_id: number | null; status: string; message?: string }> {
  if (!env.WB_API_TOKEN) {
    return { task_id: null, status: 'skip', message: 'WB_API_TOKEN not configured' };
  }

  // Pick oldest pending task (FIFO)
  const taskRow = await env.DB.prepare(
    `SELECT id, task_type, week_no, date_from, date_to, batch_no, advert_ids
     FROM wb_pnl_tasks
     WHERE status = 'pending'
     ORDER BY week_no ASC, id ASC
     LIMIT 1`
  ).first<{
    id: number;
    task_type: string;
    week_no: number;
    date_from: string;
    date_to: string;
    batch_no: number | null;
    advert_ids: string | null;
  }>();

  if (!taskRow) {
    return { task_id: null, status: 'idle', message: 'no pending tasks' };
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE wb_pnl_tasks SET status='running', attempts=attempts+1, started_at=? WHERE id=?`
  ).bind(now, taskRow.id).run();

  try {
    let rowsPulled = 0;
    if (taskRow.task_type === 'realization') {
      rowsPulled = await pullRealizationWeek(env, taskRow.id, taskRow.week_no, taskRow.date_from, taskRow.date_to);
    } else if (taskRow.task_type === 'advert') {
      if (!taskRow.advert_ids) throw new Error('advert_ids missing for advert task');
      rowsPulled = await pullAdvertBatch(
        env, taskRow.id, taskRow.week_no, taskRow.date_from, taskRow.date_to,
        taskRow.batch_no ?? 0, taskRow.advert_ids
      );
    }

    await env.DB.prepare(
      `UPDATE wb_pnl_tasks SET status='done', finished_at=?, rows_pulled=? WHERE id=?`
    ).bind(Math.floor(Date.now() / 1000), rowsPulled, taskRow.id).run();
    return { task_id: taskRow.id, status: 'done', message: `${taskRow.task_type} W${taskRow.week_no} batch=${taskRow.batch_no ?? '-'} rows=${rowsPulled}` };
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('too many');
    // On rate limit revert to pending so it retries next tick; otherwise mark error
    const newStatus = isRateLimit ? 'pending' : 'error';
    await env.DB.prepare(
      `UPDATE wb_pnl_tasks SET status=?, finished_at=?, error_message=? WHERE id=?`
    ).bind(newStatus, Math.floor(Date.now() / 1000), msg, taskRow.id).run();
    return { task_id: taskRow.id, status: newStatus, message: msg };
  }
}

async function pullRealizationWeek(
  env: Env,
  taskId: number,
  weekNo: number,
  dateFrom: string,
  dateTo: string
): Promise<number> {
  // Clear existing rows for this week (in case of retry)
  await env.DB.prepare(`DELETE FROM wb_pnl_realization_rows WHERE week_no=?`).bind(weekNo).run();

  let totalRows = 0;
  let rrdid = 0;
  const maxPages = 30;
  let page = 0;
  while (page < maxPages) {
    const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}&rrdid=${rrdid}&limit=100000`;
    const resp = await fetch(url, { headers: { 'Authorization': env.WB_API_TOKEN! } });
    if (resp.status === 429) throw new Error('WB realization 429 rate-limited');
    if (!resp.ok) throw new Error(`WB realization HTTP ${resp.status}: ${await resp.text()}`);
    const rows: any[] = await resp.json();
    if (!rows || rows.length === 0) break;

    // Bulk insert in batches of 100
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const stmts = chunk.map((r) =>
        env.DB.prepare(
          `INSERT INTO wb_pnl_realization_rows (
            week_no, date_from, date_to, realizationreport_id, rrd_id,
            supplier_oper_name, doc_type_name, bonus_type_name, sa_name, nm_id,
            quantity, retail_amount, ppvz_for_pay, delivery_rub, penalty,
            storage_fee, acceptance, deduction, additional_payment, rebill_logistic_cost,
            date_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          weekNo, dateFrom, dateTo,
          r.realizationreport_id ?? null,
          r.rrd_id ?? null,
          r.supplier_oper_name ?? null,
          r.doc_type_name ?? null,
          r.bonus_type_name ?? null,
          r.sa_name ?? null,
          r.nm_id ?? null,
          r.quantity ?? 0,
          r.retail_amount ?? 0,
          r.ppvz_for_pay ?? 0,
          r.delivery_rub ?? 0,
          r.penalty ?? 0,
          r.storage_fee ?? 0,
          r.acceptance ?? 0,
          r.deduction ?? 0,
          r.additional_payment ?? 0,
          r.rebill_logistic_cost ?? 0,
          r.date ?? null
        )
      );
      await env.DB.batch(stmts);
    }
    totalRows += rows.length;

    if (rows.length < 100000) break;
    rrdid = rows[rows.length - 1].rrd_id;
    page++;
  }
  return totalRows;
}

async function pullAdvertBatch(
  env: Env,
  taskId: number,
  weekNo: number,
  dateFrom: string,
  dateTo: string,
  batchNo: number,
  advertIdsStr: string
): Promise<number> {
  // Clear existing rows for this week+batch (retry-safe)
  await env.DB.prepare(
    `DELETE FROM wb_pnl_advert_nm WHERE week_no=? AND advert_id IN (${advertIdsStr})`
  ).bind(weekNo).run();

  const url = `https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${advertIdsStr}&beginDate=${dateFrom}&endDate=${dateTo}`;
  const resp = await fetch(url, { headers: { 'Authorization': env.WB_API_TOKEN! } });
  if (resp.status === 429) throw new Error('WB advert 429 rate-limited');
  if (!resp.ok) throw new Error(`WB advert HTTP ${resp.status}: ${await resp.text()}`);
  const campaigns: any[] = await resp.json();
  if (!campaigns) return 0;

  const stmts: any[] = [];
  let rowsInserted = 0;
  for (const camp of campaigns) {
    if (!camp || !camp.advertId) continue;
    const advertId = camp.advertId;
    const days = camp.days ?? [];
    for (const day of days) {
      const dayDate = (day.date || '').substring(0, 10);
      const apps = day.apps ?? [];
      for (const app of apps) {
        const appType = app.appType ?? null;
        const nms = app.nms ?? [];
        for (const nm of nms) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO wb_pnl_advert_nm (
                week_no, date_from, date_to, advert_id, day_date, app_type, nm_id,
                nm_name, spend, views, clicks, orders, shks, sum_price
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              weekNo, dateFrom, dateTo, advertId, dayDate, appType, nm.nmId ?? null,
              nm.name ?? null, nm.sum ?? 0, nm.views ?? 0, nm.clicks ?? 0,
              nm.orders ?? 0, nm.shks ?? 0, nm.sum_price ?? 0
            )
          );
          rowsInserted++;
          if (stmts.length >= 50) {
            await env.DB.batch(stmts);
            stmts.length = 0;
          }
        }
      }
    }
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  return rowsInserted;
}

// ----------------------------------------------------------------------------
// Admin endpoints
// ----------------------------------------------------------------------------

// GET /api/wb-pnl/status — task queue summary
wbPnl.get('/status', async (c) => {
  const summary = await c.env.DB.prepare(
    `SELECT task_type, status, COUNT(*) AS n FROM wb_pnl_tasks GROUP BY task_type, status`
  ).all();
  const realRows = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wb_pnl_realization_rows`
  ).first<{ n: number }>();
  const advRows = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wb_pnl_advert_nm`
  ).first<{ n: number }>();
  const lastDone = await c.env.DB.prepare(
    `SELECT id, task_type, week_no, batch_no, finished_at, rows_pulled
     FROM wb_pnl_tasks WHERE status='done' ORDER BY finished_at DESC LIMIT 5`
  ).all();
  const lastError = await c.env.DB.prepare(
    `SELECT id, task_type, week_no, batch_no, attempts, error_message
     FROM wb_pnl_tasks WHERE status='error' ORDER BY id DESC LIMIT 5`
  ).all();
  return ok(c, {
    summary: summary.results,
    realization_rows: realRows?.n ?? 0,
    advert_rows: advRows?.n ?? 0,
    last_done: lastDone.results,
    last_errors: lastError.results,
  });
});

// POST /api/wb-pnl/tick — manually fire ONE task (for debugging)
wbPnl.post('/tick', async (c) => {
  const result = await processNextWbPnlTask(c.env);
  return ok(c, result);
});

// POST /api/wb-pnl/retry-errors — reset error tasks to pending
wbPnl.post('/retry-errors', async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE wb_pnl_tasks SET status='pending', error_message=NULL WHERE status='error'`
  ).run();
  return ok(c, { reset: res.meta?.changes ?? 0 });
});

// POST /api/wb-pnl/build-operations — after all tasks done, build operations
// Aggregates realization + advert into weekly operations
wbPnl.post('/build-operations', async (c) => {
  // Check all tasks are done
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wb_pnl_tasks WHERE status != 'done'`
  ).first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) {
    return fail(c, 400, [{ code: 'tasks_not_done', message: `${pending?.n} tasks still pending/running/error` }]);
  }

  // Build per-week aggregates
  const weeks = await c.env.DB.prepare(
    `SELECT DISTINCT week_no, date_from, date_to FROM wb_pnl_tasks ORDER BY week_no`
  ).all<{ week_no: number; date_from: string; date_to: string }>();

  const built: any[] = [];
  for (const w of weeks.results) {
    const result = await buildWeekOperation(c.env, w.week_no, w.date_from, w.date_to);
    built.push(result);
  }
  return ok(c, { weeks_built: built.length, details: built });
});

async function buildWeekOperation(
  env: Env,
  weekNo: number,
  dateFrom: string,
  dateTo: string
): Promise<any> {
  // Per-SKU rollup from realization (direct attribution per-row)
  const perSku = await env.DB.prepare(`
    SELECT
      LOWER(sa_name) AS sku_lc,
      MAX(nm_id) AS nm_id,
      SUM(CASE WHEN supplier_oper_name='Продажа' THEN quantity ELSE 0 END) AS qty_sold,
      SUM(CASE WHEN supplier_oper_name='Продажа' THEN retail_amount ELSE 0 END) AS retail_total,
      SUM(ppvz_for_pay) AS payout,
      SUM(delivery_rub) AS delivery,
      SUM(penalty) AS penalty,
      SUM(acceptance) AS acceptance,
      SUM(additional_payment) AS add_payment,
      SUM(rebill_logistic_cost) AS rebill
    FROM wb_pnl_realization_rows
    WHERE week_no=? AND sa_name IS NOT NULL AND sa_name != ''
    GROUP BY LOWER(sa_name)
  `).bind(weekNo).all<any>();

  // Pool: rows with empty sa_name (account-wide deductions - includes "Удержание / WB Продвижение")
  const pool = await env.DB.prepare(`
    SELECT
      SUM(storage_fee) AS storage_pool,
      SUM(deduction) AS deduction_pool,
      SUM(penalty) AS penalty_pool
    FROM wb_pnl_realization_rows
    WHERE week_no=? AND (sa_name IS NULL OR sa_name = '')
  `).bind(weekNo).first<any>();

  const totalPayout = perSku.results.reduce((s, r) => s + (r.payout ?? 0), 0);
  const storagePool = pool?.storage_pool ?? 0;
  const deductionPool = pool?.deduction_pool ?? 0; // includes advert + Jam + other
  const penaltyPool = pool?.penalty_pool ?? 0;

  // Compute NET per SKU — deduction pool covers advert proportionally by payout
  const lineItems: any[] = [];
  for (const r of perSku.results) {
    const sku = r.sku_lc;
    const qty = r.qty_sold ?? 0;
    if (qty <= 0) continue;
    const payout = r.payout ?? 0;
    const share = totalPayout > 0 ? payout / totalPayout : 0;
    // Direct costs: logistics, penalty, acceptance minus refunds/compensations
    const direct = (r.delivery ?? 0) + (r.penalty ?? 0) + (r.acceptance ?? 0) - (r.add_payment ?? 0) - (r.rebill ?? 0);
    // Pooled costs: storage + deduction (advert/Jam/etc) + pool penalty
    const pooled = (storagePool + deductionPool + penaltyPool) * share;
    const totalCosts = direct + pooled;
    const net = payout - totalCosts;
    const netPer = qty > 0 ? Math.round(net / qty) : 0;
    lineItems.push({
      sku_lc: sku,
      qty,
      payout: Math.round(payout),
      delivery: Math.round(r.delivery ?? 0),
      pooled_cost: Math.round(pooled),
      net_total: Math.round(net),
      net_per: netPer,
    });
  }

  const catalog = await env.DB.prepare(`SELECT id FROM products WHERE deleted_at IS NULL`).all<{ id: string }>();
  const catalogIds = new Set(catalog.results.map((r) => r.id));
  const filtered = lineItems.filter((li) => catalogIds.has(li.sku_lc));
  const dropped = lineItems.length - filtered.length;
  const totalAmount = filtered.reduce((s, li) => s + li.qty * li.net_per, 0);

  if (filtered.length === 0) {
    return { week_no: weekNo, status: 'skipped', reason: 'no_catalog_skus', dropped };
  }

  const year = dateTo.substring(0, 4);
  const reference = `WB-${year}-W${String(weekNo).padStart(2, '0')}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM operations WHERE reference=? AND deleted_at IS NULL`
  ).bind(reference).first<{ id: string }>();
  if (existing) {
    return { week_no: weekNo, status: 'exists', reference, op_id: existing.id };
  }

  const opDateTs = Math.floor(new Date(`${dateTo}T23:59:59Z`).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  const opId = `op_wb_${year}_w${String(weekNo).padStart(2, '0')}_weekly`;

  const contractRow = await env.DB.prepare(
    `SELECT id FROM contracts WHERE partner_id='wb' AND deleted_at IS NULL ORDER BY id LIMIT 1`
  ).first<{ id: string }>();
  const contractId = contractRow?.id ?? null;

  await env.DB.prepare(
    `INSERT INTO operations (
      id, operation_date, operation_type, partner_id, our_company_id,
      warehouse_from_id, warehouse_to_id, status, currency,
      total_amount, contract_id, notes,
      created_at, updated_at,
      reference, vat_rate, delivery_status, operation_track, default_document_language
    ) VALUES (
      ?, ?, 'sale', 'wb', 'dee',
      'wb', NULL, 'delivered', 'RUB',
      ?, ?, ?,
      ?, ?,
      ?, 0, 'delivered', 'goods', 'RU'
    )`
  ).bind(
    opId, opDateTs,
    totalAmount, contractId,
    `WB weekly realization PnL — ${dateFrom} → ${dateTo}. NET per-SKU income after logistics, storage, advert (deduction pool distributed by payout share). Source: reportDetailByPeriod.`,
    now, now,
    reference
  ).run();

  for (const li of filtered) {
    const lineAmount = li.qty * li.net_per;
    const lineId = `li_wb_${year}_w${String(weekNo).padStart(2, '0')}_${li.sku_lc}`;
    await env.DB.prepare(
      `INSERT INTO line_items (
        id, operation_id, product_id, item_description, qty, cartons, inner_boxes,
        unit_price, discount_pct, unit_price_after_disc, line_amount, currency,
        line_usd_equiv, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, 'RUB', NULL, ?, ?)`
    ).bind(
      lineId, opId, li.sku_lc, li.sku_lc, li.qty,
      li.net_per, li.net_per, lineAmount, now, now
    ).run();
  }

  return {
    week_no: weekNo,
    status: 'created',
    reference,
    op_id: opId,
    total_amount: totalAmount,
    line_items: filtered.length,
    dropped_skus: dropped,
    pool_storage: Math.round(storagePool),
    pool_deduction: Math.round(deductionPool),
    pool_penalty: Math.round(penaltyPool),
  };
}

export default wbPnl;
