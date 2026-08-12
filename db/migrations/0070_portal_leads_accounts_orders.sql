-- =============================================================================
-- 0070 — partner portal: leads, accounts, orders.
--
-- Owner 2026-08-12: dasexperten.com/partners becomes a real lead surface and
-- partners.dasexperten.com becomes a closed wholesale cabinet. Three tables,
-- because three different things happen at three different moments and each
-- one has to survive on its own:
--
--   portal_leads      a stranger asked to work with us. Not a counterparty yet.
--   portal_accounts   an approved partner can now sign in.
--   portal_orders     a signed-in partner submitted a basket.
--
-- Why leads do not go straight into `partners`: a lead is an unverified claim
-- typed into a public form by someone we have never met. The counterparty
-- directory is the place where legal names, tax ids and bank details live, and
-- letting an anonymous form write there would poison the one table the whole
-- ERP trusts. Approval is the Owner's hand (Owner 2026-08-12); only then does a
-- row appear in `partners` with partner_type='buyer'.
--
-- Why accounts hang off the partner and not off the person: staff leave. When
-- the purchasing manager changes, the company keeps buying. Binding the login
-- to the partner means a leaver costs one password, not one counterparty.
--
-- Why orders get their own table when `operations` already exists: an operation
-- is a financial document. The portal must record what the partner actually saw
-- on screen, what the server recomputed, and whether the notification mail went
-- out — none of which belongs in a sales ledger. The portal row points at the
-- draft operation; it does not replace it.
--
-- Money columns are REAL here on purpose. `product_prices.sell_price` is
-- declared INTEGER but holds decimals (0.96 USD) because SQLite is loosely
-- typed. Declaring these INTEGER would repeat a statement the data already
-- contradicts. The mismatch in the existing column is a separate finding, not
-- something this migration should quietly spread.
--
-- Agent slugs are plain TEXT, not foreign keys: the roster lives in the
-- organizacia repository, not in this database (same reasoning as 0068).
-- =============================================================================

CREATE TABLE IF NOT EXISTS portal_leads (
  id                 TEXT PRIMARY KEY,

  company            TEXT NOT NULL,
  country            TEXT NOT NULL,
  country_edge       TEXT,
  business_type      TEXT NOT NULL
                     CHECK (business_type IN ('distributor','importer','pharmacy_chain',
                                              'retail_chain','marketplace_seller',
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

-- No UNIQUE on email. The same company writes twice: a second buyer, a second
-- market, a follow-up after silence. A constraint would throw away a real
-- enquiry to prevent a duplicate a human closes in one click.


CREATE TABLE IF NOT EXISTS portal_accounts (
  id                    TEXT PRIMARY KEY,
  partner_id            TEXT NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,

  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT,
  must_change_password  INTEGER NOT NULL DEFAULT 1
                        CHECK (must_change_password IN (0,1)),

  status                TEXT NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited','active','disabled')),
  invited_at            INTEGER,
  invited_by            TEXT,
  last_login_at         INTEGER,
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          INTEGER,

  reset_token_hash      TEXT,
  reset_expires_at      INTEGER,

  lang                  TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_accounts_partner ON portal_accounts(partner_id);
CREATE INDEX IF NOT EXISTS idx_portal_accounts_status  ON portal_accounts(status);

-- password_hash holds a hash and nothing else. reset_token_hash likewise: the
-- token goes to the partner by mail, only its hash is kept here, so a copy of
-- this table does not hand anyone a working reset link.


CREATE TABLE IF NOT EXISTS portal_orders (
  id                 TEXT PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,

  partner_id         TEXT NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  account_id         TEXT REFERENCES portal_accounts(id) ON DELETE RESTRICT,
  operation_id       TEXT REFERENCES operations(id) ON DELETE RESTRICT,

  seller_company_id  TEXT REFERENCES companies(id) ON DELETE RESTRICT,
  price_type_id      TEXT REFERENCES price_types(id) ON DELETE RESTRICT,
  currency           TEXT NOT NULL,

  screen_total       REAL NOT NULL,
  server_total       REAL NOT NULL,
  price_mismatch     INTEGER NOT NULL DEFAULT 0
                     CHECK (price_mismatch IN (0,1)),

  items_snapshot     TEXT NOT NULL,
  xlsx_r2_key        TEXT,

  mail_status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (mail_status IN ('pending','sent','failed')),
  mail_message_id    TEXT,

  submitted_at       INTEGER NOT NULL,
  ip_country         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_orders_partner   ON portal_orders(partner_id);
CREATE INDEX IF NOT EXISTS idx_portal_orders_operation ON portal_orders(operation_id);
CREATE INDEX IF NOT EXISTS idx_portal_orders_submitted ON portal_orders(submitted_at);
CREATE INDEX IF NOT EXISTS idx_portal_orders_mail      ON portal_orders(mail_status);

-- screen_total and server_total are stored side by side deliberately. The price
-- on screen is a convenience; the contract price is recomputed on the server at
-- submit. Keeping both means a partner who queries an invoice can be answered
-- from the record instead of from memory, and price_mismatch makes the rare
-- disagreement countable rather than anecdotal.
--
-- The order is accepted even when the notification mail fails. mail_status
-- carries that fact so nobody assumes silence means the order was lost.
