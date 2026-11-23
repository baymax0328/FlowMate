CREATE TABLE IF NOT EXISTS recent_file_views (
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  file_id TEXT NOT NULL REFERENCES files(id),
  last_viewed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, file_id)
);

CREATE INDEX IF NOT EXISTS ix_recent_file_views
  ON recent_file_views(user_id, organization_id, last_viewed_at DESC);
