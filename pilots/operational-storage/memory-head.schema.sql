-- ISOLATED, DEFAULT-OFF PILOT ONLY. Apply after schema.sql, never production migrations.
-- The logical mutable pointer is the latest immutable transition, not a second
-- independently updated row. One INSERT atomically publishes history and head.
CREATE TABLE IF NOT EXISTS pilot_working_memory_transitions (
  namespace TEXT NOT NULL,
  agent_slug TEXT NOT NULL CHECK (agent_slug IN ('diana-helios', 'angela')),
  memory_name TEXT NOT NULL CHECK (memory_name IN ('MEMORY.md', 'MEMORY_RAW.md')),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
  expected_version INTEGER NOT NULL CHECK (typeof(expected_version) = 'integer' AND expected_version BETWEEN 0 AND 9007199254740990),
  fence INTEGER NOT NULL CHECK (typeof(fence) = 'integer' AND fence BETWEEN 0 AND 9007199254740991),
  expected_fence INTEGER NOT NULL CHECK (typeof(expected_fence) = 'integer' AND expected_fence BETWEEN 0 AND 9007199254740991),
  action TEXT NOT NULL CHECK (action IN ('advance', 'rollback', 'fence')),
  manifest_id TEXT NOT NULL CHECK (length(manifest_id) = 64 AND manifest_id NOT GLOB '*[^0-9a-f]*'),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  previous_manifest_id TEXT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (namespace, agent_slug, memory_name, version),
  UNIQUE (namespace, agent_slug, memory_name, request_id),
  FOREIGN KEY (namespace, manifest_id) REFERENCES pilot_operational_manifests(namespace, manifest_id)
);

CREATE VIEW IF NOT EXISTS pilot_working_memory_heads AS
SELECT t.* FROM pilot_working_memory_transitions AS t
WHERE t.version = (
  SELECT MAX(h.version) FROM pilot_working_memory_transitions AS h
  WHERE h.namespace = t.namespace AND h.agent_slug = t.agent_slug AND h.memory_name = t.memory_name
);

CREATE TRIGGER IF NOT EXISTS pilot_memory_transition_guard
BEFORE INSERT ON pilot_working_memory_transitions
BEGIN
  -- Prevent REPLACE from deleting history, even with recursive_triggers OFF.
  -- The API compares an existing request's payload after an ignored insertion.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM pilot_working_memory_transitions
    WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND memory_name = NEW.memory_name
      AND (version = NEW.version OR request_id = NEW.request_id)
  ) THEN RAISE(IGNORE) END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pilot_operational_manifests AS m
    WHERE m.namespace = NEW.namespace AND m.agent_slug = NEW.agent_slug AND m.manifest_id = NEW.manifest_id
      AND m.kind = 'working-memory' AND m.source_type = 'github'
      AND m.source_key = 'dasexperten/organizacia:agents/' || NEW.agent_slug || '/' || NEW.memory_name
      AND length(m.source_revision) = 40 AND m.source_revision NOT GLOB '*[^0-9a-f]*'
      AND m.content_sha256 = NEW.content_sha256
      AND m.archive_only = 1 AND m.integrity_state = 'bytes-verified'
  ) THEN RAISE(ABORT, 'head_target_invalid') END;
  SELECT CASE WHEN NEW.version != NEW.expected_version + 1 OR NEW.expected_version != COALESCE((
    SELECT MAX(version) FROM pilot_working_memory_transitions
    WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND memory_name = NEW.memory_name
  ), 0) THEN RAISE(ABORT, 'head_version_conflict') END;
  SELECT CASE WHEN NEW.expected_fence != COALESCE((
    SELECT fence FROM pilot_working_memory_heads
    WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND memory_name = NEW.memory_name
  ), 0) THEN RAISE(ABORT, 'head_fence_conflict') END;
  SELECT CASE WHEN NEW.previous_manifest_id IS NOT (
    SELECT manifest_id FROM pilot_working_memory_heads
    WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND memory_name = NEW.memory_name
  ) THEN RAISE(ABORT, 'head_previous_conflict') END;
  SELECT CASE WHEN (NEW.action IN ('advance', 'rollback') AND NEW.fence != NEW.expected_fence)
    OR (NEW.action = 'fence' AND (NEW.fence != NEW.expected_fence + 1 OR NEW.expected_version = 0
      OR NEW.manifest_id IS NOT NEW.previous_manifest_id))
    THEN RAISE(ABORT, 'head_fence_invalid') END;
  -- Re-selecting any previously referenced manifest is a rollback operation.
  -- It must not bypass the separately authorized rollback API as an advance.
  SELECT CASE WHEN NEW.action = 'advance' AND EXISTS (
    SELECT 1 FROM pilot_working_memory_transitions
    WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND memory_name = NEW.memory_name
      AND manifest_id = NEW.manifest_id
  ) THEN RAISE(ABORT, 'head_advance_target_known') END;
  SELECT CASE WHEN NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM pilot_working_memory_transitions
    WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND memory_name = NEW.memory_name
      AND manifest_id = NEW.manifest_id
  ) THEN RAISE(ABORT, 'head_rollback_target_unknown') END;
END;
CREATE TRIGGER IF NOT EXISTS pilot_memory_transitions_no_update
BEFORE UPDATE ON pilot_working_memory_transitions
BEGIN
  SELECT RAISE(ABORT, 'memory head history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS pilot_memory_transitions_no_delete
BEFORE DELETE ON pilot_working_memory_transitions
BEGIN
  SELECT RAISE(ABORT, 'memory head history is append-only');
END;
