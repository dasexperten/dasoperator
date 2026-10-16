-- Owner 2026-10-16: blogger database evidence, not executable payouts.
CREATE TABLE IF NOT EXISTS ugc_source_records (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES ugc_creators(id),
  creator_platform_id TEXT REFERENCES ugc_creator_platforms(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment_register', 'product_reference')),
  source_document TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  source_text TEXT,
  source_flag TEXT,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR currency = 'RUB'),
  product_codes TEXT,
  content_url TEXT,
  imported_at INTEGER NOT NULL,
  UNIQUE(source_document, source_sheet, source_row, kind, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_ugc_source_creator ON ugc_source_records(creator_id, kind);
CREATE INDEX IF NOT EXISTS idx_ugc_source_profile ON ugc_source_records(creator_platform_id, kind);
