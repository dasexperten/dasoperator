// =============================================================================
// /api/wb/health — non-destructive probe of both WB tokens against live WB API
//
// Pings one endpoint per relevant API surface and reports the HTTP status for
// each. No data is read or written; rate-limit-friendly (smallest queries).
//
//   WB_API_TOKEN          → statistics-api (sales) + discounts-prices-api
//   WB_API_TOKEN_REVIEWS  → feedbacks-api (questions count)
//
// Status helps tell apart: token missing (no_secret), token invalid (401),
// scope mismatch (403), throttled (429), or healthy (200).
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';

const wbHealth = new Hono<{ Bindings: Env }>();

interface ProbeResult {
  endpoint: string;
  status: number | null;
  label: string;
  ok: boolean;
  hint?: string;
}

function hintFor(status: number | null): string | undefined {
  if (status === null) return 'no_secret_or_network_error';
  if (status === 200) return undefined;
  if (status === 401) return 'token_invalid_or_revoked';
  if (status === 403) return 'token_lacks_required_scope';
  if (status === 429) return 'rate_limited_by_wb';
  if (status >= 500) return 'wb_upstream_error';
  return 'unexpected_status';
}

async function probe(
  url: string,
  token: string | undefined,
  label: string
): Promise<ProbeResult> {
  if (!token) {
    return { endpoint: url, status: null, label, ok: false, hint: 'no_secret' };
  }
  try {
    const res = await fetch(url, { headers: { Authorization: token } });
    const status = res.status;
    // Drain body so the connection closes cleanly.
    try { await res.text(); } catch { /* ignore */ }
    return {
      endpoint: url,
      status,
      label,
      ok: status === 200,
      hint: hintFor(status),
    };
  } catch (err) {
    return {
      endpoint: url,
      status: null,
      label,
      ok: false,
      hint: `fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

wbHealth.get('/', async (c) => {
  const mainToken = c.env.WB_API_TOKEN;
  // Tamara lane preferred (Owner 2026-07-20)
  const reviewsToken =
    c.env.TAMARA_WB_API_TOKEN_REVIEWS || c.env.WB_API_TOKEN_REVIEWS;
  const reviewsLabel = c.env.TAMARA_WB_API_TOKEN_REVIEWS
    ? 'TAMARA_WB_API_TOKEN_REVIEWS → feedbacks-api/questions'
    : 'WB_API_TOKEN_REVIEWS → feedbacks-api/questions';

  // Use the smallest, cheapest available query on each surface.
  const probes = await Promise.all([
    probe(
      'https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=2026-05-23',
      mainToken,
      'WB_API_TOKEN → statistics-api/sales'
    ),
    probe(
      'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1',
      mainToken,
      'WB_API_TOKEN → discounts-prices-api'
    ),
    probe(
      'https://common-api.wildberries.ru/ping',
      mainToken,
      'WB_API_TOKEN → common-api/ping'
    ),
    probe(
      'https://feedbacks-api.wildberries.ru/api/v1/questions/count?isAnswered=false',
      reviewsToken,
      reviewsLabel
    ),
  ]);

  const main = probes.filter((p) => p.label.startsWith('WB_API_TOKEN '));
  const reviews = probes.filter(
    (p) =>
      p.label.startsWith('WB_API_TOKEN_REVIEWS') ||
      p.label.startsWith('TAMARA_WB_API_TOKEN_REVIEWS'),
  );

  // Treat 429 as "working but throttled" — token itself is fine.
  const isHealthy = (p: ProbeResult) => p.status === 200 || p.status === 429;

  return c.json({
    ok: probes.every(isHealthy),
    main_token: {
      configured: !!mainToken,
      healthy: main.every(isHealthy),
      probes: main,
    },
    reviews_token: {
      configured: !!reviewsToken,
      healthy: reviews.every(isHealthy),
      probes: reviews,
    },
    checked_at: new Date().toISOString(),
  });
});

export default wbHealth;
