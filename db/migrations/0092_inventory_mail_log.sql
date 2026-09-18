-- inventory@dasexperten.com: one row per letter with a stock list (Owner 2026-09-18).
-- The letter's counts become an inventory session of the named warehouse.
CREATE TABLE IF NOT EXISTS inventory_mail_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  TEXT    NOT NULL,
  from_addr    TEXT,
  subject      TEXT,
  message_id   TEXT,
  warehouse_id TEXT,
  session_id   TEXT,
  reference    TEXT,
  status       TEXT    NOT NULL,   -- committed | held | failed
  rows_total   INTEGER NOT NULL DEFAULT 0,
  rows_matched INTEGER NOT NULL DEFAULT 0,
  unmatched    TEXT,               -- JSON: lines the model could not tie to a product
  reason       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_mail_msg ON inventory_mail_log (message_id);
