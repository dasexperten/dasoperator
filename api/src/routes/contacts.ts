import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { queryFirst } from '../lib/db';

// =============================================================================
// GET /api/contacts/:slug
// Returns: full record from companies / partners / manufacturers / shippers
// Slug prefix determines table:
//   cmp_*   → companies
//   mfr_*   → manufacturers
//   shp_*   → shippers
//   wh_*    → warehouses
//   <bare>  → partners (no prefix after Phase 4.3c-clean)
// =============================================================================

const contacts = new Hono<{ Bindings: Env }>();

interface ContactResult {
  type: 'company' | 'partner' | 'manufacturer' | 'shipper' | 'warehouse';
  data: Record<string, unknown>;
}

contacts.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  if (!slug || slug.length < 2) {
    return fail(c, 400, [{
      code: 'invalid_slug',
      message: 'Slug must be a non-empty identifier',
    }]);
  }

  const prefix = slug.split('_')[0];

  let result: Record<string, unknown> | null = null;
  let type: ContactResult['type'] | null = null;

  switch (prefix) {
    case 'cmp':
      result = await queryFirst(
        c.env.DB,
        'SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL',
        slug
      );
      type = 'company';
      break;
    case 'mfr':
      result = await queryFirst(
        c.env.DB,
        'SELECT * FROM manufacturers WHERE id = ? AND deleted_at IS NULL',
        slug
      );
      type = 'manufacturer';
      break;
    case 'shp':
      result = await queryFirst(
        c.env.DB,
        'SELECT * FROM shippers WHERE id = ? AND deleted_at IS NULL',
        slug
      );
      type = 'shipper';
      break;
    case 'wh':
      result = await queryFirst(
        c.env.DB,
        'SELECT * FROM warehouses WHERE id = ? AND deleted_at IS NULL',
        slug
      );
      type = 'warehouse';
      break;
    default:
      // No matching prefix → assume bare partner slug (Phase 4.3c-clean)
      result = await queryFirst(
        c.env.DB,
        'SELECT * FROM partners WHERE id = ? AND deleted_at IS NULL',
        slug
      );
      type = 'partner';
      break;
  }

  if (!result) {
    return fail(c, 404, [{
      code: 'contact_not_found',
      message: `No ${type} found with slug ${slug}`,
    }]);
  }

  return ok(c, { type, data: result });
});

export default contacts;
