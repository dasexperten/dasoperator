-- =============================================================================
-- 0063a — COGS-RU price type (Justina + Zina landed cost for Russia)
--
-- Owner 2026-07-22: create price type COGS-RU (RUB) = factory + freight 20'GP
-- + duty (paste 6.5% / brush+floss 15%) + Honest Sign 3 RUB per paste tube.
-- Import VAT 22% is NOT included in COGS.
--
-- Renumbered 0063 → 0063a on 2026-08-03 (Mina): two files shared the 0063
-- prefix (this one and 0063_ozon_discount_tasks.sql), which kept the CI guard
-- scripts/check-migration-numbers.sh red on every commit and made apply order
-- depend on the runner's sort. Suffix form matches the historic 0014a fix.
-- Nothing re-applies: migrations run one file at a time via workflow_dispatch,
-- there is no applied-ledger keyed on filename, and this file is idempotent.
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
