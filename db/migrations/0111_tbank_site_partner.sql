-- Owner 2026-10-07: dasexperten.ru own-site orders are paid through T-Kassa
-- (T-Bank, formerly Tinkoff). They become TBANK-YYYYMM sale operations built
-- by api/src/lib/tbank-site-sale.ts on the erp-ru-orders cron. This adds the
-- counterparty and the contract those operations and payments hang on.
-- Rollback (before any TBANK operation exists):
--   DELETE FROM contracts WHERE id = 'tbank_kassa_dasexperten_ru';
--   DELETE FROM partners  WHERE id = 'tbank';
INSERT OR IGNORE INTO partners (
  id, trade_name, legal_name, country, currency, status, partner_type, kind,
  slug, abbreviation, notes, created_at, updated_at
) VALUES (
  'tbank', 'T-Bank', 'dasexperten.ru online channel (T-Kassa, T-Bank)', 'Russia', 'RUB',
  'active', 'buyer', 'buyer', 'tbank', 'TBANK',
  'Own-site sales on dasexperten.ru — customers pay through T-Kassa (T-Bank, formerly Tinkoff)',
  strftime('%s','now'), strftime('%s','now')
);
INSERT OR IGNORE INTO contracts (
  id, contract_no, partner_id, our_company_id, currency, status, notes,
  vat_rate, agreement_type, created_at, updated_at
) VALUES (
  'tbank_kassa_dasexperten_ru', 'T-KASSA-DASEXPERTEN-RU', 'tbank', 'dee', 'RUB', 'active',
  'Internet acquiring — T-Kassa (T-Bank). End customers of dasexperten.ru pay by card / SBP / T-Pay; T-Bank settles to DEE.',
  0, 'main', strftime('%s','now'), strftime('%s','now')
);
