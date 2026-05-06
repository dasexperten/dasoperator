import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const warehouses = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/warehouses — list all warehouses with basic info
// Used by:
//   - /warehouses page (matrix view headers)
//   - /warehouses/[slug] hub
//   - inventory session creation (to pick warehouse)
// =============================================================================
warehouses.get('/', async (c) => {
  // Optional ownership filters — used by operations form to scope dropdowns:
  //   ?company_id=cmp_dee       → only warehouses owned by DEE (Russia 3PLs)
  //   ?manufacturer_id=mfr_jinxia → only Jinxia's factory warehouse (YZH)
  //   ?partner_id=prt_X         → only partner's warehouses (rare; partners
  //                               usually receive via incoterms, no warehouse)
  const companyId = c.req.query('company_id');
  const manufacturerId = c.req.query('manufacturer_id');
  const partnerId = c.req.query('partner_id');

  let sql = `
    SELECT
      id, code, name, country, city, warehouse_type,
      owner_id, owner_company_id, owner_manufacturer_id, owner_partner_id,
      notes, created_at, updated_at
    FROM warehouses
    WHERE deleted_at IS NULL
  `;
  const binds: unknown[] = [];

  if (companyId) {
    sql += ' AND owner_company_id = ?';
    binds.push(companyId);
  }
  if (manufacturerId) {
    sql += ' AND owner_manufacturer_id = ?';
    binds.push(manufacturerId);
  }
  if (partnerId) {
    sql += ' AND owner_partner_id = ?';
    binds.push(partnerId);
  }

  sql += ' ORDER BY code';

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  return ok(c, {
    count: result.results.length,
    warehouses: result.results,
  });
});

// =============================================================================
// GET /api/warehouses/:id — single warehouse with last counted snapshot
// =============================================================================
warehouses.get('/:id', async (c) => {
  const id = c.req.param('id');

  const wh = await c.env.DB.prepare(`
    SELECT
      id, code, name, country, city, warehouse_type,
      owner_id, owner_company_id, owner_manufacturer_id, owner_partner_id,
      notes, created_at, updated_at
    FROM warehouses
    WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first();

  if (!wh) {
    return fail(c, 404, [{ code: 'warehouse_not_found', message: id }]);
  }

  // Latest counted_at across all stocks at this warehouse (max)
  const latest = await c.env.DB.prepare(`
    SELECT MAX(last_counted_at) AS last_counted_at,
           MAX(last_movement_at) AS last_movement_at
    FROM stocks
    WHERE warehouse_id = ?
  `).bind(id).first<{ last_counted_at: number | null; last_movement_at: number | null }>();

  return ok(c, {
    ...wh,
    last_counted_at: latest?.last_counted_at ?? null,
    last_movement_at: latest?.last_movement_at ?? null,
  });
});

export default warehouses;
