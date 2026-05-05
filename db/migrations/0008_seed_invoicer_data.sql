-- =============================================================================
-- Migration 0008 — Seed invoicer data (companies, manufacturers, products,
-- partners, contracts) + product-id rename + test-operation cleanup.
-- =============================================================================
-- Source of truth: contacts skill .md files (das-group/dee, dei, deasean,
-- dec; manufacturers/honghui, jinxia, wdaa, meizhiyuan; partners/...) and
-- the invoicer skill product database. Values were extracted by hand and
-- inlined here so this migration is self-contained.
--
-- Behaviour notes:
--   * Updates only — no INSERTs of new partners/products/manufacturers.
--   * Operations / line_items / documents are wiped: they were 2 test rows
--     created during Phase 2.0c-2/2.0c-3 development and are no longer
--     referenced by anything we want to keep.
--   * Sequences for DEE / CI / PL are reset to next_number=1.
--   * Product IDs are renamed prd_de* → de* (skill-canonical SKU casing).
--     line_items references are updated in the same transaction.
--   * partners.id keeps the prt_<slug> form: the public API exposes it as
--     :slug but it is the primary key, not a separate column.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. companies — populate banking, identity, signing authority, defaults
-- -----------------------------------------------------------------------------

-- DEE: Russian entity. Two settlement accounts → see step 2.
UPDATE companies SET
  legal_name = 'DAS EXPERTEN EURASIA LLC',
  legal_name_ru = 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ"',
  trade_name = 'Das Experten Eurasia',
  jurisdiction = 'Russia',
  registration_no = '1227700061313',
  tax_id = '9704117379',
  kpp = '130001001',
  ogrn = '1227700061313',
  registered_address = '430034, Republic of Mordovia, Saransk, Promyshlennaya 1-YA st., bldg 23, premises 4, Russian Federation',
  base_currency = 'RUB',
  bank_name = 'ФИЛИАЛ "ЦЕНТРАЛЬНЫЙ" БАНКА ВТБ (ПАО)',
  bank_name_en = 'VTB Bank (PJSC) Tsentralnyi Branch, Moscow',
  bank_address = 'Moscow, Russia',
  bik = '044525411',
  correspondent_account = '30101810145250000411',
  swift = 'VTBRRUM2MS2',
  signing_authority_name = 'Aram Badalyan',
  signing_authority_title_en = 'General Manager',
  signing_authority_title_ru = 'Генеральный директор',
  default_invoice_language = 'RU',
  preferred_incoterms_domestic = 'FCA Moscow',
  preferred_incoterms_international = 'EXW Saransk',
  last_verified = 1745020800,  -- 2026-04-19
  updated_at = strftime('%s','now')
WHERE id = 'cmp_dee';

-- DEI: UAE entity, Wio Bank.
UPDATE companies SET
  legal_name = 'Das Experten International LLC',
  legal_name_local = 'داس إكسبيرتن إنترناشيونال ذ م م',
  trade_name = 'Das Experten International',
  jurisdiction = 'United Arab Emirates',
  registration_no = '2221260',
  tax_id = '104184998300001',
  registered_address = 'Shams Business Center, Sharjah Media City Free Zone, Al Messaned, Sharjah, UAE',
  base_currency = 'USD',
  bank_name = 'Wio Bank PJSC',
  bank_address = 'Etihad Airways Centre, 5th Floor, Abu Dhabi, UAE',
  iban = 'AE350860000009191889772',
  swift = 'WIOBAEADXXX',
  signing_authority_name = 'Aram Badalyan',
  signing_authority_title_en = 'General Manager',
  default_invoice_language = 'EN',
  preferred_incoterms_international = 'FOB Guangzhou',
  last_verified = 1745107200,  -- 2026-04-20
  updated_at = strftime('%s','now')
WHERE id = 'cmp_dei';

-- DEASEAN: Vietnam entity. Banking PENDING.
UPDATE companies SET
  legal_name = 'Das Experten ASEAN Co. Ltd.',
  trade_name = 'Das Experten ASEAN',
  jurisdiction = 'Vietnam',
  base_currency = 'USD',
  default_invoice_language = 'EN',
  preferred_incoterms_international = 'FOB Guangzhou',
  notes = 'Banking PENDING — request from user before issuing invoice',
  updated_at = strftime('%s','now')
WHERE id = 'cmp_dasean';

-- DEC: Seychelles IP holder. Banking PENDING.
UPDATE companies SET
  legal_name = 'Das Experten Corporation',
  trade_name = 'Das Experten Corporation',
  jurisdiction = 'Seychelles',
  base_currency = 'USD',
  default_invoice_language = 'EN',
  notes = 'IP holding entity. Banking PENDING. Owns WIPO trademarks IR 1550919, IR 1675375.',
  updated_at = strftime('%s','now')
WHERE id = 'cmp_dec';

-- -----------------------------------------------------------------------------
-- 2. company_bank_accounts — DEE (2 accounts) + DEI (1 account)
-- -----------------------------------------------------------------------------
INSERT INTO company_bank_accounts
  (id, company_id, account_purpose, account_number, currency, is_default, notes, created_at, updated_at) VALUES
  ('cba_dee_rub',    'cmp_dee', 'rub',     '40702810024370000534', 'RUB', 1,
   'Расчётный счёт RUB. Для российских платежей.',
   strftime('%s','now'), strftime('%s','now')),
  ('cba_dee_cnyusd', 'cmp_dee', 'cny_usd', '40702156600340000037', 'USD', 0,
   'Текущий счёт. Для платежей из Китая (Honghui/Jinxia) и USD/CNY transactions.',
   strftime('%s','now'), strftime('%s','now')),
  ('cba_dei_usd',    'cmp_dei', 'primary', 'AE350860000009191889772', 'USD', 1,
   'IBAN format. Wio Bank.',
   strftime('%s','now'), strftime('%s','now'));

-- -----------------------------------------------------------------------------
-- 3. manufacturers — multilingual identity + dual-route flag
--    (Bank routes intentionally NOT seeded; has_dual_route_banking=1
--    triggers ROUTE_REQUIRED hard-stop in invoicer until rows exist in
--    manufacturer_bank_routes — that is the desired behaviour.)
-- -----------------------------------------------------------------------------
UPDATE manufacturers SET
  legal_name_en = 'GUANGZHOU HONGHUI DAILY TECHNOLOGY CO., LTD.',
  legal_name_cn = '广州虹辉日用品科技有限公司',
  legal_name_ru = 'GUANGZHOU HONGHUI DAILY TECHNOLOGY CO., LTD.',
  registered_address_en = 'Room 107, Building B, No.337 Baiyundadaobei, Baiyun District, Guangzhou City, post code 510000, China',
  registered_address_ru = 'Китай, г. Гуанчжоу, район Байюнь, ул. Байюнь Дадаобэй, № 337, здание B, комната 107, почтовый индекс 510000',
  tax_id = '91440101MA5AM6CU3M',
  has_dual_route_banking = 1,
  updated_at = strftime('%s','now')
WHERE id = 'mfr_honghui';

UPDATE manufacturers SET
  legal_name_en = 'YANGZHOU JINXIA PLASTIC PRODUCTS & RUBBER CO., LTD',
  legal_name_cn = '扬州金霞塑料制品橡胶有限公司',
  legal_name_ru = 'Компания с ограниченной ответственностью Янчжоу Цзинься Пластик Продактс энд Раббер',
  registered_address_en = 'No.40 Weiye Road, Hangji Industrial Park, Yangzhou City, China',
  registered_address_ru = 'Китай, Янчжоу, Ханцзи Индастриал Парк, ул. Вэйе 40',
  has_dual_route_banking = 1,
  updated_at = strftime('%s','now')
WHERE id = 'mfr_jinxia';

UPDATE manufacturers SET
  legal_name_en = 'WDAA Limited',
  has_dual_route_banking = 0,
  updated_at = strftime('%s','now')
WHERE id = 'mfr_wdaa';

UPDATE manufacturers SET
  legal_name_en = 'Guangzhou MEIZHIYUAN Cosmetics Co., Ltd.',
  has_dual_route_banking = 0,
  updated_at = strftime('%s','now')
WHERE id = 'mfr_meizhiyuan';

-- -----------------------------------------------------------------------------
-- 4. products — rename IDs (prd_de* → de*) and populate invoicer fields.
--    FKs: line_items.product_id, product_prices.product_id, stocks.product_id,
--    inventory_items.product_id all reference products(id) ON DELETE RESTRICT.
--    With FKs disabled (D1 default), the UPDATE on products(id) does not
--    cascade, so we must update each child table by hand. We do them in
--    one transaction with PRAGMA foreign_keys=OFF to be explicit.
-- -----------------------------------------------------------------------------
PRAGMA foreign_keys = OFF;

UPDATE line_items
   SET product_id = LOWER(REPLACE(product_id, 'prd_', ''))
 WHERE product_id LIKE 'prd_%';

UPDATE product_prices
   SET product_id = LOWER(REPLACE(product_id, 'prd_', ''))
 WHERE product_id LIKE 'prd_%';

UPDATE stocks
   SET product_id = LOWER(REPLACE(product_id, 'prd_', ''))
 WHERE product_id LIKE 'prd_%';

UPDATE inventory_items
   SET product_id = LOWER(REPLACE(product_id, 'prd_', ''))
 WHERE product_id LIKE 'prd_%';

UPDATE products
   SET id = LOWER(REPLACE(id, 'prd_', ''))
 WHERE id LIKE 'prd_%';

PRAGMA foreign_keys = ON;

-- ---- Toothpastes 70ml — HS 3306100000, ctn_qty=72, china origin ------------
-- Common carton dims for 70ml toothpastes: 35.5 × 32 × 19 cm; gross 7.6 kg.
UPDATE products SET
  description_en = 'Das Experten SCHWARZ Charcoal Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten SCHWARZ 70 мл',
  description_cn = 'Das Experten SCHWARZ 黑色 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de201';

UPDATE products SET
  description_en = 'Das Experten DETOX Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten DETOX 70 мл',
  description_cn = 'Das Experten DETOX 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de202';

UPDATE products SET
  description_en = 'Das Experten GINGER FORCE Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten GINGER FORCE 70 мл',
  description_cn = 'Das Experten GINGER FORCE 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de203';

UPDATE products SET
  description_en = 'Das Experten AKTIV FORTE Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten AKTIV FORTE 70 мл',
  description_cn = 'Das Experten AKTIV FORTE 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de204';

UPDATE products SET
  description_en = 'Das Experten COCOCANNABIS Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten COCOCANNABIS 70 мл',
  description_cn = 'Das Experten COCOCANNABIS 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de205';

UPDATE products SET
  description_en = 'Das Experten SYMBIOS Enzyme Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten SYMBIOS 70 мл',
  description_cn = 'Das Experten SYMBIOS 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de206';

-- 50ml kid toothpastes (BUDDY, EVOLUTION) share the same ctn dims; net 50g.
UPDATE products SET
  description_en = 'Das Experten BUDDY MICROBIES 0+ Toothpaste 50ml',
  description_ru = 'Зубная паста Das Experten BUDDY MICROBIES 0+ 50 мл',
  description_cn = 'Das Experten BUDDY MICROBIES 0+ 牙膏 50毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 50, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de207';

UPDATE products SET
  description_en = 'Das Experten EVOLUTION 5+ Toothpaste 50ml',
  description_ru = 'Зубная паста Das Experten EVOLUTION 5+ 50 мл',
  description_cn = 'Das Experten EVOLUTION 5+ 牙膏 50毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 50, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de208';

UPDATE products SET
  description_en = 'Das Experten THERMO 39° Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten THERMO 39° 70 мл',
  description_cn = 'Das Experten THERMO 39° 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de209';

UPDATE products SET
  description_en = 'Das Experten INNOWEISS Toothpaste 70ml',
  description_ru = 'Зубная паста Das Experten INNOWEISS 70 мл',
  description_cn = 'Das Experten INNOWEISS 牙膏 70毫升',
  hs_code = '3306100000',
  ctn_qty = 72, ctn_weight_gross_kg = 7.6,
  ctn_dim_l_cm = 35.5, ctn_dim_w_cm = 32, ctn_dim_h_cm = 19,
  unit_net_weight_g = 70, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de210';

-- ---- Toothbrushes — HS 9603210000, ctn_qty=288, china origin ----------------
UPDATE products SET
  description_en = 'Das Experten ETALON Toothbrush',
  description_ru = 'Зубная щётка Das Experten ETALON',
  description_cn = 'Das Experten ETALON 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 9.0,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 20, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de101';

UPDATE products SET
  description_en = 'Das Experten SCHWARZ Toothbrush',
  description_ru = 'Зубная щётка Das Experten SCHWARZ',
  description_cn = 'Das Experten SCHWARZ 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 8.5,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 20, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de105';

UPDATE products SET
  description_en = 'Das Experten SENSITIV Toothbrush',
  description_ru = 'Зубная щётка Das Experten SENSITIV',
  description_cn = 'Das Experten SENSITIV 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 8.5,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 20, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de106';

UPDATE products SET
  description_en = 'Das Experten MITTEL Toothbrush',
  description_ru = 'Зубная щётка Das Experten MITTEL',
  description_cn = 'Das Experten MITTEL 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 8.5,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 20, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de107';

UPDATE products SET
  description_en = 'Das Experten KRAFT Toothbrush',
  description_ru = 'Зубная щётка Das Experten KRAFT',
  description_cn = 'Das Experten KRAFT 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 6.5,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 18, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de116';

-- DE117 ZERO — packaging dims TBD per skill notes; leave dims NULL.
UPDATE products SET
  description_en = 'Das Experten ZERO Toothbrush',
  description_ru = 'Зубная щётка Das Experten ZERO',
  description_cn = 'Das Experten ZERO 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288,
  unit_net_weight_g = 18, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de117';

UPDATE products SET
  description_en = 'Das Experten GROSSE Toothbrush',
  description_ru = 'Зубная щётка Das Experten GROSSE',
  description_cn = 'Das Experten GROSSE 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 9.0,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 22, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de119';

UPDATE products SET
  description_en = 'Das Experten NANO MASSAGE Toothbrush',
  description_ru = 'Зубная щётка Das Experten NANO MASSAGE',
  description_cn = 'Das Experten NANO MASSAGE 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 9.0,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 22, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de120';

UPDATE products SET
  description_en = 'Das Experten AKTIV Toothbrush',
  description_ru = 'Зубная щётка Das Experten AKTIV',
  description_cn = 'Das Experten AKTIV 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 7.0,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 25,
  unit_net_weight_g = 20, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de122';

UPDATE products SET
  description_en = 'Das Experten INTENSIV Toothbrush',
  description_ru = 'Зубная щётка Das Experten INTENSIV',
  description_cn = 'Das Experten INTENSIV 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288, ctn_weight_gross_kg = 9.0,
  ctn_dim_l_cm = 41, ctn_dim_w_cm = 38, ctn_dim_h_cm = 26,
  unit_net_weight_g = 22, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de130';

-- DE131 3D — packaging dims TBD per skill notes; leave dims NULL.
UPDATE products SET
  description_en = 'Das Experten 3D Toothbrush',
  description_ru = 'Зубная щётка Das Experten 3D',
  description_cn = 'Das Experten 3D 牙刷',
  hs_code = '9603210000',
  ctn_qty = 288,
  unit_net_weight_g = 22, country_of_origin = 'China',
  updated_at = strftime('%s','now')
WHERE id = 'de131';

-- -----------------------------------------------------------------------------
-- 5. partners — populate local-language identity, payment terms, language.
--    partners.id has the form prt_<slug>; use id directly.
-- -----------------------------------------------------------------------------
UPDATE partners SET
  legal_name = 'TORWEY TRADE LLC',
  legal_name_local = 'ООО «Торвей Трейд»',
  registered_address_local = 'Саратовская область, г. Энгельс',
  payment_terms = '100% prepayment',
  preferred_invoice_language = 'RU',
  last_verified = strftime('%s','now'),
  updated_at = strftime('%s','now')
WHERE id = 'prt_torwey';

UPDATE partners SET
  legal_name = 'TAMA TRADE LLC',
  legal_name_local = 'ООО «ТАМА Трейд»',
  registered_address_local = 'Саратовская область, г. Энгельс',
  payment_terms = '100% prepayment',
  preferred_invoice_language = 'RU',
  last_verified = strftime('%s','now'),
  updated_at = strftime('%s','now')
WHERE id = 'prt_tama';

UPDATE partners SET
  legal_name = 'TORI-GEORGIA LLC',
  legal_name_local = 'ООО «ТОРИ-ДЖОРДЖИЯ»',
  payment_terms = 'Net 30 days (per DEI contract)',
  preferred_incoterms = 'CIF Tbilisi',
  preferred_invoice_language = 'EN',
  last_verified = strftime('%s','now'),
  updated_at = strftime('%s','now')
WHERE id = 'prt_tori_georgia';

UPDATE partners SET
  legal_name = 'ARVITPHARM LLC',
  legal_name_local = 'ООО «АрвитФарм»',
  payment_terms = '2% per month penalty on overdue payments',
  preferred_invoice_language = 'RU',
  last_verified = strftime('%s','now'),
  updated_at = strftime('%s','now')
WHERE id = 'prt_arvitpharm';

UPDATE partners SET
  legal_name = 'JV NATUSANA LLC',
  legal_name_local = 'СП ООО «Натусана»',
  preferred_incoterms = 'FCA Illichivsk',
  preferred_invoice_language = 'RU',
  last_verified = strftime('%s','now'),
  updated_at = strftime('%s','now')
WHERE id = 'prt_natusana';

-- VIP SALES intentionally left as pending — data missing.

-- -----------------------------------------------------------------------------
-- 6. contracts — УНК + invoice_language
--    The DEE-DEI inter-company contract is identified by contract_no
--    starting with 'DEE-DEI' and signed 2022-06-06 — guard with LIKE.
-- -----------------------------------------------------------------------------
UPDATE contracts SET
  unk_reference = '22110206/1927/0006/2/1',
  unk_valid_until = 1861833600,  -- 2028-12-31
  invoice_language = 'EN',
  updated_at = strftime('%s','now')
WHERE contract_no LIKE 'DEE-DEI%' AND contract_no LIKE '%06062022%';

-- For all other contracts, mirror the partner's preferred_invoice_language.
UPDATE contracts SET
  invoice_language = (
    SELECT preferred_invoice_language
      FROM partners
     WHERE partners.id = contracts.partner_id
  ),
  updated_at = strftime('%s','now')
WHERE invoice_language IS NULL
  AND EXISTS (
    SELECT 1 FROM partners
     WHERE partners.id = contracts.partner_id
       AND partners.preferred_invoice_language IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 7. Wipe test operations + dependent rows + reset relevant sequences.
--    Both ops were created during Phase 2.0c-2 / 2.0c-3 development.
--    deletes are scoped explicitly so unrelated rows are never touched.
-- -----------------------------------------------------------------------------
DELETE FROM line_items
 WHERE operation_id IN (
   'op_6b4b73f4-2ca5-4f3d-9d15-51096bc37f14',
   'op_2f59466f-ce82-4573-be46-9e91127601d3'
 );

DELETE FROM documents
 WHERE operation_id IN (
   'op_6b4b73f4-2ca5-4f3d-9d15-51096bc37f14',
   'op_2f59466f-ce82-4573-be46-9e91127601d3'
 );

DELETE FROM operations
 WHERE id IN (
   'op_6b4b73f4-2ca5-4f3d-9d15-51096bc37f14',
   'op_2f59466f-ce82-4573-be46-9e91127601d3'
 );

-- Sequences: column is next_number (the value WILL be issued next), reset to 1.
UPDATE sequences SET next_number = 1, updated_at = strftime('%s','now')
 WHERE id IN ('seq_dee', 'seq_ci', 'seq_pl');

-- =============================================================================
-- END OF MIGRATION 0008
-- =============================================================================
