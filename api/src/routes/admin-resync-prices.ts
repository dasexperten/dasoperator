// =============================================================================
// Admin — Resync D1 product_prices from Pricer .md pricelists in R2.
//
// Flow (button "Resync prices" on /products):
//   R2 das-pricelists/<file> → parse SKU→base price → per product:
//     base SKU  = file price
//     pack SKU  = base price × bundle_size  (2in1 → ×2, 4in1 → ×4)
//   → upsert D1 product_prices (close active row, insert new), keep history.
//
// Source of truth stays Pricer .md (uploaded to R2 by the daily sync script).
// D1 is the served cache read by /api/pricer/list/:type.
//
// Guard: valid admin session (Authorization: Bearer <session token>).
// Body: { apply?: boolean, price_types?: string[] }  — apply=false ⇒ dry-run.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';
import { validateSession } from '../lib/auth';

const resync = new Hono<{ Bindings: Env }>();

// price_type_id → source .md in R2 (PRICELISTS binding = das-pricelists)
const SOURCE: Record<string, string> = {
  distr_usd: 'PL-INT_USD.md',   // FOB Guangzhou international USD
  distr_rub: 'PL-DISTR_RF.md',  // Russia distributor RUB
};

// Base prices for SKUs absent from the .md files (edited here, by decision).
const OVERRIDES: Record<string, Record<string, number>> = {
  distr_rub: { de117: 79, de131: 79, de310: 127 }, // ZERO/3D = GROSSE; MW = SYMBIOS
  distr_usd: { de310: 1.25 },                        // MW = SYMBIOS
};

interface ProductRow { id: string; base_sku: string | null; bundle_size: number | null; }
interface PriceRow { product_id: string; sell_price: number; }
interface Change { price_type: string; product_id: string; from: number | null; to: number; }

function parsePricelist(md: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || t.includes('---')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
    if (cells.length === 0 || !/^DE\d+$/i.test(cells[0])) continue;
    for (let i = cells.length - 1; i >= 1; i--) {
      const v = cells[i].replace(',', '.');
      if (/^\d+(\.\d+)?$/.test(v)) { out[cells[0].toLowerCase()] = parseFloat(v); break; }
    }
  }
  return out;
}

resync.post('/resync-prices', async (c) => {
  // --- auth: admin session ---
  const authz = c.req.header('Authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const user = await validateSession(c.env.DB, token);
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  if (user.role !== 'admin') return fail(c, 403, [{ code: 'forbidden', message: 'admin role required' }]);

  let body: { apply?: boolean; price_types?: string[] } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* empty body ⇒ dry-run all */ }
  const apply = body.apply === true;
  const wantTypes = Array.isArray(body.price_types) && body.price_types.length
    ? body.price_types : Object.keys(SOURCE);

  const now = Math.floor(Date.now() / 1000);

  try {
    const productsRes = await c.env.DB.prepare(
      'SELECT id, base_sku, bundle_size FROM products WHERE deleted_at IS NULL'
    ).all<ProductRow>();
    const products = productsRes.results ?? [];

    const summary: Array<Record<string, unknown>> = [];
    const changesAll: Change[] = [];

    for (const ptype of wantTypes) {
      const file = SOURCE[ptype];
      if (!file) { summary.push({ price_type: ptype, error: 'no source file mapped' }); continue; }

      const obj = await c.env.PRICELISTS.get(file);
      if (!obj) { summary.push({ price_type: ptype, error: `R2 file ${file} not found` }); continue; }
      const base = parsePricelist(await obj.text());
      Object.assign(base, OVERRIDES[ptype] || {});

      const activeRes = await c.env.DB.prepare(
        `SELECT product_id, sell_price FROM product_prices
         WHERE price_type_id = ?1 AND (effective_until IS NULL OR effective_until > ?2)`
      ).bind(ptype, now).all<PriceRow>();
      const active: Record<string, number> = {};
      for (const r of activeRes.results ?? []) active[r.product_id] = r.sell_price;

      const currency = ptype.endsWith('usd') ? 'USD' : ptype.endsWith('rub') ? 'RUB' : 'USD';
      const changes: Change[] = [];
      for (const p of products) {
        const key = p.base_sku || p.id;
        if (!(key in base)) continue;
        const bs = p.bundle_size || 1;
        const target = Math.round(base[key] * bs * 100) / 100;
        const cur = active[p.id];
        if (cur === undefined || Math.abs(Number(cur) - target) > 0.005) {
          changes.push({ price_type: ptype, product_id: p.id, from: cur ?? null, to: target });
        }
      }

      if (apply) {
        for (const ch of changes) {
          await c.env.DB.prepare(
            `UPDATE product_prices SET effective_until = ?3, updated_at = ?3
             WHERE price_type_id = ?1 AND product_id = ?2
               AND (effective_until IS NULL OR effective_until > ?3)`
          ).bind(ptype, ch.product_id, now).run();
          const id = `pp_${ch.product_id}_${ptype}_${now}`;
          await c.env.DB.prepare(
            `INSERT INTO product_prices
               (id, product_id, price_type_id, sell_price, currency,
                effective_from, effective_until, notes, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?6,?6)`
          ).bind(id, ch.product_id, ptype, ch.to, currency, now,
                 `resync from ${file} by ${user.name}`).run();
        }
      }

      summary.push({ price_type: ptype, source: file, currency, changed: changes.length });
      for (const ch of changes) changesAll.push(ch);
    }

    return ok(c, { dry_run: !apply, applied: apply, summary, changes: changesAll },
      [apply
        ? `Resync applied: ${changesAll.length} price rows updated`
        : `Dry-run: ${changesAll.length} rows would change`]);
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default resync;
