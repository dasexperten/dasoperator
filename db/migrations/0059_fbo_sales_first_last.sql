-- Migration 0059: fbo_sales_cluster first_sale / last_sale — V2 velocity inputs.
-- The V2 calc (fbo-calc.ts) derives velocity from the active span
-- first_sale..last_sale inside the 30-day window instead of a flat /30,
-- so a SKU that stocked out on day 12 shows its true speed.
-- 0058 already ran on das_erp_dev, so the columns arrive via ALTER here.
-- NULL = sync has not written dates for the row; calc falls back to /30.
ALTER TABLE fbo_sales_cluster ADD COLUMN first_sale TEXT;
ALTER TABLE fbo_sales_cluster ADD COLUMN last_sale TEXT;
