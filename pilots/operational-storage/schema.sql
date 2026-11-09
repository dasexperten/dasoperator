-- ISOLATED PILOT ONLY. Not a production migration or an ERP schema replacement.
-- Apply only to a separate empty pilot D1 database. No production tables touched.
CREATE TABLE IF NOT EXISTS pilot_operational_manifests (
  namespace TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  agent_slug TEXT NOT NULL CHECK (agent_slug IN ('diana-helios', 'angela')),
  source_type TEXT NOT NULL CHECK (source_type IN ('github', 'd1', 'r2', 'local-export')),
  source_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  original_url TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'working-memory', 'communication', 'report', 'evidence',
    'queue-snapshot', 'approval-snapshot', 'operational-record'
  )),
  content_type TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
  object_key TEXT NOT NULL,
  archive_only INTEGER NOT NULL DEFAULT 1 CHECK (archive_only = 1),
  integrity_state TEXT NOT NULL CHECK (integrity_state = 'bytes-verified'),
  imported_at TEXT NOT NULL,
  PRIMARY KEY (namespace, manifest_id),
  UNIQUE (namespace, agent_slug, source_type, source_key, source_revision)
);
CREATE INDEX IF NOT EXISTS pilot_manifest_agent
  ON pilot_operational_manifests(namespace, agent_slug, manifest_id);

-- Retain old versions and provenance even if another client bypasses the API.
-- IGNORE an existing identity before REPLACE can implicitly delete its row.
-- API callers reread and compare all fields, so conflicts still fail visibly.
CREATE TRIGGER IF NOT EXISTS pilot_manifests_no_replace
BEFORE INSERT ON pilot_operational_manifests
WHEN EXISTS (
  SELECT 1 FROM pilot_operational_manifests
  WHERE namespace = NEW.namespace AND (
    manifest_id = NEW.manifest_id OR (
      agent_slug = NEW.agent_slug AND source_type = NEW.source_type
      AND source_key = NEW.source_key AND source_revision = NEW.source_revision
    )
  )
)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER IF NOT EXISTS pilot_manifests_no_update
BEFORE UPDATE ON pilot_operational_manifests
BEGIN
  SELECT RAISE(ABORT, 'pilot manifests are append-only');
END;
CREATE TRIGGER IF NOT EXISTS pilot_manifests_no_delete
BEFORE DELETE ON pilot_operational_manifests
BEGIN
  SELECT RAISE(ABORT, 'pilot manifests are append-only');
END;
