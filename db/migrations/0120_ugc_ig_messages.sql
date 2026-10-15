-- 0120 — Instagram Direct for Diana, read by the server (Owner 2026-10-15:
-- «She can check, answer, and do everything even when the browsers are not
-- turned on or the PC is not turned on»).
--
-- One row per Instagram message, keyed by Meta's message id, so a re-read
-- never doubles a row. direction: 'in' from the creator, 'out' from @dasexperten.
-- handled_at stays NULL until Diana has answered or closed the incoming message.
--
-- Additive only. Rollback: DROP TABLE ugc_ig_messages;

CREATE TABLE IF NOT EXISTS ugc_ig_messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  from_id          TEXT,
  from_username    TEXT,
  text             TEXT,
  attachments_json TEXT,
  created_at       TEXT NOT NULL,
  seen_at          TEXT NOT NULL,
  handled_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ugc_ig_messages_conv ON ugc_ig_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_ig_messages_open ON ugc_ig_messages(direction, handled_at, created_at);
