-- =============================================================================
-- 0030_language_model_overhaul.sql
-- Move document language decision from buyer-side to seller-side (issuer).
--
-- Semantic model AFTER this migration:
--
--   companies.default_document_language   — issuer's primary language for
--                                            ALL outbound documents. Required
--                                            by bookkeeping, tax authority,
--                                            bank, audit. Seeded:
--                                              DEE     → RU
--                                              DEI     → EN
--                                              DEASEAN → EN
--                                              DEC     → EN
--
--   partners.preferred_invoice_language   — UNCHANGED schema (still EN/RU/
--                                            BILINGUAL/NULL). Now interpreted
--                                            as the RENDER MODE for documents
--                                            issued TO this partner:
--                                              NULL or 'EN' → only issuer lang
--                                              'BILINGUAL'  → issuer + local
--                                              'RU'         → legacy override
--
--   partners.partner_local_language       — NEW. ISO code of partner's
--                                            national language. Used when
--                                            preferred_invoice_language is
--                                            'BILINGUAL'. Wider CHECK with
--                                            20 languages.
--
-- Migration is purely additive — no table rebuild, no FK risk.
-- =============================================================================

-- 1. companies: add default_document_language
ALTER TABLE companies ADD COLUMN default_document_language TEXT
  CHECK (default_document_language IN ('EN','RU','KA','ZH','VI','AM','UK','BILINGUAL')
         OR default_document_language IS NULL);

UPDATE companies SET default_document_language = 'RU' WHERE abbreviation = 'DEE';
UPDATE companies SET default_document_language = 'EN' WHERE abbreviation = 'DEI';
UPDATE companies SET default_document_language = 'EN' WHERE abbreviation = 'DEASEAN';
UPDATE companies SET default_document_language = 'EN' WHERE abbreviation = 'DEC';

-- 2. partners: add partner_local_language with wider language CHECK
ALTER TABLE partners ADD COLUMN partner_local_language TEXT
  CHECK (partner_local_language IN
         ('EN','RU','KA','ZH','VI','AM','UK','DE','TR','UZ','KK',
          'TH','ID','MS','HI','AR','FR','ES','PT')
         OR partner_local_language IS NULL);

UPDATE partners SET partner_local_language='RU' WHERE country='Russia' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='RU' WHERE country='Belarus' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='RU' WHERE country='Kazakhstan' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='RU' WHERE country='Kyrgyzstan' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='UZ' WHERE country='Uzbekistan' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='AM' WHERE country='Armenia' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='KA' WHERE country='Georgia' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='UK' WHERE country='Ukraine' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='ZH' WHERE country='China' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='VI' WHERE country='Vietnam' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='DE' WHERE country='Germany' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='TR' WHERE country='Turkey' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='FR' WHERE country='Burkina Faso' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='TH' WHERE country='Thailand' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='ID' WHERE country='Indonesia' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='MS' WHERE country='Malaysia' AND partner_local_language IS NULL;
UPDATE partners SET partner_local_language='HI' WHERE country='India' AND partner_local_language IS NULL;
