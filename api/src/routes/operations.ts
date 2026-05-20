import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueOperationReference } from '../lib/operation-reference';
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

function derivePaymentState(
  total: number,
  paid: number,
  status: string,
  partnerId?: string | null,
  reference?: string | null,
): PaymentState {
  if (status === 'draft' || status === 'cancelled') return 'neutral';
  if (paid <= 0) return 'unpaid';

  // Marketplace settlement reports (WB-WEEKLY, OZN-MONTHLY) — once a payment
  // matches, the report is considered fully paid even if the bank amount
  // differs from the NET (small reserves/returns adjustments are normal).
  // No partial-paid (brown) state for these.
  const isMarketplaceSettlement =
    (partnerId === 'wb' || partnerId === 'ozon') &&
    (reference?.includes('-WEEKLY') || reference?.includes('-MONTHLY'));
  if (isMarketplaceSettlement) return 'paid';

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

  line_items: z.array(lineItemSchema),

  // Operation track (added by migration 0034). Service operations don't have
  // line items or warehouses — they bill a service, not a shipment.
  operation_track: z.enum(['goods', 'service']).optional().default('goods'),
  service_description: z.string().max(500).optional(),

  // Invoicer routing flags (added by 0009_invoicer_roles_and_routes.sql).
  // dei_layer = 1 means a sale to Russia routes Factory→DEI→DEE and the
  // invoicer emits CI+PL (Factory→DEI) plus an IS (DEI→buyer) at issue
  // time. legal_seller_id overrides the products-derived legal seller for
  // operations where multiple manufacturers ship under one invoice.
  dei_layer: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional().default(0),
  legal_seller_id: z.string().nullable().optional(),
  gtd_number: z.string().nullable().optional(),
})
  // SALE: must supply contract_id (carries partner + company + currency)
  .refine(
    (data) => data.operation_type !== 'sale' || !!data.contract_id,
    { message: 'contract_id required for sale operations' }
  )
  // PURCHASE: must supply manufacturer_id + our_company_id + currency
  // EXCEPT for service-track purchases (auditors, logistics, agencies) —
  // these have no manufacturer, only a service provider (partner).
  .refine(
    (data) => {
      if (data.operation_type !== 'purchase') return true;
      if (data.operation_track === 'service') {
        // Service purchase: need our_company_id + currency only.
        return !!data.our_company_id && !!data.currency;
      }
      return !!data.manufacturer_id && !!data.our_company_id && !!data.currency;
    },
    { message: 'goods purchase: manufacturer_id+our_company_id+currency required; service purchase: our_company_id+currency required' }
  )
  // PURCHASE goods: gtd_number is mandatory (customs declaration always exists
  // for legal imports). Services don't have GTD.
  .refine(
    (data) => {
      if (data.operation_type !== 'purchase') return true;
      if (data.operation_track === 'service') return true;
      return !!(data.gtd_number && data.gtd_number.trim());
    },
    { message: 'gtd_number is required for goods purchases', path: ['gtd_number'] }
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
      // Service operations have no warehouse — they consume a service, not goods.
      if (data.operation_track === 'service') return true;
      if (data.operation_type === 'purchase' || data.operation_type === 'transfer') {
        return !!data.warehouse_to_id;
      }
      return true;
    },
    { message: 'warehouse_to_id required for goods purchase and transfer operations' }
  )
  // Service operations must have a partner (the service provider).
  // The partner_id flows in via contract_id (sale) or — for service purchases —
  // must be supplied directly in a future PR. For now, service ops are
  // created via the sale path with a service-provider contract, OR via
  // purchase with manufacturer_id pointing to a stub. The UI handles this.
  ;

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
      'SELECT id FROM manufacturers WHERE id = ? AND deleted_at IS NULL'
    ).bind(data.manufacturer_id!).first<{ id: string }>();

    if (!manufacturer) {
      return fail(c, 404, [{
        code: 'manufacturer_not_found',
        message: `manufacturer_id ${data.manufacturer_id} does not exist or is deactivated`,
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

    // Auto-link partner: if a manufacturer-kind partner exists with the same id,
    // attach it. Without this, purchase ops have partner_id=NULL even though the
    // factory exists as a partner in the system — breaks the Partner column UI
    // (no link) and excludes the op from partner-hub views. Body partner_id wins
    // if explicitly provided.
    if (data.partner_id) {
      resolvedPartnerId = data.partner_id;
    } else {
      const mfrPartner = await c.env.DB.prepare(
        "SELECT id FROM partners WHERE id = ? AND kind = 'manufacturer' AND deleted_at IS NULL"
      ).bind(resolvedManufacturerId).first<{ id: string }>();
      if (mfrPartner) resolvedPartnerId = mfrPartner.id;
    }

  // No route-resolution here — it's done below, just before INSERT,
  // because it depends on dei_layer which is parsed later.

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
  // Step 6: Issue operation reference (format: ENTITY-YYMMDDXX)
  // XX is the daily counter within (entity, operation_date) bucket.
  // ---------------------------------------------------------------------------
  const refResult = await issueOperationReference(
    c.env.DB,
    resolvedCompanyId,
    data.operation_date
  );
  if (!refResult) {
    return fail(c, 500, [{
      code: 'reference_failed',
      message: `No entity mapping for company ${resolvedCompanyId}`,
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

  // ---------------------------------------------------------------------------
  // Route resolution — for purchase ops, determine which partner issues the
  // invoice and which of their bank accounts receives payment. Snapshot at
  // create time, stored on the operation row so invoicer skill can pull these
  // directly without re-resolving.
  // ---------------------------------------------------------------------------
  let issuingPartnerId: string | null = null;
  let issuingBankAccountId: string | null = null;

  if (data.operation_type === 'purchase' && resolvedManufacturerId) {
    // Determine if this is DEE-direct route (no DEI layer)
    const isDirect = resolvedCompanyId === 'dee' && deiLayerInt === 0;
    const accountSearchTag = isDirect ? 'dee' : resolvedCompanyId;

    // Lookup manufacturer's group to decide issuer
    const mfr = await c.env.DB.prepare(
      'SELECT id, group_id FROM manufacturers WHERE id = ?'
    ).bind(resolvedManufacturerId).first<{ id: string; group_id: string | null }>();

    if (mfr) {
      if (mfr.group_id === 'honghui_group') {
        issuingPartnerId = isDirect ? 'honghui' : 'wdaa';
      } else if (mfr.group_id === 'jinxia_group') {
        issuingPartnerId = 'jinxia';
      } else {
        issuingPartnerId = resolvedManufacturerId;
      }

      // Find best matching bank account
      const accts = await c.env.DB.prepare(`
        SELECT id, routing_buyer_entities, is_default
        FROM partner_bank_accounts
        WHERE partner_id = ? AND deleted_at IS NULL
        ORDER BY is_default DESC
      `).bind(issuingPartnerId).all<{
        id: string; routing_buyer_entities: string | null; is_default: number;
      }>();

      let chosen = accts.results.find((a) => {
        if (!a.routing_buyer_entities) return false;
        const tags = a.routing_buyer_entities.split(',').map((s) => s.trim().toLowerCase());
        return tags.includes(accountSearchTag!);
      });
      if (!chosen) {
        chosen = accts.results.find((a) => a.is_default === 1) ?? accts.results[0];
      }
      if (chosen) issuingBankAccountId = chosen.id;
    }
  }

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
      operation_track, gtd_number,
      issuing_partner_id, issuing_bank_account_id,
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
      ?, ?,
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
    refResult.reference,
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
    data.operation_track ?? 'goods',
    data.gtd_number ?? null,
    issuingPartnerId,
    issuingBankAccountId,
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
      reference: refResult.reference,
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
  const includeCancelled = c.req.query('include_cancelled') === '1';
  // ?q=... — case-insensitive search across reference, partner.trade_name,
  // and notes. Used by the attach-to-operation modal in /inbox.
  const searchQ = c.req.query('q')?.trim();
  // ?limit=N — cap result count. Default unlimited (back-compat).
  const limit = parseInt(c.req.query('limit') ?? '0', 10);
  // ?compact=1 — return only fields consumed by list/table views
  // (no notes, manufacturer_*, warehouse_*, vat_rate, total_usd_equiv, *_at).
  // Cuts payload by ~80% (277 KB → ~50 KB for 335 operations).
  const compact = c.req.query('compact') === '1';

  const columns = compact
    ? `o.id, ct.contract_no, o.partner_id, p.trade_name as partner_trade_name, p.kind as partner_kind,
       o.manufacturer_id, mfr.name as manufacturer_name,
       o.our_company_id, co.abbreviation as entity_abbreviation,
       o.operation_type, o.operation_track, o.operation_date,
       o.currency, o.total_amount,
       o.status, o.reference, o.delivery_status`
    : `o.id, o.contract_id, ct.contract_no,
       o.partner_id, p.trade_name as partner_trade_name, p.kind as partner_kind,
       o.manufacturer_id, mfr.name as manufacturer_name,
       o.our_company_id, co.abbreviation as entity_abbreviation,
       o.operation_type, o.operation_track, o.operation_date,
       o.warehouse_from_id, o.warehouse_to_id,
       o.currency, o.total_amount, o.total_usd_equiv,
       o.status, o.reference, o.notes, o.vat_rate,
       o.delivery_status, o.gtd_number,
       o.created_at, o.updated_at`;

  const fromJoin = compact
    ? `FROM operations o
       LEFT JOIN contracts ct ON o.contract_id = ct.id
       LEFT JOIN partners p ON o.partner_id = p.id
       LEFT JOIN manufacturers mfr ON o.manufacturer_id = mfr.id
       LEFT JOIN companies co ON o.our_company_id = co.id`
    : `FROM operations o
       LEFT JOIN contracts ct ON o.contract_id = ct.id
       LEFT JOIN partners p ON o.partner_id = p.id
       LEFT JOIN manufacturers mfr ON o.manufacturer_id = mfr.id
       LEFT JOIN companies co ON o.our_company_id = co.id`;

  let sql = `
    SELECT
      ${columns},
      COALESCE((
        SELECT SUM(pay.amount)
        FROM payments pay
        WHERE pay.operation_id = o.id
          AND pay.currency = o.currency
          AND pay.deleted_at IS NULL
      ), 0) AS paid_amount
    ${fromJoin}
    WHERE o.deleted_at IS NULL
      AND (o.batch_id IS NULL)
  `;
  const binds: unknown[] = [];

  if (partnerId) { sql += ` AND o.partner_id = ?`; binds.push(partnerId); }
  if (contractId) { sql += ` AND o.contract_id = ?`; binds.push(contractId); }
  if (opType) { sql += ` AND o.operation_type = ?`; binds.push(opType); }
  if (status) {
    sql += ` AND o.status = ?`;
    binds.push(status);
  } else if (!includeCancelled) {
    // Exclude cancelled by default — caller can opt in via include_cancelled=1
    sql += ` AND o.status != 'cancelled'`;
  }
  if (searchQ) {
    // Case-insensitive substring match across reference, partner name, notes.
    sql += ` AND (
      LOWER(COALESCE(o.reference,'')) LIKE ?
      OR LOWER(COALESCE(p.trade_name,'')) LIKE ?
      OR LOWER(COALESCE(o.notes,'')) LIKE ?
    )`;
    const pattern = `%${searchQ.toLowerCase()}%`;
    binds.push(pattern, pattern, pattern);
  }

  sql += ` ORDER BY o.created_at DESC, o.operation_date DESC`;
  if (limit > 0 && limit <= 500) {
    sql += ` LIMIT ${limit}`;
  }

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  const decorated = (result.results as Array<Record<string, unknown>>).map((row) => {
    const total = Number(row.total_amount) || 0;
    const paid = Number(row.paid_amount) || 0;
    return {
      ...row,
      payment_state: derivePaymentState(total, paid, String(row.status), row.partner_id as string | null, row.reference as string | null),
    };
  });

  // ── Operation batches (migration 0039) ────────────────────────────────
  // F4-WH-R individual operations are grouped under a parent batch per
  // (date, marketplace). The batch is shown in the list as one synthetic
  // row with operation_type='transfer_batch'. Children are hidden above
  // via `AND o.batch_id IS NULL`. Skip this when filtering by partner,
  // contract, opType (other than 'transfer' or none), or status — batches
  // don't carry those attributes.
  let batchRows: Array<Record<string, unknown>> = [];
  const showBatches =
    !partnerId &&
    !contractId &&
    (!opType || opType === 'transfer' || opType === 'transfer_batch') &&
    (!status || status === 'delivered' || status === 'issued');

  if (showBatches) {
    let batchSql = `
      SELECT
        b.id,
        b.batch_reference as reference,
        b.batch_date as operation_date,
        b.marketplace,
        b.our_company_id,
        co.abbreviation as entity_abbreviation,
        b.notes,
        b.created_at,
        b.updated_at,
        (SELECT COUNT(*) FROM operations o
           WHERE o.batch_id = b.id AND o.deleted_at IS NULL) as cluster_count,
        (SELECT COUNT(*) FROM operations o
           WHERE o.batch_id = b.id AND o.deleted_at IS NULL
             AND o.status = 'delivered') as delivered_count,
        (SELECT COALESCE(SUM(li.qty), 0)
           FROM line_items li
           JOIN operations o ON li.operation_id = o.id
           WHERE o.batch_id = b.id AND o.deleted_at IS NULL) as total_units
      FROM operation_batches b
      LEFT JOIN companies co ON b.our_company_id = co.id
      WHERE b.deleted_at IS NULL
    `;
    const batchBinds: unknown[] = [];
    if (searchQ) {
      batchSql += ` AND LOWER(b.batch_reference) LIKE ?`;
      batchBinds.push(`%${searchQ.toLowerCase()}%`);
    }
    batchSql += ` ORDER BY b.batch_date DESC, b.created_at DESC`;
    const bStmt = c.env.DB.prepare(batchSql);
    const bRes = batchBinds.length > 0
      ? await bStmt.bind(...batchBinds).all()
      : await bStmt.all();
    batchRows = (bRes.results as Array<Record<string, unknown>>).map((row) => {
      const cluster = Number(row.cluster_count) || 0;
      const delivered = Number(row.delivered_count) || 0;
      const batchAccepted = cluster > 0 && delivered === cluster;
      const mp = String(row.marketplace || '').toUpperCase();
      const partnerId = mp === 'OZN' ? 'ozon' : mp === 'WB' ? 'wb' : null;
      const partnerName = mp === 'OZN' ? 'Ozon' : mp === 'WB' ? 'Wildberries' : null;
      return {
        ...row,
        operation_type: 'transfer',
        operation_track: 'goods',
        status: batchAccepted ? 'delivered' : 'shipped',
        delivery_status: batchAccepted ? 'delivered' : 'pending',
        currency: 'RUB',
        total_amount: 0,
        total_usd_equiv: 0,
        partner_id: partnerId,
        partner_name: partnerName,
        partner_trade_name: partnerName,
        partner_kind: 'marketplace',
        manufacturer_id: null,
        manufacturer_name: null,
        paid_amount: 0,
        payment_state: 'neutral',
        is_batch: true,
        batch_accepted: batchAccepted,
        total_units: Number(row.total_units) || 0,
      };
    });
  }

  const merged = [...decorated, ...batchRows].sort((a, b) => {
    const ad = Number(a.operation_date) || 0;
    const bd = Number(b.operation_date) || 0;
    if (bd !== ad) return bd - ad;
    const ac = Number(a.created_at) || 0;
    const bc = Number(b.created_at) || 0;
    return bc - ac;
  });

  return ok(c, {
    count: merged.length,
    operations: merged,
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
      p.acceptance_required as partner_acceptance_required,
      mfr.name as manufacturer_name,
      co.abbreviation as entity_abbreviation,
      er.delivery_number as arrival_delivery_number,
      er.is_completed as arrival_request_completed,
      ip.trade_name as issuing_partner_name,
      ba.account_label as issuing_bank_label,
      ba.bank_name as issuing_bank_name,
      ba.account_number as issuing_account_number,
      ba.swift_bic as issuing_bank_swift,
      ba.cnaps_code as issuing_bank_cnaps,
      ba.iban as issuing_bank_iban,
      ba.currency as issuing_bank_currency,
      ba.bank_address as issuing_bank_address,
      ba.correspondent_bank_name as issuing_correspondent_bank,
      ba.correspondent_swift as issuing_correspondent_swift
    FROM operations o
    LEFT JOIN contracts ct ON o.contract_id = ct.id
    LEFT JOIN partners p ON o.partner_id = p.id
    LEFT JOIN manufacturers mfr ON o.manufacturer_id = mfr.id
    LEFT JOIN companies co ON o.our_company_id = co.id
    LEFT JOIN external_requests er ON o.arrival_source_request_id = er.id
    LEFT JOIN partners ip ON o.issuing_partner_id = ip.id
    LEFT JOIN partner_bank_accounts ba ON o.issuing_bank_account_id = ba.id
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

  // Service-track signal: which inbound documents are attached.
  // operation_attachments.kind values are free-text — the canonical pair we
  // look for is 'acceptance' (ACP, акт выполненных работ) and 'invoice'
  // (INV, счёт на оплату). Used by ServiceStatusBar to light up the three
  // status chips (Service provided / Documents issued / Payment).
  const attachmentCounts = await c.env.DB.prepare(`
    SELECT
      SUM(CASE WHEN kind = 'acceptance' THEN 1 ELSE 0 END) AS acceptance_n,
      SUM(CASE WHEN kind = 'invoice'    THEN 1 ELSE 0 END) AS invoice_n
    FROM operation_attachments
    WHERE operation_id = ?
      AND deleted_at IS NULL
  `).bind(opId).first<{ acceptance_n: number; invoice_n: number }>();

  const hasAcceptance = Number(attachmentCounts?.acceptance_n ?? 0) > 0;
  const hasInvoice    = Number(attachmentCounts?.invoice_n ?? 0) > 0;

  return ok(c, {
    operation: {
      ...op,
      paid_amount: paid,
      payment_state: derivePaymentState(total, paid, String(op.status), op.partner_id as string | null, op.reference as string | null),
      // Service-track chip signals (read by ServiceStatusBar)
      has_acceptance_attachment: hasAcceptance,
      has_invoice_attachment: hasInvoice,
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
// PURCHASE: draft → issued → production → shipped → delivered (+cancel)
// TRANSFER: draft → issued → shipped → delivered (+cancel)
//
// PURCHASE LIFECYCLE (per Aram 2026-05-11):
//   production → +qty appears at factory warehouse with stock_state='in_production'
//                (rendered green "+15" on factory cell in /warehouses)
//   shipped    → -qty leaves factory in_production, +qty appears at otw
//                with stock_state='in_transit' (rendered yellow OTW column)
//   delivered  → -qty leaves otw, +qty arrives at warehouse_to with
//                stock_state='on_hand' (plain black number).
//                Automatic — triggered by destination warehouse API confirmation,
//                not a manual button. Manual PATCH is allowed for backfill / fixup.
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
    issued:     ['production', 'shipped', 'cancelled'],  // skip allowed
    production: ['shipped', 'cancelled'],
    shipped:    ['delivered', 'cancelled'],
    delivered:  [],
    cancelled:  [],
    // Legacy 'stocked' kept as a non-target for backward compat with old rows.
    // No incoming transition can land on 'stocked' anymore.
    stocked:    ['shipped', 'cancelled'],
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
    "SELECT id, on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ? AND stock_state = 'on_hand'"
  ).bind(warehouseId, productId).first<StockRow>();

  if (existing) return existing;

  // Create zero-balance stock row on first touch
  const newId = `stk_${crypto.randomUUID()}`;
  await db.prepare(
    "INSERT INTO stocks (id, warehouse_id, product_id, stock_state, on_hand, updated_at) VALUES (?, ?, ?, 'on_hand', 0, ?)"
  ).bind(newId, warehouseId, productId, now).run();

  return { id: newId, on_hand: 0 };
}

// Stock with explicit state — used by the purchase lifecycle to track
// in_production (reserved at factory) and in_transit (in OTW) quantities
// separately from physical on_hand stock.
async function getOrCreateStockWithState(
  db: D1Database,
  warehouseId: string,
  productId: string,
  stockState: 'on_hand' | 'in_production' | 'in_transit',
  now: number
): Promise<StockRow> {
  const existing = await db.prepare(
    'SELECT id, on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ? AND stock_state = ?'
  ).bind(warehouseId, productId, stockState).first<StockRow>();

  if (existing) return existing;

  const newId = `stk_${crypto.randomUUID()}`;
  await db.prepare(
    'INSERT INTO stocks (id, warehouse_id, product_id, stock_state, on_hand, updated_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).bind(newId, warehouseId, productId, stockState, now).run();

  return { id: newId, on_hand: 0 };
}

const OTW_WAREHOUSE_ID = 'otw';

operations.patch('/:id/delivery-status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const schema = z.object({
    delivery_status: z.enum(['pending', 'delivered', 'disputed', 'refunded']),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, parsed.error.errors.map((e) => ({
      code: 'validation', message: e.message, path: e.path.join('.'),
    })));
  }
  const existing = await c.env.DB.prepare(
    'SELECT id FROM operations WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();
  if (!existing) {
    return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${id} not found` }]);
  }
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    'UPDATE operations SET delivery_status = ?, updated_at = ? WHERE id = ?'
  ).bind(parsed.data.delivery_status, now, id).run();
  return ok(c, { id, delivery_status: parsed.data.delivery_status, updated_at: now });
});

// PATCH /:id/gtd — set or update the customs declaration number on a purchase.
// Goods purchases require a non-empty GTD; sales/transfers/services don't have
// one. Sending empty string or null clears the field (only allowed on
// non-goods-purchase operations).
operations.patch('/:id/gtd', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const schema = z.object({
    gtd_number: z.string().nullable(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, parsed.error.errors.map((e) => ({
      code: 'validation', message: e.message, path: e.path.join('.'),
    })));
  }
  const op = await c.env.DB.prepare(
    'SELECT id, operation_type, operation_track FROM operations WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first<{ id: string; operation_type: string; operation_track: string | null }>();
  if (!op) {
    return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${id} not found` }]);
  }

  const newValue = parsed.data.gtd_number?.trim() || null;
  const isGoodsPurchase = op.operation_type === 'purchase' && op.operation_track !== 'service';
  if (isGoodsPurchase && !newValue) {
    return fail(c, 400, [{
      code: 'gtd_required',
      message: 'GTD number cannot be empty on goods purchases',
      path: 'gtd_number',
    }]);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    'UPDATE operations SET gtd_number = ?, updated_at = ? WHERE id = ?'
  ).bind(newValue, now, id).run();
  return ok(c, { id, gtd_number: newValue, updated_at: now });
});

// POST /:id/gtd/upload — upload a GTD PDF for an operation. The same payload
// can also update the gtd_number text field in one request (recommended). PDF
// is stored in R2 at documents/<year>/GTD/<sanitized-number>.pdf and a
// documents row is created/replaced linking it to the operation.
//
// Multipart form fields:
//   file        — required, PDF binary
//   gtd_number  — optional, if provided also updates operations.gtd_number
operations.post('/:id/gtd/upload', async (c) => {
  const id = c.req.param('id');
  const op = await c.env.DB.prepare(
    `SELECT id, operation_type, operation_track, gtd_number, our_company_id,
            partner_id, total_amount, currency
     FROM operations WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first<{
    id: string;
    operation_type: string;
    operation_track: string | null;
    gtd_number: string | null;
    our_company_id: string | null;
    partner_id: string | null;
    total_amount: number | null;
    currency: string | null;
  }>();
  if (!op) {
    return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${id} not found` }]);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, 400, [{ code: 'invalid_multipart', message: 'Expected multipart/form-data' }]);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return fail(c, 400, [{ code: 'file_required', message: 'PDF file is required (field name: file)', path: 'file' }]);
  }
  if (file.size === 0) {
    return fail(c, 400, [{ code: 'empty_file', message: 'Uploaded file is empty', path: 'file' }]);
  }
  if (file.size > 10 * 1024 * 1024) {
    return fail(c, 400, [{ code: 'file_too_large', message: 'PDF must be under 10 MB', path: 'file' }]);
  }

  const providedNumber = form.get('gtd_number');
  const newNumberRaw = typeof providedNumber === 'string' ? providedNumber.trim() : '';
  const isGoodsPurchase = op.operation_type === 'purchase' && op.operation_track !== 'service';
  const finalNumber = newNumberRaw || op.gtd_number || null;

  if (isGoodsPurchase && !finalNumber) {
    return fail(c, 400, [{
      code: 'gtd_required',
      message: 'GTD number required (either provide gtd_number form field or operation must already have one)',
      path: 'gtd_number',
    }]);
  }
  if (!finalNumber) {
    return fail(c, 400, [{
      code: 'gtd_required',
      message: 'GTD number required',
      path: 'gtd_number',
    }]);
  }

  // Sanitize number for R2 path: keep digits and dashes, replace slashes
  const safeKey = finalNumber.replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  const year = new Date().getUTCFullYear();
  const r2Key = `documents/${year}/GTD/${safeKey}.pdf`;

  // Upload PDF to R2
  const fileBuffer = await file.arrayBuffer();
  try {
    await c.env.DOCS.put(r2Key, fileBuffer, {
      httpMetadata: { contentType: 'application/pdf' },
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'r2_upload_failed',
      message: err instanceof Error ? err.message : 'Failed to upload to R2',
    }]);
  }

  const now = Math.floor(Date.now() / 1000);

  // Check if a GTD document already exists for this operation — replace if so
  const existingDoc = await c.env.DB.prepare(
    `SELECT id FROM documents
     WHERE operation_id = ? AND document_type = 'GTD'
       AND deleted_at IS NULL
     LIMIT 1`
  ).bind(id).first<{ id: string }>();

  const metadata = JSON.stringify({
    kind: 'GTD',
    customs_declaration_no: finalNumber,
    uploaded_at: new Date().toISOString(),
    file_size: file.size,
  });

  if (existingDoc) {
    await c.env.DB.prepare(
      `UPDATE documents SET
         document_number = ?, document_date = ?, pdf_r2_url = ?,
         metadata = ?, updated_at = ?
       WHERE id = ?`
    ).bind(finalNumber, now, r2Key, metadata, now, existingDoc.id).run();
  } else {
    const docId = `doc_${crypto.randomUUID()}`;
    // total_amount in documents is stored as decimal (same scale as
    // operations.total_amount) — NOT minor units. Past pattern was wrong.
    const totalAmountDecimal = op.total_amount ?? null;
    await c.env.DB.prepare(
      `INSERT INTO documents (
         id, document_number, document_type, operation_id, issuer_id, partner_id,
         contract_ref, document_date, currency, total_amount, pdf_r2_url,
         mandatory_level, status, metadata, created_at, updated_at
       ) VALUES (?, ?, 'GTD', ?, ?, ?,
         NULL, ?, ?, ?, ?,
         'mandatory', 'issued', ?, ?, ?)`
    ).bind(
      docId, finalNumber, id, op.our_company_id, op.partner_id,
      now, op.currency, totalAmountDecimal, r2Key,
      metadata, now, now
    ).run();
  }

  // Sync gtd_number on operation if changed
  if (finalNumber !== op.gtd_number) {
    await c.env.DB.prepare(
      'UPDATE operations SET gtd_number = ?, updated_at = ? WHERE id = ?'
    ).bind(finalNumber, now, id).run();
  }

  return ok(c, {
    id,
    gtd_number: finalNumber,
    pdf_r2_key: r2Key,
    file_size: file.size,
    replaced: !!existingDoc,
  });
});

// GET /:id/gtd/download — download the GTD PDF for an operation. Returns the
// raw PDF stream with content-disposition for inline viewing in the browser.
operations.get('/:id/gtd/download', async (c) => {
  const id = c.req.param('id');
  const doc = await c.env.DB.prepare(
    `SELECT document_number, pdf_r2_url FROM documents
     WHERE operation_id = ? AND document_type = 'GTD'
       AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).bind(id).first<{ document_number: string; pdf_r2_url: string }>();
  if (!doc || !doc.pdf_r2_url) {
    return fail(c, 404, [{ code: 'gtd_pdf_not_found', message: 'No GTD PDF attached to this operation' }]);
  }

  const obj = await c.env.DOCS.get(doc.pdf_r2_url);
  if (!obj) {
    return fail(c, 404, [{ code: 'r2_object_missing', message: 'GTD PDF record exists but file not found in storage' }]);
  }

  const safeFilename = doc.document_number.replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '') + '.pdf';
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="GTD-${safeFilename}"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
});

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
    stockState: 'on_hand' | 'in_production' | 'in_transit';
  };

  const movementSpecs: MovementSpec[] = [];

  const opType = op.operation_type;

  if (targetStatus === 'production') {
    // PURCHASE only: factory started production.
    // +qty appears at factory warehouse with stock_state='in_production'.
    // No movement out of any on_hand stock — this is fresh new inventory
    // being created at the factory.
    if (opType === 'purchase' && op.warehouse_from_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: 'production_reserve',
          qty: +li.qty,
          reason: 'purchase_in_production_at_factory',
          stockState: 'in_production',
        });
      }
    }

  } else if (targetStatus === 'order_fulfilment') {
    // SALE only: Boxing — goods get reserved for the buyer.
    // -qty appears at warehouse_from with stock_state='in_production'.
    // This is a NEGATIVE reservation that mirrors purchase 'production': both
    // sit in the in_production state, sign of qty distinguishes incoming (+)
    // from outgoing (-). on_hand is left untouched at this stage; the actual
    // on_hand deduction happens when status moves to 'shipped' (see below).
    if (opType === 'sale' && op.warehouse_from_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: 'order_fulfilment_reserve',
          qty: -li.qty,
          reason: 'sale_boxing_reserved',
          stockState: 'in_production',
        });
      }
    }

  } else if (targetStatus === 'stocked') {
    // LEGACY: kept only for old purchase rows that already used this state.
    // New purchases skip directly production → shipped.
    if (opType === 'purchase' && op.warehouse_from_id) {
      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: 'receipt',
          qty: +li.qty,
          reason: 'purchase_stocked_at_factory_legacy',
          stockState: 'on_hand',
        });
      }
    }

  } else if (targetStatus === 'shipped') {
    // sale or transfer: goods leave warehouse_from on_hand
    if ((opType === 'sale' || opType === 'transfer') && op.warehouse_from_id) {
      // If sale came via Boxing (order_fulfilment), first release the
      // -qty reservation that's parked in in_production. Otherwise the
      // shipment double-counts the deduction (reserved + on_hand both go
      // negative). Skip case is fine — direct issued → shipped just goes
      // straight to on_hand without an intermediate release.
      if (opType === 'sale' && op.status === 'order_fulfilment') {
        for (const li of lineItems) {
          movementSpecs.push({
            warehouseId: op.warehouse_from_id,
            productId: li.product_id,
            movementType: 'order_fulfilment_release',
            qty: +li.qty, // +N zeroes out the -N reservation
            reason: 'sale_boxing_released',
            stockState: 'in_production',
          });
        }
      }

      for (const li of lineItems) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: opType === 'sale' ? 'shipment' : 'transfer_out',
          qty: -li.qty,
          reason: opType === 'sale' ? 'sale_shipped' : 'transfer_shipped',
          stockState: 'on_hand',
        });
      }
      // For transfer: goods also go INTO OTW until delivered confirms arrival
      if (opType === 'transfer') {
        for (const li of lineItems) {
          movementSpecs.push({
            warehouseId: OTW_WAREHOUSE_ID,
            productId: li.product_id,
            movementType: 'in_transit_in',
            qty: +li.qty,
            reason: 'transfer_in_transit',
            stockState: 'in_transit',
          });
        }
      }
    }
    // PURCHASE at shipped:
    //   1. -qty leaves factory in_production reservation
    //   2. +qty arrives at otw with state in_transit
    // (Phantom on_hand at warehouse_from cleared by the universal pass below.)
    if (opType === 'purchase' && op.warehouse_from_id) {
      for (const li of lineItems) {
        // Release the in_production reservation at the factory
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: li.product_id,
          movementType: 'production_release',
          qty: -li.qty,
          reason: 'purchase_left_factory',
          stockState: 'in_production',
        });
        // Place into OTW
        movementSpecs.push({
          warehouseId: OTW_WAREHOUSE_ID,
          productId: li.product_id,
          movementType: 'in_transit_in',
          qty: +li.qty,
          reason: 'purchase_in_transit',
          stockState: 'in_transit',
        });
      }
    }

  } else if (targetStatus === 'delivered') {
    // transfer or purchase: goods leave OTW, arrive at warehouse_to as on_hand
    if ((opType === 'transfer' || opType === 'purchase') && op.warehouse_to_id) {
      for (const li of lineItems) {
        // Remove from OTW
        movementSpecs.push({
          warehouseId: OTW_WAREHOUSE_ID,
          productId: li.product_id,
          movementType: 'in_transit_out',
          qty: -li.qty,
          reason: opType === 'transfer' ? 'transfer_delivered' : 'purchase_delivered',
          stockState: 'in_transit',
        });
        // Land on destination warehouse as on_hand
        movementSpecs.push({
          warehouseId: op.warehouse_to_id,
          productId: li.product_id,
          movementType: opType === 'transfer' ? 'transfer_in' : 'arrival',
          qty: +li.qty,
          reason: opType === 'transfer' ? 'transfer_arrived' : 'purchase_received',
          stockState: 'on_hand',
        });
      }
    }

  } else if (targetStatus === 'cancelled') {
    // Universal reversal: undo every stock_movement this operation has produced,
    // regardless of which status path created them. Without this, cancellations
    // from non-'shipped' states (e.g. operations that wrote movements via 'stocked',
    // 'order_fulfilment', or 'delivered') leave permanent ghost balances.
    //
    // We look up the actual movements rather than re-deriving them from line items,
    // because line items may have been edited since the movements were written.
    const existingMovements = await c.env.DB.prepare(`
      SELECT id, warehouse_id, product_id, movement_type, quantity, stock_state
      FROM stock_movements
      WHERE source_ref_id = ? AND source_ref_type = 'operation'
        AND movement_type != 'return'
        AND NOT EXISTS (
          SELECT 1 FROM stock_movements rev
          WHERE rev.source_ref_id = stock_movements.source_ref_id
            AND rev.movement_type = 'return'
            AND rev.product_id = stock_movements.product_id
            AND rev.warehouse_id = stock_movements.warehouse_id
            AND rev.stock_state = stock_movements.stock_state
            AND rev.quantity = -stock_movements.quantity
        )
    `).bind(opId).all<{
      id: string;
      warehouse_id: string;
      product_id: string;
      movement_type: string;
      quantity: number;
      stock_state: 'on_hand' | 'in_production' | 'in_transit';
    }>();

    for (const mov of existingMovements.results || []) {
      movementSpecs.push({
        warehouseId: mov.warehouse_id,
        productId: mov.product_id,
        movementType: 'return',
        qty: -mov.quantity, // flip the sign to reverse
        reason: `cancelled_reversal_of_${mov.movement_type}`,
        stockState: mov.stock_state,
      });
    }

    // Mark all documents linked to this operation as cancelled (audit trail kept)
    stmts.push(
      c.env.DB.prepare(
        `UPDATE documents SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status != 'cancelled'`
      ).bind(now, opId)
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2.5 UNIVERSAL PHANTOM CLEAR — applies after type-specific logic above
  //
  // Purpose: keep stock state consistent with physical reality regardless of
  // how older data was imported (manual entry, migrations from legacy systems,
  // F4 sync writes that bypassed the lifecycle).
  //
  // Rules:
  //   SHIPPED — goods physically leave warehouse_from. Any on_hand phantom
  //             remaining at warehouse_from for these SKUs must be zeroed.
  //             Applies to: sale, purchase, transfer.
  //
  //   DELIVERED — goods physically arrived at warehouse_to. Any in_transit
  //               phantom in OTW for these SKUs that wasn't already accounted
  //               for in step 2 must be zeroed. Applies to: purchase, transfer.
  //               (Sale doesn't touch OTW so no in_transit phantom possible.)
  //
  // A "phantom" is non-zero stock that lingers in the wrong state. It's not
  // an error in itself — it's leftover historical data. Once a real movement
  // confirms the goods are elsewhere, that phantom must clear automatically.
  //
  // Skipped SKUs: those already at zero (no movement created — saves audit noise).
  // ──────────────────────────────────────────────────────────────────────
  if (targetStatus === 'shipped' && op.warehouse_from_id && lineItems.length > 0) {
    const skuList = lineItems.map((li) => li.product_id);
    const placeholders = skuList.map(() => '?').join(',');
    const phantomQuery = await c.env.DB.prepare(
      `SELECT product_id, on_hand FROM stocks
       WHERE warehouse_id = ? AND stock_state = 'on_hand'
         AND product_id IN (${placeholders}) AND on_hand > 0`
    ).bind(op.warehouse_from_id, ...skuList).all<{ product_id: string; on_hand: number }>();
    for (const phantom of phantomQuery.results || []) {
      // Skip if a real movement spec already drains this exact phantom — avoids
      // double-counting (e.g. sale 'shipment' already takes -qty from on_hand;
      // we only clear what's left over after that real deduction).
      const alreadyDeducted = movementSpecs
        .filter((m) =>
          m.warehouseId === op.warehouse_from_id &&
          m.productId === phantom.product_id &&
          m.stockState === 'on_hand'
        )
        .reduce((sum, m) => sum + m.qty, 0);
      const remaining = phantom.on_hand + alreadyDeducted;
      if (remaining > 0) {
        movementSpecs.push({
          warehouseId: op.warehouse_from_id,
          productId: phantom.product_id,
          movementType: 'phantom_clear',
          qty: -remaining,
          reason: 'phantom_cleared_at_shipped',
          stockState: 'on_hand',
        });
      }
    }
  }

  if (targetStatus === 'delivered' && lineItems.length > 0 &&
      (opType === 'purchase' || opType === 'transfer')) {
    const skuList = lineItems.map((li) => li.product_id);
    const placeholders = skuList.map(() => '?').join(',');
    const otwPhantomQuery = await c.env.DB.prepare(
      `SELECT product_id, on_hand FROM stocks
       WHERE warehouse_id = ? AND stock_state = 'in_transit'
         AND product_id IN (${placeholders}) AND on_hand > 0`
    ).bind(OTW_WAREHOUSE_ID, ...skuList).all<{ product_id: string; on_hand: number }>();
    for (const phantom of otwPhantomQuery.results || []) {
      // Real movement already drains -qty for these SKUs (in_transit_out).
      // Anything beyond what the real movement clears is phantom — zero it.
      const alreadyDeducted = movementSpecs
        .filter((m) =>
          m.warehouseId === OTW_WAREHOUSE_ID &&
          m.productId === phantom.product_id &&
          m.stockState === 'in_transit'
        )
        .reduce((sum, m) => sum + m.qty, 0);
      const remaining = phantom.on_hand + alreadyDeducted;
      if (remaining > 0) {
        movementSpecs.push({
          warehouseId: OTW_WAREHOUSE_ID,
          productId: phantom.product_id,
          movementType: 'phantom_clear',
          qty: -remaining,
          reason: 'phantom_cleared_at_delivered',
          stockState: 'in_transit',
        });
      }
    }
  }

  // 3a. Pre-validation pass — guard against any spec that would push stock < 0.
  // Without this guard, the system silently writes shipments out of empty
  // warehouses (the DEI-010 incident on 2026-05-11 left -298,080 pcs at YZH).
  // Reversal movements ('return') and manual adjustments are allowed to go
  // negative because they intentionally correct an existing imbalance.
  // State-aware: each (warehouse, product, stock_state) is checked independently.
  const negativeViolations: Array<{
    product_id: string;
    warehouse_id: string;
    stock_state: string;
    current: number;
    delta: number;
    would_be: number;
  }> = [];

  // Build a temporary balance map so multi-line operations validate against
  // the running balance (e.g. shipping 5 units then 3 of the same SKU from a
  // stock of 7 should fail on the second line, not pass because each was <7).
  const tentativeBalances = new Map<string, number>();

  for (const spec of movementSpecs) {
    // Reservations and reversals are allowed to be negative:
    //  - 'return' / 'adjustment' intentionally correct an existing imbalance
    //  - 'order_fulfilment_reserve' parks a NEGATIVE qty in 'in_production'
    //    to mirror purchase production (which parks POSITIVE in the same state).
    //    The pair (purchase +1000 / sale -200) live in the same column and
    //    distinguish by sign — this is by design, not a bug.
    const allowNegative =
      spec.movementType === 'return' ||
      spec.movementType === 'adjustment' ||
      spec.movementType === 'order_fulfilment_reserve';
    if (allowNegative) continue;
    if (spec.qty >= 0) continue; // only outflows can drive below zero

    const key = `${spec.warehouseId}:${spec.productId}:${spec.stockState}`;
    let current = tentativeBalances.get(key);
    if (current === undefined) {
      const existing = await c.env.DB.prepare(
        'SELECT on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ? AND stock_state = ?'
      ).bind(spec.warehouseId, spec.productId, spec.stockState).first<{ on_hand: number }>();
      current = existing?.on_hand ?? 0;
    }
    const wouldBe = current + spec.qty;
    if (wouldBe < 0) {
      negativeViolations.push({
        product_id: spec.productId,
        warehouse_id: spec.warehouseId,
        stock_state: spec.stockState,
        current,
        delta: spec.qty,
        would_be: wouldBe,
      });
    }
    tentativeBalances.set(key, wouldBe);
  }

  if (negativeViolations.length > 0) {
    return fail(c, 422, [{
      code: 'insufficient_stock',
      message: `Cannot transition to '${targetStatus}': ${negativeViolations.length} stock line(s) would go negative. Register a receipt first.`,
      details: { violations: negativeViolations },
    }]);
  }

  // 3. For each movement spec: compute balance_after, add movement insert + stock update
  for (const spec of movementSpecs) {
    let stock: StockRow;
    try {
      stock = await getOrCreateStockWithState(c.env.DB, spec.warehouseId, spec.productId, spec.stockState, now);
    } catch {
      warnings.push(`stock_row_error: could not access stock for ${spec.productId} @ ${spec.warehouseId} (${spec.stockState})`);
      continue;
    }

    const balanceAfter = stock.on_hand + spec.qty;
    // Negative balance still possible here ONLY for return/adjustment specs,
    // which we explicitly skip in pre-validation. Keep the warning for audit.
    if (balanceAfter < 0) {
      warnings.push(`negative_stock_allowed: ${spec.productId} @ ${spec.warehouseId} (${spec.stockState}) = ${balanceAfter} (${spec.movementType})`);
    }

    const movId = `mov_${crypto.randomUUID()}`;

    stmts.push(
      c.env.DB.prepare(`
        INSERT INTO stock_movements
          (id, warehouse_id, product_id, movement_type, quantity, source,
           source_ref_type, source_ref_id, reason, notes, performed_by,
           performed_at, balance_after, stock_state, created_at)
        VALUES (?, ?, ?, ?, ?, 'operation', 'operation', ?, ?, ?, 'system', ?, ?, ?, ?)
      `).bind(
        movId, spec.warehouseId, spec.productId, spec.movementType,
        spec.qty, opId, spec.reason,
        parsed.data.notes ?? null, now, balanceAfter, spec.stockState, now
      )
    );

    stmts.push(
      c.env.DB.prepare(
        'UPDATE stocks SET on_hand = ?, last_movement_at = ?, updated_at = ? WHERE warehouse_id = ? AND product_id = ? AND stock_state = ?'
      ).bind(balanceAfter, now, now, spec.warehouseId, spec.productId, spec.stockState)
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

// PATCH /api/line-items/:id — update line item qty or unit_price
operations.patch('/api/line-items/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ qty?: number; unit_price?: number }>();

  if (!body.qty && body.unit_price === undefined) {
    return fail(c, 400, [{ code: 'missing_fields', message: 'qty or unit_price required' }]);
  }

  const now = Math.floor(Date.now() / 1000);

  // Find parent operation to recompute total + cancel docs if needed
  const li = await c.env.DB.prepare(
    'SELECT operation_id FROM line_items WHERE id = ?'
  ).bind(id).first<{ operation_id: string }>();

  if (!li) {
    return fail(c, 404, [{ code: 'not_found', message: 'Line item not found' }]);
  }

  const op = await c.env.DB.prepare(
    'SELECT id, status FROM operations WHERE id = ?'
  ).bind(li.operation_id).first<{ id: string; status: string }>();

  if (!op) {
    return fail(c, 404, [{ code: 'op_not_found', message: 'Parent operation not found' }]);
  }

  if (op.status === 'cancelled' || op.status === 'delivered') {
    return fail(c, 409, [{ code: 'op_locked', message: `Cannot edit line items on ${op.status} operation` }]);
  }

  const updates: string[] = [];
  const binds: (string | number)[] = [];

  if (body.qty !== undefined) {
    updates.push('qty = ?');
    binds.push(body.qty);
  }
  if (body.unit_price !== undefined) {
    updates.push('unit_price = ?');
    binds.push(body.unit_price);
  }

  updates.push('updated_at = ?');
  binds.push(now);
  binds.push(id);

  const sql = `UPDATE line_items SET ${updates.join(', ')} WHERE id = ?`;

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(sql).bind(...binds),
  ];

  // Recompute total_amount on parent operation
  stmts.push(
    c.env.DB.prepare(`
      UPDATE operations SET
        total_amount = COALESCE((SELECT SUM(qty * unit_price) FROM line_items WHERE operation_id = ?), 0),
        updated_at = ?
      WHERE id = ?
    `).bind(op.id, now, op.id)
  );

  // If issued or further: mark documents as cancelled (composition changed → docs invalid)
  if (op.status !== 'draft') {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE documents SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status != 'cancelled'`
      ).bind(now, op.id)
    );
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    return fail(c, 500, [{ code: 'update_failed', message: 'Failed to update line item', details: { error: String(err) } }]);
  }

  return ok(c, {
    id,
    operation_id: op.id,
    docs_cancelled: op.status !== 'draft',
    updated_at: now,
  }, op.status !== 'draft'
    ? ['Line item updated', 'Existing documents marked cancelled — re-issue when ready']
    : ['Line item updated']);
});

// =============================================================================
// POST /api/operations/:id/line-items — add a new line item
// =============================================================================
operations.post('/:id/line-items', async (c) => {
  const opId = c.req.param('id');
  const body = await c.req.json<{
    product_id: string;
    qty: number;
    unit_price: number;
    discount_pct?: number;
    cartons?: number;
    inner_boxes?: number;
    item_description?: string | null;
  }>();

  if (!body.product_id || !body.qty || body.unit_price === undefined) {
    return fail(c, 400, [{ code: 'missing_fields', message: 'product_id, qty, unit_price required' }]);
  }

  const op = await c.env.DB.prepare(
    'SELECT id, status FROM operations WHERE id = ?'
  ).bind(opId).first<{ id: string; status: string }>();

  if (!op) {
    return fail(c, 404, [{ code: 'op_not_found', message: 'Operation not found' }]);
  }

  if (op.status === 'cancelled' || op.status === 'delivered') {
    return fail(c, 409, [{ code: 'op_locked', message: `Cannot add line items to ${op.status} operation` }]);
  }

  const now = Math.floor(Date.now() / 1000);
  const newId = `li_${crypto.randomUUID()}`;

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(`
      INSERT INTO line_items
        (id, operation_id, product_id, qty, unit_price, discount_pct, cartons, inner_boxes, item_description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId, opId, body.product_id, body.qty, body.unit_price,
      body.discount_pct ?? 0, body.cartons ?? 0, body.inner_boxes ?? 0,
      body.item_description ?? null, now, now
    ),
  ];

  // Recompute total
  stmts.push(
    c.env.DB.prepare(`
      UPDATE operations SET
        total_amount = COALESCE((SELECT SUM(qty * unit_price) FROM line_items WHERE operation_id = ?), 0) + ?,
        updated_at = ?
      WHERE id = ?
    `).bind(opId, body.qty * body.unit_price, now, opId)
  );

  // Mark docs cancelled if op was already issued+
  if (op.status !== 'draft') {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE documents SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status != 'cancelled'`
      ).bind(now, opId)
    );
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    return fail(c, 500, [{ code: 'insert_failed', message: 'Failed to add line item', details: { error: String(err) } }]);
  }

  return ok(c, {
    id: newId,
    operation_id: opId,
    docs_cancelled: op.status !== 'draft',
  }, op.status !== 'draft'
    ? ['Line item added', 'Existing documents marked cancelled — re-issue when ready']
    : ['Line item added']);
});

// =============================================================================
// DELETE /api/line-items/:id — remove a line item
// =============================================================================
operations.delete('/api/line-items/:id', async (c) => {
  const id = c.req.param('id');

  const li = await c.env.DB.prepare(
    'SELECT id, operation_id FROM line_items WHERE id = ?'
  ).bind(id).first<{ id: string; operation_id: string }>();

  if (!li) {
    return fail(c, 404, [{ code: 'not_found', message: 'Line item not found' }]);
  }

  const op = await c.env.DB.prepare(
    'SELECT id, status FROM operations WHERE id = ?'
  ).bind(li.operation_id).first<{ id: string; status: string }>();

  if (!op) {
    return fail(c, 404, [{ code: 'op_not_found', message: 'Parent operation not found' }]);
  }

  if (op.status === 'cancelled' || op.status === 'delivered') {
    return fail(c, 409, [{ code: 'op_locked', message: `Cannot remove line items from ${op.status} operation` }]);
  }

  // Don't allow deleting the last line item — operation must have at least one
  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM line_items WHERE operation_id = ?'
  ).bind(op.id).first<{ cnt: number }>();

  if (countRow && countRow.cnt <= 1) {
    return fail(c, 409, [{
      code: 'last_line_item',
      message: 'Cannot delete the last line item. Cancel the operation instead.',
    }]);
  }

  const now = Math.floor(Date.now() / 1000);

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM line_items WHERE id = ?').bind(id),
    c.env.DB.prepare(`
      UPDATE operations SET
        total_amount = COALESCE((SELECT SUM(qty * unit_price) FROM line_items WHERE operation_id = ? AND id != ?), 0),
        updated_at = ?
      WHERE id = ?
    `).bind(op.id, id, now, op.id),
  ];

  if (op.status !== 'draft') {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE documents SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status != 'cancelled'`
      ).bind(now, op.id)
    );
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    return fail(c, 500, [{ code: 'delete_failed', message: 'Failed to delete line item', details: { error: String(err) } }]);
  }

  return ok(c, {
    id,
    operation_id: op.id,
    docs_cancelled: op.status !== 'draft',
  }, op.status !== 'draft'
    ? ['Line item removed', 'Existing documents marked cancelled — re-issue when ready']
    : ['Line item removed']);
});

// =============================================================================
// DELETE /api/operations/:id — hard delete (draft only, no documents)
// =============================================================================
//
// Strict rules:
//   - Operation status MUST be 'draft' (returns 409 otherwise)
//   - No documents must reference this operation (returns 409 if found)
//   - No payments must reference this operation (returns 409 if found)
//   - Stock movements: draft never writes any, but we double-check (returns 409
//     if any exist — would mean inconsistent state)
//
// Cascade:
//   - line_items rows for this operation are deleted in same batch
//
// Reversibility: NONE. This is hard delete.
// For non-draft operations, use PATCH /:id/status with target='cancelled'.
//
// =============================================================================

operations.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const op = await c.env.DB.prepare(
    'SELECT id, status, reference FROM operations WHERE id = ?'
  ).bind(id).first<{ id: string; status: string; reference: string | null }>();

  if (!op) {
    return fail(c, 404, [{ code: 'not_found', message: 'Operation not found' }]);
  }

  if (op.status !== 'draft') {
    return fail(c, 409, [{
      code: 'not_draft',
      message: `Cannot delete operation in status '${op.status}'. Only draft operations can be deleted. Use status change to 'cancelled' instead.`,
    }]);
  }

  // Guard: documents
  // Only count alive (non-soft-deleted) documents. Exclude RFQ — those are
  // logistics-quote artifacts internal to the operation, not commercial
  // documents like CI/PL/IS/UPD/TN. A draft op with only RFQs should be
  // deletable; CASCADE soft-delete below will sweep them.
  const docCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM documents WHERE operation_id = ? AND deleted_at IS NULL AND document_type != 'RFQ'"
  ).bind(id).first<{ cnt: number }>();

  if (docCount && docCount.cnt > 0) {
    return fail(c, 409, [{
      code: 'has_documents',
      message: `Operation has ${docCount.cnt} document(s) attached. Cannot delete.`,
    }]);
  }

  // Guard: payments — alive rows only
  const payCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM payments WHERE operation_id = ? AND deleted_at IS NULL"
  ).bind(id).first<{ cnt: number }>();

  if (payCount && payCount.cnt > 0) {
    return fail(c, 409, [{
      code: 'has_payments',
      message: `Operation has ${payCount.cnt} payment(s) linked. Cannot delete.`,
    }]);
  }

  // Guard: stock movements (sanity — draft should never have any)
  const movCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM stock_movements WHERE source = 'operation' AND source_ref_id = ?"
  ).bind(id).first<{ cnt: number }>();

  if (movCount && movCount.cnt > 0) {
    return fail(c, 409, [{
      code: 'has_movements',
      message: `Operation has ${movCount.cnt} stock movement(s). Inconsistent state — contact admin.`,
    }]);
  }

  // Atomic delete:
  //   1. hard-delete soft-deleted documents (cleans up RFQ test artifacts + any
  //      previously soft-deleted commercial docs — guards above already blocked
  //      live commercial documents)
  //   2. hard-delete soft-deleted payments (live payments blocked above)
  //   3. hard-delete soft-deleted attachments
  //   4. hard-delete line_items
  //   5. hard-delete the operation itself
  // All in one batch — runs as a single SQLite transaction.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM documents WHERE operation_id = ? AND deleted_at IS NOT NULL').bind(id),
    c.env.DB.prepare('DELETE FROM payments WHERE operation_id = ? AND deleted_at IS NOT NULL').bind(id),
    c.env.DB.prepare('DELETE FROM operation_attachments WHERE operation_id = ? AND deleted_at IS NOT NULL').bind(id),
    c.env.DB.prepare('DELETE FROM line_items WHERE operation_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(id),
  ]);

  return ok(c, {
    id,
    reference: op.reference,
    deleted: true,
  }, [`Operation ${op.reference || id} permanently deleted`]);
});

// ─────────────────────────────────────────────────────────────────────────
// PHASE 3 — F4 arrival confirmation flow
//
// When the F4 sync cron detects a closed acceptance request matching a
// shipped purchase op, it stamps arrival_detected_at + arrival_received_qtys
// on that op. The UI shows a green confirmation card. The user has three
// choices:
//
//   POST /:id/confirm-arrival
//     → operation transitions to 'delivered'
//     → existing PATCH /status logic fires (OTW drain, LBR populate,
//       universal phantom clear)
//     → If F4 received quantities differ from line items, line items get
//       updated to F4's numbers before the status change so stock movement
//       reflects reality.
//
//   POST /:id/reject-arrival
//     → arrival_rejected_at stamped; arrival_detected_at cleared
//     → card disappears, op stays shipped
//     → next sync won't re-match this same F4 request to this op
//
//   PATCH /api/line-items/:id (existing endpoint, no change needed)
//     → user manually adjusts qty before confirming
// ─────────────────────────────────────────────────────────────────────────
operations.post('/:id/confirm-arrival', async (c) => {
  const id = c.req.param('id');
  const op = await c.env.DB.prepare(
    `SELECT id, status, operation_type, operation_track,
            arrival_detected_at, arrival_received_qtys
     FROM operations WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first<{
    id: string;
    status: string;
    operation_type: string;
    operation_track: string | null;
    arrival_detected_at: number | null;
    arrival_received_qtys: string | null;
  }>();

  if (!op) {
    return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${id} not found` }]);
  }
  if (!op.arrival_detected_at) {
    return fail(c, 400, [{ code: 'no_arrival_detected', message: 'No F4 arrival to confirm on this operation' }]);
  }
  if (op.status !== 'shipped') {
    return fail(c, 400, [{ code: 'wrong_status', message: `Operation must be in shipped status, got ${op.status}` }]);
  }

  const now = Math.floor(Date.now() / 1000);

  // 1. Adjust line items based on F4 received qtys. Two paths:
  //
  //    Path A — direct match: receivedMap[product_id] = qty
  //      F4 accepted same SKU we shipped, just possibly different qty.
  //      Action: update qty only.
  //
  //    Path B — pre-bundle: our line item is single (e.g. de202), but F4
  //      accepted the AA-pack form (de202aa). The factory shipped the pair
  //      wrapped together with a 2in1 barcode; F4 scanned it as DE202AA.
  //      Action: rewrite product_id to the AA variant, set qty to F4 received.
  //      Only paste SKUs that have a sibling _aa entry in our products
  //      catalog can pre-bundle. Brushes never pre-bundle. SKUs without an
  //      _aa catalog entry (DE204, DE209, DE210) silently fall through to
  //      no-op even if they were somehow flagged.
  if (op.arrival_received_qtys) {
    const receivedMap = JSON.parse(op.arrival_received_qtys) as Record<string, number>;
    const lineItems = await c.env.DB.prepare(
      'SELECT id, product_id, qty FROM line_items WHERE operation_id = ?'
    ).bind(id).all<{ id: string; product_id: string; qty: number }>();

    const adjustStmts: D1PreparedStatement[] = [];

    for (const li of lineItems.results || []) {
      // Path A — same SKU received
      if (receivedMap[li.product_id] !== undefined) {
        const received = receivedMap[li.product_id]!;
        if (received !== li.qty) {
          adjustStmts.push(
            c.env.DB.prepare(
              'UPDATE line_items SET qty = ?, line_amount = qty * unit_price_after_disc, updated_at = ? WHERE id = ?'
            ).bind(received, now, li.id)
          );
        }
        continue;
      }

      // Path B — pre-bundle. Check if F4 received the AA-pack form.
      const candidateAa = `${li.product_id}aa`;
      const candidateAaaa = `${li.product_id}aaaa`;
      let aaVariant: string | null = null;
      let aaReceived: number | null = null;
      if (receivedMap[candidateAa] !== undefined) {
        aaVariant = candidateAa;
        aaReceived = receivedMap[candidateAa]!;
      } else if (receivedMap[candidateAaaa] !== undefined) {
        aaVariant = candidateAaaa;
        aaReceived = receivedMap[candidateAaaa]!;
      }
      if (aaVariant && aaReceived !== null) {
        // Verify the AA variant exists in our products catalog before swapping.
        const aaExists = await c.env.DB.prepare(
          "SELECT id FROM products WHERE id = ? AND deleted_at IS NULL"
        ).bind(aaVariant).first();
        if (aaExists) {
          adjustStmts.push(
            c.env.DB.prepare(
              'UPDATE line_items SET product_id = ?, qty = ?, line_amount = ? * unit_price_after_disc, updated_at = ? WHERE id = ?'
            ).bind(aaVariant, aaReceived, aaReceived, now, li.id)
          );
        }
      }
    }
    if (adjustStmts.length > 0) {
      await c.env.DB.batch(adjustStmts);
    }
  }

  // 2. Fire the existing status PATCH logic by calling the handler internally.
  //    Using a self-fetch keeps movement logic in one place (the PATCH route)
  //    so phantom clear, audit movements, etc. all apply identically.
  const url = new URL(c.req.url);
  const patchUrl = `${url.origin}/api/operations/${id}/status`;
  const patchResp = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'delivered', notes: 'F4 arrival confirmed' }),
  });
  if (!patchResp.ok) {
    const err = await patchResp.text();
    return fail(c, 500, [{ code: 'status_transition_failed', message: `Internal PATCH failed: ${err}` }]);
  }

  return ok(c, { id, status: 'delivered', arrival_confirmed_at: now });
});

operations.post('/:id/reject-arrival', async (c) => {
  const id = c.req.param('id');
  const op = await c.env.DB.prepare(
    `SELECT id, arrival_detected_at, arrival_source_request_id
     FROM operations WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first<{
    id: string;
    arrival_detected_at: number | null;
    arrival_source_request_id: string | null;
  }>();

  if (!op) {
    return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${id} not found` }]);
  }
  if (!op.arrival_detected_at) {
    return fail(c, 400, [{ code: 'no_arrival_detected', message: 'No F4 arrival to reject on this operation' }]);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `UPDATE operations
     SET arrival_rejected_at = ?,
         arrival_detected_at = NULL,
         arrival_received_qtys = NULL,
         updated_at = ?
     WHERE id = ?`
  ).bind(now, now, id).run();

  return ok(c, { id, arrival_rejected_at: now });
});

// =============================================================================
// GET /api/operations/batch/:id — single batch with its child operations
// =============================================================================
// Returns the batch row plus all F4-WH-R operations linked to it.
// Used by the frontend detail page for batches (one entry per OZN-260512 etc.)
operations.get('/batch/:id', async (c) => {
  const batchId = c.req.param('id');

  const batch = await c.env.DB.prepare(`
    SELECT
      b.id,
      b.batch_reference,
      b.marketplace,
      b.batch_date,
      b.our_company_id,
      co.abbreviation as entity_abbreviation,
      b.notes,
      b.created_at,
      b.updated_at
    FROM operation_batches b
    LEFT JOIN companies co ON b.our_company_id = co.id
    WHERE b.id = ? AND b.deleted_at IS NULL
  `).bind(batchId).first();

  if (!batch) {
    return c.json({ success: false, error: 'batch_not_found' }, 404);
  }

  const childrenRes = await c.env.DB.prepare(`
    SELECT
      o.id, o.reference, o.operation_date, o.operation_type,
      o.warehouse_from_id, o.warehouse_to_id,
      o.status, o.delivery_status, o.notes,
      w_from.code as warehouse_from_code,
      w_to.code as warehouse_to_code
    FROM operations o
    LEFT JOIN warehouses w_from ON o.warehouse_from_id = w_from.id
    LEFT JOIN warehouses w_to ON o.warehouse_to_id = w_to.id
    WHERE o.batch_id = ? AND o.deleted_at IS NULL
    ORDER BY o.reference DESC
  `).bind(batchId).all();

  return c.json({
    success: true,
    result: {
      batch,
      children: childrenRes.results,
      cluster_count: childrenRes.results.length,
    },
  });
});


export default operations;

