-- 0124 — guard for 0122 (Owner 2026-10-15). 0122 was meant for the one
-- registry №2 row of eseniya__oo3__ (sent by chat, never executed in Konsol).
-- A new payout row for her created on 15.10 with requisites (to be paid by the
-- Owner) must stay payable. Any row 0122 flipped that has requisites and was
-- waiting to be paid gets its prior status back. Changes nothing otherwise.

UPDATE ugc_payouts
   SET status = CASE WHEN note LIKE '%(было: approved)' THEN 'approved' ELSE 'awaiting_approval' END,
       failed_at = NULL,
       note = NULL,
       updated_at = 1792080000000
 WHERE note LIKE 'реестр №2 в чате, Консоль не исполнила (было: %'
   AND (note LIKE '%(было: approved)' OR note LIKE '%(было: awaiting_approval)')
   AND EXISTS (SELECT 1 FROM ugc_payout_requisites r WHERE r.payout_id = ugc_payouts.id);
