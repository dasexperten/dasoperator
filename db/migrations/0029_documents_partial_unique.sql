-- =============================================================================
-- 0029_documents_partial_unique.sql
-- Replace the implicit UNIQUE on documents.document_number with a partial
-- unique index that ignores soft-deleted rows. This unblocks re-issue:
-- the upstream flow soft-deletes prior docs then inserts new ones with the
-- same deterministic reference (e.g. PL-DEI-260009). Without this change
-- the simple UNIQUE constraint rejects the new row.
-- =============================================================================

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- 1. Build a replacement table identical to documents but WITHOUT the
--    column-level UNIQUE on document_number.
CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  document_number TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('CI','PL','IS','UPD','TN','contract','annex','addendum','other')),
  operation_id TEXT,
  issuer_id TEXT NOT NULL,
  partner_id TEXT,
  contract_ref TEXT,
  document_date INTEGER NOT NULL,
  currency TEXT,
  total_amount INTEGER,
  pdf_r2_url TEXT,
  owner_name TEXT,
  mandatory_level TEXT CHECK (mandatory_level IN ('mandatory','important','on_request') OR mandatory_level IS NULL),
  when_ready TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  pdf_converted_r2_url TEXT,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (issuer_id) REFERENCES companies(id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT
);

-- 2. Copy everything.
INSERT INTO documents_new SELECT * FROM documents;

-- 3. Swap.
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

-- 4. Recreate the uniqueness guarantee as a PARTIAL index: only live rows
--    must have unique numbers. Soft-deleted rows are excluded.
CREATE UNIQUE INDEX idx_documents_number_live
  ON documents (document_number)
  WHERE deleted_at IS NULL;

-- 5. Helpful operational indexes preserved/created.
CREATE INDEX IF NOT EXISTS idx_documents_operation
  ON documents (operation_id);

CREATE INDEX IF NOT EXISTS idx_documents_issuer
  ON documents (issuer_id);

CREATE INDEX IF NOT EXISTS idx_documents_partner
  ON documents (partner_id);

COMMIT;

PRAGMA foreign_keys = ON;
