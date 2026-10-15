-- 0122 — Honest «Оплата» (Owner 2026-10-15, «Да, выкладывай»).
--
-- eseniya__oo3__ 484 ₽ went out by chat registry №2 and showed green in the
-- ERP, but Konsol has no payment for it (checked by Konsol GET, 15.10). The row
-- becomes failed («не исполнено в Консоли») and keeps its prior status in the
-- note. One row only; no row is created; no payment is made or scheduled.
--
-- Rollback: UPDATE ugc_payouts SET status=<prior status from the note>, failed_at=NULL,
--           note=NULL WHERE id=<that row>;

UPDATE ugc_payouts
   SET note = 'реестр №2 в чате, Консоль не исполнила (было: ' || status || ')',
       status = 'failed',
       failed_at = '2026-10-15T00:00:00.000Z',
       updated_at = 1792022400000
 WHERE id IN (
   SELECT p.id FROM ugc_payouts p JOIN ugc_creators c ON c.id = p.creator_id
    WHERE (lower(p.handle) = 'eseniya__oo3__' OR c.normalized_handle = 'eseniya__oo3__')
      AND p.amount_minor = 48400
      AND p.konsol_payment_id IS NULL
      AND p.status IN ('sent', 'paid', 'approved', 'awaiting_approval')
 );

SELECT id, status, note FROM ugc_payouts WHERE note LIKE 'реестр №2%';
