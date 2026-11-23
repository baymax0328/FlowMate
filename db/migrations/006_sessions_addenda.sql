-- FlowMate v0.2 · 006 Sessions 附加列（append-only；仅新增，不改既有 001~003 语义）
-- 目的：为「创建 Team 分支」的幂等重试提供可索引的服务端键，避免重复建分支（§10 / C07）。
-- agent_sessions.branch_point 仍记录人类可读的分支点（消息 ID 或序号）；branch_idem_key 仅用于服务端幂等判定。

ALTER TABLE agent_sessions ADD COLUMN branch_idem_key TEXT;

CREATE INDEX IF NOT EXISTS ix_sess_branch_idem
  ON agent_sessions(source_session_id, branch_idem_key);
