-- FlowMate v0.2 · 007 orchestrator 追加列（append-only；不改 001~003）
-- §08.4 / §11 / §17：计划来源标注、指令修订留痕、取消原因、产物与提案关联。

ALTER TABLE requests ADD COLUMN planner TEXT;                       -- 'model' | 'deterministic'
ALTER TABLE requests ADD COLUMN instruction_log TEXT NOT NULL DEFAULT '[]';  -- [{revision,goal,answered_at,by}]
ALTER TABLE runs ADD COLUMN planner TEXT;                           -- 与所属计划一致，界面字段
ALTER TABLE runs ADD COLUMN cancel_reason TEXT;
ALTER TABLE runs ADD COLUMN output_kind TEXT NOT NULL DEFAULT 'draft';       -- 子任务产出类型
ALTER TABLE run_steps ADD COLUMN planner TEXT;                      -- 每个 RunStep 明确标注来源（诚实底线）
ALTER TABLE artifacts ADD COLUMN proposal_id TEXT;
ALTER TABLE artifacts ADD COLUMN saved_file_id TEXT;
ALTER TABLE artifacts ADD COLUMN saved_version_id TEXT;
