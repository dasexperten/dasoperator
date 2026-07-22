-- =============================================================================
-- 0063 — COGS-RU price type (Justina + Zina landed cost for Russia)
--
-- Owner 2026-07-22: create price type COGS-RU (RUB) = factory + freight 20'GP
-- + duty (paste 6.5% / brush+floss 15%) + Honest Sign 3 RUB per paste tube.
-- Import VAT 22% is NOT included in COGS.
--
-- Recompute: POST /api/admin/cogs-ru/recompute  (or product_prices seed script)
-- Idempotent: INSERT OR IGNORE so re-run on already-seeded D1 is safe.
-- =============================================================================

INSERT OR IGNORE INTO price_types (
  id, code, description, currency, used_by_entity, active, created_at, updated_at
) VALUES (
  'cogs_ru',
  'COGS-RU',
  'Russia landed COGS (Justina+Zina): factory + freight 20GP + duty 6.5%/15% + Honest Sign 3 RUB/paste tube. Import VAT 22% NOT included.',
  'RUB',
  'DEE',
  1,
  strftime('%s','now'),
  strftime('%s','now')
);
