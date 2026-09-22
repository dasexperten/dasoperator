-- 0093 — deterministic shipment details for issued operation documents
-- Stores the exact booking/contact lines supplied for a shipment. The
-- invoicer renders them on CI and PL without asking a model to reconstruct
-- logistics facts from notes or from the seller's jurisdiction.
ALTER TABLE operations ADD COLUMN shipment_details TEXT;
