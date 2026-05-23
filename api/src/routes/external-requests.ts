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

/** Resolve a (possibly bundled) product_id to its base SKU + multiplier.
 *  Handles the 'paste 2-pack' case where Honghui ships single SKUs but the
 *  warehouse accepts them as pre-bundled pairs (DE202AA = 2 × DE202).
 *  Examples:
 *    de202aaaa → { base: 'de202', multiplier: 4 }
 *    de202aa   → { base: 'de202', multiplier: 2 }
 *    de202     → { base: 'de202', multiplier: 1 }
 */
function expandToBase(productId: string): { base: string; multiplier: number } {
  const pid = productId.toLowerCase().trim();
  if (pid.endsWith('aaaa')) {
    const base = pid.slice(0, -4);
    if (base.length > 2) return { base, multiplier: 4 };
  }
  if (pid.endsWith('aa')) {
    const base = pid.slice(0, -2);
    if (base.length > 2) return { base, multiplier: 2 };
  }
  return { base: pid, multiplier: 1 };
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

  // ──────────────────────────────────────────────────────────────────────
  // Post-sync: scan recently-completed acceptance requests and try to match
  // each to a candidate purchase operation. On match, set arrival_detected_at
  // and stash per-SKU received qtys for the UI confirmation card.
  //
  // Match rule: completed acceptance request → look for a purchase operation
  // that is:
  //   - operation_track = 'goods' (services excluded)
  //   - status = 'shipped' (already in OTW, awaiting arrival)
  //   - has at least 50% of the request's accepted SKUs in its line items
  //   - manufacturer matches if both have manufacturer_id set
  //   - not already matched (arrival_detected_at IS NULL)
  //   - not user-rejected for this same request (arrival_rejected_at)
  //
  // Single best match by SKU overlap count. Ties resolve to the most recently
  // updated operation. No match → skipped silently, user can match manually
  // later if needed.
  // ──────────────────────────────────────────────────────────────────────
  const matchResults: Array<{ request: string; op: string | null; reason: string }> = [];
  try {
    const completedAcceptances = await c.env.DB.prepare(`
      SELECT r.id AS request_id, r.delivery_number, r.warehouse_id,
             er.product_id, er.accepted_amount
      FROM external_requests r
      JOIN external_request_items er ON er.external_request_id = r.id
      WHERE r.is_completed = 1
        AND r.request_type_norm IN ('acceptance', 'pickup_acceptance')
        AND r.external_provider = 'f4_skladbot'
        AND er.accepted_amount > 0
        AND er.product_id IS NOT NULL
        AND r.synced_at > ?
    `).bind(now - 1).all<{
      request_id: string;
      delivery_number: string;
      warehouse_id: string;
      product_id: string;
      accepted_amount: number;
    }>();

    const byRequest = new Map<string, {
      delivery_number: string;
      warehouse_id: string;
      qtys: Map<string, number>;
    }>();
    for (const row of completedAcceptances.results || []) {
      let entry = byRequest.get(row.request_id);
      if (!entry) {
        entry = {
          delivery_number: row.delivery_number,
          warehouse_id: row.warehouse_id,
          qtys: new Map(),
        };
        byRequest.set(row.request_id, entry);
      }
      // Keep qtys keyed by the SKU as physically received (e.g. de202aa for
      // a 2-pack). The factory ships singles → OTW holds singles; the
      // warehouse accepts bundled pairs → LBR will hold AA. arrival_received_qtys
      // must record what physically arrived (AA), so the delivery transition
      // can apply the bundle conversion on the destination side.
      entry.qtys.set(
        row.product_id,
        (entry.qtys.get(row.product_id) ?? 0) + row.accepted_amount
      );
    }

    for (const [requestId, entry] of byRequest) {
      const acceptedSkus = Array.from(entry.qtys.keys());
      if (acceptedSkus.length === 0) continue;

      // For candidate matching, expand AA → base so an acceptance with de202aa
      // can still match a purchase whose line_items hold de202 (the factory
      // shipping form). The qtys map itself stays in AA form.
      const matchSkuSet = new Set<string>(acceptedSkus);
      for (const sku of acceptedSkus) {
        const exp = expandToBase(sku);
        if (exp.base !== sku) matchSkuSet.add(exp.base);
      }
      const matchSkus = Array.from(matchSkuSet);

      // Look up acceptance date for this request (text 'YYYY-MM-DD'). Used as
      // a sanity guard so we never match a recent acceptance to a long-stale
      // shipment (e.g. an October 2025 acceptance accidentally hitting an
      // April 2026 purchase). Window: operation must be on/before acceptance
      // date AND no older than 180 days before it.
      const reqMeta = await c.env.DB.prepare(
        'SELECT created_at_external FROM external_requests WHERE id = ?'
      ).bind(requestId).first<{ created_at_external: string | null }>();
      const acceptanceDate = reqMeta?.created_at_external || '';

      const skuPlaceholders = matchSkus.map(() => '?').join(',');
      const candidateRows = await c.env.DB.prepare(`
        SELECT o.id, o.reference, o.warehouse_to_id, o.manufacturer_id,
               COUNT(DISTINCT li.product_id) AS sku_overlap,
               o.updated_at
        FROM operations o
        JOIN line_items li ON li.operation_id = o.id
        WHERE o.deleted_at IS NULL
          AND o.operation_type = 'purchase'
          AND COALESCE(o.operation_track, 'goods') = 'goods'
          AND o.status = 'shipped'
          AND o.arrival_detected_at IS NULL
          AND (o.arrival_rejected_at IS NULL OR o.arrival_source_request_id != ?)
          AND (o.warehouse_to_id = ? OR o.warehouse_to_id IS NULL)
          AND li.product_id IN (${skuPlaceholders})
          AND (? = '' OR date(o.operation_date, 'unixepoch') <= ?)
          AND (? = '' OR date(o.operation_date, 'unixepoch') >= date(?, '-180 days'))
        GROUP BY o.id
        ORDER BY sku_overlap DESC, o.updated_at DESC
        LIMIT 5
      `).bind(
        requestId,
        entry.warehouse_id,
        ...matchSkus,
        acceptanceDate, acceptanceDate,
        acceptanceDate, acceptanceDate
      ).all<{
        id: string;
        reference: string;
        warehouse_to_id: string | null;
        manufacturer_id: string | null;
        sku_overlap: number;
        updated_at: number;
      }>();

      const candidates = candidateRows.results || [];
      if (candidates.length === 0) {
        matchResults.push({ request: entry.delivery_number, op: null, reason: 'no_candidate' });
        continue;
      }

      const best = candidates[0];
      const requiredOverlap = Math.ceil(matchSkus.length * 0.5);
      if (best.sku_overlap < requiredOverlap) {
        matchResults.push({
          request: entry.delivery_number,
          op: null,
          reason: `low_overlap_${best.sku_overlap}_of_${matchSkus.length}`,
        });
        continue;
      }

      const qtysJson = JSON.stringify(Object.fromEntries(entry.qtys));
      await c.env.DB.prepare(`
        UPDATE operations
        SET arrival_detected_at = ?,
            arrival_source_request_id = ?,
            arrival_received_qtys = ?,
            updated_at = ?
        WHERE id = ?
          AND arrival_detected_at IS NULL
      `).bind(now, requestId, qtysJson, now, best.id).run();

      matchResults.push({ request: entry.delivery_number, op: best.reference, reason: 'matched' });
    }
  } catch (e: any) {
    errors.push(`auto-match: ${e.message ?? String(e)}`);
  }

  // Phase 5 mp_delivery → transfer operations creation runs as a separate
  // endpoint (POST /external-requests/mp-delivery-backfill?limit=N) because
  // creating 56 retroactive operations exceeds the sync request timeout.
  // The cron will trigger it after sync completes.

  return ok(c, {
    synced,
    total: list.length,
    matched: matchResults,
    errors,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PHASE 5: mp_delivery → transfer operation creation (paginated)
//
// Walks unprocessed F4 mp_delivery requests and creates one transfer
// operation per request based on stage:
//
//   'Завершение' + isCompleted=True  → operation 'delivered' (lbr→ozon/wb)
//   'Забор груза' or later (incomplete) → operation 'shipped' (lbr→otw)
//   Earlier stages → skip (still at LBR, reserved but not picked up)
//
// Idempotency: reference 'MP-{delivery_number}'. Existing skipped.
// Marketplace OZON → partner_id 'ozon', warehouse_to 'ozon'
// Marketplace Wildberries → partner_id 'wb', warehouse_to 'wb'
// Operation date = collection_date (yyyy-mm-dd or dd.mm.yyyy) or now.
//
// Query param: limit (default 10, max 30) to keep each request under
// Worker time budget. Returns has_more flag to drive paginated backfill.
// ──────────────────────────────────────────────────────────────────────────
externalRequests.post('/mp-delivery-backfill', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 30);
  const now = Math.floor(Date.now() / 1000);

  // Backfill cutoff: all stock_movements for historical mp_delivery (operations
  // dated before opening_balance) are stamped at this date so they don't
  // collide with the May 7 opening snapshot. Day after opening = 2026-05-08.
  // Forward sync (operations created today and onward) use real op date.
  const OPENING_BALANCE_DATE = Math.floor(Date.UTC(2026, 4, 7) / 1000); // May 7 2026
  const BACKFILL_MOVEMENT_DATE = Math.floor(Date.UTC(2026, 4, 8) / 1000); // May 8 2026

  // Find mp_delivery requests not yet converted to operations.
  // Process oldest first so backfill builds chronologically.
  const mpRequests = await c.env.DB.prepare(`
    SELECT er.id, er.delivery_number, er.raw_json, er.created_at_external, er.is_completed
    FROM external_requests er
    LEFT JOIN operations o ON o.reference = 'MP-' || er.delivery_number AND o.deleted_at IS NULL
    WHERE er.request_type_norm = 'mp_delivery'
      AND er.external_provider = 'f4_skladbot'
      AND o.id IS NULL
    ORDER BY er.created_at_external ASC
    LIMIT ?
  `).bind(limit).all<{
    id: string;
    delivery_number: string;
    raw_json: string;
    created_at_external: string;
    is_completed: number;
  }>();

  const results: Array<{ request: string; op: string | null; reason: string }> = [];

  for (const req of mpRequests.results || []) {
    const opRef = `MP-${req.delivery_number}`;

    let parsed: any;
    try {
      parsed = JSON.parse(req.raw_json);
    } catch {
      results.push({ request: req.delivery_number, op: null, reason: 'bad_json' });
      continue;
    }

    const fields = (parsed.fields || []) as Array<{ field: string; value: string }>;
    const stageLogs = (parsed.stageLogs || []) as Array<{ stage: string }>;
    const productsRaw = (parsed.products || []) as Array<{ vendorCode: string; amount: number }>;
    const getField = (name: string) => fields.find((f) => f.field === name)?.value || null;

    const marketplace = getField('marketplace');
    const collectionDateStr = getField('collection_date');
    const stagesSeen = new Set(stageLogs.map((s) => s.stage));

    // Current stage code/name from F4 — single source of truth.
    // stagesSeen contains historical stages including ones the request
    // was rolled back from, so it cannot be used to determine current state.
    // Example failure mode: a delivery that briefly reached "Забор груза"
    // but was rolled back to "Согласование перечня работ" still has
    // stagesSeen.has('Забор груза') === true. Use the live stage instead.
    const currentStageCode = (parsed.stage?.code || '').toLowerCase();
    const currentStageName = (parsed.stage?.name || '').trim();

    // Marketplace dictates destination warehouse, NOT partner.
    // mp_delivery is an internal stock movement LBR → marketplace_warehouse
    // (ozon or wb). partner_id stays NULL.
    let warehouseDest: 'ozon' | 'wb' | null = null;
    if (marketplace === 'OZON') warehouseDest = 'ozon';
    else if (marketplace === 'Wildberries') warehouseDest = 'wb';
    if (!warehouseDest) {
      results.push({ request: req.delivery_number, op: null, reason: `unknown_marketplace_${marketplace}` });
      continue;
    }

    let opStatus: 'delivered' | 'shipped' | null = null;
    let warehouseTo: 'ozon' | 'wb' | 'otw' | null = null;
    const isCompleted = req.is_completed === 1;

    // Decision is based on CURRENT stage, not historical stages.
    //   completion + isCompleted → goods physically at marketplace warehouse
    //   pickup (active, not rolled back)   → goods in transit (OTW)
    //   anything earlier (works_coordination, etc.) → skip; goods not yet moved.
    const isAtCompletion = currentStageCode === 'completion' || currentStageName === 'Завершение';
    const isAtPickup     = currentStageCode === 'pickup'      || currentStageName === 'Забор груза';

    if (isAtCompletion && isCompleted) {
      opStatus = 'delivered';
      warehouseTo = warehouseDest;
    } else if (isAtPickup) {
      opStatus = 'shipped';
      warehouseTo = 'otw';
    } else {
      // works_coordination, manager_review, anything else — no stock movement yet.
      results.push({ request: req.delivery_number, op: null, reason: `pre_pickup_current_stage_${currentStageCode || 'unknown'}` });
      continue;
    }

    const skuMap: Record<string, number> = {};
    for (const p of productsRaw) {
      if (!p.amount || p.amount <= 0) continue;
      const code = p.vendorCode.toLowerCase();
      skuMap[code] = (skuMap[code] ?? 0) + p.amount;
    }
    const skus = Object.keys(skuMap);
    if (skus.length === 0) {
      results.push({ request: req.delivery_number, op: null, reason: 'no_products' });
      continue;
    }

    const placeholders = skus.map(() => '?').join(',');
    const catalogCheck = await c.env.DB.prepare(
      `SELECT id FROM products WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(...skus).all<{ id: string }>();
    const validSkus = new Set((catalogCheck.results || []).map((r) => r.id));
    const lineItems = skus
      .filter((s) => validSkus.has(s))
      .map((s) => ({ product_id: s, qty: skuMap[s] }));
    if (lineItems.length === 0) {
      results.push({ request: req.delivery_number, op: null, reason: 'no_valid_skus' });
      continue;
    }

    // Operation date — actual collection_date from F4 (keeps history intact)
    let opDate = now;
    if (collectionDateStr) {
      const m1 = collectionDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const m2 = collectionDateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m1) opDate = Math.floor(Date.UTC(+m1[1], +m1[2] - 1, +m1[3]) / 1000);
      else if (m2) opDate = Math.floor(Date.UTC(+m2[3], +m2[2] - 1, +m2[1]) / 1000);
    }

    // Stock movements: if operation predates opening_balance, stamp movements
    // at BACKFILL_MOVEMENT_DATE so they live on top of the snapshot. Otherwise
    // use the real operation date.
    const isBackfill = opDate < OPENING_BALANCE_DATE;
    const movementDate = isBackfill ? BACKFILL_MOVEMENT_DATE : opDate;
    const movementReason = isBackfill
      ? 'retroactive_backfill_mp_delivery'
      : 'mp_delivery_f4';

    const opId = `op_${crypto.randomUUID()}`;
    const stmts: D1PreparedStatement[] = [];

    // Insert operation: partner_id NULL (internal transfer between our warehouses)
    stmts.push(
      c.env.DB.prepare(`
        INSERT INTO operations (
          id, operation_date, operation_type, operation_track, partner_id,
          our_company_id, warehouse_from_id, warehouse_to_id, status,
          currency, total_amount, reference, notes, delivery_status,
          created_at, updated_at
        ) VALUES (?, ?, 'transfer', 'goods', NULL, 'dee', 'lbr', ?, ?, 'RUB', 0, ?, ?, ?, ?, ?)
      `).bind(
        opId,
        opDate,
        warehouseTo,
        opStatus,
        opRef,
        `F4 mp_delivery → ${marketplace}. ${getField('cross_dock') || ''}`.trim(),
        opStatus === 'delivered' ? 'delivered' : 'pending',
        now,
        now
      )
    );

    // Line items
    for (const li of lineItems) {
      const liId = `li_${crypto.randomUUID()}`;
      stmts.push(
        c.env.DB.prepare(`
          INSERT INTO line_items (
            id, operation_id, product_id, qty, unit_price, unit_price_after_disc,
            line_amount, currency, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, 0, 0, 'RUB', ?, ?)
        `).bind(liId, opId, li.product_id, li.qty, now, now)
      );
    }

    try {
      // First, run inserts of operation + line items in a batch
      await c.env.DB.batch(stmts);

      // ── Transfer batch linking (migration 0039) ──────────────────────
      // Group new F4-WH-R operations under a parent batch per
      // (operation_date, marketplace). Reference format: MP-YYMMDD.
      // Skip when destination is OTW (marketplace not yet decided).
      if (warehouseTo === 'ozon' || warehouseTo === 'wb') {
        const mpShort: 'OZN' | 'WB' = warehouseTo === 'ozon' ? 'OZN' : 'WB';
        // Normalize op date to midnight UTC for stable batch lookup
        const opDay = Math.floor(opDate / 86400) * 86400;
        const dateObj = new Date(opDay * 1000);
        const y = String(dateObj.getUTCFullYear()).slice(2);
        const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const d = String(dateObj.getUTCDate()).padStart(2, '0');
        const batchRef = `${mpShort}-${y}${m}${d}`;

        // Look up existing batch
        let existing = await c.env.DB.prepare(
          'SELECT id FROM operation_batches WHERE batch_reference = ? AND deleted_at IS NULL'
        ).bind(batchRef).first<{ id: string }>();

        let batchId: string;
        if (existing) {
          batchId = existing.id;
        } else {
          batchId = `bch_${crypto.randomUUID().slice(0, 16).replace(/-/g, '')}`;
          await c.env.DB.prepare(`
            INSERT INTO operation_batches (
              id, batch_reference, marketplace, batch_date,
              our_company_id, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'dee', ?, unixepoch(), unixepoch())
          `).bind(batchId, batchRef, mpShort, opDay,
                  `Auto-created by external-requests sync for ${batchRef}`)
            .run();
        }

        // Attach the operation we just created
        await c.env.DB.prepare(
          'UPDATE operations SET batch_id = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(batchId, opId).run();
      }

      // Then stocks update + movement records, both need current balances.
      // Do them per line item with separate prepare calls (cannot batch
      // because we need to read updated on_hand for balance_after).
      for (const li of lineItems) {
        // ---- LBR on_hand decreases ----
        await c.env.DB.prepare(`
          INSERT INTO stocks (id, warehouse_id, product_id, stock_state, on_hand, updated_at)
          VALUES (?, 'lbr', ?, 'on_hand', ?, ?)
          ON CONFLICT(warehouse_id, product_id, stock_state)
          DO UPDATE SET on_hand = on_hand + ?, updated_at = ?
        `).bind(`stk_${crypto.randomUUID()}`, li.product_id, -li.qty, now, -li.qty, now).run();

        const lbrBalance = await c.env.DB.prepare(
          "SELECT on_hand FROM stocks WHERE warehouse_id = 'lbr' AND product_id = ? AND stock_state = 'on_hand'"
        ).bind(li.product_id).first<{ on_hand: number }>();

        await c.env.DB.prepare(`
          INSERT INTO stock_movements (
            id, warehouse_id, product_id, movement_type, quantity,
            source, source_ref_type, source_ref_id,
            reason, performed_at, balance_after, stock_state, created_at
          ) VALUES (?, 'lbr', ?, 'shipment_out', ?, 'operation', 'operation', ?, ?, ?, ?, 'on_hand', ?)
        `).bind(
          `mov_${crypto.randomUUID()}`,
          li.product_id,
          -li.qty,
          opId,
          movementReason,
          movementDate,
          lbrBalance?.on_hand ?? -li.qty,
          movementDate
        ).run();

        // ---- Destination side (ozon/wb on_hand OR otw in_transit) ----
        if (opStatus === 'delivered') {
          await c.env.DB.prepare(`
            INSERT INTO stocks (id, warehouse_id, product_id, stock_state, on_hand, updated_at)
            VALUES (?, ?, ?, 'on_hand', ?, ?)
            ON CONFLICT(warehouse_id, product_id, stock_state)
            DO UPDATE SET on_hand = on_hand + ?, updated_at = ?
          `).bind(`stk_${crypto.randomUUID()}`, warehouseTo, li.product_id, li.qty, now, li.qty, now).run();

          const destBalance = await c.env.DB.prepare(
            'SELECT on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ? AND stock_state = \'on_hand\''
          ).bind(warehouseTo, li.product_id).first<{ on_hand: number }>();

          await c.env.DB.prepare(`
            INSERT INTO stock_movements (
              id, warehouse_id, product_id, movement_type, quantity,
              source, source_ref_type, source_ref_id,
              reason, performed_at, balance_after, stock_state, created_at
            ) VALUES (?, ?, ?, 'arrival', ?, 'operation', 'operation', ?, ?, ?, ?, 'on_hand', ?)
          `).bind(
            `mov_${crypto.randomUUID()}`,
            warehouseTo,
            li.product_id,
            li.qty,
            opId,
            movementReason,
            movementDate,
            destBalance?.on_hand ?? li.qty,
            movementDate
          ).run();
        } else {
          // shipped → OTW in_transit
          await c.env.DB.prepare(`
            INSERT INTO stocks (id, warehouse_id, product_id, stock_state, on_hand, updated_at)
            VALUES (?, 'otw', ?, 'in_transit', ?, ?)
            ON CONFLICT(warehouse_id, product_id, stock_state)
            DO UPDATE SET on_hand = on_hand + ?, updated_at = ?
          `).bind(`stk_${crypto.randomUUID()}`, li.product_id, li.qty, now, li.qty, now).run();

          const otwBalance = await c.env.DB.prepare(
            "SELECT on_hand FROM stocks WHERE warehouse_id = 'otw' AND product_id = ? AND stock_state = 'in_transit'"
          ).bind(li.product_id).first<{ on_hand: number }>();

          await c.env.DB.prepare(`
            INSERT INTO stock_movements (
              id, warehouse_id, product_id, movement_type, quantity,
              source, source_ref_type, source_ref_id,
              reason, performed_at, balance_after, stock_state, created_at
            ) VALUES (?, 'otw', ?, 'in_transit_in', ?, 'operation', 'operation', ?, ?, ?, ?, 'in_transit', ?)
          `).bind(
            `mov_${crypto.randomUUID()}`,
            li.product_id,
            li.qty,
            opId,
            movementReason,
            movementDate,
            otwBalance?.on_hand ?? li.qty,
            movementDate
          ).run();
        }
      }

      results.push({ request: req.delivery_number, op: opRef, reason: `created_${opStatus}${isBackfill ? '_backfill' : ''}` });
    } catch (e: any) {
      results.push({ request: req.delivery_number, op: null, reason: `insert_failed_${e.message}` });
    }
  }

  // Check if more remain
  const remainCheck = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM external_requests er
    LEFT JOIN operations o ON o.reference = 'MP-' || er.delivery_number AND o.deleted_at IS NULL
    WHERE er.request_type_norm = 'mp_delivery'
      AND er.external_provider = 'f4_skladbot'
      AND o.id IS NULL
  `).first<{ n: number }>();

  return ok(c, {
    processed: results.length,
    results,
    remaining: remainCheck?.n ?? 0,
    has_more: (remainCheck?.n ?? 0) > 0,
  });
});

export default externalRequests;
