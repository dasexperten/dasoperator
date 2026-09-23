-- 0100 — Evidence-backed product identification state for each UGC publication.
-- product_codes remains the raw imported evidence. These fields describe the
-- best completed classification pass without pretending that a missing match
-- is a zero or that a generic visual theme proves a SKU.

ALTER TABLE ugc_content ADD COLUMN product_status TEXT
  CHECK (product_status IN ('identified', 'queued', 'unknown'));
ALTER TABLE ugc_content ADD COLUMN product_source TEXT
  CHECK (product_source IN ('explicit_import', 'metadata_text', 'vision', 'manual'));
ALTER TABLE ugc_content ADD COLUMN product_confidence REAL
  CHECK (product_confidence IS NULL OR (product_confidence >= 0 AND product_confidence <= 1));
ALTER TABLE ugc_content ADD COLUMN product_evidence TEXT;
ALTER TABLE ugc_content ADD COLUMN product_checked_at TEXT;

-- Only canonical products verified in product-skill are marked identified.
UPDATE ugc_content
SET product_status = 'identified', product_source = 'explicit_import',
    product_confidence = 1.0, product_evidence = 'Legacy XLSX product column',
    product_checked_at = datetime('now')
WHERE product_codes IS NOT NULL AND (
  product_codes LIKE '%"DE101%' OR product_codes LIKE '%"DE105%' OR
  product_codes LIKE '%"DE106%' OR product_codes LIKE '%"DE107%' OR
  product_codes LIKE '%"DE111%' OR product_codes LIKE '%"DE112%' OR
  product_codes LIKE '%"DE115%' OR product_codes LIKE '%"DE116%' OR
  product_codes LIKE '%"DE117%' OR product_codes LIKE '%"DE119%' OR
  product_codes LIKE '%"DE120%' OR product_codes LIKE '%"DE122%' OR
  product_codes LIKE '%"DE125%' OR product_codes LIKE '%"DE126%' OR
  product_codes LIKE '%"DE130%' OR product_codes LIKE '%"DE131%' OR
  product_codes LIKE '%"DE201%' OR product_codes LIKE '%"DE202%' OR
  product_codes LIKE '%"DE203%' OR product_codes LIKE '%"DE205%' OR
  product_codes LIKE '%"DE206%' OR product_codes LIKE '%"DE207%' OR
  product_codes LIKE '%"DE208%' OR product_codes LIKE '%"DE209%' OR
  product_codes LIKE '%"DE210%' OR product_codes LIKE '%"DE310%'
);

UPDATE ugc_content
SET product_status = 'unknown', product_source = 'explicit_import',
    product_evidence = 'Unrecognized explicit legacy product code',
    product_checked_at = datetime('now')
WHERE product_status IS NULL AND product_codes IS NOT NULL
  AND TRIM(product_codes) NOT IN ('', '[]');

UPDATE ugc_content
SET product_status = CASE
      WHEN content_url IS NOT NULL AND TRIM(content_url) <> '' THEN 'queued'
      ELSE 'unknown'
    END
WHERE product_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_ugc_content_product_status
  ON ugc_content(product_status, creator_platform_id);
