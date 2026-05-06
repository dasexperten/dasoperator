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
  const result = await c.env.DB.prepare(`
    SELECT id, abbreviation, legal_name, jurisdiction
    FROM companies
    WHERE deleted_at IS NULL
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

export default directories;
