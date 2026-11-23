-- 013 · 任务排期（负责阶段的当日时间块）
-- 「负责」tab 的任务可加排期：某天的一段起止时间；排期后看板最前端显示具体时间，未排期仍显示状态（已接收/进行中）。
-- 沿用本项目「只加列、绝不重建表」的迁移约定（见 011 / 012）。
--   schedule_date  = 'YYYY-MM-DD'；schedule_start / schedule_end = 'HH:MM'；三者同时存在才算已排期。
--   schedule_note  = 排期理由（AI 一键排期会写入；手动排期可留空）。
ALTER TABLE tasks ADD COLUMN schedule_date TEXT;
ALTER TABLE tasks ADD COLUMN schedule_start TEXT;
ALTER TABLE tasks ADD COLUMN schedule_end TEXT;
ALTER TABLE tasks ADD COLUMN schedule_note TEXT;
