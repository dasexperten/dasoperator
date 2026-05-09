-- Phase 9.x — Invoice Inbox foundation
-- Applied to D1 prod via REST API on 2026-05-09.
--
-- Background: every night at 03:00 МСК a Cloudflare cron Worker pulls
-- yesterday's emails from dasexperten@gmail.com via Apps Script, tries
-- to classify and extract invoice data with DeepSeek, and writes results
-- here. Conservative profile: only confident matches against known
-- partners create operations; everything else queues for manual review.
--
-- Three classifications:
--   A — service:      vendor invoice (accountant, lawyer, hosting, ads)
--   B — purchase:     supplier invoice (Honghui, Jinxia, etc.)
--   C — sale_payment: client says they paid one of OUR invoices
--
-- Decisions locked from 2026-05-09 chat:
--   Q3=Y  each line item → separate operation (no multi-line ops)
--   Q4=R  unknown partner → no operation, queue for manual link
--   Q5=T  uncertain extraction → no operation, alert digest
--   Q6=N2 cron at 03:00 МСК
--   Q7=C1 sale_payment creates payment_pending (amber dot)

-- =============================================================================
-- invoice_inbox — audit log of every processed email
-- =============================================================================
CREATE TABLE IF NOT EXISTS invoice_inbox (
  id                       TEXT PRIMARY KEY,           -- inv_<uuid>
  -- Email envelope
  gmail_message_id         TEXT NOT NULL UNIQUE,       -- dedupe across runs
  gmail_thread_id          TEXT,
  email_from               TEXT NOT NULL,
  email_subject            TEXT,
  email_received_at        INTEGER NOT NULL,           -- unix seconds
  email_snippet            TEXT,                       -- first 200 chars

  -- Attachment(s) — primary one used for classification
  attachment_filename      TEXT,
  attachment_r2_key        TEXT,                       -- inbox/YYYY-MM-DD/<id>/<filename>
  attachment_content_type  TEXT,
  attachment_text_extracted TEXT,                      -- raw text for audit

  -- Classification (DeepSeek output)
  classification           TEXT NOT NULL DEFAULT 'pending'
    CHECK (classification IN (
      'pending',           -- not yet processed
      'service',           -- A: vendor invoice
      'purchase',          -- B: supplier invoice
      'sale_payment',      -- C: client paid us
      'not_invoice',       -- noise (newsletter, marketing, etc.)
      'error'              -- LLM failed or attachment unreadable
    )),
  classification_confidence REAL,                      -- 0.0 .. 1.0

  -- Extraction (filled when classification != not_invoice/error)
  extracted_vendor_name    TEXT,
  extracted_vendor_inn     TEXT,
  extracted_invoice_no     TEXT,
  extracted_invoice_date   TEXT,                       -- YYYY-MM-DD
  extracted_period         TEXT,                       -- e.g. "March 2026"
  extracted_currency       TEXT,                       -- 3-letter code
  extracted_amount         REAL,                       -- decimal, vendor's currency
  extracted_line_items_json TEXT,                      -- JSON array of {description, qty, unit_price, line_total}
  -- For sale_payment specifically:
  extracted_our_invoice_ref TEXT,                      -- e.g. "DEE-007"
  extracted_payment_date   TEXT,

  -- Resolution
  status                   TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',                -- newly arrived, classification not yet run
      'processed',             -- LLM ran, ready for routing decision
      'auto_created',          -- operation/payment created without intervention
      'needs_partner_link',    -- vendor not found in partners table
      'needs_review',          -- LLM uncertain or conflict in data
      'manual_confirmed',      -- user clicked Confirm in /inbox
      'manual_rejected',       -- user clicked Reject in /inbox
      'error'                  -- pipeline failure
    )),
  matched_partner_id       TEXT,                       -- FK to partners (when found)
  created_operation_id     TEXT,                       -- FK to operations (when auto-created)
  created_payment_id       TEXT,                       -- FK to payments (when sale_payment confirmed)
  notes                    TEXT,                       -- LLM reasoning + any error messages

  -- Timestamps
  created_at               INTEGER NOT NULL,
  processed_at             INTEGER,                    -- when classification finished
  resolved_at              INTEGER,                    -- when reached terminal status
  deleted_at               INTEGER,

  FOREIGN KEY (matched_partner_id)     REFERENCES partners(id)   ON DELETE SET NULL,
  FOREIGN KEY (created_operation_id)   REFERENCES operations(id) ON DELETE SET NULL,
  FOREIGN KEY (created_payment_id)     REFERENCES payments(id)   ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invoice_inbox_status
  ON invoice_inbox(status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_inbox_classification
  ON invoice_inbox(classification) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_inbox_received
  ON invoice_inbox(email_received_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_inbox_partner
  ON invoice_inbox(matched_partner_id) WHERE deleted_at IS NULL AND matched_partner_id IS NOT NULL;

-- =============================================================================
-- payment_pending status — adds amber dot to existing payment overlay
-- =============================================================================
-- Existing payment_state derivation in operations.ts already returns
-- 'unpaid' / 'partial' / 'paid' / 'neutral'. We extend it with 'pending'
-- which means a sale_payment came in via email but is not yet confirmed
-- by the bank webhook (Modulbank for RUB, manual for other currencies).
--
-- Payments table already exists with confirmation_status column from
-- earlier phase. We add a new value here.
--
-- The payments.confirmation_status existing CHECK constraint may need
-- recreation. Let's check what's there first by adding column if missing.

-- Add confirmation_status if it doesn't exist (idempotent guard)
-- SQLite can't ALTER ADD COLUMN with constraint easily, so we just
-- document the new allowed value. The check in API code (zod schemas)
-- needs to allow 'pending_email' as a value.

-- Track which inbox row created which payment, for traceability:
-- (created_payment_id already on invoice_inbox does this from the inbox side)

-- Add inbox_origin column to payments to mark email-originated entries
-- so the UI can render amber dot only for them and the bank reconciliation
-- can find them efficiently.
ALTER TABLE payments ADD COLUMN inbox_origin TEXT;
-- Allowed values: NULL (manual entry), 'email_pending' (from invoice_inbox,
-- not yet bank-confirmed), 'email_confirmed' (bank webhook later matched it).

CREATE INDEX IF NOT EXISTS idx_payments_inbox_origin
  ON payments(inbox_origin) WHERE inbox_origin IS NOT NULL AND deleted_at IS NULL;
