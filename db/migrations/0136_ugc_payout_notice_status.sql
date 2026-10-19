-- Owner 2026-10-19: the paid message has its own status, set only by Instagram's answer to the send.
-- sending → delivered (Instagram returned a message id) | failed (reason) | queued (7-day window closed).
ALTER TABLE ugc_payouts ADD COLUMN notice_status TEXT;
ALTER TABLE ugc_payouts ADD COLUMN notice_error TEXT;
ALTER TABLE ugc_payouts ADD COLUMN notice_message_id TEXT;
ALTER TABLE ugc_payouts ADD COLUMN notice_at TEXT;
