-- 0123 — read-only check after 0122 (Owner 2026-10-15): which rows 0122 touched.
-- Changes nothing.
SELECT id, status, amount_minor, payout_date, created_at, created_by, note,
       (SELECT COUNT(*) FROM ugc_payout_requisites r WHERE r.payout_id = p.id) has_req
  FROM ugc_payouts p WHERE note LIKE 'реестр №2%' OR lower(handle) = 'eseniya__oo3__';
