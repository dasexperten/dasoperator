-- Caller dial (Owner 2026-09-28): a signed-in user asks an agent to call a number from the ERP.
-- ERP only stores the request; the voice bridge on the Mac claims it, places the call and
-- writes its progress back here. Rollback: DROP TABLE call_requests.
CREATE TABLE IF NOT EXISTS call_requests (
  id TEXT PRIMARY KEY,
  seat_slug TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'telegram')),
  target TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'dialing', 'connected', 'completed', 'no_answer', 'failed', 'cancelled')),
  detail TEXT,
  call_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_requests_status_created
  ON call_requests(status, created_at);
