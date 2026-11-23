// FlowMate · 权限（PRD §20）
// 团队会话成员权、目录权、业务动作权三者分别校验，不可互相代替。
// 服务端鉴权，不靠前端隐藏；无权对象不返回标题、摘要或计数。
import { getDb } from './db';
import { AppError } from './errors';

export interface Actor {
  userId: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
  displayName: string;
}

const RANK: Record<string, number> = { viewer: 1, editor: 2, manager: 3 };

export function orgRole(userId: string, orgId: string): 'owner' | 'admin' | 'member' | null {
  const r = getDb().get<{ role: string }>(
    'SELECT role FROM memberships WHERE user_id=? AND organization_id=? AND status=\'active\'', userId, orgId);
  return r ? (r.role as 'owner' | 'admin' | 'member') : null;
}

export function isOrgManager(actor: Actor) {
  return actor.role === 'owner' || actor.role === 'admin';
}

export function userTeams(userId: string, orgId: string): string[] {
  return getDb()
    .all<{ team_id: string }>('SELECT t.id AS team_id FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.organization_id=?', userId, orgId)
    .map((r) => r.team_id);
}

export function teamRole(userId: string, teamId: string): 'lead' | 'member' | null {
  const r = getDb().get<{ role: string }>('SELECT role FROM team_members WHERE user_id=? AND team_id=?', userId, teamId);
  return r ? (r.role as 'lead' | 'member') : null;
}

/** 目录链：返回 [自身, 父, 祖父, ...] 的 folder id */
function folderChain(folderId: string | null): string[] {
  const out: string[] = [];
  let cur = folderId;
  const d = getDb();
  let guard = 0;
  while (cur && guard++ < 64) {
    out.push(cur);
    const p = d.get<{ parent_id: string | null }>('SELECT parent_id FROM folders WHERE id=?', cur);
    cur = p?.parent_id ?? null;
  }
  return out;
}

interface AclRow { principal_type: string; principal_id: string; permission: string; effect: string; depth: number }

/**
 * ACL 解析：继承父目录、子目录可收紧、显式拒绝优先。
 * 同层（depth 小）优先于上层；deny 优先于 allow。
 */
export function resolveAcl(actor: Actor, resourceType: 'folder' | 'file', resourceId: string): { allow: number; denied: boolean; via: string[] } {
  const d = getDb();
  // folders 表的父级列是 parent_id，files 表是 folder_id —— 之前统一按 folder_id 取列，
  // 对目录鉴权会直接抛「no such column: folder_id」，导致会话绑定、移动、共享等全部 500。
  const res = resourceType === 'folder'
    ? d.get<{ folder_id: string | null; owner_id: string | null; team_id: string | null; space: string; id: string }>(
      'SELECT parent_id AS folder_id, owner_id, team_id, space, id FROM folders WHERE id=?', resourceId)
    : d.get<{ folder_id: string | null; owner_id: string | null; team_id: string | null; space: string; id: string }>(
      'SELECT folder_id, owner_id, team_id, space, id FROM files WHERE id=?', resourceId);
  if (!res) return { allow: 0, denied: false, via: [] };
  const chain = resourceType === 'folder' ? folderChain(res.id) : [res.folder_id, ...folderChain(res.folder_id)].filter(Boolean) as string[];
  // 每个待查 id 的资源类型必须与它在 acls 里的登记类型一致：文件的祖先都是「目录」，
  // 若统一按 resource_type='file' 查，团队/组织在目录上授予的权限就永远匹配不到
  // （表现：队友打不开团队目录里的文件、提交产物被 403、共同确认无法发起）。
  const targets: { type: 'folder' | 'file'; id: string }[] = resourceType === 'folder'
    ? chain.map((id) => ({ type: 'folder' as const, id }))
    : [{ type: 'file' as const, id: resourceId }, ...chain.map((id) => ({ type: 'folder' as const, id }))];
  if (!targets.length && resourceType === 'file') targets.push({ type: 'file', id: resourceId });
  const teams = userTeams(actor.userId, actor.orgId);
  const rows: AclRow[] = [];
  for (let depth = 0; depth < targets.length; depth++) {
    const got = d.all<AclRow>(
      `SELECT principal_type, principal_id, permission, effect, ? AS depth FROM acls
       WHERE resource_type=? AND resource_id=?
         AND ((principal_type='user' AND principal_id=?)
           ${teams.length ? `OR (principal_type='team' AND principal_id IN (${teams.map(() => '?').join(',')}))` : ''}
           OR (principal_type='org' AND principal_id=?))`,
      depth, targets[depth].type, targets[depth].id, actor.userId, ...teams, actor.orgId);
    rows.push(...got);
  }
  const denied = rows.some((r) => r.effect === 'deny' && RANK[r.permission] >= 1);
  let allow = 0;
  const via: string[] = [];
  // 私有空间归属人天然 manager
  if (resourceType === 'file' && res.space === 'personal' && res.owner_id === actor.userId) allow = RANK.manager;
  if (resourceType === 'folder' && res.space === 'personal' && (res as unknown as { owner_id: string }).owner_id === actor.userId) allow = RANK.manager;
  if (actor.role === 'owner') {
    // 组织所有者：管理权不自动获得他人 Personal 正文（§20）
    const isPersonal = res.space === 'personal';
    if (!isPersonal) allow = Math.max(allow, RANK.manager);
  }
  for (const r of rows) {
    if (r.effect !== 'allow') continue;
    if (RANK[r.permission] > allow) {
      allow = RANK[r.permission];
      via.push(`${r.principal_type}:${r.principal_id}:${r.permission}@${r.depth}`);
    }
  }
  if (denied) {
    // 显式拒绝优先，但仍保留归属人对自己个人文件的访问
    const isOwn = (resourceType === 'file' ? res.owner_id : (res as unknown as { owner_id: string }).owner_id) === actor.userId;
    if (!isOwn) allow = 0;
  }
  return { allow, denied, via };
}

export function canRead(actor: Actor, type: 'folder' | 'file', id: string) {
  return resolveAcl(actor, type, id).allow >= RANK.viewer;
}
export function canEdit(actor: Actor, type: 'folder' | 'file', id: string) {
  return resolveAcl(actor, type, id).allow >= RANK.editor;
}
export function canManage(actor: Actor, type: 'folder' | 'file', id: string) {
  return resolveAcl(actor, type, id).allow >= RANK.manager;
}
export function assertCan(actor: Actor, type: 'folder' | 'file', id: string, level: 'viewer' | 'editor' | 'manager', what = '该操作') {
  const r = resolveAcl(actor, type, id);
  if (r.allow < RANK[level]) {
    throw AppError.forbidden(`${what}需要该工作区或文件的 ${level} 权限，当前授权不足`);
  }
  return r;
}

/** 会话访问：参与者或只读共享（Session ID 本身无授权效力，C06） */
export interface SessionAccess {
  session_id: string;
  role: 'coordinator' | 'participant' | 'viewer' | 'share_viewer';
  share_id?: string;
}

export function sessionAccess(actor: Actor, sessionId: string): SessionAccess | null {
  const d = getDb();
  const p = d.get<{ role: string }>('SELECT role FROM session_participants WHERE session_id=? AND user_id=? AND left_at IS NULL', sessionId, actor.userId);
  if (p) return { session_id: sessionId, role: p.role as SessionAccess['role'] };
  const share = d.get<{ id: string; expires_at: string; revoked_at: string | null }>(
    `SELECT sh.id, sh.expires_at, sh.revoked_at FROM session_shares sh
     JOIN agent_sessions s ON s.id=sh.session_id
     WHERE sh.session_id=? AND sh.grantee_user_id=? AND s.organization_id=?
       AND sh.revoked_at IS NULL AND sh.expires_at>?
       AND (sh.discovery='direct' OR EXISTS (SELECT 1 FROM session_link_shares l WHERE l.session_id=s.id AND l.enabled=1 AND l.expires_at>?))
     ORDER BY CASE sh.discovery WHEN 'direct' THEN 0 ELSE 1 END, sh.created_at DESC LIMIT 1`,
    sessionId, actor.userId, actor.orgId, new Date().toISOString(), new Date().toISOString());
  if (share && !share.revoked_at && new Date(share.expires_at).getTime() > Date.now()) {
    return { session_id: sessionId, role: 'share_viewer', share_id: share.id };
  }
  return null;
}

export function assertSessionAccess(actor: Actor, sessionId: string, min: 'read' | 'write' | 'coordinate' = 'read'): SessionAccess {
  const a = sessionAccess(actor, sessionId);
  if (!a) throw AppError.notFound('会话不存在或不可见');
  if (min === 'read') return a;
  if (a.role === 'share_viewer') throw AppError.forbidden('共享受邀者仅可查看，不能发送消息或触发执行');
  if (min === 'write' && a.role === 'viewer') throw AppError.forbidden('仅查看角色不能发起请求');
  if (min === 'coordinate' && a.role !== 'coordinator') throw AppError.forbidden('需要协调者权限');
  return a;
}

export function assertConversationMember(actor: Actor, conversationId: string) {
  const m = getDb().get<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL', conversationId, actor.userId);
  if (!m) throw AppError.notFound('会话不存在或你不是成员');
}

export function orgScopeOf(orgId: string, actor: Actor) {
  return { organization_id: orgId, userId: actor.userId, role: actor.role };
}

export const aclRank = RANK;

/** 列出某资源当前 ACL（供权限面板） */
export function listAcl(type: 'folder' | 'file', id: string) {
  return getDb().all(
    `SELECT a.*, u.display_name AS user_name, t.name AS team_name
     FROM acls a LEFT JOIN users u ON u.id=a.principal_id LEFT JOIN teams t ON t.id=a.principal_id
     WHERE a.resource_type=? AND a.resource_id=? ORDER BY a.created_at`, type, id);
}
