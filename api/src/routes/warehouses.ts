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

  let sql: string;
  const binds: unknown[] = [];

  if (manufacturerId) {
    // Manufacturer warehouses come from TWO sources, unioned:
    //   1. Direct ownership (warehouses.owner_manufacturer_id) — single owner case
    //   2. M:N junction (warehouse_manufacturers) — shared/consolidation hubs,
    //      e.g. GZH serves Honghui as production + Meizhiyuan/WDAA as consolidation.
    // Additional filters (company_id / partner_id) compose with AND.
    sql = `
      SELECT DISTINCT
        w.id, w.code, w.name, w.country, w.city, w.warehouse_type,
        w.owner_id, w.owner_company_id, w.owner_manufacturer_id, w.owner_partner_id,
        w.notes, w.created_at, w.updated_at
      FROM warehouses w
      LEFT JOIN warehouse_manufacturers wm ON wm.warehouse_id = w.id
      WHERE w.deleted_at IS NULL
        AND (w.owner_manufacturer_id = ? OR wm.manufacturer_id = ?)
    `;
    binds.push(manufacturerId, manufacturerId);

    if (companyId) {
      sql += ' AND w.owner_company_id = ?';
      binds.push(companyId);
    }
    if (partnerId) {
      sql += ' AND w.owner_partner_id = ?';
      binds.push(partnerId);
    }
  } else {
    sql = `
      SELECT
        id, code, name, country, city, warehouse_type,
        owner_id, owner_company_id, owner_manufacturer_id, owner_partner_id,
        notes, created_at, updated_at
      FROM warehouses
      WHERE deleted_at IS NULL
    `;

    if (companyId) {
      sql += ' AND owner_company_id = ?';
      binds.push(companyId);
    }
    if (partnerId) {
      sql += ' AND owner_partner_id = ?';
      binds.push(partnerId);
    }
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
