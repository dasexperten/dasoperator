-- =============================================================================
-- 0071 — portal_leads: clinics become a business type of their own.
--
-- Owner 2026-08-12: dental clinics and clinic chains buy differently from a
-- pharmacy or a retail chain. They order small, they reorder on a schedule,
-- and they resell at the desk on the strength of a recommendation rather than
-- a planogram. The partner page now speaks to them directly, so the form has to
-- let them say who they are — a clinic that reads its own card and then cannot
-- find itself in the dropdown is a lead lost at the last field.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- Safe to do bluntly here: portal_leads was created hours ago in 0070 and holds
-- zero rows. Should that ever stop being true, this migration must be rewritten
-- to copy the data across, not dropped and recreated.
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
  website            TEXT NOT NULL,
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
