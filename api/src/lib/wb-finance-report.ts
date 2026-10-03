// Official Finance API, inspected 2026-10-03:
// https://dev.wildberries.ru/en/docs/openapi/documents-and-accounting#tag/financialReports/operation/postV1SalesReportsDetailed
export const WB_REALIZATION_URL = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
export const WB_PAGE_LIMIT = 10000;

export function wbRealizationRequest(task: { period_from: string; period_to: string; pagination_token?: string | null }) {
  const rrdId = Number(task.pagination_token || 0);
  if (!Number.isSafeInteger(rrdId) || rrdId < 0) throw new Error('Invalid WB realization cursor');
  return { dateFrom: task.period_from, dateTo: task.period_to, limit: WB_PAGE_LIMIT, rrdId, period: 'weekly' };
}

// Keep staging's existing RUB amounts and column meanings. The Finance API uses
// camelCase and returns money as decimal strings; do not bind those as SQL text.
export function normalizeWbFinanceRow(r: Record<string, unknown>) {
  if (!Number.isSafeInteger(r.rrdId) || Number(r.rrdId) <= 0) throw new Error('Invalid WB finance row ID');
  const money = (field: string) => {
    const value = r[field];
    if (value === undefined || value === null || value === '') return 0;
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`Invalid WB finance amount: ${field}`);
    return result;
  };
  return {
    rrd_id: r.rrdId, sa_name: String(r.vendorCode || '').trim().toLowerCase(),
    supplier_oper_name: String(r.sellerOperName || ''), sale_dt: String(r.saleDt || r.orderDt || ''),
    quantity: money('quantity'), retail_price: money('retailPrice'), retail_amount: money('retailAmount'),
    ppvz_vw: money('vw'), ppvz_for_pay: money('forPay'), delivery_rub: money('deliveryService'),
    penalty: money('penalty'), rebill_logistic_cost: money('rebillLogisticCost'),
    storage_fee: money('paidStorage'), deduction: money('deduction'), acceptance: money('paidAcceptance'),
    raw_json: JSON.stringify(r),
  };
}
