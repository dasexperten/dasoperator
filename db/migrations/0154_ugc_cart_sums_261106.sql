-- Owner 2026-11-06: cart sums for the two payouts the ERP opened from text tonight (read from their cart photos).
-- Only rows still unconfirmed (1 kopeck), not yet sent to Konsol, are touched.
UPDATE ugc_payouts SET amount_minor = 52000, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE lower(handle) = 'yana_anankinaa' AND amount_minor = 1 AND status IN ('awaiting_approval','approved') AND konsol_payment_id IS NULL;
UPDATE ugc_payouts SET amount_minor = 49000, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE lower(handle) = 'mis.ludmilo4ka' AND amount_minor = 1 AND status IN ('awaiting_approval','approved') AND konsol_payment_id IS NULL;
SELECT handle, amount_minor, status FROM ugc_payouts WHERE lower(handle) IN ('yana_anankinaa','mis.ludmilo4ka');
