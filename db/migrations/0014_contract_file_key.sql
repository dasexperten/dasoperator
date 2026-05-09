-- Migration 0014 — contract_file_key
-- Adds R2 object key reference to contracts table.
-- Contract documents now live in R2 bucket das-erp-docs-dev under
-- the prefix `contracts/<company>/<partner>_<date>.pdf`.
-- The contract_no field stays as-is (free-text, optional in practice).
-- contract_file_key may be NULL (no PDF uploaded yet) or a string
-- like "contracts/dee/letoile_2024-03-15.pdf".

ALTER TABLE contracts ADD COLUMN contract_file_key TEXT;
