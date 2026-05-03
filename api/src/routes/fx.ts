import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { todayUtcDate, refreshFxFromCbr, applyFxToAmount, getRateToUsdNano } from '../lib/fx-cbr';
import { storeSnapshot, readSnapshot, readLatestPointer, getRatesFor } from '../lib/fx-store';

const fx = new Hono<{ Bindings: Env }>();

const refreshSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const backfillSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

const DATE_PARAM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// =============================================================================
// POST /api/fx/refresh
// Pulls CBR for given date (or today UTC), caches in KV.
// =============================================================================
fx.post('/refresh', async (c) => {
  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON or empty' }]);
  }

  const parsed = refreshSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const date = parsed.data.date ?? todayUtcDate();

  const snapshot = await refreshFxFromCbr(date);
  if (!snapshot) {
    return fail(c, 502, [{
      code: 'cbr_unreachable',
      message: `Failed to fetch CBR feed for ${date}`,
    }]);
  }

  await storeSnapshot(c.env.FX, snapshot);

  return ok(c, {
    date: snapshot.date,
    source: snapshot.source,
    fetched_at: snapshot.fetched_at,
    rates_count: Object.keys(snapshot.rates).length,
    rates: snapshot.rates,
  });
});

// =============================================================================
// GET /api/fx/rates/:date
// Returns cached snapshot for date or 404.
// =============================================================================
fx.get('/rates/:date', async (c) => {
  const date = c.req.param('date');
  if (!DATE_PARAM_PATTERN.test(date)) {
    return fail(c, 422, [{
      code: 'invalid_date',
      message: 'Date must be in YYYY-MM-DD format',
    }]);
  }

  const snapshot = await readSnapshot(c.env.FX, date);
  if (!snapshot) {
    return fail(c, 404, [{
      code: 'fx_not_cached',
      message: `No FX snapshot cached for ${date}. Try POST /api/fx/refresh first.`,
    }]);
  }

  return ok(c, snapshot);
});

// =============================================================================
// GET /api/fx/latest
// Returns most recent cached snapshot.
// =============================================================================
fx.get('/latest', async (c) => {
  const latestDate = await readLatestPointer(c.env.FX);
  if (!latestDate) {
    return fail(c, 404, [{
      code: 'fx_no_data',
      message: 'No FX data cached yet. Call POST /api/fx/refresh first.',
    }]);
  }

  const snapshot = await readSnapshot(c.env.FX, latestDate);
  if (!snapshot) {
    return fail(c, 500, [{
      code: 'fx_pointer_stale',
      message: `Latest pointer references ${latestDate} but snapshot missing`,
    }]);
  }

  return ok(c, snapshot);
});

// =============================================================================
// POST /api/fx/backfill
// Recomputes total_usd_equiv for operations where it is NULL.
// =============================================================================
fx.post('/backfill', async (c) => {
  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON or empty' }]);
  }

  const parsed = backfillSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const limit = parsed.data.limit;

  const opsToBackfill = await c.env.DB.prepare(`
    SELECT id, operation_date, currency, total_amount
    FROM operations
    WHERE total_usd_equiv IS NULL
      AND deleted_at IS NULL
      AND currency IS NOT NULL
      AND total_amount IS NOT NULL
    ORDER BY operation_date DESC
    LIMIT ?
  `).bind(limit).all<{
    id: string;
    operation_date: number;
    currency: string;
    total_amount: number;
  }>();

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  const now = Math.floor(Date.now() / 1000);

  for (const op of opsToBackfill.results) {
    processed++;

    const dateStr = isoDate(op.operation_date);
    const snapshot = await getRatesFor(c.env.FX, dateStr);

    if (!snapshot) {
      skipped++;
      errors.push({ id: op.id, reason: `fx_unavailable for date ${dateStr}` });
      continue;
    }

    const rateNano = getRateToUsdNano(snapshot, op.currency);
    if (rateNano === null) {
      skipped++;
      errors.push({ id: op.id, reason: `currency ${op.currency} not in feed` });
      continue;
    }

    const usdEquiv = applyFxToAmount(op.total_amount, rateNano, op.currency);

    try {
      await c.env.DB.prepare(`
        UPDATE operations
        SET fx_rate_to_usd = ?,
            total_usd_equiv = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(rateNano, usdEquiv, now, op.id).run();
      updated++;
    } catch (err) {
      skipped++;
      errors.push({
        id: op.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return ok(c, {
    processed,
    updated,
    skipped,
    errors: errors.slice(0, 20),
  });
});

function isoDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export default fx;
