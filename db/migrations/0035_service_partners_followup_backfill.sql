-- =============================================================================
-- 0035_service_partners_followup_backfill.sql
-- =============================================================================
-- Follow-up to 0034. The first backfill pattern set ('audit', 'consulting',
-- 'shipper', explicit names) missed Russian-language service providers that
-- don't carry those English keywords. This migration tags the rest by exact
-- partner id, based on a manual review of partner_type='other' rows.
--
-- All targets verified to be service-only counterparties (no goods produced):
--   - certification bodies (Атлант-Тест, Уралстандартизация)
--   - trademark/registration services (Регикон)
--   - online cash register service (АТОЛ Онлайн)
--   - travel agency (Интернет Трэвел)
--   - state services (ФАУ НИА — национальное аудиторское агентство)
--   - SaaS for retail (РитейлДрайвер)
--
-- Idempotent: only updates rows where subtype is still NULL.
-- =============================================================================

UPDATE partners
SET partner_subtype = 'service_provider'
WHERE partner_subtype IS NULL
  AND id IN (
    'atlant_test',
    'uralstandart',
    'regikon',
    'atol_online',
    'fau_nia',
    'retail_driver'
  );

UPDATE partners
SET partner_subtype = 'agency'
WHERE partner_subtype IS NULL
  AND id IN (
    'internet_travel'
  );

-- =============================================================================
-- End of 0035_service_partners_followup_backfill.sql
-- =============================================================================
