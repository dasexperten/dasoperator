import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueNextSequence } from '../lib/sequence-format';
import { sequenceIdForCompany } from '../lib/company-sequence';
import { getRateToUsdNano, applyFxToAmount } from '../lib/fx-cbr';
import { getRatesFor } from '../lib/fx-store';

const operations = new Hono<{ Bindings: Env }>();

// =============================================================================
// Payment state — overlay color for any operation (Phase 4.3 follow-up)
// 95% tolerance handles FX rounding when payment currency != operation currency.
// =============================================================================
//
//   draft / cancelled              → 'neutral'  (no overlay)
//   paid_amount = 0                → 'unpaid'    (red)
//   0 < paid_amount < total × 0.95 → 'partial'   (brown)
//   paid_amount >= total × 0.95    → 'paid'      (green)
//
// =============================================================================

const PAID_TOLERANCE = 0.95;

type PaymentState = 'neutral' | 'unpaid' | 'partial' | 'paid';

function derivePaymentState(total: number, paid: number, status: string): PaymentState {
  if (status === 'draft' || status === 'cancelled') return 'neutral';
  if (paid <= 0) return 'unpaid';
  if (paid >= total * PAID_TOLERANCE) return 'paid';
  return 'partial';
}

// =============================================================================
// Schemas — Phase 3.0e: contract_id replaces partner_id+our_company_id+currency.
// Backend reads contract row to derive those three fields.
// (Q1=A hard break — frontend MUST supply contract_id.)
// =============================================================================

const lineItemSchema = z.object({
  product_id: z.string().min(1),
  qty: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_pct: z.number().min(0).max(100).default(0),
  cartons: z.number().int().nonnegative().default(0),
  inner_boxes: z.number().int().nonnegative().default(0),
  item_description: z.string().nullable().optional(),
});

const createOperationSchema = z.object({
  // SALE path: contract_id provided → derives partner+company+currency from contract.
  // PURCHASE / TRANSFER paths: contract_id omitted, fields provided directly.
  contract_id: z.string().nullable().optional(),

  // Operation type — DB CHECK constraint allows only these 3 values.
  operation_type: z.enum(['sale', 'purchase', 'transfer']),
  operation_date: z.number().int().positive(),

  // Direct fields for purchase/transfer (ignored when contract_id supplied).
  manufacturer_id: z.string().nullable().optional(),       // PURCHASE: factory we buy from
  our_company_id: z.string().nullable().optional(),        // PURCHASE/TRANSFER: our buying / sending entity
  receiving_company_id: z.string().nullable().optional(),  // TRANSFER: recipient entity
  currency: z.string().length(3).nullable().optional(),    // PURCHASE/TRANSFER: ISO-4217 (CNY/USD/etc.)

  warehouse_from_id: z.string().nullable().optional(),
  warehouse_to_id: z.string().nullable().optional(),
  price_type_id: z.string().nullable().optional(),
  incoterms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  order_doc_ref: z.string().nullable().optional(),

  line_items: z.array(lineItemSchema).min(1),

  // Invoicer routing flags (added by 0009_invoicer_roles_and_routes.sql).
  // dei_layer = 1 means a sale to Russia routes Factory→DEI→DEE and the
  // invoicer emits CI+PL (Factory→DEI) plus an IS (DEI→buyer) at issue
  // time. legal_seller_id overrides the products-derived legal seller for
  // operations where multiple manufacturers ship under one invoice.
  dei_layer: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional().default(0),
  legal_seller_id: z.string().nullable().optional(),
})
  // SALE: must supply contract_id (carries partner + company + currency)
  .refine(
    (data) => data.operation_type !== 'sale' || !!data.contract_id,
    { message: 'contract_id required for sale operations' }
  )
  // PURCHASE: must supply manufacturer_id + our_company_id + currency
  .refine(
    (data) => data.operation_type !== 'purchase'
      || (!!data.manufacturer_id && !!data.our_company_id && !!data.currency),
    { message: 'manufacturer_id, our_company_id and currency required for purchase operations' }
  )
  // TRANSFER: must supply our_company_id + receiving_company_id + currency
  .refine(
    (data) => data.operation_type !== 'transfer'
      || (!!data.our_company_id && !!data.receiving_company_id && !!data.currency),
    { message: 'our_company_id, receiving_company_id and currency required for transfer operations' }
  )
  // TRANSFER: sender and receiver must differ
  .refine(
    (data) => data.operation_type !== 'transfer'
      || data.our_company_id !== data.receiving_company_id,
    { message: 'our_company_id and receiving_company_id must differ for transfer operations' }
  )
  // Warehouse rules
  .refine(
    (data) => {
      if (data.operation_type === 'sale' || data.operation_type === 'transfer') {
        return !!data.warehouse_from_id;
      }
      return true;
    },
    { message: 'warehouse_from_id required for sale and transfer operations' }
  )
  .refine(
    (data) => {
      if (data.operation_type === 'purchase' || data.operation_type === 'transfer') {
        return !!data.warehouse_to_id;
      }
      return true;
    },
    { message: 'warehouse_to_id required for purchase and transfer operations' }
  );

// =============================================================================
// Helpers
// =============================================================================

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isoDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

interface ProductRow {
  id: string;
  product_name: string;
  invoice_label: string;
}

interface PartnerRow {
  id: string;
  trade_name: string;
  status: string;
}

interface ContractRow {
  id: string;
  partner_id: string;
  our_company_id: string;
  currency: string;
  status: string;
  vat_rate: number;
}

// =============================================================================
// POST /api/operations
// =============================================================================
operations.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = createOperationSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;
  const warnings: string[] = [];

  // ---------------------------------------------------------------------------
  // Step 1-3: Resolve counterparty fields per operation_type
  //   SALE     → from contract: partner_id, our_company_id, currency, vat_rate
  //   PURCHASE → from body:     manufacturer_id, our_company_id, currency
  //              partner_id = NULL, vat_rate = 0
  //   TRANSFER → from body:     our_company_id, receiving_company_id, currency
  //              partner_id = NULL, manufacturer_id = NULL, vat_rate = 0
  // ---------------------------------------------------------------------------
  let resolvedContractId: string | null = null;
  let resolvedPartnerId: string | null = null;
  let resolvedCompanyId: string;
  let resolvedReceivingCompanyId: string | null = null;
  let resolvedManufacturerId: string | null = null;
  let resolvedCurrency: string;
  let resolvedVatRate = 0;

  if (data.operation_type === 'sale') {
    // SALE — derive from contract
    const contract = await c.env.DB.prepare(
      'SELECT id, partner_id, our_company_id, currency, status, vat_rate FROM contracts WHERE id = ? AND deleted_at IS NULL'
    ).bind(data.contract_id!).first<ContractRow>();

    if (!contract) {
      return fail(c, 404, [{
        code: 'contract_not_found',
        message: `contract_id ${data.contract_id} does not exist`,
      }]);
    }
    if (contract.status !== 'active') {
      warnings.push(`contract_status_${contract.status}: contract is not active`);
    }

    const partner = await c.env.DB.prepare(
      'SELECT id, trade_name, status FROM partners WHERE id = ? AND deleted_at IS NULL'
    ).bind(contract.partner_id).first<PartnerRow>();

    if (!partner) {
      return fail(c, 500, [{
        code: 'partner_inconsistent',
        message: `Contract ${contract.id} references missing partner ${contract.partner_id}`,
      }]);
    }

    if (partner.status === 'pending' || partner.status === 'blocked') {
      warnings.push(`partner_${partner.status}: ${partner.trade_name} has status ${partner.status}`);
    }

    const company = await c.env.DB.prepare(
      'SELECT id FROM companies WHERE id = ?'
    ).bind(contract.our_company_id).first<{ id: string }>();

    if (!company) {
      return fail(c, 500, [{
        code: 'company_inconsistent',
        message: `Contract references non-existent company ${contract.our_company_id}`,
      }]);
    }

    resolvedContractId = contract.id;
    resolvedPartnerId = contract.partner_id;
    resolvedCompanyId = contract.our_company_id;
    resolvedCurrency = contract.currency;
    resolvedVatRate = contract.vat_rate;

  } else if (data.operation_type === 'purchase') {
    // PURCHASE — fields from body, validate FKs
    const manufacturer = await c.env.DB.prepare(
      'SELECT id FROM manufacturers WHERE id = ?'
    ).bind(data.manufacturer_id!).first<{ id: string }>();

    if (!manufacturer) {
      return fail(c, 404, [{
        code: 'manufacturer_not_found',
        message: `manufacturer_id ${data.manufacturer_id} does not exist`,
      }]);
    }

    const company = await c.env.DB.prepare(
      'SELECT id FROM companies WHERE id = ?'
    ).bind(data.our_company_id!).first<{ id: string }>();

    if (!company) {
      return fail(c, 404, [{
        code: 'company_not_found',
        message: `our_company_id ${data.our_company_id} does not exist`,
      }]);
    }

    resolvedManufacturerId = data.manufacturer_id!;
    resolvedCompanyId = data.our_company_id!;
    resolvedCurrency = data.currency!;

  } else {
    // TRANSFER — both companies from body, validate FKs
    const sender = await c.env.DB.prepare(
      'SELECT id FROM companies WHERE id = ?'
    ).bind(data.our_company_id!).first<{ id: string }>();

    if (!sender) {
      return fail(c, 404, [{
        code: 'company_not_found',
        message: `our_company_id ${data.our_company_id} does not exist`,
      }]);
    }

    const receiver = await c.env.DB.prepare(
      'SELECT id FROM companies WHERE id = ?'
    ).bind(data.receiving_company_id!).first<{ id: string }>();

    if (!receiver) {
      return fail(c, 404, [{
        code: 'company_not_found',
        message: `receiving_company_id ${data.receiving_company_id} does not exist`,
      }]);
    }

    resolvedCompanyId = data.our_company_id!;
    resolvedReceivingCompanyId = data.receiving_company_id!;
    resolvedCurrency = data.currency!;
  }

  // ---------------------------------------------------------------------------
  // Step 4: Warehouse existence
  // ---------------------------------------------------------------------------
  if (data.warehouse_from_id) {
    const wh = await c.env.DB.prepare(
      'SELECT id FROM warehouses WHERE id = ?'
    ).bind(data.warehouse_from_id).first();
    if (!wh) {
      return fail(c, 404, [{
        code: 'warehouse_not_found',
        message: `warehouse_from_id ${data.warehouse_from_id} does not exist`,
      }]);
    }
  }
  if (data.warehouse_to_id) {
    const wh = await c.env.DB.prepare(
      'SELECT id FROM warehouses WHERE id = ?'
    ).bind(data.warehouse_to_id).first();
    if (!wh) {
      return fail(c, 404, [{
        code: 'warehouse_not_found',
        message: `warehouse_to_id ${data.warehouse_to_id} does not exist`,
      }]);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: Product existence
  // ---------------------------------------------------------------------------
  const productIds = data.line_items.map((li) => li.product_id);
  const placeholders = productIds.map(() => '?').join(', ');
  const productRows = await c.env.DB.prepare(
    `SELECT id, product_name, invoice_label FROM products WHERE id IN (${placeholders})`
  ).bind(...productIds).all<ProductRow>();

  const productMap = new Map<string, ProductRow>();
  for (const p of productRows.results) {
    productMap.set(p.id, p);
  }

  const missingProducts = productIds.filter((id) => !productMap.has(id));
  if (missingProducts.length > 0) {
    return fail(c, 404, [{
      code: 'product_not_found',
      message: `Unknown product_id(s): ${missingProducts.join(', ')}`,
    }]);
  }

  // ---------------------------------------------------------------------------
  // Step 6: Issue reference number from company sequence
  // ---------------------------------------------------------------------------
  const sequenceId = sequenceIdForCompany(resolvedCompanyId);
  if (!sequenceId) {
    return fail(c, 500, [{
      code: 'sequence_mapping_missing',
      message: `No sequence mapped for company ${resolvedCompanyId}`,
    }]);
  }

  const seqResult = await issueNextSequence(c.env.DB, sequenceId);
  if (!seqResult) {
    return fail(c, 500, [{
      code: 'sequence_failed',
      message: `Failed to issue from sequence ${sequenceId}`,
    }]);
  }

  // ---------------------------------------------------------------------------
  // Step 7: FX lookup — Phase 2.0c-2b integration (preserved per-line FX)
  // ---------------------------------------------------------------------------
  const opDateStr = isoDate(data.operation_date);
  let fxRateToUsdNano: number | null = null;

  if (resolvedCurrency === 'USD') {
    fxRateToUsdNano = 1_000_000_000; // 1.0 in nano units
  } else {
    const snapshot = await getRatesFor(c.env.FX, opDateStr);
    if (snapshot) {
      const rate = getRateToUsdNano(snapshot, resolvedCurrency);
      if (rate !== null) {
        fxRateToUsdNano = rate;
      } else {
        warnings.push(
          `fx_currency_unsupported: ${resolvedCurrency} not in CBR feed for ${opDateStr}`
        );
      }
    } else {
      warnings.push(
        `fx_unavailable: no FX rate cached for ${opDateStr} and CBR fetch failed`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 8: Compute money fields with per-line FX
  // ---------------------------------------------------------------------------
  let totalAmount = 0;
  const lineItemsComputed = data.line_items.map((li) => {
    const product = productMap.get(li.product_id)!;
    const description = li.item_description ?? product.invoice_label;

    const unitPriceAfterDisc =
      li.discount_pct === 0
        ? li.unit_price
        : Math.round(li.unit_price * (100 - li.discount_pct)) / 100;
    const lineAmount = Math.round(unitPriceAfterDisc * li.qty * 100) / 100;

    totalAmount += lineAmount;

    const lineUsdEquiv = fxRateToUsdNano !== null
      ? applyFxToAmount(lineAmount, fxRateToUsdNano, resolvedCurrency)
      : null;

    return {
      id: genId('li'),
      product_id: li.product_id,
      item_description: description,
      qty: li.qty,
      cartons: li.cartons,
      inner_boxes: li.inner_boxes,
      unit_price: li.unit_price,
      discount_pct: li.discount_pct,
      unit_price_after_disc: unitPriceAfterDisc,
      line_amount: lineAmount,
      currency: resolvedCurrency,
      line_usd_equiv: lineUsdEquiv,
    };
  });

  const totalUsdEquiv = fxRateToUsdNano !== null
    ? applyFxToAmount(totalAmount, fxRateToUsdNano, resolvedCurrency)
    : null;

  // ---------------------------------------------------------------------------
  // Step 9: Atomic batch INSERT
  // (Note: 'paid' column dropped in migration 0006; not in INSERT list.)
  // ---------------------------------------------------------------------------
  const operationId = genId('op');
  const now = Math.floor(Date.now() / 1000);

  const deiLayerInt = (data.dei_layer === true || data.dei_layer === 1) ? 1 : 0;

  const insertOpStmt = c.env.DB.prepare(`
    INSERT INTO operations (
      id, contract_id, operation_date, operation_type,
      partner_id, our_company_id, receiving_company_id, manufacturer_id,
      warehouse_from_id, warehouse_to_id,
      reference, status,
      price_type_id, currency, fx_rate_to_usd,
      total_amount, total_usd_equiv,
      incoterms, notes, vat_rate,
      dei_layer, legal_seller_id,
      created_at, updated_at, deleted_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, 'draft',
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, NULL
    )
  `).bind(
    operationId,
    resolvedContractId,
    data.operation_date,
    data.operation_type,
    resolvedPartnerId,
    resolvedCompanyId,
    resolvedReceivingCompanyId,
    resolvedManufacturerId ?? data.manufacturer_id ?? null,
    data.warehouse_from_id ?? null,
    data.warehouse_to_id ?? null,
    seqResult.formatted,
    data.price_type_id ?? null,
    resolvedCurrency,
    fxRateToUsdNano,
    totalAmount,
    totalUsdEquiv,
    data.incoterms ?? null,
    data.notes ?? null,
    resolvedVatRate,
    deiLayerInt,
    data.legal_seller_id ?? null,
    now,
    now
  );

  const lineItemStmts = lineItemsComputed.map((li) =>
    c.env.DB.prepare(`
      INSERT INTO line_items (
        id, operation_id, product_id, item_description,
        qty, cartons, inner_boxes,
        unit_price, discount_pct, unit_price_after_disc,
        line_amount, currency, line_usd_equiv,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      li.id, operationId, li.product_id, li.item_description,
      li.qty, li.cartons, li.inner_boxes,
      li.unit_price, li.discount_pct, li.unit_price_after_disc,
      li.line_amount, li.currency, li.line_usd_equiv,
      now, now
    )
  );

  try {
    await c.env.DB.batch([insertOpStmt, ...lineItemStmts]);
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to insert operation',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    operation: {
      id: operationId,
      contract_id: resolvedContractId,
      reference: seqResult.formatted,
      operation_type: data.operation_type,
      operation_date: data.operation_date,
      our_company_id: resolvedCompanyId,
      receiving_company_id: resolvedReceivingCompanyId,
      partner_id: resolvedPartnerId,
      manufacturer_id: resolvedManufacturerId ?? data.manufacturer_id ?? null,
      warehouse_from_id: data.warehouse_from_id ?? null,
      warehouse_to_id: data.warehouse_to_id ?? null,
      status: 'draft',
      price_type_id: data.price_type_id ?? null,
      currency: resolvedCurrency,
      fx_rate_to_usd: fxRateToUsdNano,
      total_amount: totalAmount,
      total_usd_equiv: totalUsdEquiv,
      incoterms: data.incoterms ?? null,
      notes: data.notes ?? null,
      vat_rate: resolvedVatRate,
      dei_layer: deiLayerInt,
      legal_seller_id: data.legal_seller_id ?? null,
      created_at: now,
      updated_at: now,
    },
    line_items: lineItemsComputed,
    warnings,
  }, ['Operation created in draft status']);
});

// =============================================================================
// GET /api/operations — list with optional filters
// Query: partner_id, contract_id, operation_type, status
// Returns operations with contract_no/partner_trade_name/entity_abbreviation JOINs.
// =============================================================================
operations.get('/', async (c) => {
  const partnerId = c.req.query('partner_id');
  const contractId = c.req.query('contract_id');
  const opType = c.req.query('operation_type');
  const status = c.req.query('status');

  let sql = `
    SELECT
      o.id, o.contract_id, ct.contract_no,
      o.partner_id, p.trade_name as partner_trade_name,
      o.manufacturer_id, mfr.name as manufacturer_name,
      o.our_company_id, co.abbreviation as entity_abbreviation,
      o.operation_type, o.operation_date,
      o.warehouse_from_id, o.warehouse_to_id,
      o.currency, o.total_amount, o.total_usd_equiv,
      o.status, o.reference, o.notes, o.vat_rate,
      o.created_at, o.updated_at,
      COALESCE((
        SELECT SUM(pay.amount)
        FROM payments pay
        WHERE pay.operation_id = o.id
          AND pay.currency = o.currency
          AND pay.deleted_at IS NULL
      ), 0) AS paid_amount
    FROM operations o
    LEFT JOIN contracts ct ON o.contract_id = ct.id
    LEFT JOIN partners p ON o.partner_id = p.id
    LEFT JOIN manufacturers mfr ON o.manufacturer_id = mfr.id
    LEFT JOIN companies co ON o.our_company_id = co.id
    WHERE o.deleted_at IS NULL
  `;
  const binds: unknown[] = [];

  if (partnerId) { sql += ` AND o.partner_id = ?`; binds.push(partnerId); }
  if (contractId) { sql += ` AND o.contract_id = ?`; binds.push(contractId); }
  if (opType) { sql += ` AND o.operation_type = ?`; binds.push(opType); }
  if (status) { sql += ` AND o.status = ?`; binds.push(status); }

  sql += ` ORDER BY o.operation_date DESC, o.created_at DESC`;

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  const decorated = (result.results as Array<Record<string, unknown>>).map((row) => {
    const total = Number(row.total_amount) || 0;
    const paid = Number(row.paid_amount) || 0;
    return {
      ...row,
      payment_state: derivePaymentState(total, paid, String(row.status)),
    };
  });

  return ok(c, {
    count: decorated.length,
    operations: decorated,
  });
});

// =============================================================================
// GET /api/operations/:id
// =============================================================================
operations.get('/:id', async (c) => {
  const opId = c.req.param('id');

  const op = await c.env.DB.prepare(`
    SELECT
      o.*,
      ct.contract_no, ct.currency as contract_currency,
      p.trade_name as partner_trade_name,
      mfr.name as manufacturer_name,
      co.abbreviation as entity_abbreviation
    FROM operations o
    LEFT JOIN contracts ct ON o.contract_id = ct.id
    LEFT JOIN partners p ON o.partner_id = p.id
    LEFT JOIN manufacturers mfr ON o.manufacturer_id = mfr.id
    LEFT JOIN companies co ON o.our_company_id = co.id
    WHERE o.id = ? AND o.deleted_at IS NULL
  `).bind(opId).first<Record<string, unknown>>();

  if (!op) {
    return fail(c, 404, [{
      code: 'operation_not_found',
      message: `Operation ${opId} not found`,
    }]);
  }

  const lineItems = await c.env.DB.prepare(`
    SELECT li.*, p.product_name, p.invoice_label
    FROM line_items li
    LEFT JOIN products p ON li.product_id = p.id
    WHERE li.operation_id = ?
    ORDER BY li.created_at ASC
  `).bind(opId).all();

  // Pull payments for this operation in operation's native currency
  const paidRow = await c.env.DB.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS paid_amount
    FROM payments
    WHERE operation_id = ?
      AND currency = ?
      AND deleted_at IS NULL
  `).bind(opId, op.currency).first<{ paid_amount: number }>();

  const total = Number(op.total_amount) || 0;
  const paid = Number(paidRow?.paid_amount) || 0;

  return ok(c, {
    operation: {
      ...op,
      paid_amount: paid,
      payment_state: derivePaymentState(total, paid, String(op.status)),
    },
    line_items: lineItems.results,
  });
});

// =============================================================================
// =============================================================================
// PATCH /api/operations/:id/status — advance operation through lifecycle
//
// Phase 4.3 OPS-INTEGRATION: status change now ALSO writes stock_movements
// and updates stocks.on_hand atomically.
//
// Transition rules:
//   draft/issued → shipped:
//     sale       → shipment  from warehouse_from  (qty negative)
//     transfer   → transfer_out from warehouse_from (qty negative)
//     purchase   → no movement at shipped (goods still in transit)
//   shipped → delivered:
//     transfer   → transfer_in  to warehouse_to   (qty positive)
//     purchase   → receipt      to warehouse_to   (qty positive)
//     sale       → no movement (already gone from our books)
//   any → cancelled:
//     if prior status was shipped:
//       sale     → reverse shipment  (return, qty positive) from warehouse_from
//       transfer → reverse transfer_out (qty positive) from warehouse_from
//       purchase → no movement (never touched stock)
// =============================================================================

const updateStatusSchema = z.object({
  status: z.enum(['issued', 'order_fulfilment', 'production', 'stocked', 'shipped', 'delivered', 'cancelled']),
  notes: z.string().optional(),
});

// Allowed transitions — branched by operation_type
// SALE:     draft → issued → order_fulfilment → shipped → delivered (+cancel)
// PURCHASE: draft → issued → production → stocked → shipped → delivered (+cancel)
// TRANSFER: draft → issued → shipped → delivered (+cancel)
const ALLOWED_TRANSITIONS_BY_TYPE: Record<string, Record<string, string[]>> = {
  sale: {
    draft:            ['issued', 'cancelled'],
    issued:           ['order_fulfilment', 'shipped', 'cancelled'],  // direct skip allowed
    order_fulfilment: ['shipped', 'cancelled'],
    shipped:          ['delivered', 'cancelled'],
    delivered:        [],
    cancelled:        [],
  },
  purchase: {
    draft:      ['issued', 'cancelled'],
    issued:     ['production', 'stocked', 'shipped', 'cancelled'],  // skip allowed
    production: ['stocked', 'cancelled'],
    stocked:    ['shipped', 'cancelled'],
    shipped:    ['delivered', 'cancelled'],
    delivered:  [],
    cancelled:  [],
  },
  transfer: {
    draft:     ['issued', 'cancelled'],
    issued:    ['shipped', 'cancelled'],
    shipped:   ['delivered', 'cancelled'],
    delivered: [],
    cancelled: [],
  },
};

interface OpFull {
  id: string;
  status: string;
  operation_type: string;
  warehouse_from_id: string | null;
  warehouse_to_id: string | null;
}

interface StockRow {
  id: string;
  on_hand: number;
}

async function getOrCreateStock(
  db: D1Database,
  warehouseId: string,
  productId: string,
  now: number
): Promise<StockRow> {
  const existing = await db.prepare(
    'SELECT id, on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ?'
  ).bind(warehouseId, productId).first<StockRow>();

  if (existing) return existing;

  // Create zero-balance stock row on first touch
  const newId = `stk_${crypto.randomUUID()}`;
  await db.prepare(
    'INSERT INTO stocks (id, warehouse_id, product_id, on_hand, updated_at) VALUES (?, ?, ?, 0, ?)'
  ).bind(newId, warehouseId, productId, now).run();

  return { id: newId, on_hand: 0 };
}

operations.patch('/:id/status', async (c) => {
  const opId = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = updateStatusSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const targetStatus = parsed.data.status;

  // Load full operation row
  const op = await c.env.DB.prepare(
    `SELECT id, status, operation_type, warehouse_from_id, warehouse_to_id
     FROM operations WHERE id = ? AND deleted_at IS NULL`
  ).bind(opId).first<OpFull>();

  if (!op) {
    return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${opId} not found` }]);
  }

  // Guard: check allowed transition (branched by operation_type)
  const transitionsForType = ALLOWED_TRANSITIONS_BY_TYPE[op.operation_type] ?? {};
  const allowed = transitionsForType[op.status] ?? [];
  if (!allowed.includes(targetStatus)) {
    return fail(c, 422, [{
      code: 'invalid_transition',
      message: `Cannot move ${op.operation_type} from '${op.status}' to '${targetStatus}'`,
      details: { operation_type: op.operation_type, current: op.status, target: targetStatus, allowed },
    }]);
  }

  // Load line items (needed for stock movements)
  const lineItemsResult = await c.env.DB.prepare(
    'SELECT product_id, qty FROM line_items WHERE operation_id = ?'
  ).bind(opId).all<{ product_id: string; qty: number }>();

  const lineItems = lineItemsResult.results;
  const now = Math.floor(Date.now() / 1000);
  const warnings: string[] = [];

  // Build batch statements
  const stmts: D1PreparedStatement[] = [];

  // 1. Update operation status
  stmts.push(
    c.env.DB.prepare('UPDATE operations SET status = ?, updated_at = ? WHERE id = ?')
      .bind(targetStatus, now, opId)
  );

  // 2. Determine stock movements to write
  type MovementSpec = {
    warehouseId: string;
    productId: string;
    movementType: string;
    qty: number; // signed
    reason: string;
  };

  const movementSpecs: MovementSpec[] = [];

  const opType = op.operation_type;

  if (targetStatus === 'stocked') {
    // PURCHASE only: factory finished production, goods now at factory warehouse
    if (opType === 'purchase' && op.warehouse_from_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: 'production_complete',
          qty: +li.qty,
          reason: 'purchase_stocked_at_factory',
        });
      }
    }

  } else if (targetStatus === 'shipped') {
    // sale or transfer: goods leave warehouse_from
    if ((opType === 'sale' || opType === 'transfer') && op.warehouse_from_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: opType === 'sale' ? 'shipment' : 'transfer_out',
          qty: -li.qty,
          reason: opType === 'sale' ? 'sale_shipped' : 'transfer_shipped',
        });
      }
    }
    // purchase at shipped: goods leave factory warehouse (was added at stocked)
    if (opType === 'purchase' && op.warehouse_from_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: 'shipment',
          qty: -li.qty,
          reason: 'purchase_shipped_from_factory',
        });
      }
    }

  } else if (targetStatus === 'delivered') {
    // transfer or purchase: goods arrive at warehouse_to
    if ((opType === 'transfer' || opType === 'purchase') && op.warehouse_to_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_to_id,
          productId: li.product_id,
          movementType: opType === 'transfer' ? 'transfer_in' : 'receipt',
          qty: +li.qty,
          reason: opType === 'transfer' ? 'transfer_delivered' : 'purchase_received',
        });
      }
    }

  } else if (targetStatus === 'cancelled') {
    // Reverse if we already shipped
    if (op.status === 'shipped') {
      if ((opType === 'sale' || opType === 'transfer') && op.warehouse_from_id) {
        for (const li of lineItems) {
          movementSpecs.push({
            warehouseId: op.warehouse_from_id,
            productId: li.product_id,
            movementType: 'return',
            qty: +li.qty, // reverse the shipment
            reason: 'cancelled_after_shipped',
          });
        }
      }
    }
    // If cancelled before shipping: no movements needed
  }

  // 3. For each movement spec: compute balance_after, add movement insert + stock update
  for (const spec of movementSpecs) {
    let stock: StockRow;
    try {
      stock = await getOrCreateStock(c.env.DB, spec.warehouseId, spec.productId, now);
    } catch {
      warnings.push(`stock_row_error: could not access stock for ${spec.productId} @ ${spec.warehouseId}`);
      continue;
    }

    const balanceAfter = stock.on_hand + spec.qty;
    if (balanceAfter < 0) {
      warnings.push(`negative_stock: ${spec.productId} @ ${spec.warehouseId} would go to ${balanceAfter} — movement written anyway`);
    }

    const movId = `mov_${crypto.randomUUID()}`;

    stmts.push(
      c.env.DB.prepare(`
        INSERT INTO stock_movements
          (id, warehouse_id, product_id, movement_type, quantity, source,
           source_ref_type, source_ref_id, reason, notes, performed_by,
           performed_at, balance_after, created_at)
        VALUES (?, ?, ?, ?, ?, 'operation', 'operation', ?, ?, ?, 'system', ?, ?, ?)
      `).bind(
        movId, spec.warehouseId, spec.productId, spec.movementType,
        spec.qty, opId, spec.reason,
        parsed.data.notes ?? null, now, balanceAfter, now
      )
    );

    stmts.push(
      c.env.DB.prepare(
        'UPDATE stocks SET on_hand = ?, last_movement_at = ?, updated_at = ? WHERE warehouse_id = ? AND product_id = ?'
      ).bind(balanceAfter, now, now, spec.warehouseId, spec.productId)
    );

    // Optimistically update local cache so next iteration in same batch sees correct balance
    stock.on_hand = balanceAfter;
  }

  // 4. Execute atomically
  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    return fail(c, 500, [{
      code: 'update_failed',
      message: 'Failed to update operation status',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    id: opId,
    previous_status: op.status,
    status: targetStatus,
    movements_written: movementSpecs.length,
    updated_at: now,
    warnings,
  }, [`Status: ${op.status} → ${targetStatus}`, `${movementSpecs.length} stock movement(s) written`]);
});

export default operations;
