-- 009 · 修正 Agent 会话里「我说的话」被记成 FlowMate Agent 的历史行
-- 背景：appendSessionMessage 以前把 sender_user_id 写死 NULL、sender_label 写死 'FlowMate Agent'，
-- 不看 role。于是走 /chat 与 /requests 写进去的用户发言（role='user'）也标成了 Agent，
-- 界面上就是「我发的问句显示成 FlowMate Agent 说的」，前端 mine 判定也永远为假。
-- 代码已修（按 role 推导）；这条迁移负责把既有数据补回来。
-- 幂等：全部条件带 role='user' AND sender_user_id IS NULL，跑第二次不会有副作用。

-- 第一步：aux 里留有发起人姓名（/chat 写 initiator，请求卡写 creator_name）→ 按同组织内的显示名回填
UPDATE session_messages
SET sender_user_id = (
      SELECT u.id FROM users u
      JOIN memberships mm ON mm.user_id = u.id AND mm.organization_id = session_messages.organization_id
      WHERE mm.status = 'active'
        AND u.display_name = COALESCE(
              NULLIF(json_extract(session_messages.aux, '$.initiator'), ''),
              NULLIF(json_extract(session_messages.aux, '$.creator_name'), ''))
      LIMIT 1),
    sender_label = COALESCE((
      SELECT u.display_name FROM users u
      JOIN memberships mm ON mm.user_id = u.id AND mm.organization_id = session_messages.organization_id
      WHERE mm.status = 'active'
        AND u.display_name = COALESCE(
              NULLIF(json_extract(session_messages.aux, '$.initiator'), ''),
              NULLIF(json_extract(session_messages.aux, '$.creator_name'), ''))
      LIMIT 1), session_messages.sender_label)
WHERE role = 'user' AND sender_user_id IS NULL
  AND COALESCE(NULLIF(json_extract(session_messages.aux, '$.initiator'), ''),
               NULLIF(json_extract(session_messages.aux, '$.creator_name'), '')) IS NOT NULL;

-- 第二步：aux 里没有姓名，但该会话只有一个参与者（单人 Personal 会话的常见形态）→ 只能是他
-- 多参与人的 Team 会话不做猜测：宁可留一条明确标注，也不把话安到别人头上
UPDATE session_messages
SET sender_user_id = (SELECT p.user_id FROM session_participants p
                      WHERE p.session_id = session_messages.session_id AND p.left_at IS NULL
                      LIMIT 1),
    sender_label   = (SELECT u.display_name FROM users u
                      WHERE u.id = (SELECT p.user_id FROM session_participants p
                                    WHERE p.session_id = session_messages.session_id AND p.left_at IS NULL
                                    LIMIT 1))
WHERE role = 'user' AND sender_user_id IS NULL
  AND (SELECT COUNT(*) FROM session_participants p
       WHERE p.session_id = session_messages.session_id AND p.left_at IS NULL) = 1;

-- 第三步：仍然认不出是谁的，改掉「FlowMate Agent」这个错标签，明确写「未记录发送人」
UPDATE session_messages
SET sender_label = '未记录发送人'
WHERE role = 'user' AND sender_user_id IS NULL AND sender_label = 'FlowMate Agent';
