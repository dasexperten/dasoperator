-- Migration 0038: partners.acceptance_required
--
-- Adds a boolean flag that turns OFF the requirement for a separate
-- Acceptance Certificate (ACP) for service-provider partners on subscription
-- contracts (rent, accounting, hosting, SaaS, telecom, banks, etc).
--
-- When acceptance_required = 0:
--   The invoice (INV) document is treated as both the acceptance and the
--   billing artifact. The UI Service Provided chip lights up the moment the
--   invoice is attached — no separate ACP needed.
--
-- When acceptance_required = 1 (default):
--   A separate ACP attachment is required for Service Provided to light up.
--
-- Defaults to 1 for all existing rows (status quo: assume ACP needed unless
-- explicitly turned off in the partner card by an operator).
--
-- Applied to D1 das_erp_dev on 2026-05-15.

ALTER TABLE partners
  ADD COLUMN acceptance_required INTEGER NOT NULL DEFAULT 1
    CHECK (acceptance_required IN (0,1));
