// =============================================================================
// /api/freight-rfq
//   GET  /shippers                          list freight forwarders
//   POST /operations/:operation_id/issue    create RFQ document for an operation
//
// RFQ documents land in the standard `documents` table (document_type='RFQ')
// and are downloadable through the existing /api/documents/:id/download
// endpoint — no special download path.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueRfq } from '../skills/freight-rfq';

const freightRfq = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// GET /api/freight-rfq/shippers
// Returns all partners.kind='shipper' available for the operation's RFQ form.
// -----------------------------------------------------------------------------
freightRfq.get('/shippers', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT id, slug, trade_name, legal_name_en, email, country
    FROM partners
    WHERE kind = 'shipper' AND deleted_at IS NULL
    ORDER BY trade_name ASC
  `).all<{
    id: string;
    slug: string;
    trade_name: string;
    legal_name_en: string | null;
    email: string | null;
    country: string | null;
  }>();

  return ok(c, { shippers: rows.results ?? [] });
});

// -----------------------------------------------------------------------------
// POST /api/freight-rfq/operations/:operation_id/issue
// Body:
//   shipper_id              required — partners.id with kind='shipper'
//   requested_pickup_date   optional — unix seconds
//   notes                   optional — free text
// -----------------------------------------------------------------------------
const issueSchema = z.object({
  shipper_id: z.string().min(1, 'shipper_id is required'),
  requested_pickup_date: z.number().int().positive().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

freightRfq.post('/operations/:operation_id/issue', async (c) => {
  const operationId = c.req.param('operation_id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const outcome = await issueRfq(
    operationId,
    parsed.data.shipper_id,
    c.env,
    c.req.url,
    {
      requestedPickupDate: parsed.data.requested_pickup_date ?? null,
      notes: parsed.data.notes ?? null,
    },
  );

  if (!outcome.success) {
    const err = outcome.errors[0];
    const code = err?.code ?? 'unknown';
    const status =
      code === 'operation_not_found' || code === 'shipper_not_found' || code === 'issuer_not_found' ? 404 :
      code === 'invalid_body' ? 422 :
      500;
    return fail(c, status, outcome.errors);
  }

  return ok(c, outcome.result);
});

export default freightRfq;
