-- One verified existing inbox document per invocation. Parameters: inbox ID, now.
-- Caller must first confirm the stored source object is readable through
-- /api/inbox/:id/file. No operations, amounts, statuses or stock are changed.
-- Exact legacy operation identity and amount are rechecked at the write boundary.
INSERT INTO operation_attachments (
  id, operation_id, direction, kind, doc_number, doc_date, amount, currency,
  issuer, file_url, parsed_from, source_ref_id, notes, created_at, updated_at
)
SELECT 'att_f4_restore_' || i.id, o.id, 'incoming',
  CASE i.classification WHEN 'acceptance' THEN 'acceptance' ELSE 'invoice' END,
  TRIM(i.extracted_invoice_no), CAST(strftime('%s', i.extracted_invoice_date) AS INTEGER),
  i.extracted_amount, 'RUB', i.extracted_vendor_name,
  'https://dasoperator-api.dasexperten.workers.dev/api/inbox/' || i.id || '/file',
  'inbox', i.id, 'Restored original F4 document link omitted by legacy importer; no monetary changes', ?2, ?2
FROM invoice_inbox i JOIN operations o ON o.id=i.created_operation_id
WHERE i.id=?1 AND i.deleted_at IS NULL AND o.deleted_at IS NULL
  AND i.matched_partner_id='f4_lubertsy' AND o.partner_id='f4_lubertsy'
  AND o.our_company_id='dee' AND o.operation_type='service'
  AND o.notes LIKE 'Invoice from invoice_inbox (cron)%'
  AND o.status<>'cancelled'
  AND i.status IN ('auto_created','auto_attached','manual_confirmed')
  AND i.classification IN ('service','acceptance')
  AND i.extracted_currency='RUB' AND o.currency='RUB'
  AND i.extracted_amount>0 AND ROUND(i.extracted_amount*100)=ROUND(o.total_amount*100)
  AND i.attachment_r2_key IS NOT NULL AND TRIM(i.attachment_r2_key)<>''
  AND o.operation_date=CAST(strftime('%s', i.extracted_invoice_date) AS INTEGER)
  AND o.reference='LBR-' || REPLACE(i.extracted_invoice_date,'-','') || '-' || TRIM(i.extracted_invoice_no)
  AND NOT EXISTS (SELECT 1 FROM operation_attachments a
    WHERE a.parsed_from='inbox' AND a.source_ref_id=i.id AND a.deleted_at IS NULL)
ON CONFLICT(id) DO NOTHING;
