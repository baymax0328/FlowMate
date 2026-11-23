-- FlowMate v0.2 · 008 多方共同确认（ChangeProposal）附加表（append-only；不改 001~003）
-- 目的：为「共同确认」内核存放每一修订的提案正文（独立草稿），避免用 need('files').addVersion
--       直接给目标正式文件写草稿版本（addVersion 会推进 files.current_version_id，违反「正式文件不变」硬约束）。
--       因此提案的拟写入内容固定在 proposals 侧，按 (proposal_id, revision) 不可变保存；
--       正式文件 current_version 全程不变，仅 commitFormalVersion 成功后由 files 服务原子推进。
-- 见 proposals.service.ts 顶部说明。

CREATE TABLE IF NOT EXISTS proposal_drafts (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  revision     INTEGER NOT NULL,
  content      TEXT NOT NULL,                     -- 拟写入正式文件的完整正文（当前修订）
  base_version_id TEXT NOT NULL,                  -- 该草稿所依据的基准版本
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (proposal_id, revision)
);

CREATE INDEX IF NOT EXISTS ix_proposal_tick ON proposals(status, next_reminder_at);
CREATE INDEX IF NOT EXISTS ix_proposal_sess ON proposals(session_id, status);
CREATE INDEX IF NOT EXISTS ix_approval_active ON approvals(proposal_id, revision, active, decision);
