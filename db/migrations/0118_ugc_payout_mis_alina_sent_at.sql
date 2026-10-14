-- 0118 — Correct the send time of the mis_alina_010 payout seeded in 0117.
-- Coordinator 2026-10-14: she was in the same Konsol file as yasmin_i.b,
-- sent 14.10.2026 14:01 Yerevan (10:01 UTC). Data only, idempotent.
-- Rollback: UPDATE ugc_payouts SET sent_at = NULL, note = 'Sent; time not recorded'
--           WHERE id = 'ugcpay_20261014_mis_alina_010';

UPDATE ugc_payouts
SET sent_at = '2026-10-14T10:01:00.000Z',
    note = 'Konsol file sent 14:01 Yerevan (same file as yasmin_i.b)'
WHERE id = 'ugcpay_20261014_mis_alina_010' AND sent_at IS NULL;
