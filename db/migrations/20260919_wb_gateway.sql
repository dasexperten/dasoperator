CREATE TABLE IF NOT EXISTS wb_api_limits (bucket TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wb_api_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, path TEXT NOT NULL,
  method TEXT NOT NULL, status INTEGER NOT NULL, started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wb_api_requests_time ON wb_api_requests(started_at);
CREATE TABLE IF NOT EXISTS erp_job_claims (worker TEXT PRIMARY KEY, slot TEXT NOT NULL, lease_until INTEGER NOT NULL);
