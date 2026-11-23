-- 011 · 请求的「对话外观」标记
-- 背景：工作模式（办公模式）的产品口径是「还是正常问答，只是它能读工作区、能按要求执行」，
-- 但执行链路以前一律往会话里写一张 request_card（请求卡），用户问一句话要先看到一张卡片，
-- 像在用工单系统而不是在对话。
-- 加一个标记区分「外观」而不改 output_kind 的 CHECK 约束（SQLite 改 CHECK 要重建表，风险大）：
--   chat_mode=1 → 用户那句按普通消息落库、执行结果按普通回答气泡落库，不再产出卡片与草稿文件噪音。
ALTER TABLE requests ADD COLUMN chat_mode INTEGER NOT NULL DEFAULT 0;
