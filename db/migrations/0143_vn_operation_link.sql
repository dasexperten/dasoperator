-- Preserve operations, its inbound foreign keys and triggers while widening VAT.
ALTER TABLE operations RENAME COLUMN vat_rate TO vat_rate_previous;
ALTER TABLE operations ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 0 CHECK (vat_rate IN (0,5,8,10,20));
UPDATE operations SET vat_rate=vat_rate_previous;
ALTER TABLE operations DROP COLUMN vat_rate_previous;
ALTER TABLE vn_einvoice_documents ADD COLUMN operation_id TEXT REFERENCES operations(id);
CREATE UNIQUE INDEX idx_vn_einvoice_operation ON vn_einvoice_documents(operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE vn_einvoice_documents ADD COLUMN operation_sync_error TEXT;
