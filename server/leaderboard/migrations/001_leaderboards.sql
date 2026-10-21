-- Applied by the server db:migrate script to the game project database, never addon_webdev.
CREATE TABLE IF NOT EXISTS game_lb_players (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 display_name VARCHAR(48) NOT NULL,
 token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 expires_at DATETIME(3) NOT NULL,
 PRIMARY KEY(namespace,id), UNIQUE KEY token(namespace,token_hash)
);
CREATE TABLE IF NOT EXISTS game_lb_boards (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 rules_version VARCHAR(32) NOT NULL,
 direction VARCHAR(4) NOT NULL,
 min_score BIGINT NOT NULL, max_score BIGINT NOT NULL,
 min_duration_ms INT UNSIGNED NOT NULL, max_duration_ms INT UNSIGNED NOT NULL,
 `open` BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY(namespace,id)
);
CREATE TABLE IF NOT EXISTS game_lb_runs (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 board_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 issued_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL,
 release_sha VARCHAR(64) NULL,
 score BIGINT NULL, duration_ms INT UNSIGNED NULL,
 submission_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 submitted_at DATETIME(3) NULL,
 PRIMARY KEY(namespace,id), KEY expiry(namespace,expires_at)
);
CREATE TABLE IF NOT EXISTS game_lb_best (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 board_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 score BIGINT NOT NULL, rank_value BIGINT NOT NULL,
 achieved_at DATETIME(3) NOT NULL,
 run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(namespace,board_id,player_id),
 KEY ranking(namespace,board_id,rank_value,achieved_at,player_id)
);
CREATE TABLE IF NOT EXISTS game_lb_rate_limits (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 window_start BIGINT NOT NULL,
 request_count INT UNSIGNED NOT NULL,
 PRIMARY KEY(namespace,bucket_hash)
);
