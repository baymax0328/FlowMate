import { avatarValidationError } from './avatar-validation';
// FlowMate · Auth 模块服务（PRD §19 Auth、§20 账号、§03 演示身份切换、§21 Cookie 属性）
// 硬约束：登录失败不暴露账号是否存在；密码哈希与限速复用 server/core/auth，不重复实现；
// 本文件不引入任何模型适配器（普通聊天与账号路径绝不调用模型）。
import type { Request, Response } from 'express';
import { config } from '../../core/config';
import { appendEvent, getDb, j, nowIso, S, token as randomToken, uuid } from '../../core/db';
import { AppError } from '../../core/errors';
import {
  buildPrincipal, clearSessionCookie, clearThrottle, hashPassword, hashToken, issueSession,
  revokeSession, revokeUserSessions, setSessionCookie, throttleLogin, verifyPassword,
  type Principal,
} from '../../core/auth';
import { live } from '../../core/live';
import { sanitizeName } from '../../core/paths';
import type { Actor } from '../../core/permissions';
import type { Json } from '../../core/contracts';

export interface UserRow {
  id: string; email: string; password_hash: string; display_name: string; title: string | null;
  status: string; prefs: string; must_change_password: number; created_at: string; updated_at: string;
}
export type AuthedRequest = Request & { principal?: Principal; actor?: Actor; authUserId?: string };

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;
const RESET_TTL_MS = 30 * 60 * 1000;

export const isDemoMode = () => process.env.FLOWMATE_DEMO === '1';

export function publicUser(u: UserRow): Json {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    title: u.title,
    status: u.status,
    status_label: u.status === 'active' ? '正常' : '已停用',
    prefs: j<Record<string, unknown>>(u.prefs, {}),
    must_change_password: !!u.must_change_password,
    created_at: u.created_at,
  };
}

interface OrgRow {
  id: string; name: string; slug: string; timezone: string; role: string;
  member_status: string; joined_at: string;
}
interface TeamRow { id: string; name: string; my_role: string }

/**
 * 组装「当前用户 + 已加入组织 + 当前组织 + 未读通知/未读消息」。
 * 模型配置状态由 models/modules 负责，此处不占位（避免前端误判为已实现）。
 * OrgService.me 复用本函数，保持 /auth/me 与组织接口同源。
 */
export function buildMePayload(actor: Actor): Json {
  const d = getDb();
  const u = d.get<UserRow>('SELECT * FROM users WHERE id=?', actor.userId);
  if (!u) throw AppError.auth();
  const orgs: (OrgRow & { teams: TeamRow[] })[] = d
    .all<OrgRow>(
      `SELECT o.id, o.name, o.slug, o.timezone, m.role, m.status AS member_status, m.created_at AS joined_at
       FROM organizations o JOIN memberships m ON m.organization_id=o.id
       WHERE m.user_id=? ORDER BY o.name`, actor.userId)
    .map((o) => ({
      ...o,
      member_status_label: o.member_status === 'active' ? '正常' : '已停用',
      teams: d.all<TeamRow>(
        `SELECT t.id, t.name, tm.role AS my_role FROM teams t
         JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND t.organization_id=? ORDER BY t.name`,
        actor.userId, o.id),
    }));
  const current = orgs.find((o) => o.id === actor.orgId) ?? null;
  const unreadNotifications = Number(d.val<number>(
    'SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL', actor.userId) ?? 0);
  const pendingNotifications = Number(d.val<number>(
    'SELECT COUNT(*) FROM notifications WHERE user_id=? AND handled_at IS NULL AND organization_id=?',
    actor.userId, actor.orgId) ?? 0);
  const unreadMessages = Number(d.val<number>(
    `SELECT COALESCE(SUM((SELECT COUNT(*) FROM messages m
        WHERE m.conversation_id=cm.conversation_id AND m.sender_id<>cm.user_id AND m.retracted_at IS NULL
          AND (cm.last_read_at IS NULL OR m.created_at>cm.last_read_at))),0)
     FROM conversation_members cm
     WHERE cm.user_id=? AND cm.organization_id=? AND cm.left_at IS NULL`,
    actor.userId, actor.orgId) ?? 0);
  return {
    user: publicUser(u),
    organizations: orgs,
    current_org: current,
    unread_notifications: unreadNotifications,
    unread_notifications_label: unreadNotifications > 0 ? `未读 ${unreadNotifications} 条` : '无未读通知',
    pending_notifications: pendingNotifications,
    pending_notifications_label: pendingNotifications > 0 ? `待处理 ${pendingNotifications} 条` : '无待处理事项',
    unread_messages: unreadMessages,
    unread_messages_label: unreadMessages > 0 ? `未读 ${unreadMessages} 条` : '无未读消息',
    // §03：演示身份切换仅测试环境显示并标记
    demo_mode: isDemoMode(),
    environment_label: isDemoMode() ? '测试环境' : '正式环境',
    cookie_secure: config.cookieSecure,
  };
}

export class AuthService {
  /** POST /auth/login —— 限速 → 校验 → 发会话 → 写事件 */
  login(req: AuthedRequest, res: Response, email: string, password: string): Json {
    const d = getDb();
    const key = `${email.trim().toLowerCase()}|${req.ip ?? 'local'}`;
    throttleLogin(key);                        // 超限抛 429 RATE_LIMIT
    const u = d.get<UserRow>('SELECT * FROM users WHERE lower(email)=lower(?)', email.trim());
    const ok = !!u && u.status === 'active' && verifyPassword(password, u.password_hash);
    if (!ok) {
      // 统一文案：不区分「账号不存在 / 密码错误 / 已停用」，避免枚举账号（§19 / C20）
      throw new AppError('AUTH_FAILED', '邮箱或密码不正确', 401);
    }
    clearThrottle(key);
    const s = issueSession(d, u!.id, req);
    setSessionCookie(res, s.token);
    const principal = buildPrincipal(d, u!.id, s.sessionId);
    appendEvent({
      type: 'auth.login', organization_id: principal.orgs[0]?.id ?? '', entity_type: 'user',
      entity_id: u!.id, actor_id: u!.id, payload: { session_id: s.sessionId },
    });
    return {
      user: publicUser(u!),
      organizations: principal.orgs,
      current_org_id: principal.orgs[0]?.id ?? null,
      session: { expires_at: s.expiresAt },
      must_change_password: !!u!.must_change_password,
      demo_mode: isDemoMode(),
    };
  }

  /** POST /auth/logout —— 服务端撤销会话（令牌即时失效） */
  logout(req: AuthedRequest, res: Response): Json {
    const d = getDb();
    const p = req.principal;
    if (p) {
      revokeSession(d, p.sessionId);
      const orgs = d.all<{ organization_id: string }>(
        'SELECT organization_id FROM memberships WHERE user_id=? AND status=\'active\' LIMIT 1', p.userId);
      appendEvent({
        type: 'auth.logout', organization_id: orgs[0]?.organization_id ?? '', entity_type: 'user',
        entity_id: p.userId, actor_id: p.userId, payload: {},
      });
    }
    clearSessionCookie(res);
    return { ok: true, message: '已退出登录' };
  }

  /** GET /auth/me */
  me(actor: Actor): Json {
    return buildMePayload(actor);
  }

  /** PATCH /auth/profile —— 仅本人资料；prefs 为通知偏好（§03 账户菜单） */
  patchProfile(actor: Actor, input: { display_name?: string; title?: string | null; prefs?: Record<string, unknown> }): Json {
    const d = getDb();
    const u = d.get<UserRow>('SELECT * FROM users WHERE id=?', actor.userId);
    if (!u) throw AppError.auth();
    const name = input.display_name === undefined ? u.display_name : sanitizeName(input.display_name);
    const title = input.title === undefined ? u.title : (input.title === null ? null : sanitizeName(input.title));
    if (input.prefs && Object.prototype.hasOwnProperty.call(input.prefs, 'avatar')) {
      const error = avatarValidationError(input.prefs.avatar);
      if (error) throw AppError.validation(error, { avatar: error });
    }
    const prefs = input.prefs ? S({ ...j<Record<string, unknown>>(u.prefs, {}), ...input.prefs }) : u.prefs;
    d.run('UPDATE users SET display_name=?, title=?, prefs=?, updated_at=? WHERE id=?',
      name, title, prefs, nowIso(), actor.userId);
    appendEvent({
      type: 'user.profile.updated', organization_id: actor.orgId, entity_type: 'user',
      entity_id: actor.userId, actor_id: actor.userId, payload: { display_name: name },
    });
    const after = d.get<UserRow>('SELECT * FROM users WHERE id=?', actor.userId)!;
    return publicUser(after);
  }

  /** POST /auth/password —— 改密后撤销全部会话并断开 WS（§19 停用账号主动断 WS 的同源实现） */
  changePassword(res: Response, userId: string, currentPassword: string, newPassword: string): Json {
    const d = getDb();
    const u = d.get<UserRow>('SELECT * FROM users WHERE id=?', userId);
    if (!u) throw AppError.auth();
    if (!verifyPassword(currentPassword, u.password_hash)) {
      throw new AppError('AUTH_FAILED', '当前密码不正确', 401);
    }
    if (newPassword.length < MIN_PASSWORD) {
      throw AppError.validation(`新密码至少 ${MIN_PASSWORD} 位`, { new_password: `新密码至少 ${MIN_PASSWORD} 位` });
    }
    if (verifyPassword(newPassword, u.password_hash)) {
      throw AppError.validation('新密码不能与当前密码相同', { new_password: '新密码不能与当前密码相同' });
    }
    d.run('UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?',
      hashPassword(newPassword), nowIso(), userId);
    revokeUserSessions(userId);
    live.disconnectUser(userId);
    clearSessionCookie(res);
    const orgs = d.all<{ organization_id: string }>(
      'SELECT organization_id FROM memberships WHERE user_id=? AND status=\'active\' LIMIT 1', userId);
    appendEvent({
      type: 'auth.password.changed', organization_id: orgs[0]?.organization_id ?? '', entity_type: 'user',
      entity_id: userId, actor_id: userId, payload: {},
    });
    return { ok: true, message: '密码已修改，所有登录会话已失效，请重新登录' };
  }

  /**
   * POST /auth/password/reset-request —— 本机没有外部邮件通道（§24 明确不做推送），
   * 因此只生成并落库一次性令牌，返回 202；令牌永不回传前端，账号是否存在也一律同一响应。
   */
  requestPasswordReset(email: string): Json {
    const d = getDb();
    const u = d.get<UserRow>('SELECT * FROM users WHERE lower(email)=lower(?)', (email ?? '').trim());
    if (u && u.status === 'active') {
      d.run('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', nowIso(), u.id);
      const plain = randomToken();
      d.run('INSERT INTO password_reset_tokens(id,user_id,token_hash,token_plain,expires_at,created_at) VALUES(?,?,?,?,?,?)',
        uuid(), u.id, hashToken(plain), isDemoMode() ? plain : null,
        new Date(Date.now() + RESET_TTL_MS).toISOString(), nowIso());
      appendEvent({
        type: 'auth.password.reset_requested', organization_id: d.val<string>(
          'SELECT organization_id FROM memberships WHERE user_id=? AND status=\'active\' LIMIT 1', u.id) ?? '',
        entity_type: 'user', entity_id: u.id, actor_id: u.id, payload: {},
      });
    }
    return {
      status: 'accepted',
      message: '如该邮箱存在账号，重置令牌已生成。本环境无外部邮件通道，请通过管理员或演示接口取回令牌。',
      expires_in_seconds: Math.floor(RESET_TTL_MS / 1000),
    };
  }

  /**
   * GET /auth/password/reset-token?email= —— 演示便利，不是邮件通道。
   * 仅 FLOWMATE_DEMO=1 可用；生产语义下返回 404，避免成为账号枚举与凭据外泄面。
   */
  demoResetToken(email: string): Json {
    if (!isDemoMode()) throw AppError.notFound('演示接口未开放');
    const d = getDb();
    const row = d.get<{ token_plain: string | null; expires_at: string; used_at: string | null; user_id: string }>(
      `SELECT t.token_plain, t.expires_at, t.used_at, t.user_id FROM password_reset_tokens t
       JOIN users u ON u.id=t.user_id WHERE lower(u.email)=lower(?) ORDER BY t.created_at DESC LIMIT 1`, email);
    if (!row || !row.token_plain) throw AppError.notFound('没有可用的重置令牌，请重新发起申请');
    if (row.used_at || new Date(row.expires_at) < new Date()) {
      throw new AppError('RESET_TOKEN_EXPIRED', '重置令牌已使用或已过期，请重新发起申请', 410);
    }
    return { token: row.token_plain, expires_at: row.expires_at, note: '演示便利接口，非邮件通道' };
  }

  /** POST /auth/password/reset —— 按哈希校验一次性令牌，消费后立即撤销全部会话 */
  resetPassword(tokenValue: string, newPassword: string): Json {
    const d = getDb();
    const row = d.get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
      'SELECT * FROM password_reset_tokens WHERE token_hash=?', hashToken(tokenValue));
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      throw new AppError('RESET_TOKEN_INVALID', '重置令牌无效或已过期，请重新发起申请', 400);
    }
    if (newPassword.length < MIN_PASSWORD) {
      throw AppError.validation(`新密码至少 ${MIN_PASSWORD} 位`, { new_password: `新密码至少 ${MIN_PASSWORD} 位` });
    }
    const u = d.get<UserRow>('SELECT * FROM users WHERE id=?', row.user_id);
    if (!u || u.status !== 'active') throw new AppError('RESET_TOKEN_INVALID', '账号不存在或已停用', 400);
    d.run('UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?',
      hashPassword(newPassword), nowIso(), u.id);
    d.run('UPDATE password_reset_tokens SET used_at=? WHERE id=?', nowIso(), row.id);
    revokeUserSessions(u.id);
    live.disconnectUser(u.id);
    appendEvent({
      type: 'auth.password.reset', organization_id: d.val<string>(
        'SELECT organization_id FROM memberships WHERE user_id=? AND status=\'active\' LIMIT 1', u.id) ?? '',
      entity_type: 'user', entity_id: u.id, actor_id: u.id, payload: {},
    });
    return { ok: true, message: '密码已重置，请使用新密码登录' };
  }

  /**
   * GET /auth/demo-accounts —— §03「演示身份切换仅测试环境显示并标记」的服务端支撑。
   * 密码不落库（只存哈希），因此列表同时提供 demo_login 接口所需的最小信息，不回传密码。
   */
  demoAccounts(): Json[] {
    if (!isDemoMode()) throw AppError.notFound('演示身份切换仅在测试环境开放');
    const d = getDb();
    const allow = (process.env.FLOWMATE_DEMO_ACCOUNTS ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const users = d.all<{ id: string; email: string; display_name: string; title: string | null }>(
      `SELECT id, email, display_name, title FROM users WHERE status='active' ORDER BY created_at LIMIT 40`);
    const items: Json[] = [];
    for (const u of users) {
      if (allow.length && !allow.includes(u.email.toLowerCase())) continue;
      const orgs = d.all<{ id: string; name: string; role: string }>(
        `SELECT o.id, o.name, m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id
         WHERE m.user_id=? AND m.status='active' ORDER BY o.name`, u.id);
      items.push({
        user_id: u.id,
        email: u.email,
        display_name: u.display_name,
        title: u.title,
        role: orgs[0]?.role ?? 'member',
        organizations: orgs,
        environment_label: '测试环境',
        password_revealed: false,
        demo_login: '/api/v1/auth/demo-login',
      });
      if (items.length >= 12) break;
    }
    return items;
  }

  /**
   * POST /auth/demo-login —— 同上，仅测试环境；一键切换身份不需要知道种子密码。
   * 生产语义下返回 404。仍走真实会话签发与事件记录。
   */
  demoLogin(req: AuthedRequest, res: Response, userId: string): Json {
    if (!isDemoMode()) throw AppError.notFound('演示身份切换仅在测试环境开放');
    const d = getDb();
    const u = d.get<UserRow>('SELECT * FROM users WHERE id=?', userId);
    if (!u || u.status !== 'active') throw AppError.notFound('账号不存在或已停用');
    const s = issueSession(d, u.id, req);
    setSessionCookie(res, s.token);
    const principal = buildPrincipal(d, u.id, s.sessionId);
    appendEvent({
      type: 'auth.demo_login', organization_id: principal.orgs[0]?.id ?? '', entity_type: 'user',
      entity_id: u.id, actor_id: u.id, payload: { session_id: s.sessionId },
    });
    return {
      user: publicUser(u),
      organizations: principal.orgs,
      current_org_id: principal.orgs[0]?.id ?? null,
      session: { expires_at: s.expiresAt },
      environment_label: '测试环境',
      demo_mode: true,
    };
  }

  /** 供邀请接受流程复用（org 模块）：把重置令牌标记为已用 */
  consumeResetTokens(userId: string) {
    getDb().run('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', nowIso(), userId);
  }

  /** 工具：口令强度与新哈希（导出给 org 的邀请建号复用，避免两处 bcrypt 参数漂移） */
  static hash(pw: string) {
    return hashPassword(pw);
  }
  static verify(pw: string, hash: string) {
    return verifyPassword(pw, hash);
  }
}
