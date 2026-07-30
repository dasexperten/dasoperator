-- Planner locks — persistence for the Law of the Lock (HARD_RULES §5b.1, Owner 2026-07-29).
--
-- A hand-entered carton figure is final and is never recalculated, including zero.
-- Until now the lock lived in React state and died on page reload, so the law held
-- for exactly one browsing session. This makes it survive.
--
-- A manual zero is a decision not to order — it is the mechanism for "do not reorder"
-- (Owner 2026-07-30: no separate lifecycle status, the lock carries it).

CREATE TABLE IF NOT EXISTS planner_locks (
  id            TEXT PRIMARY KEY,
  group_name    TEXT NOT NULL,
  base_sku      TEXT NOT NULL,
  cartons       INTEGER NOT NULL,
  reason        TEXT,
  locked_by     TEXT NOT NULL DEFAULT 'owner',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (group_name, base_sku)
);

CREATE INDEX IF NOT EXISTS idx_planner_locks_group ON planner_locks(group_name);

-- EVOLUTION: not to be reordered. Ozon storage fees forced a clearance in June 2026
-- (3 835 units, 66 % of seven months) which lifted measured velocity to 69.3/day
-- against a true ~11. Stock covers roughly nine hundred days.
INSERT OR REPLACE INTO planner_locks (id, group_name, base_sku, cartons, reason, locked_by, created_at, updated_at)
VALUES (
  'lock_de208_honghui',
  'Honghui Daily',
  'de208',
  0,
  'Не заказывать. Распродажа на Озоне из-за платы за хранение, июнь 2026 — скорость продаж завышена. Owner 2026-07-30.',
  'owner',
  unixepoch('now'),
  unixepoch('now')
);
