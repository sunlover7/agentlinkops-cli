CREATE TABLE disavow_rules (
  id TEXT PRIMARY KEY, property_url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('domain','url')), value TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(property_url,kind,value)
);
CREATE TABLE disavow_sources (
  id TEXT PRIMARY KEY, property_url TEXT NOT NULL, source_label TEXT NOT NULL,
  source_sha256 TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('txt','manual')),
  raw_text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE disavow_provenance (
  rule_id TEXT NOT NULL REFERENCES disavow_rules(id),
  source_id TEXT NOT NULL REFERENCES disavow_sources(id),
  line_number INTEGER NOT NULL, line_text TEXT NOT NULL,
  comments_json TEXT NOT NULL DEFAULT '[]', recorded_at TEXT NOT NULL,
  PRIMARY KEY(rule_id,source_id,line_number)
);
CREATE INDEX disavow_property_rules ON disavow_rules(property_url,active,kind,value);
