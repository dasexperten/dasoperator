-- 0039: Transfer batches — group F4-WH-R individual operations by (date, marketplace).
-- 
-- Aram law (2026-05-15):
--   "Один день → один трансфер OZN-YYMMDD или WB-YYMMDD"
--   "Внутри одного трансфера — список индивидуальных F4-WH-R как документов/строк"
--
-- Approach: create operation_batches as parent rows, add batch_id FK to operations.
-- Existing F4-WH-R operations retain their identity but get linked under a batch.
-- UI groups by batch_id at render time. Operations table CHECK constraints unchanged.
--
-- Owned by main chat. operations.operation_type CHECK constraint NOT touched
-- (parallel chat territory).
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS operation_batches (
  id              TEXT PRIMARY KEY,
  batch_reference TEXT NOT NULL,
  marketplace     TEXT NOT NULL CHECK (marketplace IN ('OZN','WB')),
  batch_date      INTEGER NOT NULL,
  our_company_id  TEXT NOT NULL DEFAULT 'dee'
                    REFERENCES companies(id) ON DELETE RESTRICT,
  notes           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at      INTEGER,
  UNIQUE (batch_reference)
);

CREATE INDEX IF NOT EXISTS idx_operation_batches_date ON operation_batches(batch_date);
CREATE INDEX IF NOT EXISTS idx_operation_batches_marketplace ON operation_batches(marketplace);

-- Add nullable FK on operations. NULL means "standalone operation, not part of a batch".
ALTER TABLE operations ADD COLUMN batch_id TEXT
  REFERENCES operation_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operations_batch_id ON operations(batch_id);

PRAGMA foreign_keys = ON;
