ALTER TABLE placements ADD COLUMN cloud_state TEXT NOT NULL DEFAULT '{}';
ALTER TABLE placements ADD COLUMN cloud_observed_at TEXT;
ALTER TABLE placements ADD COLUMN cloud_event_id TEXT;
CREATE TABLE cloud_events (
  id TEXT PRIMARY KEY, cursor TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  project_id TEXT, watch_id TEXT, created_at TEXT NOT NULL,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE sync_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  endpoint TEXT, cursor TEXT, updated_at TEXT NOT NULL
);
INSERT INTO sync_state(singleton, updated_at) VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
