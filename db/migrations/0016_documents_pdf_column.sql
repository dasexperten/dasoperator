-- Migration 0016: add pdf_converted_r2_url to documents
-- Stores R2 key of the PDF version generated via CloudConvert.
-- pdf_r2_url remains the .docx key (source of truth for rendering).
-- pdf_converted_r2_url is populated lazily on first PDF download request.

ALTER TABLE documents ADD COLUMN pdf_converted_r2_url TEXT;
