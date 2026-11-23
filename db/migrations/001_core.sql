-- FlowMate v0.2 · 001 身份、组织、目录与文件（PRD §17 / §20 / §06 / §07）
-- 方言：SQLite（node:sqlite，WAL，foreign_keys=ON）。所有 id 为 UUID 文本；时间存 UTC ISO8601。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  prefs TEXT NOT NULL DEFAULT '{}',            -- 通知偏好
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,                          -- 随机令牌的服务端 ID
  token_hash TEXT NOT NULL UNIQUE,              -- Cookie 里放随机令牌，服务端存哈希
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS ix_auth_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,                         -- email|ip
  count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  owner_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  lead_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  team_ids TEXT NOT NULL DEFAULT '[]',
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  accepted_at TEXT
);

-- ============ 目录与文件（§06 / §07）============
-- space：personal（个人空间）/ team（团队空间）/ org（组织空间）
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space TEXT NOT NULL CHECK (space IN ('personal','team','org')),
  owner_id TEXT REFERENCES users(id),           -- personal 空间的归属人
  team_id TEXT REFERENCES teams(id),            -- team 空间的归属团队
  parent_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','trashed')),
  trashed_at TEXT,
  deleted_by TEXT,
  created_by TEXT REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((space='personal' AND owner_id IS NOT NULL) OR (space<>'personal'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_folder_name ON folders(parent_id, name) WHERE status='active';
CREATE INDEX IF NOT EXISTS ix_folder_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS ix_folder_org ON folders(organization_id, space);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space TEXT NOT NULL CHECK (space IN ('personal','team','org')),
  folder_id TEXT REFERENCES folders(id),
  owner_id TEXT REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  name TEXT NOT NULL,                           -- 显示名（已净化）
  ext TEXT NOT NULL,                            -- 归一化小写扩展名
  mime TEXT NOT NULL,
  sniffed_mime TEXT,                            -- 内容嗅探结果
  kind TEXT NOT NULL,                           -- markdown|text|html|word|pdf|excel|ppt|image
  size INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT REFERENCES file_versions(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','trashed','permanently_deleted')),
  trashed_at TEXT,
  deleted_by TEXT,
  created_by TEXT REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_file_name ON files(folder_id, name) WHERE status='active';
CREATE INDEX IF NOT EXISTS ix_file_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS ix_file_org ON files(organization_id, space);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id),
  organization_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  object_key TEXT NOT NULL,                     -- 存储用不可变 UUID 键
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  author_id TEXT REFERENCES users(id),
  agent_run_id TEXT,
  base_version_id TEXT REFERENCES file_versions(id),
  change_source TEXT NOT NULL CHECK (change_source IN
    ('upload','user_edit','restore','agent_draft','agent_formal','seed')),
  summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (file_id, version_no)
);

-- 正文抽取一次，同时服务正文检索与 Agent doc.extract（§15 末注 / D5）
CREATE TABLE IF NOT EXISTS file_text (
  file_version_id TEXT PRIMARY KEY REFERENCES file_versions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','unavailable','failed')),
  reason TEXT,                                  -- unavailable 的诚实原因（扫描版 PDF / 加密 / 超限）
  raw_text TEXT,                                -- 原文（供片段定位与证据回锚）
  tokens TEXT,                                  -- 二元组分词后的检索串
  char_count INTEGER NOT NULL DEFAULT 0,
  unit_count INTEGER NOT NULL DEFAULT 0,        -- 页 / 工作表 / 幻灯片 / 块 数
  blocks TEXT NOT NULL DEFAULT '[]',            -- [{block_id,unit,kind,heading,text,anchor}]
  preview_kind TEXT,                            -- rendered_markdown|monospace|sandbox_html|html|pdf|table|slide_cards|image
  preview_note TEXT,                            -- 能力提示（如「首版不做在线编辑」）
  preview_html TEXT,                            -- docx 只读预览（不用于在线编辑）
  provider TEXT,                                -- 解析器与版本，便于说明抽取来源
  indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FTS5 虚表（tokens = file_text.tokens 的二元组串），提供 bm25 排序与倒排检索
CREATE VIRTUAL TABLE IF NOT EXISTS file_text_fts USING fts5(
  tokens,
  version_id UNINDEXED,
  file_id UNINDEXED,
  organization_id UNINDEXED
);

-- ============ ACL（§20 目录权）============
CREATE TABLE IF NOT EXISTS acls (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('folder','file')),
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','team','org')),
  principal_id TEXT NOT NULL,                   -- user_id / team_id / organization_id
  permission TEXT NOT NULL CHECK (permission IN ('viewer','editor','manager')),
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (resource_type, resource_id, principal_type, principal_id, permission, effect)
);
CREATE INDEX IF NOT EXISTS ix_acl_lookup ON acls(organization_id, resource_type, resource_id);

-- ============ 消息（§05）============
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL CHECK (type IN ('dm','project')),
  name TEXT,                                    -- 项目群名称；私聊由成员名组合派生
  team_id TEXT REFERENCES teams(id),
  dm_key TEXT,                                  -- 私聊成员对排序后指纹，保证同一对人只建一条
  created_by TEXT REFERENCES users(id),
  last_message_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dm_key ON conversations(organization_id, dm_key) WHERE type='dm';

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  last_read_at TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_cm_user ON conversation_members(user_id, organization_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES messages(id),       -- 回复条
  mentions TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]',       -- [{file_id,version_id,name,mime,size}]
  card_type TEXT CHECK (card_type IN (NULL,'task','file_version','session','request','proposal','candidate')),
  card_id TEXT,
  client_msg_id TEXT,                           -- 发送防重复（幂等）
  edited_at TEXT,
  retracted_at TEXT,
  edited_versions TEXT NOT NULL DEFAULT '[]',   -- 已被引用的消息保留审计版本
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, client_msg_id)
);
CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conversation_id, created_at);

-- 独立 FTS5 表（非 contentless）：删除按 UNINDEXED 列过滤，量级小、可全表扫
CREATE VIRTUAL TABLE IF NOT EXISTS message_text_fts USING fts5(
  tokens, message_id UNINDEXED, conversation_id UNINDEXED, organization_id UNINDEXED
);
