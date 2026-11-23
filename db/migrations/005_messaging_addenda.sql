-- FlowMate v0.2 · 005 Message / 账号补充（append-only；仅新增表与索引，不改 001~003 语义）
-- 目的：为 §19「POST /auth/password/reset-request 与 /password/reset」提供服务端可撤销的重置令牌存储。
-- 001 的 auth_sessions 只能整户撤销会话，无法承载「一次性、限时、可用哈希校验」的重置凭据，故新增本表。
-- 令牌本体不落库明文（token_hash 为 SHA-256）；token_plain 仅在 FLOWMATE_DEMO=1 时写入，
-- 用于局域网演示取回（本机无外部邮件通道，§24 明确不做邮件/IM/短信推送）。生产语义下该列恒为 NULL。

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_plain TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prt_user ON password_reset_tokens(user_id, created_at);

-- 会话列表按「成员 + 组织 + 未退出」聚合，unread 计数按 conversation 分组扫描，补一条覆盖索引。
CREATE INDEX IF NOT EXISTS ix_cm_user_org ON conversation_members(user_id, organization_id, left_at);
