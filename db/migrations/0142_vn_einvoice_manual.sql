-- Manual ERP order input and explicit transfer evidence reuse the fiscal outbox.
-- Existing raw-XML operations retain their state machine and workflow='xml'.
ALTER TABLE vn_einvoice_documents ADD COLUMN workflow TEXT NOT NULL DEFAULT 'xml';
ALTER TABLE vn_einvoice_documents ADD COLUMN normalized_order_json TEXT;
ALTER TABLE vn_einvoice_documents ADD COLUMN transfer_at TEXT;
ALTER TABLE vn_einvoice_documents ADD COLUMN transfer_evidence TEXT;
ALTER TABLE vn_einvoice_documents ADD COLUMN transfer_recorded_by TEXT;
ALTER TABLE vn_einvoice_documents ADD COLUMN transfer_recorded_at INTEGER;
ALTER TABLE vn_einvoice_documents ADD COLUMN provider_invoice_status INTEGER;
ALTER TABLE vn_einvoice_documents ADD COLUMN provider_phase TEXT;
ALTER TABLE vn_einvoice_documents ADD COLUMN processing_token TEXT;
ALTER TABLE vn_einvoice_documents ADD COLUMN processing_until INTEGER;
