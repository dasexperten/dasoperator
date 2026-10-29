-- Owner-authorized ERP posting of a previously paid item; no bank transfer.
-- Financial classification: Justina Timber. Technical execution: Mina Rutunya.
-- Run entire file as one D1 REST query batch; guards abort atomically.
-- VND amounts are whole units. Do not alter the original goods invoices.
-- Rollback only this migration's new IDs, child rows first, after checking later links.
-- AT ASIA: supplier receipt confirmed; bank debit NOT independently confirmed.
SELECT CASE WHEN
EXISTS (SELECT 1 FROM companies WHERE id='dasean')
AND NOT EXISTS (SELECT 1 FROM payments WHERE id IS NOT 'pay_at_1031926P26031973' AND ((currency='VND' AND amount IN (9017501,901750100)) OR notes LIKE '%1031926P26031973%' OR notes LIKE '%928C609265AAYGVT%' OR notes LIKE '%6269ICBVC2FG19G5%'))
AND NOT EXISTS (SELECT 1 FROM operations WHERE id IS NOT 'op_vn_atasia_00014531' AND ((currency='VND' AND total_amount IN (9017501,901750100)) OR notes LIKE '%1031926P26031973%' OR notes LIKE '%928C609265AAYGVT%' OR notes LIKE '%6269ICBVC2FG19G5%' OR reference='ATASIA-00014531'))
AND NOT EXISTS (SELECT 1 FROM bank_transactions WHERE external_id IN ('1031926P26031973','928C609265AAYGVT','6269ICBVC2FG19G5') OR external_doc_number IN ('1031926P26031973','928C609265AAYGVT','6269ICBVC2FG19G5') OR (currency='VND' AND amount IN (9017501,901750100)))
AND NOT EXISTS (SELECT 1 FROM partners WHERE id IS NOT 'at-asia-hcm' AND (tax_id='0105684477-001' OR inn='0105684477-001'))
AND EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_04ss_8980b7b66ee038d1b717' AND operation_id='op_152b7275-809f-400d-9a86-4a0363c87b49' AND file_url IS NOT NULL AND deleted_at IS NULL)
THEN 1 ELSE json('AT ASIA source missing or duplicate payment found including deleted') END;
SELECT CASE WHEN
NOT EXISTS (SELECT 1 FROM partners WHERE id='at-asia-hcm' AND (deleted_at IS NOT NULL OR id IS NOT 'at-asia-hcm' OR trade_name IS NOT 'AT ASIA HCM' OR legal_name IS NOT 'CHI NHÁNH CÔNG TY TNHH AT Á CHÂU' OR country IS NOT 'Vietnam' OR currency IS NOT 'VND' OR status IS NOT 'active' OR partner_type IS NOT 'supplier' OR kind IS NOT 'service_provider' OR tax_id IS NOT '0105684477-001'))
AND NOT EXISTS (SELECT 1 FROM contracts WHERE id='placeholder_atasia_dasean_vnd' AND (deleted_at IS NOT NULL OR id IS NOT 'placeholder_atasia_dasean_vnd' OR contract_no IS NOT 'TECHNICAL-ATASIA-DASEAN-VND' OR partner_id IS NOT 'at-asia-hcm' OR our_company_id IS NOT 'dasean' OR currency IS NOT 'VND' OR status IS NOT 'draft' OR signed_date IS NOT NULL OR agreement_type IS NOT 'other'))
AND NOT EXISTS (SELECT 1 FROM operations WHERE id='op_vn_atasia_00014531' AND (deleted_at IS NOT NULL OR id IS NOT 'op_vn_atasia_00014531' OR reference IS NOT 'ATASIA-00014531' OR operation_date IS NOT 1790596800 OR operation_type IS NOT 'service' OR operation_track IS NOT 'service' OR partner_id IS NOT 'at-asia-hcm' OR our_company_id IS NOT 'dasean' OR contract_id IS NOT 'placeholder_atasia_dasean_vnd' OR status IS NOT 'issued' OR currency IS NOT 'VND' OR total_amount IS NOT 9017501 OR vat_rate IS NOT 8))
AND NOT EXISTS (SELECT 1 FROM payments WHERE id='pay_at_1031926P26031973' AND (deleted_at IS NOT NULL OR id IS NOT 'pay_at_1031926P26031973' OR partner_id IS NOT 'at-asia-hcm' OR contract_id IS NOT 'placeholder_atasia_dasean_vnd' OR operation_id IS NOT 'op_vn_atasia_00014531' OR amount IS NOT 9017501 OR currency IS NOT 'VND' OR payment_date IS NOT 1790424000 OR type IS NOT 'advance' OR direction IS NOT 'outgoing'))
AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_invoice_00014531' AND (deleted_at IS NOT NULL OR id IS NOT 'att_atasia_invoice_00014531' OR operation_id IS NOT 'op_vn_atasia_00014531' OR direction IS NOT 'incoming' OR kind IS NOT 'invoice' OR doc_number IS NOT '00014531' OR doc_date IS NOT 1790596800 OR amount IS NOT 9017501 OR currency IS NOT 'VND' OR issuer IS NOT 'CHI NHÁNH CÔNG TY TNHH AT Á CHÂU' OR file_url IS NOT '/api/attachment-files/attachments%2Fop_vn_atasia_00014531%2Fatasia-invoice-00014531.pdf' OR parsed_from IS NOT 'manual' OR source_ref_id IS NOT 'gmail:1a0e5b1241bb9d17'))
AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_order_1031926P26031973' AND (deleted_at IS NOT NULL OR id IS NOT 'att_atasia_order_1031926P26031973' OR operation_id IS NOT 'op_vn_atasia_00014531' OR direction IS NOT 'incoming' OR kind IS NOT 'payment_order' OR doc_number IS NOT '1031926P26031973' OR doc_date IS NOT 1790424000 OR amount IS NOT 9017501 OR currency IS NOT 'VND' OR issuer IS NOT 'VietinBank' OR file_url IS NOT '/api/attachment-files/attachments%2Fop_vn_atasia_00014531%2Fatasia-payment-order-20260926.pdf' OR parsed_from IS NOT 'manual' OR source_ref_id IS NOT 'gmail:1a0dc121357a09f2'))
AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_credit_00014531' AND (deleted_at IS NOT NULL OR id IS NOT 'att_atasia_credit_00014531' OR operation_id IS NOT 'op_vn_atasia_00014531' OR direction IS NOT 'incoming' OR kind IS NOT 'payment_confirmation' OR doc_number IS NOT '00014531' OR doc_date IS NOT 1790769600 OR amount IS NOT 9017501 OR currency IS NOT 'VND' OR issuer IS NOT 'AT ASIA' OR file_url IS NOT 'https://mail.google.com/mail/u/?authuser=dasexperten%40gmail.com#all/1a0f11541bf2597f' OR parsed_from IS NOT 'manual' OR source_ref_id IS NOT 'gmail:1a0f11541bf2597f'))
AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_04ss_00014531' AND (deleted_at IS NOT NULL OR operation_id IS NOT 'op_vn_atasia_00014531'))
THEN 1 ELSE json('AT ASIA target ID conflict') END;
INSERT INTO partners (id,trade_name,legal_name,country,currency,status,partner_type,kind,tax_id,notes,created_at,updated_at)
SELECT 'at-asia-hcm','AT ASIA HCM','CHI NHÁNH CÔNG TY TNHH AT Á CHÂU','Vietnam','VND','active','supplier','service_provider','0105684477-001','Supplier identified by invoice 00014531 dated 28 September 2026; tax ID 0105684477-001.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM partners WHERE id='at-asia-hcm');

INSERT INTO contracts (id,contract_no,partner_id,our_company_id,currency,status,signed_date,agreement_type,notes,created_at,updated_at)
SELECT 'placeholder_atasia_dasean_vnd','TECHNICAL-ATASIA-DASEAN-VND','at-asia-hcm','dasean','VND','draft',NULL,'other','Technical ERP container required by payments.contract_id for the evidenced service invoice and supplier advance. NOT a signed contract, new commitment or payment authorization.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM contracts WHERE id='placeholder_atasia_dasean_vnd');

INSERT INTO operations (id,reference,operation_date,operation_type,operation_track,partner_id,our_company_id,contract_id,status,currency,total_amount,vat_rate,notes,created_at,updated_at)
SELECT 'op_vn_atasia_00014531','ATASIA-00014531',1790596800,'service','service','at-asia-hcm','dasean','placeholder_atasia_dasean_vnd','issued','VND',9017501,8,'Logistics/local charges invoice 00014531 (1C26TAA), 28 September 2026: net 8349538 VND + VAT 667963 VND at 8% = gross 9017501 VND. Separate service expense; does not settle goods invoice DEI-26092101. Supporting 04/SS-HĐĐT corrects buyer address; original shipment attachment preserved. Supplier confirms credit 9017501 and EDO release. Payment day 26 September reported by Owner; bank debit execution and exact time were NOT independently confirmed. Stored payment order remains Pending approval. No bank transaction or bank fee is created.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM operations WHERE id='op_vn_atasia_00014531');

INSERT INTO payments (id,partner_id,contract_id,operation_id,amount,currency,payment_date,type,direction,notes,created_at,updated_at)
SELECT 'pay_at_1031926P26031973','at-asia-hcm','placeholder_atasia_dasean_vnd','op_vn_atasia_00014531',9017501,'VND',1790424000,'advance','outgoing','Supplier advance: Owner reported paid 26 September 2026 (Gmail 1a0dc121357a09f2); recipient confirmed credit +9017501 VND and EDO (Gmail 1a0f11541bf2597f). Allocated to subsequent invoice 00014531 dated 28 September. Order ref 1031926P26031973, refs 928C609265AAYGVT / 6269ICBVC2FG19G5 are evidence identifiers only. Order PDF status Pending approval; no independently confirmed bank debit execution/date. payment_date is Owner-reported date only. No Executed bank row or bank fee.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM payments WHERE id='pay_at_1031926P26031973');

INSERT INTO operation_attachments (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at)
SELECT 'att_atasia_invoice_00014531','op_vn_atasia_00014531','incoming','invoice','00014531',1790596800,9017501,'VND','CHI NHÁNH CÔNG TY TNHH AT Á CHÂU','/api/attachment-files/attachments%2Fop_vn_atasia_00014531%2Fatasia-invoice-00014531.pdf','manual','gmail:1a0e5b1241bb9d17','Invoice gross 9017501, net 8349538, VAT 667963 VND, rate 8%. SHA256 830d04f0d89a60fbf1aabc713195509d78c9007fdbbd17545bb1bdef82e2d0e4.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_invoice_00014531');

INSERT INTO operation_attachments (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at)
SELECT 'att_atasia_order_1031926P26031973','op_vn_atasia_00014531','incoming','payment_order','1031926P26031973',1790424000,9017501,'VND','VietinBank','/api/attachment-files/attachments%2Fop_vn_atasia_00014531%2Fatasia-payment-order-20260926.pdf','manual','gmail:1a0dc121357a09f2','Order status Pending approval, NOT executed debit proof. Date is Owner-reported payment/order day; no independently confirmed bank execution. SHA256 3e30b2a073c147a7d1002483a5f5d299ab186e79e3fc79cd5d5cf77701632f1d.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_order_1031926P26031973');

INSERT INTO operation_attachments (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at)
SELECT 'att_atasia_credit_00014531','op_vn_atasia_00014531','incoming','payment_confirmation','00014531',1790769600,9017501,'VND','AT ASIA','https://mail.google.com/mail/u/?authuser=dasexperten%40gmail.com#all/1a0f11541bf2597f','manual','gmail:1a0f11541bf2597f','Recipient confirms +9017501 VND credit and EDO. This confirms supplier receipt, not independently verified bank debit date/status. Acknowledgement received 30 September 2026 (original message Date Wed 30 Sep 2026 13:51:32 +0700); payment day 26 September remains Owner-reported.',unixepoch(),unixepoch()
WHERE NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_credit_00014531');

-- Reuse previously stored correction notice without copying its binary or changing original relation.
INSERT INTO operation_attachments (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at)
SELECT 'att_atasia_04ss_00014531','op_vn_atasia_00014531',direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,unixepoch(),unixepoch()
FROM operation_attachments WHERE id='att_04ss_8980b7b66ee038d1b717'
AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE id='att_atasia_04ss_00014531');
