-- Call purpose (Owner 2026-10-10): the Caller popup offers 3–5 reasons per agent. The chosen
-- reason and a free note travel with the request to the call service, so the agent opens with
-- the reason instead of «чем могу помочь». No reason chosen = the agent works it out from its
-- memory or from the conversation. The call service writes its script check back on the call.
-- Rollback: ALTER TABLE ... DROP COLUMN for each column below.
ALTER TABLE call_requests ADD COLUMN purpose_label TEXT;
ALTER TABLE call_requests ADD COLUMN purpose_kind TEXT;
ALTER TABLE call_requests ADD COLUMN purpose_note TEXT;
ALTER TABLE call_transcripts ADD COLUMN purpose_label TEXT;
ALTER TABLE call_transcripts ADD COLUMN script_grade TEXT;
ALTER TABLE call_transcripts ADD COLUMN script_flags TEXT;
