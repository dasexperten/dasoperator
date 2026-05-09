-- Phase 9.x — Extended extraction fields for invoice_inbox
-- Applied to D1 prod 2026-05-09.
--
-- Adds columns to capture banking + categorization data from invoices.
-- These flow through to partners table when user clicks Yes in /inbox.

ALTER TABLE invoice_inbox ADD COLUMN extracted_vendor_email TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_vendor_country TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_vendor_address TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_bank_name TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_bank_account TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_iban TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_swift TEXT;
ALTER TABLE invoice_inbox ADD COLUMN extracted_service_category TEXT;  -- 'Accounting & Bookkeeping', 'Hosting', 'Legal', 'Advertising', etc.
ALTER TABLE invoice_inbox ADD COLUMN extracted_buyer_entity TEXT;      -- 'DEE'|'DEI'|'DEASEAN'|'DEC'
