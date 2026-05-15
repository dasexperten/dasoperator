-- 0040: invoice_inbox supports telegram-source documents.
--
-- Aram law (2026-05-15):
--   Telegram chat -1002848395508 (forum group for F4 Lyubertsy operations)
--   is registered as operation_document_sources entry ods_e69ab6ca with
--   source_type='telegram_contact'. New invoices and acceptance certificates
--   that arrive via Telegram media uploads must land in invoice_inbox the
--   same way Gmail attachments do.
--
-- Schema changes:
--   1. gmail_message_id becomes nullable (was NOT NULL UNIQUE).
--   2. Add source_type ('gmail' | 'telegram') with default 'gmail'.
--   3. Add telegram_* columns (chat_id, msg_id, topic_id, sender, received_at,
--      source_ref_id).
--   4. classification CHECK gains 'acceptance' value.
--   5. New partial unique indexes: gmail-source rows unique on gmail_message_id,
--      telegram-source rows unique on (telegram_chat_id, telegram_msg_id).
--
-- D1 has no ALTER COLUMN, so we use the recreate-table pattern:
--   create _new → copy rows with source_type='gmail' → drop old → rename → indexes.
--
-- This migration is applied directly to D1 via REST. The file lives in repo
-- for historical record and future fresh-clone reproducibility.

PRAGMA foreign_keys = OFF;

CREATE TABLE invoice_inbox_new (
  id                       TEXT PRIMARY KEY,
  source_type              TEXT NOT NULL DEFAULT 'gmail'
    CHECK (source_type IN ('gmail','telegram')),
  gmail_message_id         TEXT,
  gmail_thread_id          TEXT,
  email_from               TEXT,
  email_subject            TEXT,
  email_received_at        INTEGER,
  email_snippet            TEXT,
  telegram_chat_id         TEXT,
  telegram_msg_id          INTEGER,
  telegram_topic_id        INTEGER,
  telegram_sender_username TEXT,
  telegram_received_at     INTEGER,
  telegram_source_ref_id   TEXT,
  attachment_filename      TEXT,
  attachment_r2_key        TEXT,
  attachment_content_type  TEXT,
  attachment_text_extracted TEXT,
  classification           TEXT NOT NULL DEFAULT 'pending'
    CHECK (classification IN ('pending','service','purchase','sale_payment','not_invoice','error','acceptance')),
  classification_confidence REAL,
  extracted_vendor_name    TEXT,
  extracted_vendor_inn     TEXT,
  extracted_invoice_no     TEXT,
  extracted_invoice_date   TEXT,
  extracted_period         TEXT,
  extracted_currency       TEXT,
  extracted_amount         REAL,
  extracted_line_items_json TEXT,
  extracted_our_invoice_ref TEXT,
  extracted_payment_date   TEXT,
  status                   TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processed','auto_created','auto_attached','needs_partner_link','needs_review','manual_confirmed','manual_rejected','error')),
  matched_partner_id       TEXT,
  created_operation_id     TEXT,
  created_payment_id       TEXT,
  notes                    TEXT,
  created_at               INTEGER NOT NULL,
  processed_at             INTEGER,
  resolved_at              INTEGER,
  deleted_at               INTEGER,
  extracted_vendor_email   TEXT,
  extracted_vendor_country TEXT,
  extracted_vendor_address TEXT,
  extracted_bank_name      TEXT,
  extracted_bank_account   TEXT,
  extracted_iban           TEXT,
  extracted_swift          TEXT,
  extracted_service_category TEXT,
  extracted_buyer_entity   TEXT,
  suggested_operation_id   TEXT,
  suggested_match_confidence REAL,
  suggested_match_reason   TEXT,
  FOREIGN KEY (matched_partner_id)   REFERENCES partners(id)   ON DELETE SET NULL,
  FOREIGN KEY (created_operation_id) REFERENCES operations(id) ON DELETE SET NULL,
  FOREIGN KEY (created_payment_id)   REFERENCES payments(id)   ON DELETE SET NULL
);

INSERT INTO invoice_inbox_new (
    id, source_type,
    gmail_message_id, gmail_thread_id, email_from, email_subject, email_received_at, email_snippet,
    attachment_filename, attachment_r2_key, attachment_content_type, attachment_text_extracted,
    classification, classification_confidence,
    extracted_vendor_name, extracted_vendor_inn, extracted_invoice_no, extracted_invoice_date,
    extracted_period, extracted_currency, extracted_amount, extracted_line_items_json,
    extracted_our_invoice_ref, extracted_payment_date,
    status, matched_partner_id, created_operation_id, created_payment_id,
    notes, created_at, processed_at, resolved_at, deleted_at,
    extracted_vendor_email, extracted_vendor_country, extracted_vendor_address,
    extracted_bank_name, extracted_bank_account, extracted_iban, extracted_swift,
    extracted_service_category, extracted_buyer_entity,
    suggested_operation_id, suggested_match_confidence, suggested_match_reason
)
SELECT
    id, 'gmail',
    gmail_message_id, gmail_thread_id, email_from, email_subject, email_received_at, email_snippet,
    attachment_filename, attachment_r2_key, attachment_content_type, attachment_text_extracted,
    classification, classification_confidence,
    extracted_vendor_name, extracted_vendor_inn, extracted_invoice_no, extracted_invoice_date,
    extracted_period, extracted_currency, extracted_amount, extracted_line_items_json,
    extracted_our_invoice_ref, extracted_payment_date,
    status, matched_partner_id, created_operation_id, created_payment_id,
    notes, created_at, processed_at, resolved_at, deleted_at,
    extracted_vendor_email, extracted_vendor_country, extracted_vendor_address,
    extracted_bank_name, extracted_bank_account, extracted_iban, extracted_swift,
    extracted_service_category, extracted_buyer_entity,
    suggested_operation_id, suggested_match_confidence, suggested_match_reason
FROM invoice_inbox;

DROP TABLE invoice_inbox;
ALTER TABLE invoice_inbox_new RENAME TO invoice_inbox;

CREATE UNIQUE INDEX idx_invoice_inbox_gmail
  ON invoice_inbox(gmail_message_id)
  WHERE source_type='gmail' AND gmail_message_id IS NOT NULL;

CREATE UNIQUE INDEX idx_invoice_inbox_telegram
  ON invoice_inbox(telegram_chat_id, telegram_msg_id)
  WHERE source_type='telegram';

CREATE INDEX idx_invoice_inbox_status
  ON invoice_inbox(status, created_at DESC);

CREATE INDEX idx_invoice_inbox_source
  ON invoice_inbox(source_type, created_at DESC);

PRAGMA foreign_keys = ON;
