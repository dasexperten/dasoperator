-- Caller (Owner 2026-09-26): transcripts of every agent's voice call, shown under Emailer.
-- Written by the WhatsApp voice bridge through POST /api/calls/ingest; rollback: DROP TABLE call_transcripts.
CREATE TABLE IF NOT EXISTS call_transcripts (
  id TEXT PRIMARY KEY,
  seat_slug TEXT NOT NULL,
  seat_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  recipient_label TEXT,
  call_type TEXT NOT NULL CHECK (call_type IN ('outgoing', 'incoming')),
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  engine TEXT NOT NULL,
  -- connection outcome: did the call happen at all
  status TEXT NOT NULL CHECK (status IN ('completed', 'no_answer', 'failed')),
  -- Owner 26.09: "status" in the list is the deal position, "type" is the call purpose
  deal_status TEXT NOT NULL DEFAULT 'no_decision' CHECK (deal_status IN
    ('agreed', 'interested', 'callback', 'no_decision', 'not_interested', 'not_reached')),
  call_purpose TEXT NOT NULL DEFAULT 'other' CHECK (call_purpose IN
    ('sales', 'follow_up', 'support', 'owner_briefing', 'test', 'other')),
  summary TEXT,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_seconds INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_transcripts_started_at
  ON call_transcripts(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_transcripts_seat
  ON call_transcripts(seat_slug, started_at DESC);
