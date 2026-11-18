-- Local candidate schema only. Never apply to a remote/production database.
CREATE TABLE pilot_handoff_reservations (
 namespace TEXT NOT NULL CHECK(namespace GLOB 'pilot-*'),
 agent TEXT NOT NULL CHECK(agent IN ('angela','diana-helios')),
 workbook TEXT NOT NULL, tab INTEGER NOT NULL CHECK(tab >= 0), case_id TEXT NOT NULL,
 reservation_id TEXT NOT NULL, binding_json TEXT NOT NULL, assertion_json TEXT NOT NULL,
 PRIMARY KEY(namespace,agent,workbook,tab,case_id),
 UNIQUE(namespace,agent,reservation_id)
);
CREATE TABLE pilot_handoff_observations (
 namespace TEXT NOT NULL, agent TEXT NOT NULL, reservation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0), observation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('erp_unknown','erp_in_progress','erp_identified','sheet_ack_failed','sheet_acknowledged')),
 erp_case_id TEXT,
 CHECK((kind IN ('erp_unknown','erp_in_progress') AND erp_case_id IS NULL)
    OR (kind IN ('erp_identified','sheet_ack_failed','sheet_acknowledged') AND erp_case_id IS NOT NULL AND length(erp_case_id)>0)),
 PRIMARY KEY(namespace,agent,reservation_id,sequence),
 UNIQUE(namespace,agent,reservation_id,observation_id),
 FOREIGN KEY(namespace,agent,reservation_id) REFERENCES pilot_handoff_reservations(namespace,agent,reservation_id)
);
CREATE TRIGGER pilot_handoff_reservation_no_update BEFORE UPDATE ON pilot_handoff_reservations
BEGIN SELECT RAISE(ABORT,'immutable_handoff_fence'); END;
CREATE TRIGGER pilot_handoff_reservation_no_delete BEFORE DELETE ON pilot_handoff_reservations
BEGIN SELECT RAISE(ABORT,'immutable_handoff_fence'); END;
CREATE TRIGGER pilot_handoff_reservation_no_replace BEFORE INSERT ON pilot_handoff_reservations
WHEN EXISTS(SELECT 1 FROM pilot_handoff_reservations WHERE namespace=NEW.namespace AND agent=NEW.agent
 AND ((workbook=NEW.workbook AND tab=NEW.tab AND case_id=NEW.case_id) OR reservation_id=NEW.reservation_id))
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER pilot_handoff_observation_no_update BEFORE UPDATE ON pilot_handoff_observations
BEGIN SELECT RAISE(ABORT,'append_only_observation'); END;
CREATE TRIGGER pilot_handoff_observation_no_delete BEFORE DELETE ON pilot_handoff_observations
BEGIN SELECT RAISE(ABORT,'append_only_observation'); END;
-- Abort, rather than replace: works with recursive_triggers OFF as well.
CREATE TRIGGER pilot_handoff_observation_no_replace BEFORE INSERT ON pilot_handoff_observations
WHEN EXISTS(SELECT 1 FROM pilot_handoff_observations WHERE namespace=NEW.namespace AND agent=NEW.agent
 AND reservation_id=NEW.reservation_id AND (sequence=NEW.sequence OR observation_id=NEW.observation_id))
BEGIN SELECT RAISE(ABORT,'observation_conflict'); END;
CREATE TRIGGER pilot_handoff_observation_consistency BEFORE INSERT ON pilot_handoff_observations
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_handoff_reservations WHERE namespace=NEW.namespace AND agent=NEW.agent AND reservation_id=NEW.reservation_id)
 THEN RAISE(ABORT,'reservation_missing') END;
 SELECT CASE WHEN NEW.sequence != 1 + COALESCE((SELECT MAX(sequence) FROM pilot_handoff_observations WHERE namespace=NEW.namespace AND agent=NEW.agent AND reservation_id=NEW.reservation_id),0)
 THEN RAISE(ABORT,'stale_sequence') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_handoff_observations WHERE namespace=NEW.namespace AND agent=NEW.agent AND reservation_id=NEW.reservation_id AND kind='sheet_acknowledged')
 THEN RAISE(ABORT,'terminal_observation') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_handoff_observations WHERE namespace=NEW.namespace AND agent=NEW.agent AND reservation_id=NEW.reservation_id AND erp_case_id IS NOT NULL AND (NEW.erp_case_id IS NULL OR erp_case_id != NEW.erp_case_id OR NEW.kind='erp_identified'))
 THEN RAISE(ABORT,'erp_identity_immutable') END;
 SELECT CASE WHEN NEW.kind IN ('sheet_ack_failed','sheet_acknowledged') AND NOT EXISTS(SELECT 1 FROM pilot_handoff_observations WHERE namespace=NEW.namespace AND agent=NEW.agent AND reservation_id=NEW.reservation_id AND kind='erp_identified' AND erp_case_id=NEW.erp_case_id)
 THEN RAISE(ABORT,'erp_identity_required') END;
END;

-- Two different source reservations cannot claim the same ERP case within an agent.
CREATE UNIQUE INDEX pilot_handoff_erp_identity ON pilot_handoff_observations(namespace,agent,erp_case_id) WHERE kind='erp_identified';
