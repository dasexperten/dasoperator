-- Nullable metadata preserves historical/manual rows. run_key's existing unique
-- index is the execution-slot identity; distinct cron expressions may share time.
ALTER TABLE erp_cron_runs ADD COLUMN scheduled_time INTEGER;
ALTER TABLE erp_cron_runs ADD COLUMN trigger_source TEXT;
ALTER TABLE erp_cron_runs ADD COLUMN api_trigger_source TEXT;
CREATE INDEX idx_erp_cron_runs_schedule ON erp_cron_runs(worker, scheduled_time);
