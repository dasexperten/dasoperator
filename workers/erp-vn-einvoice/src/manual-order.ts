export interface ManualOrder {
  source_order_id: string;
  channel: string;
  swifthub_order_id?: string;
  source_evidence_ref: string;
  captured_at: string;
  currency: "VND";
  buyer: {
    kind: "business" | "consumer";
    name: string;
    address: string;
    tax_code?: string;
  };
  payment_method: string;
  items: Array<{
    sku: string;
    name: string;
    unit: string;
    quantity: number;
    gross_amount: number;
    vat_rate: number;
    vat_evidence_ref: string;
  }>;
  shipping_gross: number;
  shipping_discount: number;
  total_gross: number;
}
export function textField(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name}_required`);
  return value.trim();
}
function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new Error(`${name}_invalid`);
  return value;
}
export function validTimestamp(
  value: unknown,
  name: string,
  notFuture = true,
): string {
  const s = textField(value, name, 60);
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      s,
    );
  const n = Date.parse(s);
  if (!m || !Number.isFinite(n)) throw new Error(`${name}_invalid`);
  const y = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(y, month, 0)).getUTCDate()
  )
    throw new Error(`${name}_invalid`);
  if (notFuture && n > Date.now()) throw new Error(`${name}_future`);
  return s;
}
export function normalizeOrder(input: unknown): ManualOrder {
  if (!input || typeof input !== "object") throw new Error("order_required");
  const v = input as Record<string, any>;
  if (v.currency !== "VND") throw new Error("currency_must_be_VND");
  if (!v.buyer || !["business", "consumer"].includes(v.buyer.kind))
    throw new Error("buyer_kind_required");
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > 100)
    throw new Error("items_required");
  const items = v.items.map((x: any) => {
    const rate = integer(x.vat_rate, "vat_rate");
    if (![0, 5, 8, 10].includes(rate)) throw new Error("vat_rate_unsupported");
    return {
      sku: textField(x.sku, "sku", 80),
      name: textField(x.name, "product_name"),
      unit: textField(x.unit, "unit", 40),
      quantity: integer(x.quantity, "quantity", 1),
      gross_amount: integer(x.gross_amount, "gross_amount", 1),
      vat_rate: rate,
      vat_evidence_ref: textField(x.vat_evidence_ref, "vat_evidence_ref", 2000),
    };
  });
  // No implicit shipping VAT or allocation: this version covers orders whose
  // fully documented shipping subsidy cancels the shipping charge.
  const shipping_gross = integer(v.shipping_gross, "shipping_gross");
  const shipping_discount = integer(v.shipping_discount, "shipping_discount");
  if (shipping_gross !== shipping_discount)
    throw new Error("nonzero_shipping_requires_fiscal_line_mapping");
  const total_gross = integer(v.total_gross, "total_gross", 1);
  if (items.reduce((s, x) => s + x.gross_amount, 0) !== total_gross)
    throw new Error("order_total_mismatch");
  // The current tenant's validated template uses one header rate. Mixed-rate
  // templates need their own approved provider mapping, not an invented rate.
  if (new Set(items.map((x) => x.vat_rate)).size !== 1)
    throw new Error("mixed_rates_require_template_mapping");
  const order: ManualOrder = {
    source_order_id: textField(v.source_order_id, "source_order_id", 100),
    channel: textField(v.channel, "channel", 40),
    source_evidence_ref: textField(
      v.source_evidence_ref,
      "source_evidence_ref",
      2000,
    ),
    captured_at: validTimestamp(v.captured_at, "captured_at"),
    currency: "VND",
    buyer: {
      kind: v.buyer.kind,
      name: textField(v.buyer.name, "buyer_name"),
      address: textField(v.buyer.address, "buyer_address", 1000),
      ...(v.buyer.tax_code
        ? { tax_code: textField(v.buyer.tax_code, "buyer_tax_code", 40) }
        : {}),
    },
    payment_method: textField(v.payment_method, "payment_method", 100),
    items,
    shipping_gross,
    shipping_discount,
    total_gross,
  };
  if (v.swifthub_order_id)
    order.swifthub_order_id = textField(
      v.swifthub_order_id,
      "swifthub_order_id",
      120,
    );
  if (order.buyer.kind === "business" && !order.buyer.tax_code)
    throw new Error("buyer_tax_code_required");
  return order;
}
export function manualIkey(order: ManualOrder): string {
  if (!/^[A-Za-z0-9._-]{1,90}$/.test(order.source_order_id))
    throw new Error("source_order_id_invalid");
  // Preserve the previously created production draft's key. Do not substitute
  // the SwiftHub UUID for the marketplace order number.
  return `swh-${order.source_order_id}`;
}
export function fiscalLines(order: ManualOrder) {
  return order.items.map((x) => {
    const denominator = BigInt(100 + x.vat_rate);
    const numerator = BigInt(x.gross_amount) * 100n;
    const net = Number((numerator * 2n + denominator) / (2n * denominator));
    return { ...x, net_amount: net, vat_amount: x.gross_amount - net };
  });
}
export function fiscalTotals(order: ManualOrder) {
  const lines = fiscalLines(order);
  return {
    net: lines.reduce((s, x) => s + x.net_amount, 0),
    vat: lines.reduce((s, x) => s + x.vat_amount, 0),
    gross: order.total_gross,
  };
}
export function vietnamDate(timestamp: string): string {
  const day = new Date(Date.parse(timestamp) + 7 * 3600_000)
    .toISOString()
    .slice(0, 10);
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}
function xml(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
const digits = [
  "không",
  "một",
  "hai",
  "ba",
  "bốn",
  "năm",
  "sáu",
  "bảy",
  "tám",
  "chín",
];
function hundred(n: number, full: boolean): string {
  const h = Math.floor(n / 100),
    t = Math.floor(n / 10) % 10,
    u = n % 10;
  const parts: string[] = [];
  if (h || full) parts.push(digits[h]!, "trăm");
  if (t > 1) parts.push(digits[t]!, "mươi");
  else if (t === 1) parts.push("mười");
  else if (u && (h || full)) parts.push("lẻ");
  if (u)
    parts.push(
      u === 1 && t > 1 ? "mốt" : u === 5 && t > 0 ? "lăm" : digits[u]!,
    );
  return parts.join(" ");
}
export function vndWords(n: number): string {
  if (n === 0) return "Không đồng";
  const groups: number[] = [];
  while (n) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--)
    if (groups[i]) {
      const scale =
        ["", "nghìn", "triệu"][i % 3] +
        (i >= 3
          ? " " +
            Array(Math.floor(i / 3))
              .fill("tỷ")
              .join(" ")
          : "");
      words.push(hundred(groups[i]!, i < groups.length - 1), scale.trim());
    }
  const s = words.filter(Boolean).join(" ") + " đồng";
  return s[0]!.toUpperCase() + s.slice(1);
}
export function orderXml(order: ManualOrder, arisingAt: string): string {
  const totals = fiscalTotals(order),
    rate = order.items[0]!.vat_rate;
  const tag = (name: string, value: string | number) =>
    `<${name}>${xml(value)}</${name}>`;
  const products = fiscalLines(order)
    .map(
      (l, i) =>
        "<Product>" +
        tag("Code", l.sku) +
        tag("No", i + 1) +
        tag("Feature", 1) +
        tag("ProdName", l.name) +
        tag("ProdUnit", l.unit) +
        tag("ProdQuantity", l.quantity) +
        tag("ProdPrice", Number((l.net_amount / l.quantity).toFixed(6))) +
        tag("Total", l.net_amount) +
        tag("VATRate", l.vat_rate) +
        tag("VATAmount", l.vat_amount) +
        tag("Amount", l.gross_amount) +
        "</Product>",
    )
    .join("");
  return (
    "<Invoices><Inv><Invoice>" +
    tag("Ikey", manualIkey(order)) +
    tag(
      "CusCode",
      order.buyer.tax_code
        ? "VN" + order.buyer.tax_code
        : "ORDER-" + order.source_order_id,
    ) +
    tag("CusName", order.buyer.name) +
    tag("CusAddress", order.buyer.address) +
    (order.buyer.tax_code ? tag("CusTaxCode", order.buyer.tax_code) : "") +
    tag("PaymentMethod", order.payment_method) +
    tag("ArisingDate", vietnamDate(arisingAt)) +
    tag("ExchangeRate", 1) +
    tag("CurrencyUnit", "VND") +
    "<Products>" +
    products +
    "</Products>" +
    tag("Total", totals.net) +
    tag("VATRate", rate) +
    tag("VATAmount", totals.vat) +
    tag("Amount", totals.gross) +
    tag("GrossValue" + rate, totals.net) +
    tag("VatAmount" + rate, totals.vat) +
    tag("Amount" + rate, totals.gross) +
    tag("AmountInWords", vndWords(totals.gross)) +
    "</Invoice></Inv></Invoices>"
  );
}
export function matchedInvoice(
  body: Record<string, any>,
  ikey: string,
): Record<string, any> | null {
  const rows = body.Data?.Invoices;
  return Array.isArray(rows)
    ? (rows.find((x) => x && x.Ikey === ikey) ?? null)
    : null;
}
export function invoiceMatches(
  order: ManualOrder,
  inv: Record<string, any>,
): boolean {
  const t = fiscalTotals(order);
  return (
    inv.Ikey === manualIkey(order) &&
    Number(inv.Total) === t.net &&
    Number(inv.TaxAmount) === t.vat &&
    Number(inv.Amount) === t.gross &&
    String(inv.CustomerName ?? "").trim() === order.buyer.name &&
    String(inv.CustomerAddress ?? "").trim() === order.buyer.address &&
    String(inv.CustomerTaxCode ?? "").trim() === (order.buyer.tax_code ?? "")
  );
}
export function seriesMatches(
  inv: Record<string, any>,
  pattern: string,
  serial: string,
): boolean {
  return (
    typeof inv.Pattern === "string" &&
    inv.Pattern === pattern &&
    typeof inv.Serial === "string" &&
    inv.Serial === serial
  );
}
export function invoiceStage(
  inv: Record<string, any>,
):
  | "draft"
  | "signing"
  | "issued_pending_tax"
  | "tax_accepted"
  | "tax_rejected"
  | "cancelled"
  | "corrected"
  | "unknown" {
  if (
    typeof inv.InvoiceStatus !== "number" &&
    !(
      typeof inv.InvoiceStatus === "string" &&
      /^-?\d+$/.test(inv.InvoiceStatus.trim())
    )
  )
    return "unknown";
  const status = Number(inv.InvoiceStatus);
  if (status === 0) return "draft";
  if (status === -1 || status === 6) return "signing";
  if (status === 5) return "cancelled";
  if (status === 3 || status === 4) return "corrected";
  if (![1, 2].includes(status) || !inv.No || !Number(inv.No)) return "unknown";
  if (
    ["-2", "Không hợp lệ"].includes(String(inv.TCTCheckStatus)) ||
    inv.TCTErrorMessage
  )
    return "tax_rejected";
  if (
    ["1", "Hợp lệ"].includes(String(inv.TCTCheckStatus)) &&
    inv.TaxAuthorityCode
  )
    return "tax_accepted";
  return "issued_pending_tax";
}
