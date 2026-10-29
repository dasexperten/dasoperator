-- Owner requested category verification; financially reviewed by Justina Timber.
-- Metadata only: no amounts, payments, bank statuses, goods allocations or new SKUs.
-- Run as one D1 batch. Rollback only changed metadata after checking later edits.
SELECT CASE WHEN
 (SELECT COUNT(*) FROM partners WHERE id IN ('at-asia-hcm','fedex-express-vietnam')
  AND deleted_at IS NULL AND partner_type='supplier' AND kind='service_provider'
  AND (partner_subtype IS NULL OR partner_subtype='logistics'))=2
 AND (SELECT COUNT(*) FROM operations WHERE deleted_at IS NULL AND currency='VND' AND operation_track='service'
  AND ((id='op_vn_atasia_00014531' AND operation_type='service' AND total_amount=9017501 AND vat_rate=8
    AND (service_subtype IS NULL OR service_subtype='logistics_local_charges'))
   OR (id='op_vn_fedex_928A26A0FMWQ51NL' AND operation_type='tax' AND total_amount=4510397 AND vat_rate=0
    AND (service_subtype IS NULL OR service_subtype='customs_duty_tax_reimbursement'))
   OR (id='op_vn_import_vat_NNS26102607904' AND operation_type='tax' AND total_amount=17249087 AND vat_rate=0
    AND (service_subtype IS NULL OR service_subtype='import_vat'))))=3
 AND EXISTS (SELECT 1 FROM finance_categories WHERE id='fc_tax_government' AND code='tax_government' AND deleted_at IS NULL)
 AND (SELECT COUNT(*) FROM bank_transactions WHERE deleted_at IS NULL AND currency='VND' AND status='Executed'
  AND (suggested_category_id IS NULL OR suggested_category_id='fc_tax_government')
  AND ((id='bt_vietin_928A26A0FMWQ51NL' AND amount=4510397
    AND matched_operation_id='op_vn_fedex_928A26A0FMWQ51NL' AND matched_payment_id='pay_vietin_928A26A0FMWQ51NL')
   OR (id='bt_vietin_NNS26102607904' AND amount=17249087
    AND matched_operation_id='op_vn_import_vat_NNS26102607904' AND matched_payment_id='pay_vietin_NNS26102607904')))=2
THEN 1 ELSE json('Vietnam classification prerequisites changed; review instead of overwriting') END;

UPDATE partners SET partner_subtype='logistics',updated_at=unixepoch()
WHERE id IN ('at-asia-hcm','fedex-express-vietnam') AND partner_subtype IS NULL;

UPDATE operations SET service_subtype=CASE id
 WHEN 'op_vn_fedex_928A26A0FMWQ51NL' THEN 'customs_duty_tax_reimbursement'
 WHEN 'op_vn_import_vat_NNS26102607904' THEN 'import_vat' END,updated_at=unixepoch()
WHERE id IN ('op_vn_fedex_928A26A0FMWQ51NL','op_vn_import_vat_NNS26102607904') AND service_subtype IS NULL;

UPDATE operations SET service_subtype='logistics_local_charges',
 notes=CASE WHEN instr(coalesce(notes,''),'Invoice line breakdown (net/VAT/gross VND):')>0 THEN notes ELSE coalesce(notes,'') || char(10) ||
 'Invoice line breakdown (net/VAT/gross VND): fuel 2711735/216939/2928674; LCL handling 1988606/159088/2147694; container imbalance 813521/65082/878603; documents 915950/73276/989226; cargo handling 654250/52340/706590; low sulphur 542347/43388/585735; port handling 723129/57850/780979. Totals 8349538/667963/9017501. These are logistics/local charges, not import duty or import VAT. Source: invoice 00014531; lines visually verified by Justina Timber.' END,
 updated_at=unixepoch()
WHERE id='op_vn_atasia_00014531' AND (service_subtype IS NULL OR instr(coalesce(notes,''),'Invoice line breakdown (net/VAT/gross VND):')=0);

UPDATE bank_transactions SET suggested_category_id='fc_tax_government',updated_at=unixepoch()
WHERE id IN ('bt_vietin_928A26A0FMWQ51NL','bt_vietin_NNS26102607904') AND suggested_category_id IS NULL;
