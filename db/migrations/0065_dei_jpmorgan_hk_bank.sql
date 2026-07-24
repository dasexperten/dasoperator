-- 0065 — DEI second operational bank: JPMorgan Chase HK (alongside Wio)
-- Owner 2026-07-24: Account B · USD + EUR · not a replacement for Wio.
-- Contacts SSOT: dasexperten.com SKILLS/contacts/reference/das-group/dei.md Account B
-- Vault: organizacia SECRETS/jpmorgan-hk-dei.md

-- -----------------------------------------------------------------------------
-- 1. Bank provider (manual entry; no API yet)
-- -----------------------------------------------------------------------------
INSERT INTO bank_providers (
  id, name, country, api_base_url, webhook_path, auth_method, notes,
  is_active, created_at, updated_at, deleted_at,
  bic, swift, correspondent_account, bank_legal_name, bank_legal_name_ru
) VALUES (
  'bp_jpmorgan_hk',
  'JPMorgan Chase HK',
  'HK',
  NULL,
  NULL,
  'manual',
  'JPMorgan Chase Bank N.A., Hong Kong Branch. DEI Current account. USD + EUR. Alongside Wio (bp_wio), not instead. Owner 2026-07-24.',
  1,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL,
  NULL,
  'CHASHKHH',
  NULL,
  'JPMorgan Chase Bank N.A., Hong Kong Branch',
  NULL
)
ON CONFLICT(id) DO UPDATE SET
  notes = excluded.notes,
  swift = excluded.swift,
  bank_legal_name = excluded.bank_legal_name,
  updated_at = strftime('%s','now'),
  deleted_at = NULL,
  is_active = 1;

-- -----------------------------------------------------------------------------
-- 2. Per-account bank identity columns (so invoicer does not mix Wio name + Chase number)
-- -----------------------------------------------------------------------------
-- SQLite: ADD COLUMN is idempotent only once — re-run safe via try pattern not available;
-- if columns already exist this migration must not be re-applied blindly.
ALTER TABLE company_bank_accounts ADD COLUMN bank_name TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN bank_address TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN swift TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN iban TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN account_holder TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN bank_code TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN branch_number TEXT;
ALTER TABLE company_bank_accounts ADD COLUMN routing_number TEXT;

-- -----------------------------------------------------------------------------
-- 3. Backfill Wio rows (existing DEI) with explicit bank identity
-- -----------------------------------------------------------------------------
UPDATE company_bank_accounts SET
  bank_name = COALESCE(bank_name, 'Wio Bank PJSC'),
  bank_address = COALESCE(bank_address, 'Etihad Airways Centre, 5th Floor, Abu Dhabi, UAE'),
  swift = COALESCE(swift, 'WIOBAEADXXX'),
  iban = COALESCE(iban, account_number),
  account_holder = COALESCE(account_holder, 'Das Experten International LLC'),
  bank_provider_id = COALESCE(bank_provider_id, 'bp_wio'),
  notes = CASE
    WHEN notes LIKE '%Wio%' THEN notes
    ELSE COALESCE(notes || ' · ', '') || 'Wio Bank PJSC · Account A (alongside Chase HK)'
  END,
  updated_at = strftime('%s','now')
WHERE company_id = 'dei'
  AND (
    account_number LIKE 'AE%'
    OR id LIKE 'cba_dei_wio%'
    OR id = 'cba_dei_usd'
  );

-- -----------------------------------------------------------------------------
-- 4. Chase HK · USD + EUR (same current account, two currency faces)
-- -----------------------------------------------------------------------------
INSERT INTO company_bank_accounts (
  id, company_id, account_purpose, account_number, currency, notes,
  is_default, created_at, updated_at, deleted_at,
  bank_provider_id, external_account_id, external_company_id,
  webhook_signature_prefix, api_enabled, last_sync_at, is_visible_in_ui,
  bank_name, bank_address, swift, iban, account_holder,
  bank_code, branch_number, routing_number
) VALUES
(
  'cba_dei_chase_usd',
  'dei',
  'usd',
  '63003463847',
  'USD',
  'JPMorgan Chase Bank N.A., Hong Kong Branch · Current · Account B (alongside Wio). Bank code 007 · Branch 863 · Routing 007863 · SWIFT CHASHKHH · CHATER HOUSE, 8 CONNAUGHT ROAD, CENTRAL, HONG KONG. Owner 2026-07-24.',
  0,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL,
  'bp_jpmorgan_hk',
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  1,
  'JPMorgan Chase Bank N.A., Hong Kong Branch',
  'CHATER HOUSE, 8 CONNAUGHT ROAD, CENTRAL, HONG KONG',
  'CHASHKHH',
  NULL,
  'Das Experten International LLC',
  '007',
  '863',
  '007863'
),
(
  'cba_dei_chase_eur',
  'dei',
  'eur',
  '63003463847',
  'EUR',
  'JPMorgan Chase Bank N.A., Hong Kong Branch · Current · Account B (alongside Wio). Same account number as USD face. Bank code 007 · Branch 863 · Routing 007863 · SWIFT CHASHKHH. Owner 2026-07-24.',
  0,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL,
  'bp_jpmorgan_hk',
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  1,
  'JPMorgan Chase Bank N.A., Hong Kong Branch',
  'CHATER HOUSE, 8 CONNAUGHT ROAD, CENTRAL, HONG KONG',
  'CHASHKHH',
  NULL,
  'Das Experten International LLC',
  '007',
  '863',
  '007863'
)
ON CONFLICT(id) DO UPDATE SET
  account_number = excluded.account_number,
  currency = excluded.currency,
  notes = excluded.notes,
  bank_provider_id = excluded.bank_provider_id,
  bank_name = excluded.bank_name,
  bank_address = excluded.bank_address,
  swift = excluded.swift,
  account_holder = excluded.account_holder,
  bank_code = excluded.bank_code,
  branch_number = excluded.branch_number,
  routing_number = excluded.routing_number,
  is_visible_in_ui = 1,
  deleted_at = NULL,
  updated_at = strftime('%s','now');

-- -----------------------------------------------------------------------------
-- 5. companies legacy columns stay Wio (default invoice rail) — do not overwrite.
--    Touch last_verified so operators see refresh.
-- -----------------------------------------------------------------------------
UPDATE companies SET
  notes = CASE
    WHEN notes LIKE '%Chase HK%' THEN notes
    WHEN notes IS NULL OR notes = '' THEN 'Operational banks: Wio (default) + JPMorgan Chase HK Account B (USD/EUR). See company_bank_accounts.'
    ELSE notes || ' · Also JPMorgan Chase HK Account B (USD/EUR) in company_bank_accounts.'
  END,
  updated_at = strftime('%s','now')
WHERE id = 'dei';
