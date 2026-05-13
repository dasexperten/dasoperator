/**
 * External warehouse requests routes — Phase 7.x F4 / Skladbot integration.
 *
 * Mirrors F4 Skladbot logistics requests ("заявки") into Das Operator. Each request
 * represents a real warehouse operation that F4 performs on our behalf:
 *   - Acceptance from manufacturer (purchase)
 *   - Delivery to marketplace FBO (bundling + transfer)
 *   - Write-off / disposal (adjustment)
 *
 * Phase 1 (this file): Read-only mirror. Stores requests + line items + comment-parsed
 * bundling metadata. Does NOT yet create Das Operator operations — that's Phase 3-5.
 *
 * Endpoints:
 *   - GET  /api/external-requests                — latest snapshot, all warehouses
 *   - GET  /api/external-requests/:id            — single request with line items
 *   - POST /api/external-requests/sync           — pull from Skladbot; idempotent
 *
 * The token to call Skladbot lives in the F4_SKLADBOT_TOKEN Worker secret.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const externalRequests = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize F4 request type into our taxonomy. */
function normalizeType(rawType: string): string {
  const t = rawType || '';
  if (t.includes('Приемка') || t.includes('Приёмка')) return 'acceptance';
  if (t.includes('Доставка на склад МП')) return 'mp_delivery';
  if (t.includes('Списание')) return 'writeoff';
  if (t.includes('Забор')) return 'pickup_acceptance';
  return 'other';
}

/** Parse F4 product comment to extract bundling formula.
 *  Returns null if no bundling needed, else { divisor, fromQty, toQty }. */
function parseBundling(
  comment: string | null | undefined,
  vendorCode: string,
  amount: number
): { divisor: number; fromQty: number; toQty: number } | null {
  const com = (comment || '').trim().toLowerCase();
  if (!com) return null;
  if (com.includes('без обработки') || com.includes('не нужно') || com.includes('не нужна'))
    return null;

  // Pattern: "8640 шт однушки /2 = 4320 шт" or "12672 шт /2 =6336"
  const m = comment!.match(/(\d+)\s*шт[^\/]*\/\s*(\d+)/);
  if (m) {
    const fromQty = parseInt(m[1], 10);
    const divisor = parseInt(m[2], 10);
    const toQty = Math.floor(fromQty / divisor);
    return { divisor, fromQty, toQty };
  }

  // Fallback: if SKU ends with AA or AAAA but no formula in comment
  if (/AAAA$/i.test(vendorCode))
    return { divisor: 4, fromQty: amount * 4, toQty: amount };
  if (/AA$/i.test(vendorCode))
    return { divisor: 2, fromQty: amount * 2, toQty: amount };

  return null;
}

/** Map F4 vendor_code (uppercase, e.g. "DE117AA") to our product.id (lowercase). */
function vendorCodeToProductId(vendorCode: string): string {
  return vendorCode.toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// GET /api/external-requests
// Optional ?warehouse_id, ?type_norm, ?completed=0|1, ?archived=0|1
// ---------------------------------------------------------------------------
externalRequests.get('/', async (c) => {
  const wh = c.req.query('warehouse_id');
  const typeNorm = c.req.query('type_norm');
  const completed = c.req.query('completed');
  const archived = c.req.query('archived');

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (wh) {
    where.push('warehouse_id = ?');
    params.push(wh);
  }
  if (typeNorm) {
    where.push('request_type_norm = ?');
    params.push(typeNorm);
  }
  if (completed !== undefined) {
    where.push('is_completed = ?');
    params.push(completed === '1' ? 1 : 0);
  }
  if (archived !== undefined) {
    where.push('is_archived = ?');
    params.push(archived === '1' ? 1 : 0);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      r.id, r.external_id, r.delivery_number, r.warehouse_id,
      r.request_type_raw, r.request_type_norm,
      r.stage_code, r.stage_name,
      r.is_completed, r.is_archived, r.is_expired,
      r.created_at_external, r.executor, r.creator, r.comment,
      r.imported_op_id, r.synced_at,
      (SELECT COUNT(*) FROM external_request_items i WHERE i.external_request_id = r.id) AS item_count,
      (SELECT SUM(amount) FROM external_request_items i WHERE i.external_request_id = r.id) AS total_amount,
      (
        SELECT GROUP_CONCAT(DISTINCT es.marketplace)
        FROM external_request_items i
        LEFT JOIN external_stocks es ON UPPER(es.external_vendor_code) = UPPER(i.vendor_code)
        WHERE i.external_request_id = r.id AND es.marketplace IS NOT NULL AND es.marketplace != ''
      ) AS destinations
    FROM external_requests r
    ${whereClause}
    ORDER BY r.synced_at DESC, r.external_id DESC
    LIMIT 500
  `;

  try {
    const rs = await c.env.DB.prepare(sql)
      .bind(...params)
      .all();
    return ok(c, { requests: rs.results });
  } catch (e: any) {
    return fail(c, 'external_requests_query_failed', e.message ?? String(e), 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/external-requests/:id
// ---------------------------------------------------------------------------
externalRequests.get('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const req = await c.env.DB.prepare(
      'SELECT * FROM external_requests WHERE id = ?'
    )
      .bind(id)
      .first();
    if (!req) return fail(c, 'not_found', `external_request ${id} not found`, 404);

    const items = await c.env.DB.prepare(
      'SELECT * FROM external_request_items WHERE external_request_id = ? ORDER BY vendor_code'
    )
      .bind(id)
      .all();

    return ok(c, { request: req, items: items.results });
  } catch (e: any) {
    return fail(c, 'external_request_query_failed', e.message ?? String(e), 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/external-requests/sync
// Pulls all F4 requests for customer 4735 + detail for each via /v1/requests/show.
// ---------------------------------------------------------------------------
externalRequests.post('/sync', async (c) => {
  if (!c.env.F4_SKLADBOT_TOKEN) {
    return fail(c, 'config_missing', 'F4_SKLADBOT_TOKEN secret not configured', 500);
  }

  const token = c.env.F4_SKLADBOT_TOKEN;
  const wh = await c.env.DB.prepare(
    "SELECT id FROM warehouses WHERE external_provider = 'f4_skladbot' AND deleted_at IS NULL LIMIT 1"
  ).first<{ id: string }>();
  if (!wh) return fail(c, 'no_f4_warehouse', 'No warehouse marked as f4_skladbot', 500);
  const warehouseId = wh.id;

  // Step 1: list all 120 requests
  const listResp = await fetch(
    'https://api.skladbot.ru/v1/requests?customer_id=4735&limit=200',
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }
  );
  if (!listResp.ok) {
    return fail(c, 'skladbot_list_failed', `HTTP ${listResp.status}`, 500);
  }
  const listJson: any = await listResp.json();
  const list: any[] = listJson.data ?? [];

  const errors: string[] = [];
  let synced = 0;
  const now = Math.floor(Date.now() / 1000);

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  for (const r of list) {
    try {
      // Step 2: pull detail for this request (with retry on rate limit)
      let detResp: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        detResp = await fetch(
          `https://api.skladbot.ru/v1/requests/show/${r.id}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          }
        );
        if (detResp.status === 429) {
          await sleep(2000 * (attempt + 1)); // 2s, 4s, 6s back-off
          continue;
        }
        break;
      }
      if (!detResp || !detResp.ok) {
        errors.push(`detail ${r.id}: HTTP ${detResp?.status ?? 'no-response'}`);
        await sleep(300);
        continue;
      }
      const detJson: any = await detResp.json();
      const d = detJson.data ?? {};

      const reqId = `f4:${r.id}`;
      const typeNorm = normalizeType(r.type);

      // Upsert request header
      await c.env.DB.prepare(
        `INSERT INTO external_requests (
          id, external_provider, external_id, delivery_number,
          warehouse_id, request_type_raw, request_type_norm,
          stage_code, stage_name,
          is_completed, is_archived, is_expired,
          created_at_external, executor, creator, comment,
          raw_json, synced_at
        ) VALUES (?, 'f4_skladbot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          request_type_raw = excluded.request_type_raw,
          request_type_norm = excluded.request_type_norm,
          stage_code = excluded.stage_code,
          stage_name = excluded.stage_name,
          is_completed = excluded.is_completed,
          is_archived = excluded.is_archived,
          is_expired = excluded.is_expired,
          executor = excluded.executor,
          comment = excluded.comment,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at`
      )
        .bind(
          reqId,
          r.id,
          r.delivery_number || '',
          warehouseId,
          r.type || '',
          typeNorm,
          d.stage?.code ?? null,
          d.stage?.name ?? r.stage_title ?? null,
          d.isCompleted || r.is_completed ? 1 : 0,
          r.archived ? 1 : 0,
          r.expired ? 1 : 0,
          r.created_at || d.createdAt || null,
          r.executor || d.executor || null,
          r.creator || d.creator || d.created_by || null,
          d.comment ?? null,
          JSON.stringify(d).slice(0, 30000),
          now
        )
        .run();

      // Wipe + re-insert line items (idempotent)
      await c.env.DB.prepare(
        'DELETE FROM external_request_items WHERE external_request_id = ?'
      )
        .bind(reqId)
        .run();

      const products = d.products ?? [];
      for (const p of products) {
        const bundling = parseBundling(p.comment, p.vendorCode || '', p.amount || 0);
        const productId = vendorCodeToProductId(p.vendorCode || '');
        await c.env.DB.prepare(
          `INSERT INTO external_request_items (
            id, external_request_id, external_item_id,
            vendor_code, product_id, product_name, barcode,
            amount, accepted_amount, delivery_amount, repair_amount, recycle_amount,
            comment, bundling_divisor, bundling_from_qty, bundling_to_qty,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            `${reqId}:i${p.id}`,
            reqId,
            p.id,
            p.vendorCode || '',
            productId,
            p.name || null,
            p.barcode || null,
            p.amount || 0,
            p.acceptedAmount || 0,
            p.delivery_amount || 0,
            p.repairAmount || 0,
            p.recycleAmount || 0,
            p.comment || null,
            bundling?.divisor ?? null,
            bundling?.fromQty ?? null,
            bundling?.toQty ?? null,
            now
          )
          .run();
      }

      synced += 1;
      await sleep(100); // throttle to stay below Skladbot rate limit
    } catch (e: any) {
      errors.push(`${r.delivery_number ?? r.id}: ${e.message ?? String(e)}`);
    }
  }

  return ok(c, { synced, total: list.length, errors });
});

export default externalRequests;
