// =============================================================================
// Admin — recompute COGS-RU product_prices (Justina + Zina landed cost RU).
//
// POST /api/admin/cogs-ru/recompute
// Body: { apply?: boolean }  — apply=false ⇒ dry-run only
//
// Reads purchasing prices (purchase_cny preferred, else export_usd Purchasing USD),
// multiplies multipacks via product.bundle_size when only base has a price,
// applies freight + duty + Honest Sign 3 RUB/paste tube, writes RUB into
// product_prices for price_type cogs_ru.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { readLatestPointer, readSnapshot } from '../lib/fx-store';
import { getRateToUsdNano } from '../lib/fx-cbr';
import {
  COGS_RU_PRICE_TYPE_ID,
  computeCogsRu,
} from '../lib/cogs-ru';

const adminCogsRu = new Hono<{ Bindings: Env }>();

interface ProductRow {
  id: string;
  product_name: string;
  category: string | null;
  base_sku: string | null;
  bundle_size: number | null;
}

interface PriceRow {
  product_id: string;
  sell_price: number;
  currency: string;
}

async function ensurePriceType(env: Env): Promise<void> {
  const existing = await env.DB.prepare('SELECT id FROM price_types WHERE id = ?')
    .bind(COGS_RU_PRICE_TYPE_ID)
    .first();
  if (existing) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO price_types (id, code, description, currency, used_by_entity, active, created_at, updated_at)
    VALUES (?, 'COGS-RU',
      'Russia landed COGS (Justina+Zina): factory + freight 20GP + duty 6.5%/15% + Honest Sign 3 RUB/paste tube. Import VAT 22% NOT included.',
      'RUB', 'DEE', 1, ?, ?)
  `).bind(COGS_RU_PRICE_TYPE_ID, now, now).run();
}

async function activePurchaseMap(
  env: Env,
  priceTypeId: string,
): Promise<Map<string, { price: number; currency: string }>> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(`
    SELECT product_id, sell_price, currency
    FROM product_prices
    WHERE price_type_id = ?
      AND effective_from <= ?
      AND (effective_until IS NULL OR effective_until > ?)
  `).bind(priceTypeId, now, now).all<PriceRow>();

  const map = new Map<string, { price: number; currency: string }>();
  for (const r of rows.results || []) {
    map.set(r.product_id, { price: r.sell_price, currency: r.currency });
  }
  return map;
}

function resolveFactoryUsd(
  product: ProductRow,
  cnyMap: Map<string, { price: number; currency: string }>,
  usdMap: Map<string, { price: number; currency: string }>,
  cnyToUsd: number,
): { factoryUsd: number; source: string } | null {
  const bundle = Math.max(1, Math.floor(product.bundle_size || 1));
  const ownCny = cnyMap.get(product.id);
  if (ownCny) {
    return { factoryUsd: ownCny.price * cnyToUsd, source: `purchase_cny ${ownCny.price}` };
  }
  const ownUsd = usdMap.get(product.id);
  if (ownUsd) {
    return { factoryUsd: ownUsd.price, source: `export_usd(purchasing) ${ownUsd.price}` };
  }
  const base = (product.base_sku || '').toLowerCase();
  if (base) {
    const baseCny = cnyMap.get(base);
    if (baseCny) {
      return {
        factoryUsd: baseCny.price * cnyToUsd * bundle,
        source: `base ${base} purchase_cny ×${bundle}`,
      };
    }
    const baseUsd = usdMap.get(base);
    if (baseUsd) {
      return {
        factoryUsd: baseUsd.price * bundle,
        source: `base ${base} export_usd ×${bundle}`,
      };
    }
  }
  return null;
}

adminCogsRu.post('/cogs-ru/recompute', async (c) => {
  let body: { apply?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body = dry-run-ish apply true default for ops */
  }
  const apply = body.apply !== false; // default true when omitted; set apply:false for dry-run

  await ensurePriceType(c.env);

  const latestDate = await readLatestPointer(c.env.FX);
  const fxSnap = latestDate ? await readSnapshot(c.env.FX, latestDate) : null;
  if (!fxSnap) {
    return fail(c, 503, [{ code: 'fx_unavailable', message: 'No CBR FX snapshot in KV' }]);
  }
  const rubToUsdNano = getRateToUsdNano(fxSnap, 'RUB');
  const cnyToUsdNano = getRateToUsdNano(fxSnap, 'CNY');
  if (!rubToUsdNano || !cnyToUsdNano) {
    return fail(c, 503, [{ code: 'fx_incomplete', message: 'Missing RUB or CNY rate' }]);
  }
  const rubPerUsd = 1e9 / rubToUsdNano;
  const cnyToUsd = cnyToUsdNano / 1e9;

  const products = await c.env.DB.prepare(`
    SELECT id, product_name, category, base_sku, bundle_size
    FROM products
    WHERE deleted_at IS NULL
    ORDER BY id
  `).all<ProductRow>();

  const cnyMap = await activePurchaseMap(c.env, 'purchase_cny');
  const usdMap = await activePurchaseMap(c.env, 'export_usd');

  const now = Math.floor(Date.now() / 1000);
  const written: Array<Record<string, unknown>> = [];
  const gaps: Array<{ product_id: string; name: string; reason: string }> = [];

  for (const p of products.results || []) {
    const fac = resolveFactoryUsd(p, cnyMap, usdMap, cnyToUsd);
    if (!fac) {
      gaps.push({ product_id: p.id, name: p.product_name, reason: 'no purchasing price' });
      continue;
    }
    const br = computeCogsRu({
      productId: p.id,
      category: p.category,
      bundleSize: p.bundle_size || 1,
      factoryUsd: fac.factoryUsd,
      rubPerUsd,
    });
    const note =
      `COGS-RU Justina+Zina | ${fac.source} | fr$${br.freight_usd.toFixed(4)} ` +
      `duty${br.duty_rate * 100}% CZ${br.mark_rub}R | FX${latestDate} no import VAT`;

    if (apply) {
      // close active rows
      await c.env.DB.prepare(`
        UPDATE product_prices
        SET effective_until = ?, updated_at = ?
        WHERE product_id = ?
          AND price_type_id = ?
          AND (effective_until IS NULL OR effective_until > ?)
          AND effective_from < ?
      `).bind(now - 1, now, p.id, COGS_RU_PRICE_TYPE_ID, now, now).run();

      const id = `price_${crypto.randomUUID()}`;
      await c.env.DB.prepare(`
        INSERT INTO product_prices
          (id, product_id, price_type_id, sell_price, currency, effective_from, effective_until, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'RUB', ?, NULL, ?, ?, ?)
      `).bind(id, p.id, COGS_RU_PRICE_TYPE_ID, br.cogs_rub, now, note.slice(0, 500), now, now).run();
    }

    written.push({
      product_id: p.id,
      name: p.product_name,
      cogs_rub: br.cogs_rub,
      ...br,
      factory_source: fac.source,
    });
  }

  return ok(c, {
    apply,
    fx_date: latestDate,
    rub_per_usd: rubPerUsd,
    price_type_id: COGS_RU_PRICE_TYPE_ID,
    written_count: written.length,
    gap_count: gaps.length,
    written,
    gaps,
  });
});

export default adminCogsRu;
