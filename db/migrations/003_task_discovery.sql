-- FlowMate v0.2 · 003 任务、任务发现、事件、通知、幂等与用量（PRD §13 / §14 / §17）

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  description TEXT,
  project TEXT,
  expected_deliverable TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','ready_to_assign','pending_accept','accepted','in_progress','pending_transfer','pending_review','completed','cancelled')),
  creator_id TEXT NOT NULL REFERENCES users(id),
  assignee_id TEXT REFERENCES users(id),
  reviewer_id TEXT REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_at TEXT,
  criteria TEXT NOT NULL DEFAULT '[]',           -- [{id,text,required}]
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','message','candidate','handoff','agent')),
  source_ref TEXT NOT NULL DEFAULT '{}',         -- {conversation_id,message_id,candidate_id,import_id,file_id}
  agent_session_id TEXT REFERENCES agent_sessions(id),  -- 只存会话 ID 用于跳转（§13）
  pending_assignee_id TEXT,                      -- 转派中：新负责人接收前旧责任保留
  progress INTEGER NOT NULL DEFAULT 0,
  blocked_note TEXT,
  cancelled_reason TEXT,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_task_org ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS ix_task_assignee ON tasks(assignee_id, status);

CREATE TABLE IF NOT EXISTS task_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,                          -- publish/assign/accept/request_adjustment/reject/transfer/submit/review/cancel/handoff
  note TEXT, fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tt_task ON task_transitions(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_progress (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  done_text TEXT, blocked_text TEXT, progress INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_submissions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL,
  submitter_id TEXT NOT NULL REFERENCES users(id),
  file_version_ids TEXT NOT NULL DEFAULT '[]',   -- 不可变：验收始终看提交时的版本（C15）
  file_snapshot TEXT NOT NULL DEFAULT '[]',      -- [{file_id,version_id,name,version_no,sha256}]
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','returned')),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, seq)
);

CREATE TABLE IF NOT EXISTS task_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  submission_id TEXT NOT NULL REFERENCES task_submissions(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','return')),
  per_criteria TEXT NOT NULL DEFAULT '[]',       -- [{criterion_id,pass,note}]
  note TEXT,
  created_at TEXT NOT NULL
);

-- ============ 导入式任务发现（§14）============
CREATE TABLE IF NOT EXISTS discovery_imports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('manual_upload','pasted_text','folder_import','folder_watch')),
  file_id TEXT REFERENCES files(id),
  file_version_id TEXT REFERENCES file_versions(id),
  pasted_text TEXT,
  name TEXT NOT NULL,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  source_time TEXT,
  source_time_is_import INTEGER NOT NULL DEFAULT 0,  -- 缺失时用导入时间并标注
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','extracting','analyzing','succeeded','partial_failed','failed')),
  extraction_status TEXT,
  counts TEXT NOT NULL DEFAULT '{}',             -- {blocks,candidates,duplicates,confirmed,ignored,failed_blocks}
  error_code TEXT, error_message TEXT,
  provider TEXT,                                 -- 实际使用的模型；无模型时明确标注
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_imp_org ON discovery_imports(organization_id, created_at);

CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES discovery_imports(id),
  organization_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paragraph',
  heading TEXT,
  quote_text TEXT NOT NULL,                      -- 原文（证据回锚的比对基准）
  anchor TEXT NOT NULL DEFAULT '{}',             -- {page,sheet,slide,line_start,line_end}
  created_at TEXT NOT NULL,
  UNIQUE (import_id, block_id)
);

CREATE TABLE IF NOT EXISTS candidate_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  import_id TEXT NOT NULL REFERENCES discovery_imports(id),
  source_item_id TEXT REFERENCES source_items(id),
  title TEXT NOT NULL,
  description TEXT,
  deliverable TEXT,
  suggested_assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  due_basis TEXT,                                -- 推断依据（原文片段 + 相对表述）
  evidence TEXT NOT NULL DEFAULT '{}',           -- {block_id,quote,anchor} quote 必须逐字命中
  confidence REAL,
  missing_fields TEXT NOT NULL DEFAULT '[]',
  cancellation_mark INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL,                       -- source_file_id + 行动项指纹 + 版本
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','needs_clarification','confirmed','ignored','source_changed')),
  possible_duplicate_of TEXT REFERENCES candidate_tasks(id),
  task_id TEXT REFERENCES tasks(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  decided_by TEXT, decided_at TEXT, note TEXT,
  manual_edits TEXT NOT NULL DEFAULT '{}',       -- 人工修改永久保留
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (dedupe_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cand_task ON candidate_tasks(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS folder_watch_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  team_id TEXT REFERENCES teams(id),
  include_children INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,             -- 默认关闭
  schedule_kind TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_kind IN ('interval','hourly','daily_at')),
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  daily_at TEXT,
  cursor TEXT NOT NULL DEFAULT '[]',              -- 极简 folder_watch_cursor：已处理 file_id + version
  last_run_at TEXT, next_run_at TEXT, last_result TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- ============ 事件 / 通知 / 发件箱 / 幂等 / 用量 ============
-- 单一追加型事件流：WS 游标补拉、Center 协作事件、审计共用
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  type TEXT NOT NULL,                             -- message.created / run.updated / proposal.suspended ...
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER,
  actor_id TEXT,
  conversation_id TEXT, session_id TEXT, run_id TEXT, task_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',             -- 内容最小化，不全量广播私人内容
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_ent ON events(entity_type, entity_id, seq);
CREATE INDEX IF NOT EXISTS ix_events_org ON events(organization_id, seq);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER NOT NULL REFERENCES events(seq),
  channel TEXT NOT NULL CHECK (channel IN ('ws','notification','usage','mail_disabled')),
  user_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(status, id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                             -- mention/share_assigned/task_assigned/pending_approval/proposal_suspended/conflict/review_result/extraction_done/candidate_created
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT, entity_id TEXT,
  actor_id TEXT,
  conversation_id TEXT, session_id TEXT, task_id TEXT, proposal_id TEXT,
  target_path TEXT,                               -- 点击定位对象与对应事件
  read_at TEXT,                                   -- 已读 ≠ 已处理
  handled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, key)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT, run_id TEXT, step_id TEXT, import_id TEXT,
  provider TEXT, model TEXT,
  input_tokens INTEGER,                           -- null = 未获取，不得写 0
  output_tokens INTEGER,
  calls INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_locks (
  resource_key TEXT PRIMARY KEY,                  -- file:<id> 正式提交资源级串行
  owner_run_id TEXT,
  owner_proposal_id TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0,
  acquired_at TEXT, expires_at TEXT
);

-- schema_meta：迁移版本记录
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
