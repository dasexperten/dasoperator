-- Migration 0019 — partners.abbreviation seed + unique index
-- Populates abbreviation values for all 70 partners and adds uniqueness guard.
-- Column itself was added by 0015_partners_abbreviation.sql.
--
-- Format: 2-6 letter uppercase code, used in contract numbering
--   (DEE-{ABBR}-{YYYY}-{NNN}) and contract file paths in R2
--   (contracts/<our_company_id>/<ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf).
--
-- Cleanup duplicates that may exist before applying unique index.

-- Populate abbreviations for all partners
UPDATE partners SET abbreviation = 'AKV', updated_at = strftime('%s','now') WHERE id = 'akvilon' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ALK', updated_at = strftime('%s','now') WHERE id = 'alfa_klass' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ALTR', updated_at = strftime('%s','now') WHERE id = 'alfa_trade' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ARV', updated_at = strftime('%s','now') WHERE id = 'arvitpharm' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ACRT', updated_at = strftime('%s','now') WHERE id = 'atlant_test' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ATOL', updated_at = strftime('%s','now') WHERE id = 'atol_online' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'AVIS', updated_at = strftime('%s','now') WHERE id = 'avis_trans' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'BZA', updated_at = strftime('%s','now') WHERE id = 'biznes_alyans' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'SRNT', updated_at = strftime('%s','now') WHERE id = 'blinkova_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'BRIT', updated_at = strftime('%s','now') WHERE id = 'bright_ideas' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FUR', updated_at = strftime('%s','now') WHERE id = 'brusnitsyn_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'CENT', updated_at = strftime('%s','now') WHERE id = 'centuno' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'COT', updated_at = strftime('%s','now') WHERE id = 'cot' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ZNAK', updated_at = strftime('%s','now') WHERE id = 'crpt' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'DBPR', updated_at = strftime('%s','now') WHERE id = 'das_beste_product' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'DSXG', updated_at = strftime('%s','now') WHERE id = 'dasex_group' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'DDL', updated_at = strftime('%s','now') WHERE id = 'dd_logistics' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'DETM', updated_at = strftime('%s','now') WHERE id = 'dm' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'EXP', updated_at = strftime('%s','now') WHERE id = 'ekspedit_pro' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'EOC', updated_at = strftime('%s','now') WHERE id = 'eots' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'LBR', updated_at = strftime('%s','now') WHERE id = 'f4_lubertsy' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ECP', updated_at = strftime('%s','now') WHERE id = 'fau_nia' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FFBS', updated_at = strftime('%s','now') WHERE id = 'ffbase_nsk' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'YNDK', updated_at = strftime('%s','now') WHERE id = 'finplat' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FZNK', updated_at = strftime('%s','now') WHERE id = 'flintstones' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FLP', updated_at = strftime('%s','now') WHERE id = 'flypost' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FLT', updated_at = strftime('%s','now') WHERE id = 'flytim' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FNS', updated_at = strftime('%s','now') WHERE id = 'fns' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'FTS', updated_at = strftime('%s','now') WHERE id = 'fts' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'HHUI', updated_at = strftime('%s','now') WHERE id = 'honghui' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'IMBR', updated_at = strftime('%s','now') WHERE id = 'imbras_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'INF2', updated_at = strftime('%s','now') WHERE id = 'inter_freight' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'INF1', updated_at = strftime('%s','now') WHERE id = 'inter_freight_vostok' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'OZTR', updated_at = strftime('%s','now') WHERE id = 'internet_travel' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'YGZH', updated_at = strftime('%s','now') WHERE id = 'jinxia' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'TSAR', updated_at = strftime('%s','now') WHERE id = 'kazan_fbs' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'KONS', updated_at = strftime('%s','now') WHERE id = 'konsol_pro' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'KRSH', updated_at = strftime('%s','now') WHERE id = 'krasheninnikova_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'LETU', updated_at = strftime('%s','now') WHERE id = 'letoile' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'MM', updated_at = strftime('%s','now') WHERE id = 'magnit_market' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'KUPR', updated_at = strftime('%s','now') WHERE id = 'market_bridge' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'MZHN', updated_at = strftime('%s','now') WHERE id = 'meizhiyuan' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'MME', updated_at = strftime('%s','now') WHERE id = 'mme' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'MDLB', updated_at = strftime('%s','now') WHERE id = 'moduldev' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'NTS', updated_at = strftime('%s','now') WHERE id = 'natusana' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'NEPL', updated_at = strftime('%s','now') WHERE id = 'neptune' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ONLP', updated_at = strftime('%s','now') WHERE id = 'online_patent' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'OZON', updated_at = strftime('%s','now') WHERE id = 'ozon' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'OZCR', updated_at = strftime('%s','now') WHERE id = 'ozon_credit' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'PRIZ', updated_at = strftime('%s','now') WHERE id = 'priz' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'RATI', updated_at = strftime('%s','now') WHERE id = 'ratiya_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'CERT', updated_at = strftime('%s','now') WHERE id = 'regikon' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'RCRM', updated_at = strftime('%s','now') WHERE id = 'retail_driver' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'RUSP', updated_at = strftime('%s','now') WHERE id = 'russian_post' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'IPSN', updated_at = strftime('%s','now') WHERE id = 'senin_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'IPST', updated_at = strftime('%s','now') WHERE id = 'startsev_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'TAMA', updated_at = strftime('%s','now') WHERE id = 'tama' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'CDK1', updated_at = strftime('%s','now') WHERE id = 'timoshchenkova_ip' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'TORI', updated_at = strftime('%s','now') WHERE id = 'tori_georgia' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'TRW', updated_at = strftime('%s','now') WHERE id = 'torwey' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'TRIM', updated_at = strftime('%s','now') WHERE id = 'trans_imperial' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'TSKN', updated_at = strftime('%s','now') WHERE id = 'tsukon' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'URLS', updated_at = strftime('%s','now') WHERE id = 'uralstandart' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'VIPS', updated_at = strftime('%s','now') WHERE id = 'vip_sales' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'VKAD', updated_at = strftime('%s','now') WHERE id = 'vk_ads' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ESTL', updated_at = strftime('%s','now') WHERE id = 'vlk' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'WB', updated_at = strftime('%s','now') WHERE id = 'wb' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'WDAA', updated_at = strftime('%s','now') WHERE id = 'wdaa' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'YAND', updated_at = strftime('%s','now') WHERE id = 'yandex' AND abbreviation IS NULL;
UPDATE partners SET abbreviation = 'ZHDE', updated_at = strftime('%s','now') WHERE id = 'zheldorekspeditsiya' AND abbreviation IS NULL;

-- Enforce uniqueness for non-null values
CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_abbreviation_unique
  ON partners(abbreviation)
  WHERE abbreviation IS NOT NULL;
