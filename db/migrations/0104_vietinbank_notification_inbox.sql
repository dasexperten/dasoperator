-- Authenticated notifications only. Quarantine is not a financial transaction ledger.
CREATE TABLE IF NOT EXISTS vietinbank_notification_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  trans_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'quarantined' CHECK (status = 'quarantined'),
  UNIQUE(provider_id, trans_id)
);
