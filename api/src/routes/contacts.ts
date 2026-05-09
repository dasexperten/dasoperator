import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { queryFirst } from '../lib/db';

// =============================================================================
// GET /api/contacts/:slug
// Returns: full record from partners (preferred) / companies / warehouses.
//
// After Phase 8.0 clean-break, all IDs are prefix-free. Routing strategy:
//   1. Look up partners first (covers buyer/manufacturer/shipper/3pl/service).
//   2. If not found, try companies (entities like dee/dei/dasean/dec).
//   3. If not found, try warehouses (lbr/flp/srn/dgn etc).
//   4. Otherwise 404.
//
// Optional `?type=company|partner|warehouse` forces a specific table lookup.
// =============================================================================

const contacts = new Hono<{ Bindings: Env }>();

type ContactType = 'company' | 'partner' | 'warehouse';

interface ContactResult {
  type: ContactType;
  data: Record<string, unknown>;
}

async function lookupPartner(db: D1Database, id: string) {
  return queryFirst<Record<string, unknown>>(
    db,
    'SELECT * FROM partners WHERE id = ? AND deleted_at IS NULL',
    id
  );
}

async function lookupCompany(db: D1Database, id: string) {
  return queryFirst<Record<string, unknown>>(
    db,
    'SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL',
    id
  );
}

async function lookupWarehouse(db: D1Database, id: string) {
  return queryFirst<Record<string, unknown>>(
    db,
    'SELECT * FROM warehouses WHERE id = ? AND deleted_at IS NULL',
    id
  );
}

contacts.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const explicitType = c.req.query('type') as ContactType | undefined;

  if (!slug || slug.length < 2) {
    return fail(c, 400, [{
      code: 'invalid_slug',
      message: 'Slug must be a non-empty identifier',
    }]);
  }

  let result: Record<string, unknown> | null = null;
  let type: ContactType | null = null;

  if (explicitType === 'company') {
    result = await lookupCompany(c.env.DB, slug);
    type = 'company';
  } else if (explicitType === 'warehouse') {
    result = await lookupWarehouse(c.env.DB, slug);
    type = 'warehouse';
  } else if (explicitType === 'partner') {
    result = await lookupPartner(c.env.DB, slug);
    type = 'partner';
  } else {
    // Fallback chain: partners → companies → warehouses
    result = await lookupPartner(c.env.DB, slug);
    if (result) {
      type = 'partner';
    } else {
      result = await lookupCompany(c.env.DB, slug);
      if (result) {
        type = 'company';
      } else {
        result = await lookupWarehouse(c.env.DB, slug);
        if (result) type = 'warehouse';
      }
    }
  }

  if (!result || !type) {
    return fail(c, 404, [{
      code: 'not_found',
      message: `No contact found for id "${slug}"`,
    }]);
  }

  const payload: ContactResult = { type, data: result };
  return ok(c, payload);
});

export default contacts;
