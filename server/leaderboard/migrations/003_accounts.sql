-- Additive project-owned mapping. users.id in the canonical Webdev schema is INT.
-- Do not change the v2 marker: the existing guest protocol/schema stays compatible.
CREATE TABLE IF NOT EXISTS game_lb_accounts (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 user_id INT NOT NULL,
 player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(namespace,user_id),
 UNIQUE KEY player(namespace,player_id)
);
