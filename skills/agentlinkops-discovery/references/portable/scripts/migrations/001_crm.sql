CREATE TABLE crm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  target_pages TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id), name TEXT NOT NULL,
  type TEXT NOT NULL, template_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', goal TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE contacts (
  id TEXT PRIMARY KEY, publisher_url TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', contact_url TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '', observed_at TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'unverified', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE opportunities (
  id TEXT PRIMARY KEY, campaign_id TEXT REFERENCES campaigns(id),
  contact_id TEXT REFERENCES contacts(id), source_url TEXT NOT NULL, target_url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom', status TEXT NOT NULL DEFAULT 'candidate',
  evidence TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE activities (
  id TEXT PRIMARY KEY, opportunity_id TEXT REFERENCES opportunities(id),
  contact_id TEXT REFERENCES contacts(id), campaign_id TEXT REFERENCES campaigns(id),
  channel TEXT NOT NULL DEFAULT 'email', kind TEXT NOT NULL,
  external_message_id TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE placements (
  id TEXT PRIMARY KEY, opportunity_id TEXT REFERENCES opportunities(id),
  project_id TEXT, watch_id TEXT UNIQUE, source_url TEXT NOT NULL, target_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX campaigns_product ON campaigns(product_id);
CREATE INDEX opportunities_campaign ON opportunities(campaign_id);
CREATE INDEX activities_opportunity ON activities(opportunity_id, occurred_at);
