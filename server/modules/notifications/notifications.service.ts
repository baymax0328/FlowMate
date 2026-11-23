import { INBOX_NOTIFICATION_SQL } from './inbox-policy';
// FlowMate · 通知与事件投递（PRD §03 通知、§19 通知接口、§17 事件/发件箱）
// 关键规则：已读 ≠ 已处理（read_at 与 handled_at 分开）；通知与事件、outbox 同一事务；
// payload 最小化，标题不承载消息正文摘录（不全量广播私人内容）。
import { appendEvent, getDb, j, nowIso, queueOutbox, S, uuid } from '../../core/db';
import { AppError } from '../../core/errors';
import type { Actor } from '../../core/permissions';
import { services, type ID, type Json, type NotificationsService as NotificationsContract } from '../../core/contracts';

export interface EmitInput {
  user_id: ID;
  organization_id: ID;
  type: string;
  title: string;
  body?: string;
  entity_type?: string;
  entity_id?: ID;
  target_path?: string;
  actor_id?: ID | null;
  conversation_id?: ID | null;
  session_id?: ID | null;
  task_id?: ID | null;
  proposal_id?: ID | null;
}

interface NotificationRow {
  id: string; organization_id: string; user_id: string; type: string; title: string; body: string | null;
  entity_type: string | null; entity_id: string | null; actor_id: string | null;
  conversation_id: string | null; session_id: string | null; task_id: string | null;
  proposal_id: string | null; target_path: string | null; read_at: string | null; handled_at: string | null;
  created_at: string; actor_name: string | null; session_mode?: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  mention: '有人提到了你',
  reply: '有人回复了你',
  conversation_added: '你被加入会话',
  conversation_removed: '你被移出会话',
  access_request: '访问申请',
  share_assigned: '分享给你',
  invite_received: '组织邀请',
  task_assigned: '任务指派',
  task_review: '待你验收',
  task_transition: '任务交接',
  session_invited: '会话邀请',
  collab_requested: '协作申请',
  pending_approval: '待共同确认',
  proposal_suspended: '提案已搁置',
  conflict: '冲突待处理',
  review_result: '验收结果',
  extraction_done: '提取完成',
  candidate_created: '候选任务',
};

function label(type: string) {
  return TYPE_LABEL[type] ?? '通知';
}

export class NotificationsService implements NotificationsContract {
  /** GET /notifications */
  async list(actor: Actor, opts?: { unread_only?: boolean; limit?: number; type?: string; inbox?: boolean }): Promise<Json[]> {
    const d = getDb();
    const limit = Math.min(Math.max(Number(opts?.limit ?? 50), 1), 200);
    const cond: string[] = ['n.user_id=?', 'n.organization_id=?'];
    const params: unknown[] = [actor.userId, actor.orgId];
    if (opts?.inbox) cond.push(INBOX_NOTIFICATION_SQL);
    if (opts?.unread_only) cond.push('n.read_at IS NULL');
    if (opts?.type) { cond.push('n.type=?'); params.push(opts.type); }
    const rows = d.all<NotificationRow>(
      `SELECT n.*, u.display_name AS actor_name, s.mode AS session_mode FROM notifications n
       LEFT JOIN users u ON u.id=n.actor_id LEFT JOIN agent_sessions s ON s.id=n.session_id
       WHERE ${cond.join(' AND ')} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      ...params, limit);
    return rows.map((r) => this.dto(r));
  }

  private dto(r: NotificationRow): Json {
    return {
      id: r.id,
      type: r.type,
      type_label: label(r.type),
      title: r.title,
      body: r.body,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      actor_id: r.actor_id,
      actor_name: r.actor_name,
      conversation_id: r.conversation_id,
      session_id: r.session_id,
      task_id: r.task_id,
      proposal_id: r.proposal_id,
      target_path: r.session_id ? `/agent/${r.session_mode === 'team' ? 'team' : 'personal'}?s=${encodeURIComponent(r.session_id)}` : r.target_path,
      read: !!r.read_at,
      read_at: r.read_at,
      read_label: r.read_at ? '已读' : '未读',
      handled: !!r.handled_at,
      handled_at: r.handled_at,
      handled_label: r.handled_at ? '已处理' : '待处理',
      created_at: r.created_at,
    };
  }

  async markRead(actor: Actor, id: ID): Promise<void> {
    const d = getDb();
    const row = d.get<{ id: string; read_at: string | null }>(
      'SELECT id, read_at FROM notifications WHERE id=? AND user_id=? AND organization_id=?', id, actor.userId, actor.orgId);
    if (!row) throw AppError.notFound('通知不存在或不可见');
    if (!row.read_at) d.run('UPDATE notifications SET read_at=? WHERE id=?', nowIso(), id);
    void d;
  }

  /** 已读 ≠ 已处理：显式的「已处理」写入，供通知点击定位后回执 */
  async markHandled(actor: Actor, id: ID): Promise<Json> {
    const d = getDb();
    const row = d.get<{ id: string; read_at: string | null }>(
      'SELECT id, read_at FROM notifications WHERE id=? AND user_id=? AND organization_id=?', id, actor.userId, actor.orgId);
    if (!row) throw AppError.notFound('通知不存在或不可见');
    const now = nowIso();
    if (!row.read_at) d.run('UPDATE notifications SET read_at=?, handled_at=? WHERE id=?', now, now, id);
    else d.run('UPDATE notifications SET handled_at=? WHERE id=?', now, id);
    return { id, handled: true, message: '已标记为已处理' };
  }

  /** 契约方法（void）；控制器需要计数时用 readAll */
  async markAllRead(actor: Actor): Promise<void> {
    this.readAll(actor);
  }

  readAll(actor: Actor, inbox = false): Json {
    const r = getDb().run(`UPDATE notifications AS n SET read_at=? WHERE user_id=? AND organization_id=? AND read_at IS NULL${inbox ? ` AND ${INBOX_NOTIFICATION_SQL}` : ''}`,
      nowIso(), actor.userId, actor.orgId);
    return { updated: r.changes, message: `已标记 ${r.changes} 条通知为已读` };
  }

  async markAllHandled(actor: Actor): Promise<Json> {
    const now = nowIso();
    const r = getDb().run(
      `UPDATE notifications SET handled_at=?, read_at=COALESCE(read_at,?)
       WHERE user_id=? AND organization_id=? AND handled_at IS NULL`, now, now, actor.userId, actor.orgId);
    return { updated: r.changes, message: `已标记 ${r.changes} 条通知为已处理` };
  }

  async unreadCount(actor: Actor, inbox = false): Promise<number> {
    return Number(getDb().val<number>(
      `SELECT COUNT(*) FROM notifications n WHERE user_id=? AND organization_id=? AND read_at IS NULL${inbox ? ` AND ${INBOX_NOTIFICATION_SQL}` : ''}`,
      actor.userId, actor.orgId) ?? 0);
  }

  /** 顶部通知菜单一次拿全：未读数 + 待处理数 + 分类计数 */
  async summary(actor: Actor): Promise<Json> {
    const d = getDb();
    const unread = await this.unreadCount(actor);
    const pending = Number(d.val<number>(
      'SELECT COUNT(*) FROM notifications WHERE user_id=? AND organization_id=? AND handled_at IS NULL',
      actor.userId, actor.orgId) ?? 0);
    const byType = d.all<{ type: string; c: number }>(
      `SELECT type, COUNT(*) AS c FROM notifications
       WHERE user_id=? AND organization_id=? AND read_at IS NULL GROUP BY type ORDER BY c DESC`,
      actor.userId, actor.orgId);
    return {
      unread,
      unread_label: unread > 0 ? `未读 ${unread} 条` : '无未读通知',
      pending,
      pending_label: pending > 0 ? `待处理 ${pending} 条` : '无待处理事项',
      by_type: byType.map((t) => ({ type: t.type, label: label(t.type), count: Number(t.c) })),
    };
  }

  /** 通知落库 + 事件 + outbox（同一事务）；契约入口返回 void，需要 id 时用 emitSync */
  async emit(input: EmitInput): Promise<void> {
    this.emitSync(input);
  }

  async emitMany(inputs: EmitInput[]): Promise<{ emitted: number }> {
    for (const i of inputs) this.emitSync(i);
    return { emitted: inputs.length };
  }

  /**
   * 同步版本：供业务事务内部调用。node:sqlite 全同步，事务里 await 会破坏边界，
   * 因此 messages / org 等模块在 d.tx(...) 中一律用本方法（嵌套时走 savepoint）。
   */
  emitSync(input: EmitInput): Json {
    if (!input.user_id) throw AppError.validation('缺少通知接收人');
    if (!input.title) throw AppError.validation('缺少通知标题');
    const d = getDb();
    const id = uuid();
    const now = nowIso();
    d.tx(() => {
      d.run(`INSERT INTO notifications(id,organization_id,user_id,type,title,body,entity_type,entity_id,actor_id,
               conversation_id,session_id,task_id,proposal_id,target_path,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.organization_id, input.user_id, input.type, input.title, input.body ?? null,
        input.entity_type ?? null, input.entity_id ?? null, input.actor_id ?? null,
        input.conversation_id ?? null, input.session_id ?? null, input.task_id ?? null,
        input.proposal_id ?? null, input.target_path ?? null, now);
      const ev = appendEvent({
        type: 'notification.created', organization_id: input.organization_id, entity_type: 'notification',
        entity_id: id, actor_id: input.actor_id ?? null, conversation_id: input.conversation_id ?? null,
        session_id: input.session_id ?? null, task_id: input.task_id ?? null,
        // 载荷最小化：标题不含消息正文摘录，客户端按 id 取详情
        payload: {
          notification_id: id, kind: input.type, title: input.title,
          entity_type: input.entity_type ?? null, entity_id: input.entity_id ?? null,
          target_path: input.target_path ?? null,
        },
      });
      queueOutbox([{ user_id: input.user_id, channel: 'notification', payload: { notification_id: id } }], Number(ev.seq));
    });
    return { id, created_at: now };
  }

  /** 清理：只统计，不静默删数据（通知是审计线索的一部分） */
  async purgeOlderThan(actor: Actor, days: number): Promise<Json> {
    const until = new Date(Date.now() - Math.max(days, 1) * 86400000).toISOString();
    const r = getDb().run(
      'DELETE FROM notifications WHERE user_id=? AND organization_id=? AND read_at IS NOT NULL AND handled_at IS NOT NULL AND created_at<?',
      actor.userId, actor.orgId, until);
    return { deleted: r.changes };
  }

  /** 便于调试：读取某条通知（仅本人） */
  async one(actor: Actor, id: ID): Promise<Json> {
    const r = getDb().get<NotificationRow>(
      `SELECT n.*, u.display_name AS actor_name, s.mode AS session_mode FROM notifications n LEFT JOIN users u ON u.id=n.actor_id LEFT JOIN agent_sessions s ON s.id=n.session_id
       WHERE n.id=? AND n.user_id=? AND n.organization_id=?`, id, actor.userId, actor.orgId);
    if (!r) throw AppError.notFound('通知不存在或不可见');
    return this.dto(r);
  }
}

/** 注册表未装配时的兜底：仍写 notifications + outbox，语义与 emit 一致 */
export async function pushNotification(input: EmitInput): Promise<void> {
  const n = services.notifications;
  if (n) { await n.emit(input); return; }
  new NotificationsService().emitSync(input);
}

/** 事务内同步发送：命中已装配的实例则复用其 emitSync，否则本地兜底实现 */
export function pushNotificationSync(input: EmitInput): void {
  const n = services.notifications as (NotificationsContract & { emitSync?: (i: EmitInput) => unknown }) | undefined;
  if (n && typeof n.emitSync === 'function') { n.emitSync(input); return; }
  new NotificationsService().emitSync(input);
}

export const notificationTypeLabel = label;
