-- RiftStrike casual Deathmatch board: higher frags score ranks first.
-- Rules are immutable for this board; changed scoring rules require a new board id.
INSERT INTO game_lb_boards
(namespace,id,rules_version,direction,min_score,max_score,min_duration_ms,max_duration_ms,`open`)
VALUES
('production','riftstrike-frags-v1','v1','desc',0,1000000000,0,1800000,TRUE);
