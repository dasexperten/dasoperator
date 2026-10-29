-- Owner report 2026-10-29: two Tica payments and their fees were transcribed
-- into bank_transactions at x100. Their authenticated-bank raw_payload and
-- the linked payments/operations already contain the correct whole VND values.
-- VND storage is whole units. Correct only these four proven rows; preserve
-- all matching links and the original evidence. Reapplying changes zero rows.
WITH expected(id, transaction_number, evidence_path, old_amount, amount, component) AS (
  VALUES
    ('bt_vietin_1031926J27304307', '1031926J27304307', '$.amount_vnd', 286200000, 2862000, ''),
    ('bt_vietin_1031926J27304087', '1031926J27304087', '$.amount_vnd', 2475000000, 24750000, ''),
    ('bt_vietin_1031926J27304307_fee', '1031926J27304307', '$.bank_charge_vnd', 2200000, 22000, 'bank_fee'),
    ('bt_vietin_1031926J27304087_fee', '1031926J27304087', '$.bank_charge_vnd', 2200000, 22000, 'bank_fee')
)
UPDATE bank_transactions
SET amount = (SELECT amount FROM expected WHERE expected.id = bank_transactions.id)
WHERE currency = 'VND'
  AND EXISTS (
    SELECT 1 FROM expected
    WHERE expected.id = bank_transactions.id
      AND expected.old_amount = bank_transactions.amount
      AND CASE WHEN json_valid(bank_transactions.raw_payload) THEN
        json_extract(bank_transactions.raw_payload, expected.evidence_path) = expected.amount
        AND json_extract(bank_transactions.raw_payload, '$.transaction_number') = expected.transaction_number
        AND COALESCE(json_extract(bank_transactions.raw_payload, '$.component'), '') = expected.component
        AND json_extract(bank_transactions.raw_payload, '$.status') = 'Successful'
        AND json_extract(bank_transactions.raw_payload, '$.recorded_by') = 'justina-timber'
        AND json_extract(bank_transactions.raw_payload, '$.source') = 'manual transcription of authenticated VietinBank eFAST transaction statistics and payment detail'
      ELSE 0 END
  );
