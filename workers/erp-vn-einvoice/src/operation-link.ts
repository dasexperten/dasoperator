import {
  normalizeOrder,
  fiscalLines,
  fiscalTotals,
  matchedInvoice,
  seriesMatches,
  invoiceMatches,
  validTransferDate,
  vietnamDate,
} from "./manual-order";
import { isProviderSuccess } from "./easyinvoice";
import type { ManualEnv, ManualRow } from "./manual-workflow";

const now = () => Math.floor(Date.now() / 1000);
async function receipt(
  env: ManualEnv,
  row: ManualRow,
  order: ReturnType<typeof normalizeOrder>,
) {
  const object = row.response_r2_key
    ? await env.DOCS.get(row.response_r2_key)
    : null;
  if (!object) return null;
  const body = JSON.parse(await object.text()).body;
  const invoice =
    body && isProviderSuccess(body) ? matchedInvoice(body, row.ikey) : null;
  if (!invoice) return null;
  if (
    !seriesMatches(invoice, row.pattern, row.serial) ||
    !invoiceMatches(order, invoice)
  )
    throw new Error("operation_invoice_facts_mismatch");
  return invoice;
}
function calendar(value: unknown) {
  if (typeof value !== "string") return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return validTransferDate(m ? `${m[3]}-${m[2]}-${m[1]}` : value);
}
// A date column needs an epoch representation; this is NOT a transfer event.
const dateEpoch = (date: string) => Date.parse(`${date}T12:00:00Z`) / 1000;
export async function linkManualOperation(
  env: ManualEnv,
  row: ManualRow,
  actor: string,
) {
  const order = normalizeOrder(JSON.parse(row.normalized_order_json));
  const totals = fiscalTotals(order),
    lines = fiscalLines(order);
  const inv = await receipt(env, row, order);
  const date =
    calendar(inv?.ArisingDate) ?? calendar(vietnamDate(order.captured_at))!;
  const id = row.operation_id || `op_vn_${row.id}`;
  const existing = await env.DB.prepare(
    "SELECT id,total_amount,currency,vat_rate,operation_type,our_company_id,order_doc_ref,deleted_at FROM operations WHERE id=?",
  )
    .bind(id)
    .first<any>();
  if (
    existing &&
    (existing.deleted_at ||
      existing.total_amount !== totals.gross ||
      existing.currency !== "VND" ||
      existing.operation_type !== "sale" ||
      existing.our_company_id !== "dasean" ||
      existing.order_doc_ref !== order.source_order_id ||
      existing.vat_rate !== order.items[0]!.vat_rate)
  )
    throw new Error("operation_link_conflict");
  if (existing) {
    const current = await env.DB.prepare(
      "SELECT product_id,qty,line_amount FROM line_items WHERE operation_id=? ORDER BY id",
    )
      .bind(id)
      .all<{ product_id: string; qty: number; line_amount: number }>();
    const expected = lines
      .map((l) => [l.sku.toLowerCase(), l.quantity, l.net_amount].join("|"))
      .sort();
    const actual = (current.results ?? [])
      .map((l) => [l.product_id, l.qty, l.line_amount].join("|"))
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error("operation_lines_conflict");
  }
  if (row.operation_id && !existing)
    throw new Error("linked_operation_missing");
  let partner = order.buyer.tax_code
    ? await env.DB.prepare(
        "SELECT id FROM partners WHERE tax_id=? AND country='VN' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
      )
        .bind(order.buyer.tax_code)
        .first<{ id: string }>()
    : null;
  const partnerId = partner?.id || `vn_buyer_${order.buyer.tax_code || row.id}`;
  for (const line of lines) {
    const found = await env.DB.prepare(
      "SELECT id FROM products WHERE id=? AND deleted_at IS NULL",
    )
      .bind(line.sku.toLowerCase())
      .first();
    if (!found) throw new Error(`operation_product_missing:${line.sku}`);
  }
  const timestamp = now();
  const issued =
    [1, 2].includes(Number(inv?.InvoiceStatus)) &&
    inv?.No &&
    String(inv.No) !== "0";
  const statements = [];
  if (!partner)
    statements.push(
      env.DB.prepare(
        `INSERT INTO partners(id,trade_name,legal_name,country,tax_id,address,registered_address_local,currency,partner_type,kind,status,created_at,updated_at,notes) VALUES(?,?,?,?,?,?,?,'VND','buyer','buyer','active',?,?,?) ON CONFLICT(id) DO NOTHING`,
      ).bind(
        partnerId,
        order.buyer.name,
        order.buyer.name,
        "VN",
        order.buyer.tax_code ?? null,
        order.buyer.address,
        order.buyer.address,
        timestamp,
        timestamp,
        `Source ${order.channel} order ${order.source_order_id}`,
      ),
    );
  statements.push(
    env.DB.prepare(
      `INSERT INTO operations(id,operation_date,operation_type,partner_id,our_company_id,reference,status,currency,total_amount,vat_rate,delivery_status,order_doc_ref,notes,created_at,updated_at) VALUES(?,?,'sale',?,'dasean',?,?,'VND',?,?,'pending',?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    ).bind(
      id,
      dateEpoch(date),
      partnerId,
      `VN-${order.channel.toUpperCase()}-${order.source_order_id}`,
      issued ? "issued" : "draft",
      totals.gross,
      order.items[0]!.vat_rate,
      order.source_order_id,
      `Заказ ${order.channel} ${order.source_order_id}; SwiftHub ${order.swifthub_order_id ?? "не указан"}; ${order.source_evidence_ref}. Способ оплаты покупателя: ${order.payment_method}. Выплата маркетплейса продавцу не сверена; сумма операции — продажа с НДС, не чистая выплата. Создано: ${actor}.`,
      timestamp,
      timestamp,
    ),
  );
  for (const [index, line] of lines.entries())
    statements.push(
      env.DB.prepare(
        `INSERT INTO line_items(id,operation_id,product_id,item_description,qty,unit_price,unit_price_after_disc,line_amount,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'VND',?,?) ON CONFLICT(id) DO NOTHING`,
      ).bind(
        `li_vn_${row.id}_${index}`,
        id,
        line.sku.toLowerCase(),
        line.name,
        line.quantity,
        line.net_amount / line.quantity,
        line.net_amount / line.quantity,
        line.net_amount,
        timestamp,
        timestamp,
      ),
    );
  statements.push(
    env.DB.prepare(
      "UPDATE vn_einvoice_documents SET operation_id=?,operation_sync_error=NULL WHERE id=? AND (operation_id IS NULL OR operation_id=?)",
    ).bind(id, row.id, id),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE document_extractions SET status='approved',target_table='operations',target_id=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE deleted_at IS NULL AND status='pending_review' AND target_id IS NULL AND json_valid(raw_extract_json) AND json_extract(raw_extract_json,'$.provider_draft.Ikey')=?`,
    ).bind(id, actor, timestamp, timestamp, row.ikey),
  );
  await env.DB.batch(statements);
  await syncManualOperation(env, { ...row, operation_id: id });
  return id;
}
// Reconciliation updates existing linked documents only; it never creates a sale.
export async function syncManualOperation(env: ManualEnv, row: ManualRow) {
  if (!row.operation_id) return;
  const order = normalizeOrder(JSON.parse(row.normalized_order_json)),
    inv = await receipt(env, row, order);
  if (
    !inv ||
    ![1, 2].includes(Number(inv.InvoiceStatus)) ||
    !inv.No ||
    String(inv.No) === "0"
  )
    return;
  const date = calendar(inv.ArisingDate);
  if (!date) throw new Error("invoice_date_missing");
  const timestamp = now();
  const statements = [
    env.DB.prepare(
      "UPDATE operations SET operation_date=?,status=CASE WHEN status='draft' THEN 'issued' ELSE status END,updated_at=? WHERE id=? AND deleted_at IS NULL",
    ).bind(dateEpoch(date), timestamp, row.operation_id),
  ];
  for (const kind of ["pdf", "xml"] as const) {
    if (!row[`provider_${kind}_r2_key`]) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO operation_attachments(id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at) VALUES(?,?,'outgoing',?,?,?,?,'VND','DEASEAN',?,'invoicer',?,?,?,?) ON CONFLICT(id) DO UPDATE SET doc_number=excluded.doc_number,doc_date=excluded.doc_date,file_url=excluded.file_url,notes=excluded.notes,updated_at=excluded.updated_at`,
      ).bind(
        `att_vn_${row.id}_${kind}`,
        row.operation_id,
        kind === "pdf" ? "invoice" : "invoice_xml",
        String(inv.No),
        dateEpoch(date),
        order.total_gross,
        `/api/integrations/vn-einvoice/orders/${row.id}/file/${kind}`,
        row.id,
        `EasyInvoice ${row.pattern}; Ikey ${row.ikey}; tax ${inv.TCTCheckStatus ?? "unknown"}; ${inv.TaxAuthorityCode ?? ""}`,
        timestamp,
        timestamp,
      ),
    );
  }
  await env.DB.batch(statements);
}
