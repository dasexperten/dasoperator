-- 0087 — DEASEAN banking: VietinBank (Branch 9 HCMC) provider + four accounts
-- Justina Timber 2026-09-14 · Owner task: read VietinBank mail in dasexperten@gmail.com,
-- understand the API connection, connect it to the ERP finance section.
--
-- Facts on file (no invention, HARD_RULES §0b):
--   · Account numbers, holder, SWIFT: dasexperten.com SKILLS/contacts/reference/das-group/dasean.md
--     (last_verified 2026-04-19). Vault: organizacia SECRETS/vietinbank-deasean.md.
--   · Branch name, address, tax code: VietinBank e-Invoice mails 1K26TAB/1K26TBB, Jan–Jun 2026.
--   · API: VietinBank Open API Portal (openapi.vietinbank.vn, new version June 2026). No
--     registration, credential or contract for DEASEAN exists in the mailbox (15 threads,
--     21 messages read 2026-09-14): eFAST internet banking only. So auth_method = 'manual'
--     and api_enabled = 0 until the Owner registers on the portal. Statements enter through
--     /finance upload (parser supports VND).
--
-- Live schema check 2026-09-14: account_purpose has no 'vnd' → VND accounts use 'primary'.
-- IRC account is RESTRICTED (capital contribution only) — excluded from invoices in
-- api/src/skills/invoicer/selectors.ts (RESTRICTED_BANK_ACCOUNT_IDS).

-- -----------------------------------------------------------------------------
-- 1. Bank provider
-- -----------------------------------------------------------------------------
INSERT INTO bank_providers (
  id, name, country, api_base_url, webhook_path, auth_method, notes,
  is_active, created_at, updated_at, deleted_at,
  bic, swift, correspondent_account, bank_legal_name, bank_legal_name_ru
) VALUES (
  'bp_vietinbank',
  'VietinBank',
  'VN',
  NULL,
  NULL,
  'manual',
  'VietinBank – Chi nhánh 9 TP. Hồ Chí Minh (seller tax code 0100111948-058). DEASEAN internet banking: eFAST (efast.vietinbank.vn), dual control create/approve. API path: VietinBank Open API Portal openapi.vietinbank.vn (account inquiry, balance-change notification, transfers) — NOT registered for DEASEAN as of 2026-09-14; statements by /finance upload until then.',
  1,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL,
  NULL,
  'ICBVVNVX928',
  NULL,
  'Vietnam Joint Stock Commercial Bank for Industry and Trade (VietinBank) – Branch 9 Ho Chi Minh City',
  NULL
)
ON CONFLICT(id) DO UPDATE SET
  notes = excluded.notes,
  swift = excluded.swift,
  bank_legal_name = excluded.bank_legal_name,
  auth_method = excluded.auth_method,
  updated_at = strftime('%s','now'),
  deleted_at = NULL,
  is_active = 1;

-- -----------------------------------------------------------------------------
-- 2. DEASEAN accounts (holder: DAS EXPERTEN ASEAN COMPANY LIMITED)
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
  'cba_dasean_vietin_usd', 'dasean', 'usd', '118003040220', 'USD',
  'VietinBank · USD operating account — default for ALL DEASEAN commercial invoices and wires (DEI → DEASEAN supply, customer payments).',
  1, strftime('%s','now'), strftime('%s','now'), NULL,
  'bp_vietinbank', NULL, NULL, NULL, 0, NULL, 1,
  'Vietnam Joint Stock Commercial Bank for Industry and Trade (VietinBank) – Branch 9 Ho Chi Minh City',
  '01 Nguyen Oanh, Go Vap Ward, Ho Chi Minh City, Vietnam',
  'ICBVVNVX928', NULL, 'DAS EXPERTEN ASEAN COMPANY LIMITED', NULL, NULL, NULL
),
(
  'cba_dasean_vietin_vnd1', 'dasean', 'primary', '116003024318', 'VND',
  'VietinBank · VND account #1 — domestic operations.',
  0, strftime('%s','now'), strftime('%s','now'), NULL,
  'bp_vietinbank', NULL, NULL, NULL, 0, NULL, 1,
  'Vietnam Joint Stock Commercial Bank for Industry and Trade (VietinBank) – Branch 9 Ho Chi Minh City',
  '01 Nguyen Oanh, Go Vap Ward, Ho Chi Minh City, Vietnam',
  'ICBVVNVX928', NULL, 'DAS EXPERTEN ASEAN COMPANY LIMITED', NULL, NULL, NULL
),
(
  'cba_dasean_vietin_vnd2', 'dasean', 'primary', '117003040219', 'VND',
  'VietinBank · VND account #2 — domestic operations.',
  0, strftime('%s','now'), strftime('%s','now'), NULL,
  'bp_vietinbank', NULL, NULL, NULL, 0, NULL, 1,
  'Vietnam Joint Stock Commercial Bank for Industry and Trade (VietinBank) – Branch 9 Ho Chi Minh City',
  '01 Nguyen Oanh, Go Vap Ward, Ho Chi Minh City, Vietnam',
  'ICBVVNVX928', NULL, 'DAS EXPERTEN ASEAN COMPANY LIMITED', NULL, NULL, NULL
),
(
  'cba_dasean_vietin_usd_irc', 'dasean', 'usd', '110003040270', 'USD',
  'RESTRICTED · VietinBank USD IRC (Investment & Registered Capital). Charter capital from the founder ONLY. Never on invoices, contracts or B2B wires (Vietnamese capital controls). Moving money IRC → operating is a web eFAST action.',
  0, strftime('%s','now'), strftime('%s','now'), NULL,
  'bp_vietinbank', NULL, NULL, NULL, 0, NULL, 1,
  'Vietnam Joint Stock Commercial Bank for Industry and Trade (VietinBank) – Branch 9 Ho Chi Minh City',
  '01 Nguyen Oanh, Go Vap Ward, Ho Chi Minh City, Vietnam',
  'ICBVVNVX928', NULL, 'DAS EXPERTEN ASEAN COMPANY LIMITED', NULL, NULL, NULL
)
ON CONFLICT(id) DO UPDATE SET
  account_purpose = excluded.account_purpose,
  account_number = excluded.account_number,
  currency = excluded.currency,
  notes = excluded.notes,
  is_default = excluded.is_default,
  bank_provider_id = excluded.bank_provider_id,
  bank_name = excluded.bank_name,
  bank_address = excluded.bank_address,
  swift = excluded.swift,
  account_holder = excluded.account_holder,
  is_visible_in_ui = 1,
  deleted_at = NULL,
  updated_at = strftime('%s','now');
