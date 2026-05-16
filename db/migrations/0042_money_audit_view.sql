-- =============================================================================
-- Migration 0042 — money audit views (per-table)
-- =============================================================================
-- Convention:
--   bank_transactions.amount      = MINOR (cents)
--   operations.total_amount       = DECIMAL major units
--   payments.amount               = DECIMAL major units
--   agent_settlements *_amount    = MINOR
--   line_items.unit_price         = DECIMAL
-- Range flags ('huge' = likely missed division, 'tiny' = likely extra division)
-- =============================================================================

DROP VIEW IF EXISTS v_money_bank_tx;
DROP VIEW IF EXISTS v_money_operations;
DROP VIEW IF EXISTS v_money_payments;
DROP VIEW IF EXISTS v_money_settlements;
DROP VIEW IF EXISTS v_money_line_items;

CREATE VIEW v_money_bank_tx AS
SELECT bt.id AS source_id, 'amount' AS amount_field, bt.amount AS amount_raw, bt.currency,
       bt.amount / CASE WHEN bt.currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS amount_correct,
       bt.amount / CASE WHEN bt.currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS amount_if_minor,
       bt.amount AS amount_if_decimal,
       CASE
         WHEN bt.currency IN ('USD','EUR') AND bt.amount / 100.0 > 10000000     THEN 'huge'
         WHEN bt.currency = 'RUB'           AND bt.amount / 100.0 > 500000000   THEN 'huge'
         WHEN bt.currency = 'CNY'           AND bt.amount / 100.0 > 50000000    THEN 'huge'
         WHEN bt.currency IN ('USD','EUR','CNY','RUB') AND bt.amount / 100.0 < 0.50 THEN 'tiny'
         ELSE 'ok'
       END AS range_check,
       bt.contragent_name AS context, bt.direction, bt.executed_at AS occurred_at
FROM bank_transactions bt WHERE bt.deleted_at IS NULL;

CREATE VIEW v_money_operations AS
SELECT o.id AS source_id, 'total_amount' AS amount_field, o.total_amount AS amount_raw, o.currency,
       o.total_amount AS amount_correct,
       o.total_amount / CASE WHEN o.currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS amount_if_minor,
       o.total_amount AS amount_if_decimal,
       CASE
         WHEN o.currency IN ('USD','EUR') AND o.total_amount > 10000000 THEN 'huge'
         WHEN o.currency = 'RUB' AND o.total_amount > 500000000 THEN 'huge'
         WHEN o.currency = 'CNY' AND o.total_amount > 50000000 THEN 'huge'
         WHEN o.currency IN ('USD','EUR','CNY','RUB') AND o.total_amount < 0.50 AND o.total_amount > 0 THEN 'tiny'
         ELSE 'ok'
       END AS range_check,
       o.reference AS context, o.operation_type AS op_type, o.operation_date AS occurred_at
FROM operations o WHERE o.deleted_at IS NULL;

CREATE VIEW v_money_payments AS
SELECT p.id AS source_id, 'amount' AS amount_field, p.amount AS amount_raw, p.currency,
       p.amount AS amount_correct,
       p.amount / CASE WHEN p.currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS amount_if_minor,
       p.amount AS amount_if_decimal,
       CASE
         WHEN p.currency IN ('USD','EUR') AND p.amount > 10000000 THEN 'huge'
         WHEN p.currency = 'RUB' AND p.amount > 500000000 THEN 'huge'
         WHEN p.currency = 'CNY' AND p.amount > 50000000 THEN 'huge'
         WHEN p.currency IN ('USD','EUR','CNY','RUB') AND p.amount < 0.50 AND p.amount > 0 THEN 'tiny'
         ELSE 'ok'
       END AS range_check,
       COALESCE(p.notes, p.id) AS context, p.direction, p.payment_date AS occurred_at
FROM payments p WHERE p.deleted_at IS NULL;

CREATE VIEW v_money_settlements AS
SELECT s.id AS source_id, s.reference AS context, s.settlement_date AS occurred_at, s.status,
       s.outbound_currency, s.outbound_amount AS outbound_amount_raw,
       s.outbound_amount / CASE WHEN s.outbound_currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS outbound_amount_correct,
       s.inbound_currency, s.inbound_amount AS inbound_amount_raw,
       s.inbound_amount / CASE WHEN s.inbound_currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS inbound_amount_correct,
       s.variance_currency, s.variance_amount AS variance_amount_raw,
       s.variance_amount / CASE WHEN COALESCE(s.variance_currency,'USD') IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS variance_amount_correct,
       CASE WHEN s.outbound_amount / 100.0 > 10000000 OR s.inbound_amount / 100.0 > 10000000 THEN 'huge' ELSE 'ok' END AS range_check
FROM agent_settlements s WHERE s.deleted_at IS NULL;

CREATE VIEW v_money_line_items AS
SELECT li.id AS source_id, 'unit_price' AS amount_field, li.unit_price AS amount_raw, o2.currency,
       li.unit_price AS amount_correct,
       li.unit_price / CASE WHEN o2.currency IN ('VND','JPY','KRW') THEN 1 ELSE 100 END AS amount_if_minor,
       li.unit_price AS amount_if_decimal,
       CASE
         WHEN o2.currency IN ('USD','EUR') AND li.unit_price > 1000000 THEN 'huge'
         WHEN o2.currency = 'RUB' AND li.unit_price > 50000000 THEN 'huge'
         WHEN o2.currency = 'CNY' AND li.unit_price > 5000000 THEN 'huge'
         ELSE 'ok'
       END AS range_check,
       o2.reference AS context, li.operation_id, o2.operation_date AS occurred_at
FROM line_items li LEFT JOIN operations o2 ON o2.id = li.operation_id
WHERE o2.deleted_at IS NULL;
