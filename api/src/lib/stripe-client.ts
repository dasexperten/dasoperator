/**
 * Minimal read-only Stripe REST client for the website→ERP mirror.
 *
 * Only the two GET list endpoints the sync needs are wrapped here:
 *   - GET /v1/checkout/sessions
 *   - GET /v1/products  /  GET /v1/prices
 *
 * Stripe's API is form-encoded on the way in (query string) and JSON on the
 * way out. Nested/array query params use the a[b]=v / a[]=v convention.
 * We never write from the ERP — writes stay in the dasexperten-checkout Worker.
 */

const STRIPE_BASE = 'https://api.stripe.com/v1';

export interface StripeListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  url: string;
}

/**
 * Flatten a nested params object into Stripe's bracket query syntax.
 *   { created: { gt: 123 }, expand: ['data.line_items'] }
 *   → created[gt]=123&expand[]=data.line_items
 */
export function encodeStripeQuery(
  params: Record<string, unknown>,
  prefix = '',
  out: string[] = []
): string {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      for (const item of v) out.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
    } else if (typeof v === 'object') {
      encodeStripeQuery(v as Record<string, unknown>, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.join('&');
}

/**
 * GET a Stripe endpoint. Throws on non-2xx with the Stripe error message,
 * mirroring how marketplace-pull surfaces Ozon/WB API failures.
 */
export async function stripeGet<T = unknown>(
  key: string,
  path: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const qs = encodeStripeQuery(params);
  const url = `${STRIPE_BASE}${path}${qs ? `?${qs}` : ''}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': '2024-06-20',
    },
  });
  if (!resp.ok) {
    let detail = await resp.text();
    try {
      const j = JSON.parse(detail) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch {
      /* keep raw body */
    }
    throw new Error(`Stripe API ${resp.status}: ${detail}`);
  }
  return (await resp.json()) as T;
}
