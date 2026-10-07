-- Owner 2026-10-07: dasexperten.com monthly settlements come from Stripe
-- (paid out via Wio Bank), so the operation is named after the payment
-- source: DASCOM-YYYYMM → STRIPE-YYYYMM. Builders in marketplace-pull*.ts
-- now write STRIPE- and still find a legacy DASCOM- row of the same month.
-- Rollback: UPDATE operations SET reference = 'DASCOM-' || substr(reference, 8)
--           WHERE partner_id = 'dasexperten_com' AND reference LIKE 'STRIPE-%';
UPDATE operations
SET reference = 'STRIPE-' || substr(reference, 8),
    updated_at = strftime('%s', 'now')
WHERE partner_id = 'dasexperten_com'
  AND reference LIKE 'DASCOM-%';
