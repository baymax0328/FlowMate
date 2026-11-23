-- 015 · 用量记录归属到人，供「我的看板」按人统计 Token / 在线时长（团队看板按组织合计）。
-- 只加列、不重建表。历史行 user_id 为空 → 团队视图计入、个人视图可按归属过滤。
ALTER TABLE usage_records ADD COLUMN user_id TEXT;
