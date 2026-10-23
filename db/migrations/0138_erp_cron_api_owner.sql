-- The API owns the result once it accepts a delegated step. A caller transport
-- failure cannot overwrite that result or authorize replay of an uncertain step.
ALTER TABLE erp_cron_runs ADD COLUMN api_owner TEXT;
ALTER TABLE erp_cron_runs ADD COLUMN api_started_at TEXT;
ALTER TABLE erp_cron_runs ADD COLUMN transport_error TEXT;
