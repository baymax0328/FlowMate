-- 014 · 接收时必填「预估时长」+ 负责页可改，供智能排期用
-- 沿用「只加列、绝不重建表」约定（见 011/012/013）。
--   estimate_min = 预估时长（分钟，整数）。接收任务时必填，之后在「负责」可改；自动排期按它给任务分配时间块长度。
ALTER TABLE tasks ADD COLUMN estimate_min INTEGER;
