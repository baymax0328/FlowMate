// FlowMate · Message 模块服务（PRD §05 人与人的会话、§15 检索层级、§19 Message 契约、§20 成员权）
// 硬约束落地：
//  · 服务端鉴权：读路径一律先验「未退出的当前成员」，退出后不再返回新内容与计数；
//  · 附件发送前校验文件 viewer 权；卡片只带标题与权限说明，发卡片不授权、不泄漏无权的对象标题；
//  · 撤回/被删原文不留摘录；被引用消息撤回保留审计版本；不级联删除任务；
//  · 普通聊天不自动调用模型 —— 本文件不导入任何模型适配器。
import { appendEvent, getDb, j, nowIso, queueOutbox, S, uuid } from '../../core/db';
import { AppError } from '../../core/errors';
import { isOrgManager, resolveAcl, sessionAccess, userTeams, type Actor } from '../../core/permissions';
import { buildMatch, snippetFor, tokensToIndex } from '../../core/tokens';
import { sanitizeName } from '../../core/paths';
import { services, type ID, type Json, type MessagesService as MessagesContract } from '../../core/contracts';
import { pushNotificationSync } from '../notifications/notifications.service';

/**
 * 文件可读判定（含目录继承）。
 * core.resolveAcl 对 resourceType='file' 只按 resource_type='file' 查祖先目录的 ACL 行，
 * 挂在目录上的 team/org 授权会漏判（allow=0），因此消息附件与卡片权限在本模块内先走这条补齐继承的判定；
 * 若 core.resolveAcl 判定为可读也直接放行（两处取并集，不引入更严的行为）。
 * 建议主控把「目录链 + 类型」的下推逻辑下沉到 server/core/permissions（见交付报告）。
 */
const ACL_RANK: Record<string, number> = { viewer: 1, editor: 2, manager: 3 };
function folderAncestors(folderId: string | null): string[] {
  const out: string[] = [];
  let cur = folderId;
  let guard = 0;
  while (cur && guard++ < 64) {
    out.push(cur);
    cur = getDb().get<{ parent_id: string | null }>('SELECT parent_id FROM folders WHERE id=?', cur)?.parent_id ?? null;
  }
  return out;
}
function aclRowsFor(resourceType: 'file' | 'folder', resourceId: string, actor: Actor): { permission: string; effect: string }[] {
  const teams = userTeams(actor.userId, actor.orgId);
  return getDb().all<{ permission: string; effect: string }>(
    `SELECT permission, effect FROM acls
     WHERE resource_type=? AND resource_id=?
       AND ((principal_type='user' AND principal_id=?)
         ${teams.length ? `OR (principal_type='team' AND principal_id IN (${inClause(teams.length)}))` : ''}
         OR (principal_type='org' AND principal_id=?))`,
    resourceType, resourceId, actor.userId, ...teams, actor.orgId);
}
export function fileAllows(actor: Actor, fileId: string, level: 'viewer' | 'editor' | 'manager' = 'viewer'): boolean {
  const f = getDb().get<{ id: string; organization_id: string; space: string; owner_id: string | null; folder_id: string | null }>(
    'SELECT id,organization_id,space,owner_id,folder_id FROM files WHERE id=?', fileId);
  if (!f || f.organization_id !== actor.orgId) return false;
  if (resolveAcl(actor, 'file', f.id).allow >= ACL_RANK[level]) return true;
  const chain: { type: 'file' | 'folder'; id: string }[] = [{ type: 'file', id: f.id },
    ...folderAncestors(f.folder_id).map((id) => ({ type: 'folder' as const, id }))];
  let allow = 0;
  let denied = false;
  for (const node of chain) {
    for (const r of aclRowsFor(node.type, node.id, actor)) {
      if (r.effect === 'deny' && ACL_RANK[r.permission] >= 1) denied = true;
      if (r.effect === 'allow' && ACL_RANK[r.permission] > allow) allow = ACL_RANK[r.permission];
    }
  }
  if (f.space === 'personal' && f.owner_id === actor.userId) return true;
  if (denied && f.owner_id !== actor.userId) return false;
  return allow >= ACL_RANK[level];
}

const MAX_BODY = 20000;
const SUMMARY_CHARS = 60;
const TASK_TITLE_CHARS = 40;
const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;
const CARD_TYPES = ['task', 'file_version', 'session'] as const;
type CardType = typeof CARD_TYPES[number];

interface ConvRow {
  id: string; organization_id: string; type: string; name: string | null; team_id: string | null;
  dm_key: string | null; created_by: string | null; last_message_at: string | null; status: string; dissolved_at: string | null;
  created_at: string; updated_at: string;
}
interface ConversationSettings {
  pinned_at: string | null; muted: number; manual_unread: number; hidden: number; history_cutoff: number;
}
interface MemberRow extends Partial<ConversationSettings> {
  prefs?: string;
  conversation_id: string; user_id: string; role: string; joined_at: string; left_at: string | null;
  last_read_at: string | null; display_name: string; title: string | null; account_status: string;
}
interface MsgRow {
  id: string; organization_id: string; conversation_id: string; sender_id: string; body: string;
  parent_id: string | null; mentions: string; attachments: string; card_type: string | null; card_id: string | null;
  client_msg_id: string | null; edited_at: string | null; retracted_at: string | null;
  edited_versions: string; created_at: string; sender_name?: string;
}
interface SendMessageInput {
  conversation_id: ID; body: string; parent_id?: ID | null; mentions?: ID[];
  attachments?: { file_id: ID; version_id?: ID | null }[]; client_msg_id?: string;
  card_type?: string; card_id?: ID;
}
interface ParentRow { id: string; body: string; retracted_at: string | null; created_at: string; display_name: string }
interface TaskRow {
  id: string; title: string; status: string; creator_id: string; assignee_id: string | null;
  reviewer_id: string | null; team_id: string | null; source: string; created_at: string;
}
interface Attachment { file_id: ID; version_id: ID | null; name?: string | null; mime?: string | null; size?: number }

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
function inClause(n: number) {
  return Array.from({ length: n }, () => '?').join(',');
}
function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
export function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}
export function encodeCursor(created_at: string, id: string): string {
  return Buffer.from(`${created_at}|${id}`, 'utf8').toString('base64url');
}
export function decodeCursor(raw: string | undefined): { created_at: string; id: string } | null {
  if (!raw) return null;
  try {
    const s = Buffer.from(raw, 'base64url').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i <= 0) return null;
    return { created_at: s.slice(0, i), id: s.slice(i + 1) };
  } catch {
    return null;
  }
}

export class MessagesService implements MessagesContract {
  /**
   * GET /messages/unread-count —— 当前用户在本组织内所有活跃会话里的未读消息总数。
   * 供最左侧「消息」导航的红点用；口径与会话列表一致：别人发的、未撤回、晚于我的已读位点、且我未退群。
   */
  async unreadMessageCount(actor: Actor): Promise<{ count: number }> {
    const d = getDb();
    const count = Number(d.val<number>(
      `SELECT SUM(unread) FROM (
       SELECT MAX(COUNT(m.id), cm.manual_unread) AS unread
       FROM conversation_members cm
       JOIN conversations c ON c.id=cm.conversation_id
       LEFT JOIN messages m ON m.conversation_id=cm.conversation_id
         AND m.sender_id<>cm.user_id AND m.retracted_at IS NULL
         AND m.history_seq>cm.history_cutoff AND (cm.last_read_at IS NULL OR m.created_at>cm.last_read_at)
       WHERE cm.user_id=? AND cm.left_at IS NULL AND cm.hidden=0 AND cm.muted=0 AND c.organization_id=? AND c.status='active'
       GROUP BY cm.conversation_id)`,
      actor.userId, actor.orgId) ?? 0);
    return { count };
  }

  // ==================== 会话 ====================

  /** GET /conversations?type=&q= —— 私聊名按对方成员名组合派生；带未读、@我、成员与最后消息摘要 */
  async list(actor: Actor, opts?: { type?: string; q?: string; limit?: number }): Promise<Json[]> {
    const d = getDb();
    const limit = clampNum(opts?.limit ?? 100, 1, 300, 100);
    const cond = ['cm.user_id=?', 'cm.left_at IS NULL', 'c.organization_id=?', "c.status='active'", 'cm.hidden=0'];
    const params: unknown[] = [actor.userId, actor.orgId];
    if (opts?.type === 'dm' || opts?.type === 'project') { cond.push('c.type=?'); params.push(opts.type); }
    const convs = d.all<ConvRow>(
      `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
       WHERE ${cond.join(' AND ')}
       ORDER BY cm.pinned_at DESC, COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`, ...params, limit);
    if (!convs.length) return [];
    const ids = convs.map((c) => c.id);

    const memberMap = new Map<string, MemberRow[]>();
    const unreadMap = new Map<string, { unread: number; at_me: number }>();
    const lastMap = new Map<string, MsgRow & { sender_name: string }>();
    for (const part of chunk(ids)) {
      const ph = inClause(part.length);
      for (const m of d.all<MemberRow>(
        `SELECT cm.conversation_id, cm.user_id, cm.role, cm.joined_at, cm.left_at, cm.last_read_at,
                CASE WHEN cm.user_id=? THEN cm.pinned_at END AS pinned_at,
                CASE WHEN cm.user_id=? THEN cm.muted ELSE 0 END AS muted,
                CASE WHEN cm.user_id=? THEN cm.manual_unread ELSE 0 END AS manual_unread,
                u.display_name, u.title, u.status AS account_status
         FROM conversation_members cm JOIN users u ON u.id=cm.user_id
         WHERE cm.conversation_id IN (${ph}) AND cm.left_at IS NULL ORDER BY u.display_name`, actor.userId, actor.userId, actor.userId, ...part)) {
        const arr = memberMap.get(m.conversation_id) ?? [];
        arr.push(m);
        memberMap.set(m.conversation_id, arr);
      }
      for (const r of d.all<{ id: string; unread: number | null; at_me: number | null }>(
        `SELECT cm.conversation_id AS id, COUNT(m.id) AS unread,
                SUM(CASE WHEN m.mentions LIKE ? THEN 1 ELSE 0 END) AS at_me
         FROM conversation_members cm
         LEFT JOIN messages m ON m.conversation_id=cm.conversation_id AND m.sender_id<>cm.user_id
           AND m.retracted_at IS NULL AND m.history_seq>cm.history_cutoff AND (cm.last_read_at IS NULL OR m.created_at>cm.last_read_at)
         WHERE cm.user_id=? AND cm.left_at IS NULL AND cm.conversation_id IN (${ph})
         GROUP BY cm.conversation_id`, `%"${actor.userId}"%`, actor.userId, ...part)) {
        unreadMap.set(r.id, { unread: Number(r.unread ?? 0), at_me: Number(r.at_me ?? 0) });
      }
      for (const r of d.all<MsgRow & { sender_name: string; rn: number }>(
        `SELECT * FROM (
           SELECT m.*, u.display_name AS sender_name,
                  ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC, m.id DESC) AS rn
           FROM messages m JOIN users u ON u.id=m.sender_id
           JOIN conversation_members viewer ON viewer.conversation_id=m.conversation_id AND viewer.user_id=?
           WHERE m.conversation_id IN (${ph}) AND m.history_seq>viewer.history_cutoff
         ) WHERE rn=1`, actor.userId, ...part)) {
        lastMap.set(r.conversation_id, r);
      }
    }

    const q = (opts?.q ?? '').trim().toLowerCase();
    const out: Json[] = [];
    for (const c of convs) {
      const members = memberMap.get(c.id) ?? [];
      const name = this.displayName(actor, c, members);
      if (q) {
        const hay = [name, ...members.map((m) => m.display_name), c.name ?? ''].join(' ').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(this.conversationDto(actor, c, name, members, unreadMap.get(c.id), lastMap.get(c.id)));
    }
    return out;
  }

  async listConversations(actor: Actor): Promise<Json[]> {
    return this.list(actor);
  }

  private displayName(actor: Actor, c: ConvRow, members: MemberRow[]): string {
    if (c.type === 'project') return c.name ?? '项目群';
    const others = members.filter((m) => m.user_id !== actor.userId).map((m) => m.display_name);
    return others.length ? others.join('、') : '私聊（仅自己）';
  }

  private conversationDto(actor: Actor, c: ConvRow, name: string, members: MemberRow[],
                          unread?: { unread: number; at_me: number }, last?: MsgRow & { sender_name: string }): Json {
    const d = getDb();
    const mine = members.find((m) => m.user_id === actor.userId);
    const atMe = unread?.at_me ?? 0;
    const unreadCount = Math.max(unread?.unread ?? 0, mine?.manual_unread ?? 0);
    return {
      id: c.id,
      organization_id: c.organization_id,
      type: c.type,
      created_by: c.created_by,
      dissolved_at: c.dissolved_at,
      type_label: c.type === 'dm' ? '私聊' : '项目群',
      name,
      stored_name: c.name,
      team_id: c.team_id ?? null,
      team_name: c.team_id ? d.val<string>('SELECT name FROM teams WHERE id=?', c.team_id) ?? null : null,
      my_role: mine?.role ?? 'member',
      member_count: members.length,
      members: members.map((m) => ({
        user_id: m.user_id, display_name: m.display_name, title: m.title, role: m.role,
        role_label: m.role === 'admin' ? '管理员' : '成员',
        active: m.account_status === 'active',
      })),
      admin_ids: members.filter((m) => m.role === 'admin').map((m) => m.user_id),
      unread_count: unreadCount,
      unread_label: unreadCount > 0 ? `未读 ${unreadCount} 条` : '无未读',
      at_me_unread_count: atMe,
      at_me_unread_label: atMe > 0 ? `@我 ${atMe} 条` : '无 @我 未读',
      last_message_at: c.last_message_at,
      last_read_at: mine?.last_read_at ?? null,
      pinned_at: mine?.pinned_at ?? null,
      muted: !!mine?.muted,
      last_message: last ? {
        id: last.id, sender_id: last.sender_id, sender_name: last.sender_name,
        created_at: last.created_at, retracted: !!last.retracted_at, summary: this.summaryOf(last),
      } : null,
      can_manage: this.canManage({ created_by: c.created_by ?? null, my_role: mine?.role ?? 'member' }, actor),
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  private summaryOf(m: MsgRow): string {
    if (m.retracted_at) return '内容已撤回';
    const body = oneLine(m.body);
    if (body) return body.length > SUMMARY_CHARS ? `${body.slice(0, SUMMARY_CHARS)}…` : body;
    const atts = j<Attachment[]>(m.attachments, []);
    if (atts.length) return atts.length > 1 ? `附件 ${atts.length} 个` : `附件：${atts[0].name ?? '文件'}`;
    if (m.card_type) return `卡片：${this.cardLabel(m.card_type)}`;
    return '空消息';
  }

  private cardLabel(t: string): string {
    return t === 'task' ? '任务' : t === 'file_version' ? '文件版本' : t === 'session' ? 'Agent 会话' : '卡片';
  }

  private canManage(conv: { created_by: string | null; my_role: string }, actor: Actor): boolean {
    if (conv.my_role === 'admin') return true;
    if (conv.created_by === actor.userId) return true;
    return isOrgManager(actor);
  }

  private canChangeRoles(conv: ConvRow, actor: Actor, role: string | undefined): boolean {
    return conv.type === 'project' && !conv.dissolved_at && (role === 'admin' || conv.created_by === actor.userId);
  }

  /** POST /conversations —— 私聊成员对复用（dm_key 唯一），群聊必填名称，成员变更写事件与通知 */
  async createConversation(actor: Actor, input: { type: 'dm' | 'project'; member_ids: ID[]; name?: string; team_id?: ID | null }): Promise<Json> {
    return this.createConversationRecord(actor, input);
  }

  private createConversationRecord(actor: Actor, input: { type: 'dm' | 'project'; member_ids: ID[]; name?: string; team_id?: ID | null }): Json {
    const d = getDb();
    const type: 'dm' | 'project' = input.type === 'project' ? 'project' : 'dm';
    const ids = Array.from(new Set([actor.userId, ...(input.member_ids ?? [])].map((s) => String(s).trim()).filter(Boolean)));
    if (type === 'dm' && ids.length < 2) {
      throw AppError.validation('私聊至少需要两名成员', { member_ids: '请选择至少一名对方成员' });
    }
    if (ids.length > 60) throw AppError.validation('会话成员不能超过 60 人', { member_ids: '成员过多' });
    this.assertOrgMembers(actor.orgId, ids);
    let name: string | null = null;
    if (type === 'project') {
      name = sanitizeName(input.name ?? '');
      if (!name || name === '未命名') throw AppError.validation('项目群必须填写名称', { name: '请输入群名称' });
    }
    if (input.team_id && !d.get('SELECT 1 AS x FROM teams WHERE id=? AND organization_id=?', input.team_id, actor.orgId)) {
      throw AppError.validation('关联团队不存在或不属于本组织', { team_id: '团队无效' });
    }
    const dmKey = type === 'dm' ? [...ids].sort().join(':') : null;
    const now = nowIso();

    const result = d.tx((): { conv: ConvRow; reused: boolean; added: ID[] } => {
      if (dmKey) {
        const existing = d.get<ConvRow>(
          "SELECT * FROM conversations WHERE organization_id=? AND type='dm' AND dm_key=?", actor.orgId, dmKey);
        if (existing) {
          const added: ID[] = [];
          for (const uid of ids) {
            const row = d.get<{ left_at: string | null }>(
              'SELECT left_at FROM conversation_members WHERE conversation_id=? AND user_id=?', existing.id, uid);
            if (!row) {
              d.run('INSERT INTO conversation_members(conversation_id,user_id,organization_id,role,joined_at) VALUES(?,?,?,?,?)',
                existing.id, uid, actor.orgId, uid === existing.created_by ? 'admin' : 'member', now);
              added.push(uid);
            } else if (row.left_at) {
              d.run('UPDATE conversation_members SET left_at=NULL, joined_at=? WHERE conversation_id=? AND user_id=?',
                now, existing.id, uid);
              added.push(uid);
            }
          }
          if (added.length) this.emitConversationEvent(actor, existing, 'members_added', added);
          return { conv: existing, reused: true, added };
        }
      }
      const id = uuid();
      const createdBy = type === 'project' ? actor.userId : null;
      d.run(`INSERT INTO conversations(id,organization_id,type,name,team_id,dm_key,created_by,last_message_at,status,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,NULL,'active',?,?)`,
        id, actor.orgId, type, name, input.team_id ?? null, dmKey, createdBy, now, now);
      for (const uid of ids) {
        d.run('INSERT INTO conversation_members(conversation_id,user_id,organization_id,role,joined_at) VALUES(?,?,?,?,?)',
          id, uid, actor.orgId, uid === createdBy ? 'admin' : 'member', now);
      }
      const created = d.get<ConvRow>('SELECT * FROM conversations WHERE id=?', id)!;
      this.emitConversationEvent(actor, created, 'created', ids);
      return { conv: created, reused: false, added: ids.filter((u) => u !== actor.userId) };
    });

    const conv = result.conv;
    const members = this.memberRows(conv.id);
    const shown = this.displayName(actor, conv, members);
    for (const uid of result.added) {
      if (uid === actor.userId) continue;
      pushNotificationSync({
        user_id: uid, organization_id: actor.orgId, type: 'conversation_added',
        title: `你被加入会话「${shown}」`, body: '打开 Message 可查看成员与最近消息。',
        entity_type: 'conversation', entity_id: conv.id, actor_id: actor.userId,
        conversation_id: conv.id, target_path: `/message?c=${conv.id}`,
      });
    }
    return { ...this.conversationDto(actor, conv, shown, members), reused: result.reused };
  }

  private emitConversationEvent(actor: Actor, conv: ConvRow, reason: string, affected: ID[]): void {
    const memberIds = this.memberRows(conv.id).map((m) => m.user_id);
    const ev = appendEvent({
      type: 'conversation.updated', organization_id: conv.organization_id, entity_type: 'conversation',
      entity_id: conv.id, actor_id: actor.userId, conversation_id: conv.id,
      payload: { reason, affected_user_ids: affected, member_count: memberIds.length },
    });
    queueOutbox(memberIds.map((uid) => ({ user_id: uid, channel: 'ws', payload: { conversation_id: conv.id } })), Number(ev.seq));
  }

  /** PATCH /conversations/:id —— 仅项目群改名与归档 */
  async updateConversation(actor: Actor, conversation_id: ID, input: { name?: string; status?: 'active' | 'archived' }): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversationRow(actor, conversation_id);
    this.assertManageable(actor, conv);
    if (input.name === undefined && input.status === undefined) throw AppError.validation('没有需要变更的字段');
    let name = conv.name;
    if (input.name !== undefined) {
      if (conv.type !== 'project') throw AppError.validation('私聊名称由成员派生，不支持改名', { name: '仅项目群可改名' });
      name = sanitizeName(input.name);
      if (!name || name === '未命名') throw AppError.validation('项目群必须填写名称', { name: '请输入群名称' });
    }
    const status = input.status ?? conv.status;
    const now = nowIso();
    d.run('UPDATE conversations SET name=?, status=?, updated_at=? WHERE id=?', name, status, now, conv.id);
    const next = { ...conv, name, status, updated_at: now };
    this.emitConversationEvent(actor, next, input.name !== undefined ? 'renamed' : 'status_changed', []);
    const members = this.memberRows(conv.id);
    return this.conversationDto(actor, next, this.displayName(actor, next, members), members);
  }

  async dissolveConversation(actor: Actor, conversationId: ID): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversation(actor, conversationId);
    if (conv.type !== 'project' || conv.created_by !== actor.userId) {
      throw AppError.forbidden('只有群聊创建者可以解散群聊');
    }
    if (conv.dissolved_at) return { id: conv.id, dissolved_at: conv.dissolved_at };
    const dissolvedAt = nowIso();
    d.tx(() => {
      d.run('UPDATE conversations SET dissolved_at=?, updated_at=? WHERE id=?', dissolvedAt, dissolvedAt, conv.id);
      this.emitConversationEvent(actor, conv, 'dissolved', []);
    });
    return { id: conv.id, dissolved_at: dissolvedAt };
  }

  /** GET /conversations/:id/members —— 成员与管理员 */
  async members(actor: Actor, conversation_id: ID): Promise<Json[]> {
    const conv = this.mustConversation(actor, conversation_id);
    const rows = this.memberRows(conv.id);
    return rows.map((m) => ({
      user_id: m.user_id, display_name: m.display_name, title: m.title, role: m.role,
      role_label: m.role === 'admin' ? '管理员' : '成员',
      is_creator: conv.created_by === m.user_id,
      joined_at: m.joined_at,
      account_status: m.account_status,
      active: m.account_status === 'active',
      teams: this.userTeamNames(m.user_id, conv.organization_id),
      last_read_at: m.last_read_at,
    }));
  }

  /** 会话详情面板：成员与管理员 + 共享文件 + 关联 Task */
  async detail(actor: Actor, conversation_id: ID): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversation(actor, conversation_id);
    const members = this.memberRows(conv.id, true);
    const mine = members.find((m) => m.user_id === actor.userId);
    const settings = this.viewerSettings(actor, conv.id);
    const cutoff = settings.history_cutoff;
    const lastRead = mine?.last_read_at ?? null;
    const unread = Number(d.val<number>(
      lastRead
        ? `SELECT COUNT(*) FROM messages m WHERE m.conversation_id=? AND m.history_seq>? AND m.sender_id<>? AND m.retracted_at IS NULL AND m.created_at>?`
        : `SELECT COUNT(*) FROM messages m WHERE m.conversation_id=? AND m.history_seq>? AND m.sender_id<>? AND m.retracted_at IS NULL`,
      conv.id, cutoff, actor.userId, ...(lastRead ? [lastRead] : [])) ?? 0);
    const atMe = Number(d.val<number>(
      `SELECT COUNT(*) FROM messages m WHERE m.conversation_id=? AND m.history_seq>? AND m.sender_id<>? AND m.retracted_at IS NULL
       AND m.mentions LIKE ? AND (? IS NULL OR m.created_at>?)`,
      conv.id, cutoff, actor.userId, `%"${actor.userId}"%`, lastRead, lastRead) ?? 0);
    return {
      conversation: this.conversationDto(actor, conv, this.displayName(actor, conv, members), members.map((member) => member === mine ? { ...member, ...settings } : member),
        { unread, at_me: atMe }),
      member_rows: members.map(({ prefs, ...member }) => ({
        ...member,
        avatar: j<Record<string, unknown>>(prefs ?? '{}', {}).avatar,
        is_creator: conv.type === 'project' && conv.created_by === member.user_id,
      })),
      admins: members.filter((m) => m.role === 'admin').map((m) => ({ user_id: m.user_id, display_name: m.display_name })),
      shared_files: this.sharedFiles(actor, conv, cutoff),
      tasks: await this.relatedTasks(actor, conv, cutoff),
      can_manage: this.canManage({ created_by: conv.created_by ?? null, my_role: mine?.role ?? 'member' }, actor),
      can_change_roles: this.canChangeRoles(conv, actor, mine?.role),
      unread_count: Math.max(unread, settings.manual_unread),
      unread_label: Math.max(unread, settings.manual_unread) > 0 ? `未读 ${Math.max(unread, settings.manual_unread)} 条` : '无未读',
    };
  }

  /** 共享文件：从 messages.attachments 聚合；无读取权的条目不出现（不泄漏标题与计数） */
  private sharedFiles(actor: Actor, conv: ConvRow, cutoff: number): Json[] {
    const d = getDb();
    const rows = d.all<{ attachments: string; created_at: string; sender_name: string; message_id: string }>(
      `SELECT m.attachments, m.created_at, m.id AS message_id, u.display_name AS sender_name
       FROM messages m JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=? AND m.history_seq>? AND m.retracted_at IS NULL ORDER BY m.created_at`, conv.id, cutoff);
    const byVersion = new Map<string, Json>();
    for (const r of rows) {
      for (const a of j<Attachment[]>(r.attachments, [])) {
        if (!a.file_id) continue;
        const f = d.get<{ id: string; name: string; mime: string; size: number; organization_id: string; current_version_id: string | null }>(
          'SELECT id,name,mime,size,organization_id,current_version_id FROM files WHERE id=?', a.file_id);
        if (!f || f.organization_id !== conv.organization_id) continue;
        if (!fileAllows(actor, f.id)) continue;
        const versionId = a.version_id ?? f.current_version_id ?? '';
        if (!versionId) continue;
        const versionNo = d.val<number>('SELECT version_no FROM file_versions WHERE id=?', versionId) ?? null;
        byVersion.set(versionId, {
          file_id: f.id, version_id: versionId, name: f.name, mime: f.mime, size: Number(f.size ?? 0),
          version_no: versionNo, current: !f.current_version_id || f.current_version_id === versionId,
          shared_by: r.sender_name, shared_at: r.created_at, message_id: r.message_id, access: 'granted',
        });
      }
    }
    return Array.from(byVersion.values());
  }

  /** 关联 Task：tasks 模块未装配返回空数组；不可见任务不返回标题 */
  private async relatedTasks(actor: Actor, conv: ConvRow, cutoff: number): Promise<Json[]> {
    if (!services.tasks) return [];
    const d = getDb();
    const cardIds = d.all<{ card_id: string }>(
      "SELECT card_id FROM messages WHERE conversation_id=? AND history_seq>? AND card_type='task' AND card_id IS NOT NULL AND retracted_at IS NULL",
      conv.id, cutoff).map((r) => r.card_id);
    const sql = `SELECT id,title,status,creator_id,assignee_id,reviewer_id,team_id,source,created_at FROM tasks
       WHERE organization_id=? AND source_ref LIKE ? ORDER BY created_at DESC LIMIT 50`;
    const fromSource = d.all<TaskRow>(sql, conv.organization_id, `%"conversation_id":"${conv.id}"%`);
    const fromCards: TaskRow[] = cardIds.length
      ? d.all<TaskRow>(
        `SELECT id,title,status,creator_id,assignee_id,reviewer_id,team_id,source,created_at FROM tasks
         WHERE organization_id=? AND id IN (${inClause(cardIds.length)})`, conv.organization_id, ...cardIds)
      : [];
    const seen = new Set<string>();
    const out: Json[] = [];
    for (const t of [...fromSource, ...fromCards]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const visible = this.taskVisible(actor, t);
      out.push({
        id: t.id, status: t.status, source: t.source, created_at: t.created_at,
        access: visible ? 'granted' : 'requestable',
        title: visible ? t.title : null,
        permission_note: visible ? '任务参与者可见' : '你不在该任务的可见范围内，可发起访问申请',
      });
    }
    return out;
  }

  // ---------- 成员增删（增减管理员与普通成员、退出会话） ----------

  /** 契约入口（void）；控制器需要回执时用 addMembersWithRole */
  async addMembers(actor: Actor, conversation_id: ID, user_ids: ID[]): Promise<void> {
    await this.addMembersWithRole(actor, conversation_id, user_ids, 'member');
  }

  async addMembersWithRole(actor: Actor, conversation_id: ID, user_ids: ID[], role: 'admin' | 'member' = 'member'): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversationRow(actor, conversation_id);
    this.assertManageable(actor, conv);
    const ids = Array.from(new Set((user_ids ?? []).map((s) => String(s).trim()).filter(Boolean)));
    if (!ids.length) throw AppError.validation('请选择要添加的成员', { user_ids: '必填' });
    if (!['admin', 'member'].includes(role)) throw AppError.validation('会话角色只能是 admin 或 member');
    this.assertOrgMembers(conv.organization_id, ids);
    const now = nowIso();
    const added: ID[] = [];
    d.tx(() => {
      for (const uid of ids) {
        const row = d.get<{ left_at: string | null }>(
          'SELECT left_at FROM conversation_members WHERE conversation_id=? AND user_id=?', conv.id, uid);
        if (!row) {
          d.run('INSERT INTO conversation_members(conversation_id,user_id,organization_id,role,joined_at) VALUES(?,?,?,?,?)',
            conv.id, uid, conv.organization_id, role, now);
          added.push(uid);
        } else if (row.left_at) {
          d.run('UPDATE conversation_members SET left_at=NULL, joined_at=?, role=? WHERE conversation_id=? AND user_id=?',
            now, role, conv.id, uid);
          added.push(uid);
        }
      }
      d.run('UPDATE conversations SET updated_at=? WHERE id=?', now, conv.id);
      this.emitConversationEvent(actor, conv, 'members_added', added);
    });
    const shown = this.displayName(actor, conv, this.memberRows(conv.id));
    for (const uid of added) {
      if (uid === actor.userId) continue;
      pushNotificationSync({
        user_id: uid, organization_id: conv.organization_id, type: 'conversation_added',
        title: `你被加入会话「${shown}」`, entity_type: 'conversation', entity_id: conv.id,
        actor_id: actor.userId, conversation_id: conv.id, target_path: `/message?c=${conv.id}`,
      });
    }
    return { added, member_count: this.memberRows(conv.id).length, message: `已添加 ${added.length} 名成员` };
  }

  /** 契约入口（void）；控制器需要 left_at 与提示文案时用 removeMemberAndReport */
  async removeMember(actor: Actor, conversation_id: ID, user_id: ID): Promise<void> {
    await this.removeMemberAndReport(actor, conversation_id, user_id);
  }

  /** 移除成员；user_id 为本人即退出会话（退出后不再接收新消息） */
  async removeMemberAndReport(actor: Actor, conversation_id: ID, user_id: ID): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversationRow(actor, conversation_id);
    const leaving = user_id === actor.userId;
    if (!leaving) this.assertManageable(actor, conv);
    if (!leaving && conv.created_by === user_id) throw AppError.forbidden('不能把会话创建者移出会话，请先归档会话');
    const row = d.get<{ left_at: string | null }>(
      'SELECT left_at FROM conversation_members WHERE conversation_id=? AND user_id=?', conv.id, user_id);
    if (!row) throw AppError.notFound('该用户不在此会话中');
    if (row.left_at) return { ok: true, already: true, message: '该成员已不在此会话中' };
    const shown = this.displayName(actor, conv, this.memberRows(conv.id));
    const now = nowIso();
    d.tx(() => {
      d.run('UPDATE conversation_members SET left_at=? WHERE conversation_id=? AND user_id=?', now, conv.id, user_id);
      d.run('UPDATE conversations SET updated_at=? WHERE id=?', now, conv.id);
      this.emitConversationEvent(actor, conv, leaving ? 'member_left' : 'member_removed', [user_id]);
    });
    if (!leaving) {
      pushNotificationSync({
        user_id, organization_id: conv.organization_id, type: 'conversation_removed',
        title: `你已被移出会话「${shown}」`, body: '移出后不再接收该会话的新消息。',
        entity_type: 'conversation', entity_id: conv.id, actor_id: actor.userId,
        conversation_id: conv.id, target_path: '/message',
      });
    }
    return {
      ok: true, user_id, left_at: now,
      message: leaving ? '你已退出该会话，不再接收新消息' : '成员已移出会话',
    };
  }

  async leave(actor: Actor, conversation_id: ID): Promise<Json> {
    return this.removeMemberAndReport(actor, conversation_id, actor.userId);
  }

  async setMemberRole(actor: Actor, conversation_id: ID, user_id: ID, role: 'admin' | 'member'): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversationRow(actor, conversation_id);
    const mine = d.get<{ role: string }>(
      'SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL',
      conv.id, actor.userId);
    if (!mine) throw AppError.notFound('会话不存在或你不是成员');
    if (!['admin', 'member'].includes(role)) throw AppError.validation('会话角色只能是 admin 或 member');
    if (conv.type === 'dm') throw AppError.validation('私聊没有管理员概念', { role: '仅项目群可设置管理员' });
    if (!this.canChangeRoles(conv, actor, mine.role)) throw AppError.forbidden('只有群聊创建者和管理员可以修改成员权限');
    if (conv.created_by === user_id) throw AppError.forbidden('群聊创建者的角色不可修改');
    if (actor.userId === user_id) throw AppError.forbidden('不能修改自己的群聊权限');
    const row = d.get<{ left_at: string | null; role: string }>(
      'SELECT left_at, role FROM conversation_members WHERE conversation_id=? AND user_id=?', conv.id, user_id);
    if (!row || row.left_at) throw AppError.notFound('该用户不在此会话中');
    if (row.role === role) return { ok: true, user_id, role };
    const now = nowIso();
    d.run('UPDATE conversation_members SET role=? WHERE conversation_id=? AND user_id=?', role, conv.id, user_id);
    d.run('UPDATE conversations SET updated_at=? WHERE id=?', now, conv.id);
    this.emitConversationEvent(actor, conv, 'role_changed', [user_id]);
    pushNotificationSync({
      user_id, organization_id: conv.organization_id, type: 'conversation_role_changed',
      title: role === 'admin' ? '你已成为会话管理员' : '你的会话管理员身份已取消',
      entity_type: 'conversation', entity_id: conv.id, actor_id: actor.userId,
      conversation_id: conv.id, target_path: `/message?c=${conv.id}`,
    });
    return { ok: true, user_id, role, message: role === 'admin' ? '已设为管理员' : '已取消管理员' };
  }

  // ==================== 消息 ====================

  /** GET /conversations/:id/messages?before=&limit=&around= —— cursor 分页 + 回跳定位窗口 */
  async messages(actor: Actor, conversation_id: ID,
                 opts?: { before?: string; limit?: number; around?: ID }): Promise<
    { items: Json[]; has_more: boolean; next_cursor: string | null; mode: string;
      anchor_index?: number; has_more_before?: boolean; has_more_after?: boolean }> {
    const d = getDb();
    const conv = this.mustConversation(actor, conversation_id);
    const limit = clampNum(opts?.limit ?? PAGE_DEFAULT, 1, PAGE_MAX, PAGE_DEFAULT);
    const cutoff = this.viewerSettings(actor, conv.id).history_cutoff;

    if (opts?.around) {
      const anchor = d.get<MsgRow>('SELECT * FROM messages WHERE id=? AND conversation_id=? AND history_seq>?', opts.around, conv.id, cutoff);
      if (!anchor) throw AppError.notFound('目标消息不存在或不可见');
      const half = Math.max(1, Math.ceil(limit / 2));
      const after = d.all<MsgRow>(
        `SELECT * FROM messages WHERE conversation_id=? AND history_seq>? AND (created_at>? OR (created_at=? AND id>=?))
         ORDER BY created_at,id LIMIT ?`, conv.id, cutoff, anchor.created_at, anchor.created_at, anchor.id, half + 1).slice(0, half);
      const before = d.all<MsgRow>(
        `SELECT * FROM messages WHERE conversation_id=? AND history_seq>? AND (created_at<? OR (created_at=? AND id<?))
         ORDER BY created_at DESC,id DESC LIMIT ?`, conv.id, cutoff, anchor.created_at, anchor.created_at, anchor.id, half).reverse();
      const rows = [...before, ...after];
      const items = this.dtos(actor, conv.id, rows);
      const tail = after[after.length - 1];
      const hasMoreAfter = tail
        ? Number(d.val<number>(
          `SELECT COUNT(*) FROM messages WHERE conversation_id=? AND history_seq>? AND (created_at>? OR (created_at=? AND id>?))`,
          conv.id, cutoff, tail.created_at, tail.created_at, tail.id) ?? 0) > 0
        : false;
      return {
        items, has_more: false, next_cursor: null, mode: 'around',
        anchor_index: items.findIndex((i) => String(i.id ?? '') === anchor.id),
        has_more_before: before.length === half,
        has_more_after: hasMoreAfter,
      };
    }

    const cur = decodeCursor(opts?.before);
    const rows: MsgRow[] = cur
      ? d.all<MsgRow>(
        `SELECT * FROM messages WHERE conversation_id=? AND history_seq>? AND (created_at<? OR (created_at=? AND id<?))
         ORDER BY created_at DESC,id DESC LIMIT ?`, conv.id, cutoff, cur.created_at, cur.created_at, cur.id, limit + 1)
      : d.all<MsgRow>('SELECT * FROM messages WHERE conversation_id=? AND history_seq>? ORDER BY created_at DESC,id DESC LIMIT ?',
        conv.id, cutoff, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const items = this.dtos(actor, conv.id, page);
    const oldest = page[0];
    return {
      items, has_more: hasMore, mode: 'page',
      next_cursor: oldest && hasMore ? encodeCursor(oldest.created_at, oldest.id) : null,
    };
  }

  private dtos(actor: Actor, conversationId: ID, rows: MsgRow[]): Json[] {
    if (!rows.length) return [];
    const d = getDb();
    const members = this.memberRows(conversationId);
    const names = new Map<string, string>();
    for (const m of members) names.set(m.user_id, m.display_name);
    for (const r of rows) if (!names.has(r.sender_id)) names.set(r.sender_id, '已离开成员');
    const parentIds = Array.from(new Set(rows.map((r) => r.parent_id).filter((v): v is string => !!v)));
    const parents = new Map<string, ParentRow>();
    if (parentIds.length) {
      for (const p of d.all<ParentRow>(
        `SELECT m.id, m.body, m.retracted_at, m.created_at, u.display_name
         FROM messages m JOIN users u ON u.id=m.sender_id
         WHERE m.conversation_id=? AND m.history_seq>? AND m.id IN (${inClause(parentIds.length)})`,
        conversationId, this.viewerSettings(actor, conversationId).history_cutoff, ...parentIds)) {
        parents.set(p.id, p);
      }
    }
    return rows.map((r) => this.dto(actor, r, names, parents));
  }

  private dto(actor: Actor, m: MsgRow, names: Map<string, string>, parents: Map<string, ParentRow>): Json {
    const retracted = !!m.retracted_at;
    const mentionIds = j<ID[]>(m.mentions, []);
    const versions = j<unknown[]>(m.edited_versions, []);
    const parent = m.parent_id ? parents.get(m.parent_id) : undefined;
    // 原文被删除或已撤回 → 只回不可用标记，绝不回摘录（§05 回复条）
    const parentSummary = !m.parent_id
      ? null
      : !parent
        ? { parent_unavailable: true, reason: 'deleted_or_forbidden', message: '原消息已删除或不可见' }
        : parent.retracted_at
          ? { parent_unavailable: true, reason: 'retracted', message: '原消息已撤回，不显示摘录' }
          : {
            parent_unavailable: false, id: parent.id, sender_name: parent.display_name, created_at: parent.created_at,
            excerpt: oneLine(parent.body).slice(0, SUMMARY_CHARS) || '（附件或卡片消息）',
          };
    return {
      id: m.id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      sender_name: names.get(m.sender_id) ?? m.sender_name ?? '未知成员',
      created_at: m.created_at,
      body: retracted ? '' : m.body,
      retracted,
      retracted_at: m.retracted_at,
      retracted_label: retracted ? '已撤回' : null,
      edited: !!m.edited_at,
      edited_at: m.edited_at,
      edited_label: m.edited_at ? '已编辑' : null,
      audit_version_count: versions.length,
      mentions: retracted ? [] : mentionIds.map((u) => ({ user_id: u, display_name: names.get(u) ?? '已离开成员' })),
      attachments: retracted ? [] : j<Attachment[]>(m.attachments, []),
      client_msg_id: m.client_msg_id,
      // parent_id 必须一起回：前端「这条是回复谁」的渲染条件是 parent_id 存在，
      // 之前 DTO 只回了 parent 摘要却没回 parent_id，于是回复发出去也显示不出引用块（本轮需求 3 的根因）。
      parent_id: m.parent_id,
      parent: parentSummary,
      card_type: retracted ? null : m.card_type,
      card: retracted ? null : this.cardOf(actor, m),
      actions: {
        copy: !retracted && !!oneLine(m.body),
        edit: !retracted && m.sender_id === actor.userId,
        retract: !retracted && m.sender_id === actor.userId,
        reply: true,
        create_task: !retracted && !!oneLine(m.body),
        agent_handoff: !retracted,
      },
    };
  }

  /** 卡片解析：无访问权不返回标题与摘要，只给可发起申请的说明（§05 / C20） */
  private cardOf(actor: Actor, m: MsgRow): Json | null {
    if (!m.card_type || !m.card_id) return null;
    const d = getDb();
    const base: Json = { card_type: m.card_type, card_id: m.card_id, auto_granted: false };
    if (m.card_type === 'task') {
      const t = d.get<TaskRow & { organization_id: string }>(
        'SELECT id,title,status,creator_id,assignee_id,reviewer_id,team_id,source,created_at,organization_id FROM tasks WHERE id=?',
        m.card_id);
      if (!t || t.organization_id !== m.organization_id) {
        return { ...base, title: null, access: 'unavailable', permission_note: '关联任务已不可见' };
      }
      if (!this.taskVisible(actor, t)) {
        return { ...base, title: null, access: 'requestable', permission_note: '发卡片不自动授权，可发起访问申请' };
      }
      return {
        ...base, title: t.title, access: 'granted', status: t.status, permission_note: '任务参与者可见',
        target_path: `/task?id=${t.id}`,
      };
    }
    if (m.card_type === 'file_version') {
      const v = d.get<{ id: string; file_id: string; version_no: number; organization_id: string; name: string }>(
        `SELECT fv.id, fv.file_id, fv.version_no, f.organization_id, f.name
         FROM file_versions fv JOIN files f ON f.id=fv.file_id WHERE fv.id=?`, m.card_id);
      if (!v || v.organization_id !== m.organization_id) {
        return { ...base, title: null, access: 'unavailable', permission_note: '文件版本已不可见' };
      }
      if (!fileAllows(actor, v.file_id)) {
        return { ...base, title: null, access: 'requestable', permission_note: '发卡片不自动授权，可发起访问申请' };
      }
      return {
        ...base, title: `${v.name} · v${v.version_no}`, file_id: v.file_id, access: 'granted',
        target_path: `/workspace?section=recent&focus=${encodeURIComponent(v.file_id)}`, permission_note: '按文件权限判定',
      };
    }
    const s = d.get<{ id: string; title: string; organization_id: string; mode: string }>(
      'SELECT id,title,organization_id,mode FROM agent_sessions WHERE id=?', m.card_id);
    if (!s || s.organization_id !== m.organization_id) {
      return { ...base, title: null, access: 'unavailable', permission_note: 'Agent 会话已不可见' };
    }
    if (!sessionAccess(actor, s.id)) {
      return { ...base, title: null, access: 'requestable', permission_note: 'Session ID 不是凭据，需所有者分享后才能查看' };
    }
    return {
      ...base, title: s.title, access: 'granted', mode: s.mode,
      target_path: s.mode === 'team' ? `/agent/team?s=${s.id}` : `/agent/personal?s=${s.id}`,
      permission_note: s.mode === 'team' ? '进入 Team 需具备会话参与权' : '查看 Personal 仅只读',
    };
  }

  private taskVisible(actor: Actor, t: { creator_id: string; assignee_id: string | null; reviewer_id: string | null; team_id: string | null }): boolean {
    if ([t.creator_id, t.assignee_id, t.reviewer_id].includes(actor.userId)) return true;
    if (t.team_id && userTeams(actor.userId, actor.orgId).includes(t.team_id)) return true;
    return false;
  }

  /** POST /conversations/:id/messages —— 文本 + 附件（先校验权限）+ @ + 回复 + client_msg_id 去重 */
  async send(actor: Actor, input: SendMessageInput): Promise<Json> {
    return this.sendMessage(actor, input);
  }

  private sendMessage(actor: Actor, input: SendMessageInput): Json {
    const d = getDb();
    const conv = this.mustConversation(actor, input.conversation_id);
    if (conv.dissolved_at) throw AppError.forbidden('该群聊已解散，无法再发送消息');
    const body = String(input.body ?? '').replace(/\r\n/g, '\n').slice(0, MAX_BODY);
    const trimmed = body.trim();
    const rawAtts = input.attachments ?? [];
    const echo = {
      body: input.body ?? '', parent_id: input.parent_id ?? null, mentions: input.mentions ?? [],
      attachments: rawAtts, client_msg_id: input.client_msg_id ?? null,
    };
    if (input.card_type && !CARD_TYPES.includes(input.card_type as CardType)) {
      throw new AppError('VALIDATION', '卡片类型只支持 task / file_version / session', 400,
        { card_type: '不支持的卡片类型' }, { echo, retryable: false });
    }
    if (!trimmed && !rawAtts.length && !input.card_type) {
      throw new AppError('VALIDATION', '消息内容为空，请输入文字或添加附件', 400,
        { body: '消息内容为空' }, { echo, retryable: true });
    }
    if ((input.body ?? '').length > MAX_BODY) {
      throw new AppError('VALIDATION', `消息过长，单条上限 ${MAX_BODY} 字`, 400,
        { body: '消息过长' }, { echo, retryable: true });
    }

    // 发送中防重复：同会话同 client_msg_id 直接返回首次那条
    if (input.client_msg_id) {
      const dup = d.get<MsgRow & { history_seq: number }>('SELECT * FROM messages WHERE conversation_id=? AND client_msg_id=?', conv.id, input.client_msg_id);
      if (dup) {
        if (dup.history_seq <= this.viewerSettings(actor, conv.id).history_cutoff) return { deduplicated: true };
        const out = this.dtos(actor, conv.id, [dup]);
        return { ...out[0], deduplicated: true, message: '该消息已发送，返回首次结果' };
      }
    }

    const cutoff = this.viewerSettings(actor, conv.id).history_cutoff;
    const attachments = rawAtts.map((a) => this.resolveAttachment(actor, conv, a, echo));
    const members = this.memberRows(conv.id);
    const memberIds = members.map((m) => m.user_id);
    const mutedIds = new Set(d.all<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id=? AND muted=1', conv.id).map((member) => member.user_id));
    const mentions = Array.from(new Set((input.mentions ?? []).map((s) => String(s).trim()).filter(Boolean)));
    const badMention = mentions.filter((u) => !memberIds.includes(u));
    if (badMention.length) {
      throw new AppError('VALIDATION', '被 @ 的成员不在该会话中', 400,
        { mentions: '有成员不在会话中，请重新选择' }, { echo, retryable: true });
    }
    let parent: MsgRow | undefined;
    if (input.parent_id) {
      parent = d.get<MsgRow>('SELECT * FROM messages WHERE id=? AND conversation_id=? AND history_seq>?', input.parent_id, conv.id, cutoff);
      if (!parent) {
        throw new AppError('VALIDATION', '被回复的消息不存在或不可见', 400,
          { parent_id: '原消息已失效' }, { echo, retryable: true });
      }
    }
    if (input.card_type) this.assertCardVisible(actor, conv, input.card_type, input.card_id ?? '', echo);

    const id = uuid();
    const now = nowIso();
    const mentionTargets = mentions.filter((u) => u !== actor.userId && !mutedIds.has(u));
    const replyTarget = parent && parent.sender_id !== actor.userId && !mutedIds.has(parent.sender_id) && !mentionTargets.includes(parent.sender_id)
      ? parent.sender_id : null;
    const shown = this.displayName(actor, conv, members);

    d.tx(() => {
      d.run(`INSERT INTO messages(id,organization_id,conversation_id,sender_id,body,parent_id,mentions,attachments,
               card_type,card_id,client_msg_id,edited_versions,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, conv.organization_id, conv.id, actor.userId, trimmed ? body : '', parent?.id ?? null,
        S(mentions), S(attachments), input.card_type ?? null, input.card_id ?? null,
        input.client_msg_id ?? null, S([]), now);
      d.run('UPDATE conversation_members SET hidden=0 WHERE conversation_id=? AND hidden=1 AND left_at IS NULL', conv.id);
      // 正文检索索引：中文二元组（§15 / D2）
      if (trimmed) {
        d.run('INSERT INTO message_text_fts(tokens,message_id,conversation_id,organization_id) VALUES(?,?,?,?)',
          tokensToIndex(body), id, conv.id, conv.organization_id);
      }
      d.run('UPDATE conversations SET last_message_at=?, updated_at=? WHERE id=?', now, now, conv.id);
      const ev = appendEvent({
        type: 'message.created', organization_id: conv.organization_id, entity_type: 'conversation',
        entity_id: conv.id, actor_id: actor.userId, conversation_id: conv.id,
        // 载荷只含定位与摘要所需字段，不含正文
        payload: {
          message_id: id, conversation_id: conv.id, sender_id: actor.userId,
          kind: input.card_type ? 'card' : attachments.length ? 'attachment' : 'text',
          char_count: trimmed.length, attachment_count: attachments.length, mention_count: mentions.length,
          reply_to: parent?.id ?? null, card_type: input.card_type ?? null, card_id: input.card_id ?? null,
        },
      });
      queueOutbox(memberIds.map((uid) => ({ user_id: uid, channel: 'ws', payload: { conversation_id: conv.id } })), Number(ev.seq));
      for (const uid of mentionTargets) {
        pushNotificationSync({
          user_id: uid, organization_id: conv.organization_id, type: 'mention',
          title: `你在会话「${shown}」中被提到了`, body: '打开会话可查看上下文。',
          entity_type: 'message', entity_id: id, actor_id: actor.userId, conversation_id: conv.id,
          target_path: `/message?c=${conv.id}&m=${id}`,
        });
      }
      if (replyTarget) {
        pushNotificationSync({
          user_id: replyTarget, organization_id: conv.organization_id, type: 'reply',
          title: `有人在会话「${shown}」中回复了你`, body: '点击可回跳原消息。',
          entity_type: 'message', entity_id: id, actor_id: actor.userId, conversation_id: conv.id,
          target_path: `/message?c=${conv.id}&m=${id}`,
        });
      }
    });

    const created = d.get<MsgRow>('SELECT * FROM messages WHERE id=?', id)!;
    const out = this.dtos(actor, conv.id, [created]);
    return { ...out[0], deduplicated: false };
  }

  private resolveAttachment(actor: Actor, conv: ConvRow, a: { file_id: ID; version_id?: ID | null }, echo: Json): Attachment {
    const d = getDb();
    const f = d.get<{ id: string; name: string; mime: string; size: number; organization_id: string; current_version_id: string | null }>(
      'SELECT id,name,mime,size,organization_id,current_version_id FROM files WHERE id=?', a.file_id);
    if (!f || f.organization_id !== conv.organization_id) {
      throw new AppError('NOT_FOUND', '附件不存在或不可见', 404, { attachments: '附件无效' }, { echo, retryable: true });
    }
    if (!fileAllows(actor, f.id)) {
      // 不泄漏文件名（C20）：只说明权限不足
      throw new AppError('FORBIDDEN',
        '你没有该附件的读取权限，不能发送。请先在「文档」页获得授权，或让文件所有者发起分享。', 403,
        { attachments: '附件权限不足' }, { file_id: f.id, echo, retryable: true });
    }
    const versionId = a.version_id ?? f.current_version_id ?? null;
    if (versionId) {
      const v = d.get<{ id: string; file_id: string }>('SELECT id,file_id FROM file_versions WHERE id=?', versionId);
      if (!v || v.file_id !== f.id) {
        throw new AppError('VALIDATION', '附件版本与文件不匹配', 400, { attachments: '附件版本无效' }, { echo, retryable: true });
      }
    }
    return { file_id: f.id, version_id: versionId, name: f.name, mime: f.mime, size: Number(f.size ?? 0) };
  }

  /** 发卡片的前置校验：发送者本人必须可见该对象（避免用卡片枚举任意 ID） */
  private assertCardVisible(actor: Actor, conv: ConvRow, cardType: string, cardId: ID, echo: Json): void {
    const d = getDb();
    if (!cardId) throw new AppError('VALIDATION', '缺少卡片对象 ID', 400, { card_id: '必填' }, { echo });
    if (cardType === 'task') {
      const t = d.get<TaskRow & { organization_id: string }>(
        `SELECT id,title,status,creator_id,assignee_id,reviewer_id,team_id,source,created_at,organization_id
         FROM tasks WHERE id=?`, cardId);
      if (!t || t.organization_id !== conv.organization_id) throw AppError.notFound('关联任务不存在或不可见');
      if (!this.taskVisible(actor, t)) throw AppError.forbidden('你不在该任务的可见范围内，不能分享该卡片');
      return;
    }
    if (cardType === 'file_version') {
      const v = d.get<{ file_id: string; organization_id: string }>(
        'SELECT fv.file_id, f.organization_id FROM file_versions fv JOIN files f ON f.id=fv.file_id WHERE fv.id=?', cardId);
      if (!v || v.organization_id !== conv.organization_id) throw AppError.notFound('文件版本不存在或不可见');
      if (!fileAllows(actor, v.file_id)) {
        throw AppError.forbidden('你没有该文件的读取权限，不能分享该卡片');
      }
      return;
    }
    const s = d.get<{ organization_id: string }>('SELECT organization_id FROM agent_sessions WHERE id=?', cardId);
    if (!s || s.organization_id !== conv.organization_id) throw AppError.notFound('会话不存在或不可见');
    if (!sessionAccess(actor, cardId)) throw AppError.forbidden('你不是该 Agent 会话的参与者或被分享者，不能分享该卡片');
  }

  async shareFile(actor: Actor, fileId: ID, input: { conversation_id?: ID; user_id?: ID; client_msg_id: string }): Promise<Json> {
    const files = services.files;
    if (!files) throw AppError.notFound('文档服务不可用');
    const d = getDb();
    return d.tx(() => {
      const conversationId = input.conversation_id ??
        String(this.createConversationRecord(actor, { type: 'dm', member_ids: [input.user_id!] }).id);
      const conv = this.mustConversation(actor, conversationId);
      if (conv.status !== 'active' || conv.dissolved_at) throw AppError.forbidden('该会话无法接收分享');
      const existing = d.get<{ id: string; sender_id: string }>(
        'SELECT id, sender_id FROM messages WHERE conversation_id=? AND client_msg_id=?', conv.id, input.client_msg_id);
      if (existing) {
        if (existing.sender_id !== actor.userId) throw AppError.forbidden('分享请求标识已被使用');
        return { id: existing.id, conversation_id: conv.id };
      }
      const recipients = this.memberRows(conv.id).filter((member) => member.user_id !== actor.userId && member.account_status === 'active');
      if (!recipients.length) throw AppError.validation('会话中没有可接收文件的成员');
      const versionId = files.grantViewForShare(actor, fileId, recipients.map((member) => member.user_id));
      return this.sendMessage(actor, {
        conversation_id: conv.id, body: '', card_type: 'file_version', card_id: versionId, client_msg_id: input.client_msg_id,
      });
    });
  }

  /** POST /conversations/:id/cards —— 卡片只带标题与权限范围说明，不自动授权 */
  async createCard(actor: Actor, conversation_id: ID, input: { card_type: string; card_id: ID; note?: string }): Promise<Json> {
    if (!CARD_TYPES.includes(input.card_type as CardType)) throw AppError.validation('卡片类型不支持', { card_type: '不支持' });
    const note = String(input.note ?? '').slice(0, 2000).trim();
    return this.send(actor, { conversation_id, body: note, card_type: input.card_type, card_id: input.card_id });
  }

  /** POST /conversations/:id/access-requests —— 无权成员发起申请（写入 notifications） */
  async requestAccess(actor: Actor, conversation_id: ID, input: { card_type: string; card_id: ID }): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversation(actor, conversation_id);
    if (!CARD_TYPES.includes(input.card_type as CardType)) throw AppError.validation('卡片类型不支持', { card_type: '不支持' });
    if (!input.card_id) throw AppError.validation('缺少卡片对象 ID', { card_id: '必填' });
    const shown = this.displayName(actor, conv, this.memberRows(conv.id));
    let owner: { user_id: string; name: string } | null = null;
    if (input.card_type === 'task') {
      const t = d.get<{ creator_id: string; display_name: string; organization_id: string; assignee_id: string | null }>(
        `SELECT t.creator_id, t.assignee_id, u.display_name, t.organization_id FROM tasks t JOIN users u ON u.id=t.creator_id
         WHERE t.id=?`, input.card_id);
      if (!t || t.organization_id !== conv.organization_id) throw AppError.notFound('关联任务不存在或不可见');
      owner = { user_id: t.creator_id, name: t.display_name };
    } else if (input.card_type === 'file_version') {
      const f = d.get<{ owner_id: string; display_name: string; organization_id: string; file_id: string }>(
        `SELECT f.owner_id, f.id AS file_id, u.display_name, f.organization_id
         FROM file_versions fv JOIN files f ON f.id=fv.file_id JOIN users u ON u.id=f.owner_id WHERE fv.id=?`,
        input.card_id);
      if (!f || f.organization_id !== conv.organization_id) throw AppError.notFound('文件版本不存在或不可见');
      if (fileAllows(actor, f.file_id)) {
        return { ok: true, already_granted: true, message: '你已具备该文件的访问权限，无需申请' };
      }
      owner = { user_id: f.owner_id ?? '', name: f.display_name };
    } else {
      const s = d.get<{ owner_id: string; display_name: string; organization_id: string }>(
        `SELECT s.owner_id, u.display_name, s.organization_id FROM agent_sessions s JOIN users u ON u.id=s.owner_id
         WHERE s.id=?`, input.card_id);
      if (!s || s.organization_id !== conv.organization_id) throw AppError.notFound('会话不存在或不可见');
      if (sessionAccess(actor, input.card_id)) return { ok: true, already_granted: true, message: '你已可查看该会话，无需申请' };
      owner = { user_id: s.owner_id, name: s.display_name };
    }
    if (!owner.user_id) throw AppError.notFound('该对象没有可受理申请的所有者，请联系组织管理员');
    if (owner.user_id === actor.userId) return { ok: true, self: true, message: '这是你自己创建的对象，无需申请' };
    const recent = d.get<{ id: string }>(
      `SELECT id FROM notifications WHERE user_id=? AND type='access_request' AND entity_id=? AND actor_id=? AND created_at>? LIMIT 1`,
      owner.user_id, input.card_id, actor.userId, new Date(Date.now() - 10 * 60000).toISOString());
    if (recent) return { ok: true, duplicated: true, message: '10 分钟内已提交过相同的访问申请' };
    pushNotificationSync({
      user_id: owner.user_id, organization_id: conv.organization_id, type: 'access_request',
      title: `${actor.displayName} 申请访问你在会话「${shown}」中分享的内容`,
      body: '请在「文档」页或会话分享面板中授权；发卡片本身不构成授权。',
      entity_type: input.card_type === 'file_version' ? 'file' : input.card_type, entity_id: input.card_id,
      actor_id: actor.userId, conversation_id: conv.id, target_path: `/message?c=${conv.id}`,
    });
    return { ok: true, requested_to: owner.name, message: '访问申请已发送给内容所有者' };
  }

  /** PATCH /messages/:id —— 仅本人；body 变化时旧内容进审计版本，返回「已编辑」标记 */
  async edit(actor: Actor, input: { message_id: ID; body: string }): Promise<Json> {
    const d = getDb();
    const m = this.mustMessage(actor, input.message_id);
    if (this.mustConversationRow(actor, m.conversation_id).dissolved_at) throw AppError.forbidden('已解散的群聊只能查看历史消息');
    if (m.retracted_at) throw AppError.forbidden('已撤回的消息不能编辑');
    if (m.sender_id !== actor.userId) throw AppError.forbidden('只能编辑自己发送的消息');
    const next = String(input.body ?? '').replace(/\r\n/g, '\n').slice(0, MAX_BODY);
    if (!next.trim()) throw AppError.validation('消息内容不能为空', { body: '请输入内容' });
    if ((input.body ?? '').length > MAX_BODY) throw AppError.validation(`消息过长，单条上限 ${MAX_BODY} 字`, { body: '消息过长' });
    if (next === m.body) {
      const out = this.dtos(actor, m.conversation_id, [m]);
      return { ...out[0], unchanged: true };
    }
    const now = nowIso();
    const versions = j<Json[]>(m.edited_versions, []);
    versions.push({ body: m.body, edited_at: m.edited_at ?? m.created_at, reason: 'user_edit' });
    d.tx(() => {
      d.run('UPDATE messages SET body=?, edited_at=?, edited_versions=? WHERE id=?',
        next, now, S(versions.slice(-20)), m.id);
      d.run('DELETE FROM message_text_fts WHERE message_id=?', m.id);
      d.run('INSERT INTO message_text_fts(tokens,message_id,conversation_id,organization_id) VALUES(?,?,?,?)',
        tokensToIndex(next), m.id, m.conversation_id, m.organization_id);
      const ev = appendEvent({
        type: 'message.updated', organization_id: m.organization_id, entity_type: 'conversation',
        entity_id: m.conversation_id, actor_id: actor.userId, conversation_id: m.conversation_id,
        payload: { message_id: m.id, edited: true, char_count: next.trim().length },
      });
      queueOutbox(this.memberRows(m.conversation_id).map((u) => ({ user_id: u.user_id, channel: 'ws' })), Number(ev.seq));
    });
    const after = d.get<MsgRow>('SELECT * FROM messages WHERE id=?', m.id)!;
    const out = this.dtos(actor, m.conversation_id, [after]);
    return { ...out[0], edited_label: '已编辑', audit_version_count: versions.length };
  }

  /** 契约入口（void）；控制器需要审计回执时用 retractAndReport */
  async retract(actor: Actor, message_id: ID): Promise<void> {
    await this.retractAndReport(actor, message_id);
  }

  /** DELETE /messages/:id —— 软撤回；被引用者保留审计版本；不级联删除由它创建的独立任务 */
  async retractAndReport(actor: Actor, message_id: ID): Promise<Json> {
    const d = getDb();
    const m = this.mustMessage(actor, message_id);
    if (this.mustConversationRow(actor, m.conversation_id).dissolved_at) throw AppError.forbidden('已解散的群聊只能查看历史消息');
    if (m.retracted_at) return { ok: true, already: true, message: '该消息已撤回' };
    if (m.sender_id !== actor.userId) throw AppError.forbidden('只能撤回自己发送的消息');
    const now = nowIso();
    const referencedBy = Number(d.val<number>('SELECT COUNT(*) FROM messages WHERE parent_id=?', m.id) ?? 0);
    const versions = j<Json[]>(m.edited_versions, []);
    if (referencedBy > 0) {
      versions.push({ body: m.body, edited_at: m.edited_at ?? m.created_at, reason: 'retracted_while_referenced' });
    }
    d.tx(() => {
      // body 保留在行内用于审计，接口一律返回空串；FTS 行删除以免被正文检索命中
      d.run('UPDATE messages SET retracted_at=?, edited_versions=? WHERE id=?', now, S(versions.slice(-20)), m.id);
      d.run('DELETE FROM message_text_fts WHERE message_id=?', m.id);
      const ev = appendEvent({
        type: 'message.retracted', organization_id: m.organization_id, entity_type: 'conversation',
        entity_id: m.conversation_id, actor_id: actor.userId, conversation_id: m.conversation_id,
        payload: { message_id: m.id, referenced_by: referencedBy, kept_audit: referencedBy > 0 },
      });
      queueOutbox(this.memberRows(m.conversation_id).map((u) => ({ user_id: u.user_id, channel: 'ws' })), Number(ev.seq));
    });
    const after = d.get<MsgRow>('SELECT * FROM messages WHERE id=?', m.id)!;
    const out = this.dtos(actor, m.conversation_id, [after]);
    return { ...out[0], message: referencedBy > 0 ? '消息已撤回；因其被其他消息引用，审计版本已保留' : '消息已撤回' };
  }

  private viewerSettings(actor: Actor, conversationId: ID): ConversationSettings {
    return getDb().get<ConversationSettings>(
      'SELECT pinned_at, muted, manual_unread, hidden, history_cutoff FROM conversation_members WHERE conversation_id=? AND user_id=?',
      conversationId, actor.userId)!;
  }

  async updateViewerSettings(actor: Actor, conversationId: ID, input: { pinned?: boolean; muted?: boolean; unread?: boolean; remove?: boolean }): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversation(actor, conversationId);
    const current = this.viewerSettings(actor, conv.id);
    const now = nowIso();
    d.tx(() => {
      if (input.remove) {
        d.run(`UPDATE conversation_members SET hidden=1, pinned_at=NULL, manual_unread=0, last_read_at=NULL,
                 history_cutoff=MAX(history_cutoff, COALESCE((SELECT MAX(history_seq) FROM messages WHERE conversation_id=?), 0))
               WHERE conversation_id=? AND user_id=?`, conv.id, conv.id, actor.userId);
      } else {
        const pinnedAt = input.pinned === undefined ? current.pinned_at : input.pinned ? current.pinned_at ?? now : null;
        d.run(`UPDATE conversation_members SET pinned_at=?, muted=?, manual_unread=?
               WHERE conversation_id=? AND user_id=?`, pinnedAt, input.muted ?? !!current.muted,
          input.unread ?? !!current.manual_unread, conv.id, actor.userId);
      }
      const ev = appendEvent({
        type: 'conversation.preferences.updated', organization_id: conv.organization_id, entity_type: 'conversation',
        entity_id: conv.id, actor_id: actor.userId, conversation_id: conv.id, payload: {},
      });
      queueOutbox([{ user_id: actor.userId, channel: 'ws' }], Number(ev.seq));
    });
    return { ok: true };
  }

  /** 契约入口（void）；控制器需要 last_read_at 时用 markReadAndReport */
  async markRead(actor: Actor, conversation_id: ID): Promise<void> {
    await this.markReadAndReport(actor, conversation_id);
  }

  /** PUT /conversations/:id/read —— 已读游标；read.updated 载荷不含正文 */
  async markReadAndReport(actor: Actor, conversation_id: ID): Promise<Json> {
    const d = getDb();
    const conv = this.mustConversation(actor, conversation_id);
    const now = nowIso();
    d.run('UPDATE conversation_members SET last_read_at=?, manual_unread=0 WHERE conversation_id=? AND user_id=?', now, conv.id, actor.userId);
    const ev = appendEvent({
      type: 'read.updated', organization_id: conv.organization_id, entity_type: 'conversation',
      entity_id: conv.id, actor_id: actor.userId, conversation_id: conv.id,
      payload: { user_id: actor.userId, last_read_at: now },
    });
    queueOutbox(this.memberRows(conv.id).map((u) => ({ user_id: u.user_id, channel: 'ws' })), Number(ev.seq));
    return { conversation_id: conv.id, last_read_at: now, cleared: true, message: '已标记为已读' };
  }

  // ==================== 检索（§15：会话/成员 P0 + 正文 P1） ====================

  /** 会话内与跨会话正文检索：只覆盖我未退出的会话，撤回内容不参与 */
  async searchMessages(actor: Actor, q: string, opts?: { conversation_id?: ID; limit?: number }): Promise<Json> {
    const query = (q ?? '').trim();
    const match = buildMatch(query);
    const limit = clampNum(opts?.limit ?? 50, 1, 200, 50);
    if (!match) return { query, groups: [], total: 0, note: '请输入至少一个可检索的字符' };
    const d = getDb();
    const cond = ['message_text_fts MATCH ?', 'message_text_fts.organization_id=?', 'm.retracted_at IS NULL',
      `EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=message_text_fts.conversation_id
        AND cm.user_id=? AND cm.left_at IS NULL AND m.history_seq>cm.history_cutoff)`];
    const params: unknown[] = [match, actor.orgId, actor.userId];
    if (opts?.conversation_id) {
      this.mustConversation(actor, opts.conversation_id);
      cond.push('message_text_fts.conversation_id=?');
      params.push(opts.conversation_id);
    }
    const rows = d.all<{ message_id: string; conversation_id: string; body: string; created_at: string; sender_id: string }>(
      `SELECT message_text_fts.message_id, message_text_fts.conversation_id, m.body, m.created_at, m.sender_id
       FROM message_text_fts JOIN messages m ON m.id=message_text_fts.message_id
       WHERE ${cond.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`, ...params, limit);
    const grouped = new Map<string, { conversation_id: string; conversation_name: string; conversation_type: string; hits: Json[] }>();
    for (const r of rows) {
      const conv = d.get<ConvRow>('SELECT * FROM conversations WHERE id=?', r.conversation_id);
      if (!conv || conv.organization_id !== actor.orgId) continue;
      const members = this.memberRows(conv.id);
      const hit = snippetFor(r.body, query);
      let g = grouped.get(conv.id);
      if (!g) {
        g = { conversation_id: conv.id, conversation_name: this.displayName(actor, conv, members), conversation_type: conv.type, hits: [] };
        grouped.set(conv.id, g);
      }
      g.hits.push({
        message_id: r.message_id, created_at: r.created_at,
        sender_name: members.find((m) => m.user_id === r.sender_id)?.display_name ?? '已离开成员',
        snippet: hit ? { text: hit.text, hits: hit.hits, start: hit.start }
          : { text: oneLine(r.body).slice(0, 120), hits: [], start: 0 },
        jump_path: `/message?c=${conv.id}&m=${r.message_id}`,
      });
    }
    return {
      query, groups: Array.from(grouped.values()), total: rows.length,
      note: rows.length ? null : '正文检索使用二元组索引；零命中不代表没写过，可能是词形未覆盖',
    };
  }

  // ==================== 消息 → 任务 / Agent ====================

  /** POST /messages/:id/task-draft —— 预填草稿（draft 即未指派），人确认后才正式创建 */
  async createTaskDraftFromMessage(actor: Actor, message_id: ID): Promise<Json> {
    const m = this.mustMessage(actor, message_id);
    if (m.retracted_at) throw AppError.forbidden('已撤回的消息不能创建任务草稿');
    const text = oneLine(m.body);
    if (!text) throw AppError.validation('该消息没有可生成任务的文本内容', { body: '消息为空' });
    const title = text.slice(0, TASK_TITLE_CHARS);
    const sourceRef = { conversation_id: m.conversation_id, message_id: m.id };
    if (!services.tasks) {
      throw new AppError('DEPENDENCY_UNAVAILABLE',
        'Task 模块未装配（services.tasks 缺失），无法从消息生成任务草稿', 501, undefined,
        { requires: 'tasks', message_id: m.id, conversation_id: m.conversation_id, prefilled: { title, source_ref: sourceRef } });
    }
    const draft = await services.tasks.create(actor, {
      title,
      description: m.body.slice(0, 4000),
      status: 'draft',
      source: 'message',
      source_ref: sourceRef,
      organization_id: m.organization_id,
    });
    return {
      task: draft, confirmed: false,
      message: '任务草稿已生成（未指派）。请在 Task 页面的草稿阶段补齐负责人与验收标准后再正式创建。',
    };
  }

  /** POST /conversations/:id/agent-handoff —— 预览只含选定消息，不自动读取全部群史 */
  async handoffToAgent(actor: Actor, input: {
    conversation_id: ID; message_ids: ID[]; target: 'personal' | 'team'; team_id?: ID | null; folder_id?: ID | null; goal?: string;
  }): Promise<{ session_id: ID; prefilled: string; preview: Json }> {
    const d = getDb();
    const conv = this.mustConversation(actor, input.conversation_id);
    const ids = Array.from(new Set((input.message_ids ?? []).map((s) => String(s).trim()).filter(Boolean)));
    if (!ids.length) throw AppError.validation('请至少选择一条消息交给 Agent', { message_ids: '未选择消息' });
    if (ids.length > 50) throw AppError.validation('单次最多选择 50 条消息', { message_ids: '选择过多' });
    const target: 'personal' | 'team' = input.target === 'team' ? 'team' : 'personal';
    if (target === 'team') {
      if (!input.team_id) throw AppError.validation('交给 Team Agent 需要指定团队', { team_id: '必填' });
      if (!userTeams(actor.userId, actor.orgId).includes(input.team_id)) {
        throw AppError.forbidden('你不是该团队成员，不能把会话资料交给该团队');
      }
    }
    const rows: MsgRow[] = [];
    for (const mid of ids) {
      const m = d.get<MsgRow>('SELECT * FROM messages WHERE id=? AND conversation_id=? AND history_seq>?',
        mid, conv.id, this.viewerSettings(actor, conv.id).history_cutoff);
      if (!m || m.conversation_id !== conv.id) throw AppError.notFound('选定的消息不存在或不可见');
      if (m.retracted_at) throw AppError.forbidden('已撤回的消息不能交给 Agent');
      rows.push(m);
    }
    const members = this.memberRows(conv.id);
    const nameOf = (uid: string) => members.find((m) => m.user_id === uid)?.display_name
      ?? d.val<string>('SELECT display_name FROM users WHERE id=?', uid) ?? '未知成员';
    const shown = this.displayName(actor, conv, members);
    const preview: Json = {
      scope: 'selected_messages',
      scope_note: `仅纳入本次选定的 ${rows.length} 条消息；不会自动读取会话「${shown}」的全部历史（§05）`,
      conversation_id: conv.id,
      conversation_name: shown,
      target,
      team_id: target === 'team' ? input.team_id ?? null : null,
      folder_id: target === 'team' ? input.folder_id ?? null : null,
      messages: rows.map((r) => ({
        message_id: r.id, sender_name: nameOf(r.sender_id), created_at: r.created_at,
        char_count: r.body.length, preview_text: oneLine(r.body).slice(0, 80),
        attachment_count: j<Attachment[]>(r.attachments, []).length,
      })),
      attachment_files: rows.flatMap((r) => j<Attachment[]>(r.attachments, []).map((a) => ({
        file_id: a.file_id, version_id: a.version_id, name: a.name ?? null,
      }))),
      excluded: {
        unselected_messages: '未选中的消息不纳入',
        retracted_messages: '已撤回消息不纳入',
        files_without_permission: '附件仍按各自文件夹权限判定，Agent 只能读到有权的版本',
        card_bodies: '卡片仅带对象标识，正文需另行授权',
      },
    };
    const prefilled = [
      `来自会话「${shown}」的 ${rows.length} 条选定消息：`,
      ...rows.map((r) => `${nameOf(r.sender_id)}（${r.created_at}）：${oneLine(r.body).slice(0, 500)}`),
      input.goal ? `\n目标：${oneLine(input.goal)}` : '\n目标：（请补充你希望 Agent 做什么）',
    ].join('\n');

    if (!services.sessions) {
      throw new AppError('DEPENDENCY_UNAVAILABLE',
        'Agent 会话模块未装配（services.sessions 缺失），已返回资料范围预览但未创建会话', 501, undefined,
        { requires: 'sessions', preview, prefilled });
    }
    if (target === 'team' && !input.folder_id) {
      throw new AppError('VALIDATION', '交给团队 Agent 需要选择团队工作区', 400,
        { folder_id: '必填' }, { preview, prefilled });
    }
    const title = `来自会话：${shown}`.slice(0, 60);
    const session = target === 'personal'
      ? await services.sessions.createPersonal(actor, { title, folder_id: null, include_children: false })
      : await services.sessions.createTeamSession(actor, {
        title, team_id: String(input.team_id), folder_id: String(input.folder_id),
        participant_ids: members.map((m) => m.user_id),
      });
    const sessionId = String((session as Json).id ?? (session as Json).session_id ?? '');
    if (!sessionId) throw new AppError('PROVIDER_UNAVAILABLE', '会话创建未返回 ID，请重试', 503, undefined, { preview, prefilled });
    return { session_id: sessionId, prefilled, preview };
  }

  // ==================== 守卫与内部查询 ====================

  /** 组织边界 + 未退出的当前成员（读写消息的默认门槛） */
  private mustConversation(actor: Actor, conversationId: ID): ConvRow {
    const conv = this.mustConversationRow(actor, conversationId);
    const ok = getDb().get('SELECT 1 AS x FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL',
      conv.id, actor.userId);
    if (!ok) throw AppError.notFound('会话不存在或你不是成员');
    return conv;
  }

  /** 只做组织边界校验（成员增删/改名内部另有权限判定） */
  private mustConversationRow(actor: Actor, conversationId: ID): ConvRow {
    const conv = getDb().get<ConvRow>('SELECT * FROM conversations WHERE id=?', conversationId);
    if (!conv || conv.organization_id !== actor.orgId) throw AppError.notFound('会话不存在或不可见');
    return conv;
  }

  private mustMessage(actor: Actor, messageId: ID): MsgRow {
    const m = getDb().get<MsgRow>(
      `SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=?
       WHERE m.id=? AND m.organization_id=? AND m.history_seq>cm.history_cutoff`, actor.userId, messageId, actor.orgId);
    if (!m || m.organization_id !== actor.orgId) throw AppError.notFound('消息不存在或不可见');
    const ok = getDb().get('SELECT 1 AS x FROM conversation_members WHERE conversation_id=? AND user_id=?',
      m.conversation_id, actor.userId);
    if (!ok) throw AppError.notFound('消息不存在或不可见');
    return m;
  }

  private assertManageable(actor: Actor, conv: ConvRow): void {
    if (conv.dissolved_at) throw AppError.forbidden('群聊已解散');
    const mine = getDb().get<{ role: string }>(
      'SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL',
      conv.id, actor.userId);
    if (!mine) throw AppError.notFound('会话不存在或你不是成员');
    if (!this.canManage({ created_by: conv.created_by ?? null, my_role: mine.role }, actor)) {
      throw AppError.forbidden('管理会话成员需要会话管理员或组织管理员权限');
    }
  }

  private memberRows(conversationId: ID, includeAvatar = false): MemberRow[] {
    return getDb().all<MemberRow>(
      `SELECT cm.conversation_id, cm.user_id, cm.role, cm.joined_at, cm.left_at, cm.last_read_at,
              u.display_name, u.title, u.status AS account_status${includeAvatar ? ", u.prefs" : ""}
       FROM conversation_members cm JOIN users u ON u.id=cm.user_id
       WHERE cm.conversation_id=? AND cm.left_at IS NULL ORDER BY u.display_name`, conversationId);
  }

  private userTeamNames(userId: ID, orgId: ID): { id: string; name: string }[] {
    return getDb().all<{ id: string; name: string }>(
      `SELECT t.id, t.name FROM teams t JOIN team_members tm ON tm.team_id=t.id
       WHERE tm.user_id=? AND t.organization_id=? ORDER BY t.name`, userId, orgId);
  }

  private assertOrgMembers(orgId: ID, userIds: ID[]): void {
    if (!userIds.length) return;
    const d = getDb();
    const ok = new Set(d.all<{ id: string }>(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id
       WHERE u.status='active' AND m.status='active' AND m.organization_id=? AND u.id IN (${inClause(userIds.length)})`,
      orgId, ...userIds).map((r) => r.id));
    const bad = userIds.filter((u) => !ok.has(u));
    if (bad.length) {
      throw AppError.validation(`以下成员不在本组织或已停用：${bad.join('，')}`, { member_ids: '存在无效成员' });
    }
  }
}
