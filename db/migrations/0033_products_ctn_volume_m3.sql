-- =============================================================================
-- Migration 0033: Add ctn_volume_m3 column to products.
--
-- Source data: Price_and_Specification_2025_11_FOB_GUANGZHOU_INTERNAL.xlsx
-- That file stores carton volume as a single m³ value (e.g. 0.021584 for paste
-- master cartons, 0.03895 for brush master cartons). Some rows store it as
-- "LxWxH" in cm which we parse and convert.
--
-- We keep the existing ctn_dim_l_cm / w / h columns for cases where dimensions
-- are known explicitly. The renderer prefers ctn_volume_m3 when present, else
-- computes from dims. If neither available, volume shows "TBD" in RFQ doc.
--
-- Applied: 2026-05-11
-- =============================================================================

ALTER TABLE products ADD COLUMN ctn_volume_m3 REAL;
