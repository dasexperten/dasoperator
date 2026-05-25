-- =============================================================================
-- Migration 0047 — recreate bank_statement_files
--
-- Background:
-- bank_transactions.source_file_id has FK REFERENCES bank_statement_files(id).
-- The bank_statement_files table was dropped (likely during a parallel-chat
-- cleanup) without removing the FK from bank_transactions. SQLite with
-- foreign_keys=ON (default in D1) fails any INSERT into bank_transactions
-- with "no such table: main.bank_statement_files" — even when source_file_id
-- is NULL. This broke hourly Modulbank pull-sync starting 2026-05-22 16:15 UTC.
--
-- Fix: recreate the table with minimal schema sufficient to satisfy the FK.
-- No data is restored (none was preserved). Future PDF-statement ingestion
-- code can extend this table via further migrations.
--
-- Applied to prod D1 on 2026-05-25 09:50 UTC (direct REST call).
-- This file is the canonical source of truth for clone reproducibility.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bank_statement_files (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'pdf_upload',
  filename TEXT,
  r2_key TEXT,
  file_size INTEGER,
  uploaded_at INTEGER NOT NULL,
  uploaded_by TEXT,
  period_from INTEGER,
  period_till INTEGER,
  rows_total INTEGER DEFAULT 0,
  rows_inserted INTEGER DEFAULT 0,
  rows_updated INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  raw_meta TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bsf_bank_account ON bank_statement_files(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bsf_uploaded_at ON bank_statement_files(uploaded_at DESC);
