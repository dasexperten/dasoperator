-- =============================================================================
-- Migration 0046 — per-user permissions JSON column.
-- Role still exists (cosmetic label + initial defaults), but the live source
-- of truth for sidebar visibility is users.permissions.
-- =============================================================================

ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}';

-- Backfill from existing role
UPDATE users SET permissions = '{"/": "full", "/partners": "full", "/operations": "full", "/planner": "full", "/products": "full", "/warehouses": "full", "/marketplaces": "full", "/reviews": "full", "/crm": "full", "/finance": "full", "/analytics": "full", "/settings": "full"}'
  WHERE role = 'admin';

UPDATE users SET permissions = '{"/": "rw", "/partners": "rw", "/operations": "rw", "/planner": "rw", "/products": "rw", "/warehouses": "rw", "/marketplaces": "read", "/reviews": "read", "/crm": "rw", "/finance": "none", "/analytics": "read", "/settings": "none"}'
  WHERE role = 'manager';

UPDATE users SET permissions = '{"/": "read", "/partners": "read", "/operations": "none", "/planner": "none", "/products": "read", "/warehouses": "read", "/marketplaces": "rw", "/reviews": "rw", "/crm": "none", "/finance": "none", "/analytics": "none", "/settings": "none"}'
  WHERE role = 'support';
