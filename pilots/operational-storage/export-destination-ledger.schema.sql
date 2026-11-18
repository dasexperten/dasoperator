-- Candidate only: not a migration, binding, deployment, or ERP-primary switch.
CREATE TABLE pilot_export_destination_receipts (
 namespace TEXT NOT NULL CHECK(namespace GLOB 'pilot-*'),
 receipt_id TEXT NOT NULL,
 agent_slug TEXT NOT NULL CHECK(agent_slug IN ('angela','diana-helios')),
 source_table TEXT NOT NULL CHECK(source_table IN ('org_task_runs','agent_chat_messages')),
 source_row_id INTEGER NOT NULL CHECK(source_row_id > 0),
 source_revision TEXT NOT NULL,
 source_key TEXT NOT NULL,
 source_status_json TEXT NOT NULL,
 manifest_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 source_content_bytes INTEGER NOT NULL CHECK(source_content_bytes >= 0 AND source_content_bytes <= 33554432),
 content_fingerprint TEXT NOT NULL,
 fingerprint_contract TEXT NOT NULL CHECK(fingerprint_contract = 'operational-json-v1'),
 archive_destination TEXT NOT NULL CHECK(archive_destination = 'pilot-r2'),
 archive_object_key TEXT NOT NULL,
 legacy_marker_json TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(namespace, agent_slug, receipt_id),
 UNIQUE(namespace, agent_slug, source_table, source_row_id, source_revision)
);
CREATE TRIGGER pilot_export_receipts_no_update BEFORE UPDATE ON pilot_export_destination_receipts
BEGIN SELECT RAISE(ABORT, 'append_only_receipt'); END;
CREATE TRIGGER pilot_export_receipts_no_delete BEFORE DELETE ON pilot_export_destination_receipts
BEGIN SELECT RAISE(ABORT, 'append_only_receipt'); END;

-- Prevent OR REPLACE implicit deletion even when recursive triggers are disabled.
CREATE TRIGGER pilot_export_receipts_no_replace BEFORE INSERT ON pilot_export_destination_receipts
WHEN EXISTS (SELECT 1 FROM pilot_export_destination_receipts
 WHERE namespace = NEW.namespace AND agent_slug = NEW.agent_slug AND
 (receipt_id = NEW.receipt_id OR (source_table = NEW.source_table AND
 source_row_id = NEW.source_row_id AND source_revision = NEW.source_revision)))
BEGIN SELECT RAISE(IGNORE); END;
