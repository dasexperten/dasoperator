-- Stable invocation identity lets journal writes be retried after a lost D1
-- acknowledgement without repeating the job or inserting a second run row.
-- Existing integer IDs and historical rows remain unchanged.
ALTER TABLE erp_cron_runs ADD COLUMN run_key TEXT;
CREATE UNIQUE INDEX idx_erp_cron_runs_run_key ON erp_cron_runs(run_key);
