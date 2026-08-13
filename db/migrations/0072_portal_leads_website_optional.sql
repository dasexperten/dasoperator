-- =============================================================================
-- 0072 — portal_leads: a website is no longer required.
--
-- Owner 2026-08-13: plenty of real distributors have no site. They trade from a
-- marketplace storefront, an Instagram page, or the phone. Requiring a website
-- turned those companies away at the first screen — and they are exactly the
-- partners a wholesale line in Armenia, Central Asia or ASEAN is built on.
--
-- The field stays, and its meaning widens: website, shop or social page. It is
-- still the strongest single signal we ask for, but a missing one is now a
-- question for Lauda to ask, not a reason the form refuses to submit.
--
-- Table rebuild again because SQLite cannot drop a NOT NULL in place. Safe while
-- portal_leads is empty; if that stops being true this must copy, not recreate.
-- =============================================================================

DROP TABLE IF EXISTS portal_leads;

CREATE TABLE portal_leads (
  id                 TEXT PRIMARY KEY,
  company            TEXT NOT NULL,
  country            TEXT NOT NULL,
  country_edge       TEXT,
  business_type      TEXT NOT NULL
                     CHECK (business_type IN ('distributor','importer','pharmacy_chain',
                                              'retail_chain','clinic','marketplace_seller',
                                              'online_store','other')),
  website            TEXT,
  contact_person     TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  imports_oral_care  INTEGER CHECK (imports_oral_care IN (0,1) OR imports_oral_care IS NULL),
  comment            TEXT,
  lang               TEXT NOT NULL,
  source_url         TEXT,
  campaign           TEXT,
  consent_at         INTEGER NOT NULL,
  routed_to          TEXT NOT NULL,
  seller_company_id  TEXT REFERENCES companies(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','acknowledged','qualified','approved','rejected','spam')),
  ack_sent_at        INTEGER,
  ack_message_id     TEXT,
  approved_by        TEXT,
  approved_at        INTEGER,
  rejected_reason    TEXT,
  partner_id         TEXT REFERENCES partners(id) ON DELETE RESTRICT,
  notes              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_leads_status     ON portal_leads(status);
CREATE INDEX IF NOT EXISTS idx_portal_leads_email      ON portal_leads(email);
CREATE INDEX IF NOT EXISTS idx_portal_leads_routed_to  ON portal_leads(routed_to);
CREATE INDEX IF NOT EXISTS idx_portal_leads_created_at ON portal_leads(created_at);
CREATE INDEX IF NOT EXISTS idx_portal_leads_partner    ON portal_leads(partner_id);
