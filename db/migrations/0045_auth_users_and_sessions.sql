-- =============================================================================
-- Migration 0045 — Auth: users + sessions tables, seed 3 users
-- PINs hashed with PBKDF2-SHA256 (100k iterations), per-user random salt.
-- Roles: admin (Aram), manager (Meri), support (Maria).
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'support')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Seed users (PINs precomputed via Python PBKDF2-SHA256 100k iter)
INSERT OR IGNORE INTO users (id, name, pin_hash, pin_salt, role, active, created_at) VALUES
  ('usr_aram',  'Aram',  'xlcO+f4q2zBzMprebJVGUIBKSVfo/NuPEW+OCYdu/mk=', 'o09T9962+ddo9nVf1YVBPQ==', 'admin',   1, strftime('%s','now')*1000),
  ('usr_meri',  'Meri',  '1/+Q0wi+LAMUfks9jBiOMEWcOsyLn+LgBrLW477X76U=', 'Zc1QBQeiwAwN9jHnW81J6A==', 'manager', 1, strftime('%s','now')*1000),
  ('usr_maria', 'Maria', 'Q0yQbNajjrSXkRLSme4XAw01kx16YbyEibWPM7TzoG0=', '3UssjZ8rqmKUPxRqEpjvlQ==', 'support', 1, strftime('%s','now')*1000);
