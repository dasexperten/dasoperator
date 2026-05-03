-- =============================================================================
-- Das Operator ERP — Phase 1.1 schema population (companies + sequences)
-- =============================================================================
-- Fresh-clone reproducibility migration. Apply ONLY to a fresh D1 database
-- (production D1 das_erp_dev already has companies rows; running this against
-- production would fail on PK collisions for the companies INSERTs).
--
-- Two parts with different histories:
--
--   companies (4 rows) — CAPTURED from production D1 das_erp_dev on
--     2026-05-04 via REST API SELECT and translated to INSERT verbatim.
--     These were inserted manually via D1 Console during Phase 1.1 before
--     seed-as-migration discipline existed. This file freezes those exact
--     values for reproducibility.
--
--   sequences (6 rows) — FIRST-TIME SEED. The sequences table was created
--     in 0001_init.sql but was empty in production until this migration
--     was applied (sequences-only portion via REST API curl alongside this
--     PR). Counters start at 1 (next value to be issued).
--
-- Application order in fresh D1 deployment:
--   1. 0001_init.sql              — schema (16 tables)
--   2. 0002_seed_reference.sql    — 59 reference rows
--   3. 0003_seed_phase11.sql      — THIS FILE (4 companies + 6 sequences)
--
-- Total reference state after all 3: 69 rows across 9 tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- COMPANIES (4 rows) — captured verbatim from production D1
-- -----------------------------------------------------------------------------
INSERT INTO companies (id, abbreviation, legal_name, trade_name, jurisdiction, registration_no, tax_id, registered_address, base_currency, notes, created_at, updated_at) VALUES ('cmp_dasean', 'DEASEAN', 'DAS EXPERTEN ASEAN COMPANY LIMITED', 'Das Experten ASEAN', 'Vietnam', '0319132917', '0319132917', '110/20/14 Đường số 30, Phường An Nhơn, Thành phố Hồ Chí Minh, Việt Nam', 'USD', 'Charter capital VND 9,000,000,000.', 1746201600, 1746201600);
INSERT INTO companies (id, abbreviation, legal_name, trade_name, jurisdiction, registration_no, tax_id, registered_address, base_currency, notes, created_at, updated_at) VALUES ('cmp_dec', 'DEC', 'Das Experten Corporation', 'Das Experten Corp', 'Seychelles (IBC)', '199359', NULL, 'Tenancy 10, Marina House, Eden Island, Mahe, Republic of Seychelles', 'USD', 'IBC. IP holder. Banking via Byblos Bank Armenia.', 1746201600, 1746201600);
INSERT INTO companies (id, abbreviation, legal_name, trade_name, jurisdiction, registration_no, tax_id, registered_address, base_currency, notes, created_at, updated_at) VALUES ('cmp_dee', 'DEE', 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ ДАС ЭКСПЕРТЕН ЕВРАЗИЯ', 'Das Experten Eurasia LLC', 'Russia', 'ОГРН 1227700061313', 'ИНН 9704117379', '430034, Республика Мордовия, г.о. Саранск, ул Промышленная 1-я, д. 23, помещ. 4', 'RUB', 'УСН taxation. CIS/Russia operations.', 1746201600, 1746201600);
INSERT INTO companies (id, abbreviation, legal_name, trade_name, jurisdiction, registration_no, tax_id, registered_address, base_currency, notes, created_at, updated_at) VALUES ('cmp_dei', 'DEI', 'Das Experten International LLC', 'Das Experten International', 'UAE — Sharjah Media City Free Zone (SHAMS)', 'Formation No 2221260', 'CT TRN 104184998300001 (not VAT-registered)', 'Shams Business Center, Sharjah Media City Free Zone, Al Messaned, Sharjah, UAE', 'USD', 'International invoicing. GIBAN AE288680104184998300001.', 1746201600, 1746201600);
-- -----------------------------------------------------------------------------
-- SEQUENCES (6 rows) — first-time seed (table was empty in production D1)
-- next_number is the value that WILL be issued on next call (not last issued).
-- format_example shows expected output format.
-- -----------------------------------------------------------------------------
INSERT INTO sequences (id, description, next_number, padding, format_example, updated_at) VALUES
('seq_dee', 'DEE entity operation reference counter', 1, 3, 'DEE-001', 1746201600),
('seq_dei', 'DEI entity operation reference counter', 1, 3, 'DEI-001', 1746201600),
('seq_dasean', 'DEASEAN entity operation reference counter', 1, 3, 'DEASEAN-001', 1746201600),
('seq_dec', 'DEC entity operation reference counter', 1, 3, 'DEC-001', 1746201600),
('seq_ci', 'Commercial Invoice global counter', 1, 4, 'CI-202605-0001', 1746201600),
('seq_pl', 'Packing List global counter', 1, 4, 'PL-202605-0001', 1746201600);

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
