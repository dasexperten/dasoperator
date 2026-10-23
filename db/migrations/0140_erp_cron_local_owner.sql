-- Self-contained timers claim execution separately from delegated API jobs.
-- Existing API/history/manual rows keep NULL; neither kind may claim the other.
ALTER TABLE erp_cron_runs ADD COLUMN local_owner TEXT;
ALTER TABLE erp_cron_runs ADD COLUMN local_started_at TEXT;
ALTER TABLE erp_cron_runs ADD COLUMN local_trigger_source TEXT;
