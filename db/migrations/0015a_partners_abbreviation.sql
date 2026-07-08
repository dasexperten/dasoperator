-- Migration 0015 — partners.abbreviation
-- Adds 4-letter uppercase abbreviation code per partner.
-- Used to construct contract filenames in R2:
--   contracts/<our_company_id>/<ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf
-- e.g. contracts/dee/DEE-LETU-2024-03-15.pdf for Л'Этуаль.
-- Required before uploading any contract PDF file via
--   POST /api/contracts/:id/file

ALTER TABLE partners ADD COLUMN abbreviation TEXT;
