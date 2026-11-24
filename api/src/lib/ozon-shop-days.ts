// =============================================================================
// Ozon shop by day — the Owner's daily shop table on the ERP home page
// (Owner 2026-11-24: «Магазин по дням» above the Ozon product sales table).
//
// One row per complete Moscow calendar day, newest last:
//   orders  — ordered_units   (Ozon «Заказано, шт»)
//   revenue — revenue, ₽      (Ozon «Заказано на сумму» at the price before any discount;
//                              NOT what the buyer paid — the public API has no such day metric)
//   avg     — revenue / orders, ₽ (before discounts)
//   views   — hits_view       (all impressions: search, category, card)
//   carts   — hits_tocart     (adds to cart, not unique buyers)
// Today is never included: a half day beside full days reads as a fall.
// =============================================================================

export type ShopDay = {
  date: string;
  orders: number;
  revenue_rub: number;
  avg_price_rub: number | null;
  views: number;
  carts: number;
};

export const SHOP_DAYS_METRICS = ['ordered_units', 'revenue', 'hits_view', 'hits_tocart'] as const;

/** Moscow calendar date (UTC+3, no DST) shifted by `offsetDays`. */
export function moscowDate(nowMs: number, offsetDays = 0): string {
  const d = new Date(nowMs + 3 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** The last `days` complete Moscow days: from … to (yesterday). */
export function shopDaysWindow(nowMs: number, days: number): { from: string; to: string } {
  const n = Math.min(Math.max(Math.trunc(days) || 5, 1), 31);
  return { from: moscowDate(nowMs, -n), to: moscowDate(nowMs, -1) };
}

/** Turn an Ozon /v1/analytics/data response (dimension: day) into ordered rows.
 *  Every day of the window is present; a day Ozon did not return reads as zeros. */
export function parseShopDays(raw: unknown, from: string, to: string): ShopDay[] {
  const data: any[] = (raw as any)?.result?.data ?? [];
  const byDate = new Map<string, number[]>();
  for (const row of data) {
    const date = String(row?.dimensions?.[0]?.id ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDate.set(date, (row?.metrics ?? []).map((v: unknown) => Number(v) || 0));
  }
  const out: ShopDay[] = [];
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const [orders = 0, revenue = 0, views = 0, carts = 0] = byDate.get(date) ?? [];
    const o = Math.round(orders);
    const r = Math.round(revenue);
    out.push({
      date,
      orders: o,
      revenue_rub: r,
      avg_price_rub: o > 0 ? Math.round(r / o) : null,
      views: Math.round(views),
      carts: Math.round(carts),
    });
  }
  return out;
}
