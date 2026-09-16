-- 0088 — DEI resale markup and billed freight on one operation
-- Justina Timber 2026-09-16 · Owner: one operation per shipment (air / sea),
-- all invoices of that shipment inside it. Lot HA26730: WDAA -> DEI at cost,
-- DEI -> DEASEAN at +50%, freight paid by DEASEAN and billed on the invoice.
ALTER TABLE operations ADD COLUMN dei_markup_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN freight_amount REAL NOT NULL DEFAULT 0;
