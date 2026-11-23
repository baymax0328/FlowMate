// 顶部收件箱只显示"别人发来的、需要处理"的通知；审计类通知照常入库，只是不在这里出现。
// 旧版任务通知没有记 actor_id，从对应的流转记录里把它补回来。
export const INBOX_NOTIFICATION_SQL = `(
  (n.type IN ('task_assigned','task_review','reply','conversation_added','share_assigned','session_invited','collab_requested')
   OR (n.type='pending_approval' AND n.session_id IS NOT NULL)
   OR (n.type='task_transition' AND (n.title LIKE '%退回%' OR n.title LIKE '%请求调整%')))
  AND COALESCE(n.actor_id, (
    SELECT tt.actor_id FROM task_transitions tt
    WHERE tt.task_id=n.task_id AND tt.created_at<=n.created_at
    ORDER BY tt.created_at DESC, tt.rowid DESC LIMIT 1
  )) IS NOT n.user_id
)`;
