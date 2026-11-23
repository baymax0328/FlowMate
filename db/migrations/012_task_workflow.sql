-- 012 · 任务板块重设计（创建 / 接收 / 负责 / 验收 四段 + 经手人链）
-- 背景：任务从「五阶段流程」改为「创建→接收→负责→验收」四段，引入「任务经手成员链」
--   创建人 →(≥1 中间经手人，最多 7)→ 交付人（验收人）。
-- 只做 ADD COLUMN（沿用本项目「SQLite 改 CHECK 要重建表、风险大，故一律加列」的既有约定，见 011）：
--   优先级 T0/T1/T2/T3 在应用层映射到既有的 urgent/high/normal/low，不动 tasks.priority 的 CHECK 约束。
--
-- handlers：有序中间经手人 user_id 数组（JSON）。当前该处理的人 = handlers[handler_index]，
--   同步写入既有的 assignee_id 列（这样列表 / 权限 / 可见性等老逻辑无需改动即可继续工作）。
-- handler_index：指针；下游交接即把它 +1。
-- returned：接收人「退回」后置 1，任务带着不同看板颜色回到创建人的「创建」tab；再次编辑即清 0。
-- reject_reason：退回原因（接收人填写）。
-- folder_id：关联工作区（可空）。负责 tab 的「在个人办公中处理」据此在该工作区开 / 复用会话。
-- review_round：交付人「重新指派」轮次；重派不清历史，只递增轮次并另起一条经手人链。
-- handler_log：每一环的 {user_id,accepted_at,ended_at,action,duration_ms}，验收页「每一环用时」直接读它。
ALTER TABLE tasks ADD COLUMN handlers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN handler_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN returned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN reject_reason TEXT;
ALTER TABLE tasks ADD COLUMN folder_id TEXT REFERENCES folders(id);
ALTER TABLE tasks ADD COLUMN review_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN handler_log TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS ix_task_creator_status ON tasks(creator_id, status);
