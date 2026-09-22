-- 0094 — shipment-specific packing facts for packing lists
-- JSON supplied from the factory packing list. It overrides product-master
-- estimates only for this operation and is rendered deterministically.
ALTER TABLE operations ADD COLUMN packing_details TEXT;
