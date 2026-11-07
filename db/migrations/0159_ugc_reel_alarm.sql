-- UGC Selection: one accepted assignment to a live tool-capable Mac consumer.
ALTER TABLE ugc_reel_jobs ADD COLUMN consumer_id TEXT;
ALTER TABLE ugc_reel_jobs ADD COLUMN acknowledged_at TEXT;
ALTER TABLE ugc_reel_jobs ADD COLUMN required_destinations TEXT NOT NULL DEFAULT '[]';
UPDATE ugc_reel_jobs SET required_destinations='["instagram","threads","vk","youtube","tiktok"]' WHERE status <> 'published';
CREATE TABLE ugc_reel_alarm (
  id INTEGER PRIMARY KEY CHECK(id=1),
  consumer_id TEXT,
  heartbeat_at INTEGER,
  ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
  last_started_at INTEGER,
  tick_at INTEGER,
  pending_content_id TEXT,
  note TEXT
);
INSERT INTO ugc_reel_alarm(id,note,last_started_at) SELECT 1,'consumer_missing',CAST(ROUND((julianday(MAX(started_at))-2440587.5)*86400000) AS INTEGER) FROM ugc_reel_jobs;
