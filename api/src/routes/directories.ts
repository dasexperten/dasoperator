// =============================================================================
// GET /api/companies      — list of internal entities (DEE, DEI, DEASEAN, DEC)
// GET /api/manufacturers  — list of factory suppliers
// Used by /operations/new form for Purchase / Transfer dropdowns.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';

interface Company {
  id: string;
  abbreviation: string | null;
  legal_name: string;
  jurisdiction: string | null;
}

interface Manufacturer {
  id: string;
  name: string;
  country: string | null;
}

const directories = new Hono<{ Bindings: Env }>();

directories.get('/companies', async (c) => {
  // DEC is a holding entity — never participates in Purchase/Sale operations.
  // Exclude from operational dropdowns (operations, contracts).
  const result = await c.env.DB.prepare(`
    SELECT id, abbreviation, legal_name, jurisdiction
    FROM companies
    WHERE deleted_at IS NULL
      AND abbreviation != 'DEC'
    ORDER BY abbreviation, id
  `).all<Company>();

  return ok(c, { count: result.results.length, companies: result.results });
});

directories.get('/manufacturers', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT id, name, country
    FROM manufacturers
    WHERE deleted_at IS NULL
    ORDER BY name
  `).all<Manufacturer>();

  return ok(c, { count: result.results.length, manufacturers: result.results });
});

// =============================================================================
// GET /api/manufacturers/:id/products
// Returns products this factory can produce, via product_manufacturers M:N table.
// Used by Purchase form to filter SKU dropdown by selected factory.
// (Replaces simple products.manufacturer_id filter — needed because paste
// factories Honghui/Meizhiyuan/WDAA all produce the same SKUs.)
// =============================================================================

directories.get('/manufacturers/:id/products', async (c) => {
  const mfrId = c.req.param('id');

  const result = await c.env.DB.prepare(`
    SELECT p.id, p.product_name, p.invoice_label, p.category, p.barcode,
           p.manufacturer_id, p.buy_price, p.buy_currency
    FROM product_manufacturers pm
    INNER JOIN products p ON p.id = pm.product_id
    WHERE pm.manufacturer_id = ?
      AND p.deleted_at IS NULL
    ORDER BY p.id
  `).bind(mfrId).all();

  return ok(c, { count: result.results.length, products: result.results });
});

export default directories;
