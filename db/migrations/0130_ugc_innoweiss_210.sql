-- Owner 2026-10-17: INNOWEISS = 210, including the legacy InnoWeis name.
-- Preserve source text and amounts. Explicit mouthwash code 310 is untouched.
UPDATE ugc_source_records
SET product_codes = json_insert(COALESCE(product_codes, '[]'), '$[#]', 'DE210')
WHERE kind = 'product_reference'
  AND upper(trim(source_text)) IN ('INNOWEIS', 'INNOWEISS')
  AND json_valid(COALESCE(product_codes, '[]'))
  AND json_type(COALESCE(product_codes, '[]')) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(product_codes, '[]')) WHERE value IN ('DE210', 'DE310'));

-- Only publication-local INNOWEISS evidence can resolve a publication.
-- Do not inherit an account's historical product into another publication.
UPDATE ugc_content
SET product_codes = json_insert(COALESCE(product_codes, '[]'), '$[#]', 'DE210'),
    product_status = 'identified', product_source = 'manual', product_confidence = 1,
    product_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    updated_at = unixepoch(),
    product_evidence = json_set(product_evidence,
      '$.owner_resolution', json_object('date', '2026-10-17', 'rule', 'INNOWEISS = 210', 'sku', 'DE210'),
      '$.labels', json((SELECT json_group_array(json(value)) FROM json_each(product_evidence, '$.labels') WHERE json_extract(value, '$.name') != 'INNOWEISS')))
WHERE product_status = 'unknown'
  AND json_valid(product_evidence)
  AND json_valid(COALESCE(product_codes, '[]'))
  AND json_type(COALESCE(product_codes, '[]')) = 'array'
  AND EXISTS (SELECT 1 FROM json_each(product_evidence, '$.labels') WHERE json_extract(value, '$.name') = 'INNOWEISS')
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(product_codes, '[]')) WHERE value IN ('DE210', 'DE310'));
