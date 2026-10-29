import { minorFactor } from './money';

type FinanceOperation = {
  operation_type: string;
  operation_track?: string;
  total_amount: number;
  currency: string;
  vat_rate: number;
  vn_einvoice_document_id?: string | null;
};
type FinanceLine = { qty: number; unit_price: number; line_amount: number };
type FinancePayment = { amount: number; direction: string };

// Both operation detail routes use the same totals. Service invoice headers
// already include VAT; an absent product line is not an invoice with zero VAT.
export function operationTotals(operation: FinanceOperation, lines: FinanceLine[]) {
  let subtotal = lines.reduce((sum, line) => sum + line.qty * line.unit_price, 0);
  let totalAfterDiscount = lines.reduce((sum, line) => sum + line.line_amount, 0);
  const managedInvoice = Boolean(operation.vn_einvoice_document_id);
  const headerOnlyService = lines.length === 0 && !managedInvoice &&
    (operation.operation_track === 'service' || ['service', 'tax'].includes(operation.operation_type));
  let vatAmount: number;
  let grandTotal: number;
  if (headerOnlyService) {
    grandTotal = Number(operation.total_amount) || 0;
    // This UI formats amounts in the operation's displayed units: whole VND,
    // two decimals for USD/RUB/etc. Preserve the authoritative gross exactly.
    const factor = minorFactor(operation.currency);
    totalAfterDiscount = Math.round(grandTotal / (1 + operation.vat_rate / 100) * factor) / factor;
    subtotal = totalAfterDiscount;
    vatAmount = Math.round((grandTotal - totalAfterDiscount) * factor) / factor;
  } else {
    // Keep the existing line and managed fiscal invoice calculation unchanged.
    vatAmount = managedInvoice
      ? operation.total_amount - totalAfterDiscount
      : Math.round(totalAfterDiscount * operation.vat_rate) / 100;
    const computedTotal = Math.round((totalAfterDiscount + vatAmount) * 100) / 100;
    grandTotal = managedInvoice ? operation.total_amount
      : lines.length === 0 && operation.total_amount ? Number(operation.total_amount) : computedTotal;
  }
  const discount = subtotal - totalAfterDiscount;
  const discountPct = subtotal > 0 ? Math.round(discount / subtotal * 1000) / 10 : 0;
  return { subtotal, totalAfterDiscount, discount, discountPct, vatAmount, grandTotal,
    showVat: operation.vat_rate > 0,
    // A tax payment amount may itself be import VAT. Zero additional invoice VAT
    // does not mean the underlying import tax has a statutory rate of zero.
    showVatSummary: operation.operation_type !== 'tax' || operation.vat_rate > 0,
    vatSummaryLabel: operation.operation_type === 'tax' ? 'Additional VAT' : 'VAT',
  };
}

export function operationSettlement(
  operation: Pick<FinanceOperation, 'operation_type'>,
  payments: FinancePayment[],
  grandTotal: number,
  partnerType?: string | null,
) {
  const payable = ['purchase', 'tax'].includes(operation.operation_type) ||
    (operation.operation_type === 'service' && ['supplier', 'shipper'].includes(partnerType ?? ''));
  // Unknown service sides and transfers retain the historical incoming-positive
  // fallback. Do not infer an obligation's side from payment sign or use abs().
  const settlementDirection = payable ? 'outgoing' : 'incoming';
  const paidAmount = payments.reduce((sum, payment) => sum +
    (payment.direction === settlementDirection ? payment.amount : -payment.amount), 0);
  return { paidAmount, outstanding: Math.round((grandTotal - paidAmount) * 100) / 100 };
}
