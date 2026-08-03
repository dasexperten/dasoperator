-- =============================================================================
-- 0067 — email_links: the missing row between a letter and the business.
--
-- Owner 2026-08-03: until now the R2 archive knew an address and the ERP knew
-- a partner, and nothing joined them. A letter could not appear in a partner's
-- card, could not be attached to a shipment, and could not be re-attached when
-- it landed on the wrong one. This table is that join, and it is the ground the
-- re-link action and Lena's router both stand on.
--
-- One row per letter (mail_key = the R2 object key, e.g.
-- Inbox/support@dasexperten.com/received/2026-08-03T…-<uuid>.json). Unique, so
-- the auto-linker is idempotent: re-running it updates instead of duplicating.
--
-- LAW OF THE LOCK. A row written by a human carries locked = 1, and no
-- algorithm may ever touch it again — not the nightly pass, not a smarter
-- matcher, not a re-import. A manual decision that a machine can silently undo
-- is not a decision.
--
-- Deliberately NOT guessed: the operation. A partner is matched by an exact
-- address or a reference found in the letter itself. Picking "their newest open
-- shipment" would be right often enough to be trusted and wrong often enough to
-- be dangerous, and a wrong link that nobody notices is worse than no link.
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_links (
  id                  TEXT PRIMARY KEY,              -- 'elnk_' + uuid
  mail_key            TEXT NOT NULL UNIQUE,          -- R2 object key of the letter
  mailbox             TEXT NOT NULL,                 -- which of our boxes holds it
  direction           TEXT NOT NULL                  -- sent | received
                      CHECK (direction IN ('sent','received')),
  counterparty_email  TEXT,                          -- the other side, lowercased

  partner_id          TEXT REFERENCES partners(id),
  operation_id        TEXT REFERENCES operations(id),
  crm_customer_id     TEXT REFERENCES crm_customers(id),
  crm_order_id        TEXT REFERENCES crm_orders(id),

  source              TEXT NOT NULL DEFAULT 'auto'   -- auto | rule | manual
                      CHECK (source IN ('auto','rule','manual')),
  confidence          REAL NOT NULL DEFAULT 0,       -- 0..1, 1 = exact address
  matched_on          TEXT,                          -- partner_email | reference | domain | crm_email
  locked              INTEGER NOT NULL DEFAULT 0,    -- 1 = human decided, hands off
  linked_by           TEXT,                          -- who locked it

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_links_partner   ON email_links(partner_id);
CREATE INDEX IF NOT EXISTS idx_email_links_operation ON email_links(operation_id);
CREATE INDEX IF NOT EXISTS idx_email_links_customer  ON email_links(crm_customer_id);
CREATE INDEX IF NOT EXISTS idx_email_links_mailbox   ON email_links(mailbox);
CREATE INDEX IF NOT EXISTS idx_email_links_party     ON email_links(counterparty_email);
