-- Preserve existing grants while adding the previously missing from_now range.
CREATE TABLE session_shares_next (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  organization_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL REFERENCES users(id),
  range_type TEXT NOT NULL CHECK (range_type IN ('all','until','selected','from_now')),
  range_payload TEXT NOT NULL DEFAULT '{}',
  aux_image_ids TEXT NOT NULL DEFAULT '[]',
  file_snapshot TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  discovery TEXT NOT NULL DEFAULT 'direct',
  UNIQUE (session_id,grantee_user_id,expires_at)
);
INSERT INTO session_shares_next(id,session_id,organization_id,grantee_user_id,range_type,range_payload,aux_image_ids,file_snapshot,created_by,created_at,expires_at,revoked_at)
  SELECT id,session_id,organization_id,grantee_user_id,range_type,range_payload,aux_image_ids,file_snapshot,created_by,created_at,expires_at,revoked_at FROM session_shares;
DROP TABLE session_shares;
ALTER TABLE session_shares_next RENAME TO session_shares;
CREATE INDEX ix_session_share_recipient ON session_shares(grantee_user_id,discovery,revoked_at,expires_at);
CREATE TABLE session_link_shares (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  range_type TEXT NOT NULL DEFAULT 'all',
  range_payload TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
