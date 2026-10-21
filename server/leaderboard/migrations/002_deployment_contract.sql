-- Applied by the server db:migrate script before saving the checkpoint that first uses it.
-- Additive and retry-safe: keep these columns/table when rolling code back.
ALTER TABLE game_lb_runs
 ADD COLUMN IF NOT EXISTS rules_version VARCHAR(32) NULL,
 ADD COLUMN IF NOT EXISTS protocol_version INT UNSIGNED NULL;
CREATE TABLE IF NOT EXISTS game_lb_environment (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 schema_version INT UNSIGNED NOT NULL
);
INSERT IGNORE INTO game_lb_environment (id,namespace,schema_version)
VALUES (1,'production',2);
-- A checkpoint Preview uses a database branch of this project database. Both use
-- the same application namespace; the database branch provides write isolation.
-- Existing unsubmitted runs lack a rules binding and are rejected. Existing
-- successful receipts remain idempotent; no inferred rules are backfilled.
