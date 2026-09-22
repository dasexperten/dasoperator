-- 0095 — Vietnam retail e-invoice outbox and immutable provider-attempt log.
--
-- Architecture: platform -> SwiftHub -> our ERP -> SoftDreams EasyInvoice.
-- One normal invoice per SwiftHub order is enforced in D1. An uncertain
-- provider submission is verified by Ikey and is never blindly re-issued.

CREATE TABLE IF NOT EXISTS vn_einvoice_documents (
  id                    TEXT PRIMARY KEY,
  source                TEXT NOT NULL DEFAULT 'swifthub',
  source_event_id       TEXT NOT NULL UNIQUE,
  source_order_id       TEXT NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('issue','adjust','replace','cancel')),
  ikey                  TEXT NOT NULL UNIQUE,
  original_ikey         TEXT,
  pattern               TEXT,
  serial                TEXT,
  state                 TEXT NOT NULL CHECK (state IN (
                          'received','blocked_config','checking','submitting',
                          'verify_pending','issued','issued_archive_pending',
                          'cancelled','failed_terminal','manual_review'
                        )),
  provider_status       INTEGER,
  provider_error_code   TEXT,
  provider_message      TEXT,
  invoice_no            TEXT,
  lookup_code           TEXT,
  request_r2_key        TEXT NOT NULL,
  response_r2_key       TEXT,
  provider_xml_r2_key   TEXT,
  provider_pdf_r2_key   TEXT,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  verify_count          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  issued_at             INTEGER,
  completed_at          INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vn_einvoice_issue_order
  ON vn_einvoice_documents(source, source_order_id)
  WHERE action = 'issue';

CREATE INDEX IF NOT EXISTS idx_vn_einvoice_state_due
  ON vn_einvoice_documents(state, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_vn_einvoice_order
  ON vn_einvoice_documents(source, source_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vn_einvoice_attempts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id           TEXT NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN ('preflight','submit','verify','archive_xml','archive_pdf')),
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  http_status           INTEGER,
  provider_status       INTEGER,
  provider_error_code   TEXT,
  outcome               TEXT NOT NULL,
  detail                TEXT,
  response_r2_key       TEXT,
  FOREIGN KEY (document_id) REFERENCES vn_einvoice_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vn_einvoice_attempts_document
  ON vn_einvoice_attempts(document_id, started_at DESC);

