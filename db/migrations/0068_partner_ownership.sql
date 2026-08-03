-- =============================================================================
-- 0068 — partner ownership: who entered this counterparty, and whose it is now.
--
-- Owner 2026-08-03: a counterparty created from a letter must not become an
-- orphan record. Whoever is already talking to them keeps them — a carrier goes
-- to Zina, a distributor to Lauda — and from then on that agent is the one who
-- fills in the address, the bank details, the contract, as the correspondence
-- brings them in. A directory nobody owns is a directory nobody completes.
--
-- Two different facts, two columns, because they answer different questions and
-- diverge the moment work is handed over:
--
--   created_by_agent  who put the record in. Never changes. This is history.
--   owner_agent       whose it is right now. Changes when work moves.
--
-- Collapsing them into one column would mean that reassigning a counterparty
-- quietly rewrites who found them, and the first person to notice would be the
-- one whose work disappeared.
--
-- Values are roster slugs (zina-pevtsova, lauda-briana, …) or 'owner' for the
-- Owner acting directly. Deliberately not a foreign key: the roster lives in
-- the organizacia repository, not in this database, and a constraint against a
-- table that does not exist here would be a lie in schema form.
-- =============================================================================

ALTER TABLE partners ADD COLUMN created_by_agent TEXT;
ALTER TABLE partners ADD COLUMN owner_agent TEXT;
ALTER TABLE partners ADD COLUMN owner_assigned_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_partners_owner_agent ON partners(owner_agent);
