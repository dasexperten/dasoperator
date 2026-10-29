-- Owner-authorized posting of an ALREADY EXECUTED tax payment, 2026-10-29.
-- Financial specification: Justina Timber. VND is stored in whole units.
-- Execute the complete file as one D1 REST query batch. A failed guard must
-- abort the batch. No bank transfer is initiated by this migration.
-- Rollback: remove only the six newly created IDs, child rows first, after
-- verifying no later links; retain the original shipment and its evidence.

-- Evidence/account preconditions, plus duplicate detection including soft-deleted rows.
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM company_bank_accounts WHERE id='cba_dasean_vietin_vnd2'
    AND company_id='dasean' AND currency='VND' AND deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_customs_NNS26102607904'
    AND operation_id='op_152b7275-809f-400d-9a86-4a0363c87b49'
    AND doc_number='NNS26102607904' AND amount=17249087 AND currency='VND'
    AND file_url IS NOT NULL AND deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM bank_transactions WHERE id IS NOT 'bt_vietin_NNS26102607904' AND
    (external_id='NNS26102607904' OR external_doc_number='NNS26102607904'
     OR raw_payload LIKE '%NNS26102607904%'
     OR (company_bank_account_id='cba_dasean_vietin_vnd2' AND currency='VND'
       AND amount IN (17249087,1724908700) AND date(executed_at,'unixepoch')='2026-10-26')))
  AND NOT EXISTS (SELECT 1 FROM payments WHERE id IS NOT 'pay_vietin_NNS26102607904' AND
    (notes LIKE '%NNS26102607904%' OR (currency='VND' AND amount IN (17249087,1724908700)
      AND date(payment_date,'unixepoch')='2026-10-26')))
  AND NOT EXISTS (SELECT 1 FROM operations WHERE id IS NOT 'op_vn_import_vat_NNS26102607904'
    AND (reference='VN-IMPORT-VAT-NNS26102607904' OR (operation_type='tax'
      AND our_company_id='dasean' AND currency='VND' AND total_amount=17249087
      AND date(operation_date,'unixepoch')='2026-10-26')))
THEN 1 ELSE json('VietinBank tax source/account missing or duplicate payment found') END;

-- Existing target IDs may be reused only if they are the same active posting.
SELECT CASE WHEN
  NOT EXISTS (SELECT 1 FROM partners WHERE id='vn-treasury-region-ii-pgd1' AND
    (deleted_at IS NOT NULL OR trade_name IS NOT 'KBNN KHU VUC II - PHONG GIAO DICH SO 1'
      OR partner_type IS NOT 'other' OR country IS NOT 'Vietnam'))
  AND NOT EXISTS (SELECT 1 FROM contracts WHERE id='placeholder_vn_treasury_dasean_vnd' AND
    (deleted_at IS NOT NULL OR partner_id IS NOT 'vn-treasury-region-ii-pgd1'
      OR our_company_id IS NOT 'dasean' OR currency IS NOT 'VND' OR status IS NOT 'draft' OR signed_date IS NOT NULL
      OR agreement_type IS NOT 'other' OR contract_no IS NOT 'TECHNICAL-VN-TREASURY-DASEAN-VND'))
  AND NOT EXISTS (SELECT 1 FROM operations WHERE id='op_vn_import_vat_NNS26102607904' AND
    (deleted_at IS NOT NULL OR operation_type IS NOT 'tax' OR our_company_id IS NOT 'dasean'
      OR currency IS NOT 'VND' OR total_amount IS NOT 17249087 OR status IS NOT 'issued'
      OR partner_id IS NOT 'vn-treasury-region-ii-pgd1'
      OR contract_id IS NOT 'placeholder_vn_treasury_dasean_vnd'))
  AND NOT EXISTS (SELECT 1 FROM payments WHERE id='pay_vietin_NNS26102607904' AND
    (deleted_at IS NOT NULL OR amount IS NOT 17249087 OR currency IS NOT 'VND' OR direction IS NOT 'outgoing'
      OR operation_id IS NOT 'op_vn_import_vat_NNS26102607904'
      OR partner_id IS NOT 'vn-treasury-region-ii-pgd1' OR contract_id IS NOT 'placeholder_vn_treasury_dasean_vnd'))
  AND NOT EXISTS (SELECT 1 FROM bank_transactions WHERE id='bt_vietin_NNS26102607904' AND
    (deleted_at IS NOT NULL OR amount IS NOT 17249087 OR currency IS NOT 'VND' OR direction IS NOT 'outgoing'
      OR company_bank_account_id IS NOT 'cba_dasean_vietin_vnd2' OR external_id IS NOT 'NNS26102607904'
      OR matched_payment_id IS NOT 'pay_vietin_NNS26102607904'
      OR matched_operation_id IS NOT 'op_vn_import_vat_NNS26102607904'))
  AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_vn_import_vat_NNS26102607904' AND
    (deleted_at IS NOT NULL OR amount IS NOT 17249087 OR currency IS NOT 'VND'
      OR operation_id IS NOT 'op_vn_import_vat_NNS26102607904' OR doc_number IS NOT 'NNS26102607904'))
THEN 1 ELSE json('VietinBank tax target ID is occupied by a different or deleted record') END;

INSERT INTO partners (id,trade_name,legal_name,country,currency,status,partner_type,kind,notes,created_at,updated_at)
SELECT 'vn-treasury-region-ii-pgd1','KBNN KHU VUC II - PHONG GIAO DICH SO 1',
  'KBNN KHU VUC II - PHONG GIAO DICH SO 1','Vietnam','VND','active','other','other',
  'Treasury recipient named in VietinBank C1-02/NS for NNS26102607904. Treasury code 79701026 is not a tax ID. Collector: Hai quan cua khau cang Sai Gon khu vuc 1, code 2995342. Recipient account 7111 at VIETINBANK CN THU THIEM, bank code 79201021. No unverified tax ID or INN assigned.',
  unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM partners WHERE id='vn-treasury-region-ii-pgd1');

INSERT INTO contracts (id,contract_no,partner_id,our_company_id,currency,status,agreement_type,notes,created_at,updated_at)
SELECT 'placeholder_vn_treasury_dasean_vnd','TECHNICAL-VN-TREASURY-DASEAN-VND',
  'vn-treasury-region-ii-pgd1','dasean','VND','draft','other',
  'Technical ERP container for statutory treasury payments, required by payments.contract_id. NOT a signed contract, commercial agreement, new commitment or payment authorization. signed_date intentionally NULL. Payment NNS26102607904 is supported by its bank receipt and tax declaration.',
  unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM contracts WHERE id='placeholder_vn_treasury_dasean_vnd');

INSERT INTO operations (id,reference,operation_date,operation_type,operation_track,partner_id,our_company_id,
  contract_id,status,currency,total_amount,vat_rate,notes,created_at,updated_at)
SELECT 'op_vn_import_vat_NNS26102607904','VN-IMPORT-VAT-NNS26102607904',1793016000,'tax','service',
  'vn-treasury-region-ii-pgd1','dasean','placeholder_vn_treasury_dasean_vnd','issued','VND',17249087,0,
  'Already executed import VAT payment NNS26102607904, 26 October 2026, 17249087 whole VND. The amount is import VAT itself; vat_rate=0 does not assert the statutory rate. Bank receipt declaration 10871137956 dated 16 October; prior shipment evidence says 108711379560, both preserved without normalization. Associated shipment DEI-26092101 / container KYHCMG2600249. This tax does NOT settle the USD 8383.11 goods invoice. Bank status Successful is distinct from customs credit/release. Posting authorized by Owner 29 October and classified by Justina Timber. Date-only execution precision, no inferred approval time.',
  unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id='op_vn_import_vat_NNS26102607904');

INSERT INTO payments (id,partner_id,contract_id,operation_id,amount,currency,payment_date,type,direction,notes,created_at,updated_at)
SELECT 'pay_vietin_NNS26102607904','vn-treasury-region-ii-pgd1','placeholder_vn_treasury_dasean_vnd',
  'op_vn_import_vat_NNS26102607904',17249087,'VND',1793016000,'final','outgoing',
  'Existing successful VietinBank transfer NNS26102607904 of 26 October 2026. Import VAT only. Same payment as bank row bt_vietin_NNS26102607904; not a new transfer and not payment of DEI-26092101 goods invoice. Execution time is known to date precision only. Evidence: att_customs_NNS26102607904 and VietinBank C1-02/NS inspected by Justina Timber.',
  unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM payments WHERE id='pay_vietin_NNS26102607904');

INSERT INTO bank_transactions (id,company_bank_account_id,external_id,external_doc_number,direction,status,
  amount,currency,executed_at,created_at_bank,contragent_name,contragent_account,contragent_bank_name,
  payment_purpose,matched_payment_id,matched_operation_id,match_method,matched_at,matched_by,raw_payload,
  source_type,created_at,updated_at)
SELECT 'bt_vietin_NNS26102607904','cba_dasean_vietin_vnd2','NNS26102607904','NNS26102607904',
  'outgoing','Executed',17249087,'VND',1793016000,1792988163,
  'KBNN KHU VUC II - PHONG GIAO DICH SO 1','7111','VIETINBANK CN THU THIEM',
  'Import VAT / Thue GTGT hang nhap khau. Declaration 10871137956 dated 16/10/2026. Treasury 79701026; collector Hai quan cua khau cang Sai Gon khu vuc 1 (2995342).',
  'pay_vietin_NNS26102607904','op_vn_import_vat_NNS26102607904','manual',unixepoch(),'justina-timber',
  json_object('source','Owner-authorized posting from authenticated VietinBank C1-02/NS and Successful transaction evidence',
    'transaction_number','NNS26102607904','amount_vnd',17249087,'status','Successful',
    'execution_date','2026-10-26','execution_time_precision','date_only',
    'created_at_bank','2026-10-26T11:16:03+07:00','treasury_code','79701026','collector_code','2995342',
    'recipient_account','7111','recipient_bank_code','79201021','declaration_number','10871137956',
    'prior_shipment_declaration_number','108711379560','source_attachment_id','att_customs_NNS26102607904',
    'recorded_by','justina-timber','technical_execution_by','mina-rutunya'),
  'manual_upload',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM bank_transactions WHERE id='bt_vietin_NNS26102607904');

-- Reuse the existing stored image: new relation, no duplicate file or payment.
INSERT INTO operation_attachments (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,
  issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at)
SELECT 'att_vn_import_vat_NNS26102607904','op_vn_import_vat_NNS26102607904','incoming','customs_tax_payment',
  doc_number,doc_date,amount,currency,issuer,file_url,'manual','bt_vietin_NNS26102607904',
  'Reference to the existing stored bank evidence att_customs_NNS26102607904. Original shipment attachment preserved. Tax payment posted separately; no additional transfer or goods-invoice settlement.',
  unixepoch(),unixepoch()
FROM operation_attachments WHERE id='att_customs_NNS26102607904'
  AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_vn_import_vat_NNS26102607904');
