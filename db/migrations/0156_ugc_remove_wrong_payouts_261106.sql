-- Owner 2026-11-06: two payouts the text pass opened by mistake for bloggers already paid earlier
-- (natali_matrysovaa, fatima_massage26). Removed only while unconfirmed (1 kopeck) and never sent.
DELETE FROM ugc_payout_requisites WHERE payout_id IN ('9402517d-8f31-42d4-b34e-ab6e0a03c412','018cc216-768b-4721-8b29-d4f14ec8cfc6')
  AND payout_id IN (SELECT id FROM ugc_payouts WHERE amount_minor = 1 AND status = 'awaiting_approval' AND konsol_payment_id IS NULL);
DELETE FROM ugc_payouts WHERE id IN ('9402517d-8f31-42d4-b34e-ab6e0a03c412','018cc216-768b-4721-8b29-d4f14ec8cfc6')
  AND amount_minor = 1 AND status = 'awaiting_approval' AND konsol_payment_id IS NULL;
