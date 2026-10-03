-- Keep old spend as evidence; its period was not recorded, so it is unverified.
ALTER TABLE perf_reports ADD COLUMN date_from TEXT;
ALTER TABLE perf_reports ADD COLUMN date_to TEXT;
ALTER TABLE perf_reports ADD COLUMN group_id TEXT;
ALTER TABLE perf_reports ADD COLUMN remaining_campaigns TEXT;
ALTER TABLE perf_reports ADD COLUMN accumulated_cpc TEXT;
ALTER TABLE marketplace_sales_ozon ADD COLUMN cpc_period_from TEXT;
ALTER TABLE marketplace_sales_ozon ADD COLUMN cpc_period_to TEXT;
ALTER TABLE marketplace_sales_ozon ADD COLUMN cpc_report_created_at INTEGER;
CREATE INDEX IF NOT EXISTS perf_reports_period ON perf_reports(date_from, date_to, status);
