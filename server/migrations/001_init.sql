CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  name TEXT,
  scopes TEXT,
  hash TEXT UNIQUE,
  created_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  doc TEXT,
  updated_at TEXT
);

CREATE TABLE profile_revisions (
  id INTEGER PRIMARY KEY,
  doc TEXT,
  created_at TEXT,
  token_id INTEGER
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  doc TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  kind TEXT CHECK(kind IN ('resume', 'cover')),
  current_version INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE template_versions (
  template_id TEXT,
  version INTEGER,
  meta TEXT,
  source TEXT,
  created_at TEXT,
  PRIMARY KEY(template_id, version)
);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  status TEXT,
  verdict TEXT,
  score REAL,
  vacancy_url TEXT,
  vacancy_url_norm TEXT,
  vacancy_source TEXT,
  company TEXT,
  company_norm TEXT,
  title TEXT,
  location TEXT,
  language TEXT,
  vacancy_text TEXT,
  track_id TEXT,
  resume_template TEXT,
  cover_template TEXT,
  resume_content TEXT,
  cover_content TEXT,
  notes TEXT,
  warnings TEXT,
  pages_resume INTEGER,
  pages_cover INTEGER,
  profile_revision_id INTEGER,
  created_at TEXT,
  updated_at TEXT,
  created_by_token_id INTEGER
);

CREATE UNIQUE INDEX applications_url ON applications(vacancy_url_norm) WHERE vacancy_url_norm != '';
CREATE INDEX applications_status ON applications(status);
CREATE INDEX applications_company_norm ON applications(company_norm);
CREATE INDEX applications_track_id ON applications(track_id);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER,
  status TEXT,
  note TEXT,
  token_id INTEGER,
  at TEXT
);

CREATE INDEX application_events_application_id ON application_events(application_id);

INSERT INTO meta(key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING;
INSERT INTO meta(key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO NOTHING;
