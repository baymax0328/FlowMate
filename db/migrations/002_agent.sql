-- FlowMate v0.2 · 002 Agent 会话、请求、执行、提案与冲突（PRD §09—§12 / §17）

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  mode TEXT NOT NULL CHECK (mode IN ('personal','team')),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  folder_id TEXT REFERENCES folders(id),        -- 绑定目录根；可为空（临时聊天，不能读写文件）
  include_children INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  source_session_id TEXT REFERENCES agent_sessions(id),  -- Team 分支来源
  branch_point TEXT,                            -- 分支点（消息 ID 或序号）
  context_snapshot TEXT NOT NULL DEFAULT '{}',  -- 服务端固定的上下文快照
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  last_active_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sess_org ON agent_sessions(organization_id, mode, status);

CREATE TABLE IF NOT EXISTS session_participants (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('coordinator','participant','viewer')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS session_shares (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  organization_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL REFERENCES users(id),
  range_type TEXT NOT NULL DEFAULT 'all' CHECK (range_type IN ('all','until','selected')),
  range_payload TEXT NOT NULL DEFAULT '{}',     -- {until_seq} 或 {message_ids}
  aux_image_ids TEXT NOT NULL DEFAULT '[]',     -- 逐项勾选的辅助图片
  file_snapshot TEXT NOT NULL DEFAULT '[]',     -- 共享资料的独立预检结果
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (session_id, grantee_user_id, expires_at)
);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  organization_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender_user_id TEXT REFERENCES users(id),     -- 空 = Agent / 系统
  sender_label TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','agent','system')),
  kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN
    ('message','request_card','plan','execution_card','approval_card','artifact','clarification','event','share_notice')),
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT, ref_id TEXT,                   -- 指向 request/run/proposal/artifact
  aux TEXT NOT NULL DEFAULT '{}',               -- 图片、读取清单摘要等展示元数据
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS auxiliary_attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'session' CHECK (visibility IN ('private','session','workspace')),
  saved_file_id TEXT REFERENCES files(id),      -- 「保存到工作区」后的正式文件
  saved_version_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- ============ 请求 / 计划 / Run / 步骤 / 产物（§08.4 / §11 / §12）============
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  goal TEXT NOT NULL,
  instruction_revision INTEGER NOT NULL DEFAULT 1,
  output_kind TEXT NOT NULL DEFAULT 'draft' CHECK (output_kind IN ('draft','formal_change','answer')),
  write_scope TEXT NOT NULL DEFAULT '[]',       -- 目标文件/目录（canonical 后）
  risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN
    ('submitted','needs_clarification','planned','running','completed','failed','cancelled')),
  plan TEXT NOT NULL DEFAULT '[]',              -- [{subtask_id,name,depends_on,read_set,write_set,output_kind,risk,parallel_reason}]
  clarification TEXT,
  idempotency_key TEXT,
  source_message_id TEXT,                       -- 来自哪条会话消息（交给 Agent）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_req_sess ON requests(session_id, status);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  subtask_id TEXT NOT NULL,
  subtask_name TEXT NOT NULL,
  slot INTEGER,                                 -- 0/1 = 两个子 Agent 执行槽
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','planning','running','waiting_input','waiting_approval','blocked','recovering','succeeded','failed','cancelled')),
  lease_token INTEGER NOT NULL DEFAULT 0,       -- fencing token，单调递增
  lease_owner TEXT,
  lease_expires_at TEXT,
  cancel_epoch INTEGER NOT NULL DEFAULT 0,
  queue_position INTEGER,
  queue_reason TEXT,                            -- 排队必须显示原因与前序任务
  depends_on TEXT NOT NULL DEFAULT '[]',
  read_set TEXT NOT NULL DEFAULT '[]',          -- [{file_id,version_id}] 固定版本
  write_set TEXT NOT NULL DEFAULT '[]',
  context_snapshot TEXT NOT NULL DEFAULT '{}',
  error_code TEXT, error_message TEXT,
  started_at TEXT, finished_at TEXT, heartbeat_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_run_state ON runs(status, queue_position);
CREATE INDEX IF NOT EXISTS ix_run_sess ON runs(session_id, status);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  step_index INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  tool_name TEXT NOT NULL,
  args_digest TEXT NOT NULL DEFAULT '{}',       -- 只含路径与查询词，不含正文
  read_version_ids TEXT NOT NULL DEFAULT '[]',  -- 实际读取的文件版本清单
  output_digest TEXT,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('success','error','denied')),
  error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, attempt, step_index)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  request_id TEXT REFERENCES requests(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  creator_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('draft','answer','diff','report')),
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown',
  draft_file_id TEXT REFERENCES files(id),      -- 草稿是独立文件，与正式文件物理分离
  draft_version_id TEXT,
  target_file_id TEXT REFERENCES files(id),     -- 正式变更的目标
  base_version_id TEXT REFERENCES file_versions(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','committed','discarded')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- ============ 共同确认（§11.2 / §11.3）============
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  request_id TEXT REFERENCES requests(id),
  run_id TEXT REFERENCES runs(id),
  target_file_id TEXT NOT NULL REFERENCES files(id),
  target_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  base_version_id TEXT NOT NULL REFERENCES file_versions(id),
  proposed_version_id TEXT REFERENCES file_versions(id),  -- 提案内容（独立草稿版本，正式文件未变）
  diff_hash TEXT NOT NULL,
  diff TEXT NOT NULL,                            -- unified diff
  instruction_ids TEXT NOT NULL DEFAULT '[]',    -- 相关指令集合
  required_approvers TEXT NOT NULL DEFAULT '[]', -- 相关指令人
  approval_count INTEGER NOT NULL DEFAULT 0,
  needed_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN
    ('draft','pending_approval','suspended','ready_to_commit','committing','committed','superseded','rejected','stale','cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id),
  executor_id TEXT NOT NULL REFERENCES users(id), -- 实际执行者（需具备编辑权）
  summary TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  next_reminder_at TEXT,
  suspend_deadline_at TEXT,                      -- 超阈值挂起（默认 72h）
  suspended_at TEXT, woken_at TEXT,
  committed_version_id TEXT REFERENCES file_versions(id),
  committed_at TEXT,
  final_reason TEXT,                             -- 拒绝/修改/作废/撤回的理由
  revision_history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prop_status ON proposals(organization_id, status);

CREATE TABLE IF NOT EXISTS proposal_revisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  revision INTEGER NOT NULL,
  diff_hash TEXT NOT NULL,
  base_version_id TEXT NOT NULL,
  proposed_version_id TEXT,
  instruction_ids TEXT NOT NULL DEFAULT '[]',
  required_approvers TEXT NOT NULL DEFAULT '[]',
  cause TEXT NOT NULL,                           -- created / content_change / base_change / new_instruction
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (proposal_id, revision)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  organization_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  diff_hash TEXT NOT NULL,                       -- 签名固定到 revision+diff_hash+base+instructions
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','request_changes')),
  reason TEXT,
  signed_for_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,             -- 旧签名失效但保留审计（不得删除）
  created_at TEXT NOT NULL,
  UNIQUE (proposal_id, revision, user_id, decision)
);

CREATE TABLE IF NOT EXISTS proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  type TEXT NOT NULL,                            -- created/reminded/suspended/woken/stale/voided/withdrawn/committed
  actor_id TEXT, note TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT REFERENCES agent_sessions(id),
  type TEXT NOT NULL CHECK (type IN ('resource','version','path','write_set','dependency','semantic')),
  resource_key TEXT NOT NULL,
  affected_ids TEXT NOT NULL DEFAULT '[]',       -- 影响哪些 Run / Request
  waiting_on TEXT NOT NULL DEFAULT '[]',         -- 在等谁
  detail TEXT,
  basis TEXT NOT NULL DEFAULT 'deterministic' CHECK (basis IN ('deterministic','model_assisted')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution TEXT,                               -- 确认顺序 / 选方案 / 请求澄清
  resolved_by TEXT, resolved_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- usage_records 定义在 003（与 discovery 导入共用一张用量表）

