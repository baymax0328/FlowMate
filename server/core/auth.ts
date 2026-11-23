// FlowMate · 认证与请求上下文（PRD §19 认证 / §20 账号 / §21 Cookie 属性）
// HttpOnly + SameSite=Lax Cookie；局域网 HTTP 下 Secure=false（D6，界面常驻测试环境横幅）。
import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config';
import { getDb, nowIso, token, uuid, type Db } from './db';
import { AppError } from './errors';
import { orgRole, type Actor } from './permissions';

export const COOKIE = 'fm_session';
export const PUBLIC = Symbol('public');
export const Public = () => SetMetadata('public', true);

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compareSync(pw, hash);

export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
  orgId: string | null;
  orgs: { id: string; name: string; slug: string; role: string; teams: string[] }[];
}

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function issueSession(d: Db, userId: string, req?: Request): { token: string; sessionId: string; expiresAt: string } {
  const t = token();
  const sid = uuid();
  const expires = new Date(Date.now() + config.sessionTtlDays * 86400000).toISOString();
  d.run('INSERT INTO auth_sessions(id,token_hash,user_id,created_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?,?)',
    sid, hashToken(t), userId, nowIso(), expires, req?.header('user-agent') ?? null, req?.ip ?? null);
  return { token: t, sessionId: sid, expiresAt: expires };
}

export function setSessionCookie(res: Response, t: string) {
  res.cookie(COOKIE, t, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlDays * 86400000,
    path: '/',
  });
}
export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
}

export function revokeSession(d: Db, sessionId: string) {
  d.run('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', nowIso(), sessionId);
}
export function revokeUserSessions(userId: string) {
  getDb().run('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', nowIso(), userId);
}

/** 登录限速（§20：登录限速、日志不记密码） */
export function throttleLogin(key: string) {
  const d = getDb();
  const winStart = new Date(Date.now() - config.loginWindowMinutes * 60000).toISOString();
  const row = d.get<{ count: number; window_started_at: string; locked_until: string | null }>('SELECT * FROM login_attempts WHERE key=?', key);
  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    throw AppError.rate('登录尝试过多，请稍后再试');
  }
  let count = 1;
  if (row && new Date(row.window_started_at) > new Date(winStart)) count = row.count + 1;
  const locked = count > config.loginMaxAttempts
    ? new Date(Date.now() + config.loginWindowMinutes * 60000).toISOString() : null;
  d.run(`INSERT INTO login_attempts(key,count,window_started_at,locked_until) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET count=excluded.count, window_started_at=excluded.window_started_at, locked_until=excluded.locked_until`,
    key, count, row && new Date(row.window_started_at) > new Date(winStart) ? row.window_started_at : nowIso(), locked);
}
export function clearThrottle(key: string) {
  getDb().run('DELETE FROM login_attempts WHERE key=?', key);
}

export function buildPrincipal(d: Db, userId: string, sessionId: string): Principal {
  const u = d.get<{ id: string; email: string; display_name: string; status: string }>('SELECT * FROM users WHERE id=?', userId);
  if (!u) throw AppError.auth();
  if (u.status !== 'active') throw AppError.forbidden('账号已停用');
  const orgs = d.all<{ id: string; name: string; slug: string; role: string }>(
    `SELECT o.id, o.name, o.slug, m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id
     WHERE m.user_id=? AND m.status='active' ORDER BY o.name`, userId);
  const withTeams = orgs.map((o) => ({
    ...o,
    teams: d.all<{ id: string }>('SELECT id FROM teams WHERE organization_id=?', o.id)
      .filter((t) => d.get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', t.id, userId))
      .map((t) => t.id),
  }));
  return { userId: u.id, email: u.email, displayName: u.display_name, sessionId, orgId: null, orgs: withTeams };
}

/**
 * 全局守卫：解析会话 Cookie → req.actor。
 * 组织上下文来自 X-Organization-Id（组织切换），写入接口必须带组织。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & { principal?: Principal; actor?: Actor; authUserId?: string }>();
    const res = http.getResponse<Response>();
    const t = (req as unknown as { cookies?: Record<string, string> }).cookies?.[COOKIE];
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]);
    if (!t) {
      if (isPublic) return true;
      throw AppError.auth();
    }
    const d = getDb();
    const s = d.get<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
      'SELECT id,user_id,expires_at,revoked_at FROM auth_sessions WHERE token_hash=?', hashToken(t));
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) {
      clearSessionCookie(res);
      if (isPublic) return true;
      throw AppError.auth();
    }
    const principal = buildPrincipal(d, s.user_id, s.id);
    req.principal = principal;
    req.authUserId = s.user_id;
    const wanted = req.header('X-Organization-Id');
    // 组织 ID 只当作用户偏好，不做硬校验：客户端 localStorage 里的值会因为重新灌种子 / 换库而失效，
    // 若此时直接 403「不属于该组织」，连 /auth/me 与登录本身都会被拒，前端再也没有机会自我纠正。
    // 回落目标只会是「本人确实属于的组织」，因此跨组织越权仍然被挡住。
    const orgId = (wanted && principal.orgs.some((o) => o.id === wanted))
      ? wanted
      : (principal.orgs[0]?.id ?? null);
    if (!orgId) {
      if (isPublic) return true;
      throw AppError.forbidden('你还没有加入任何组织');
    }
    principal.orgId = orgId;
    const role = orgRole(s.user_id, orgId);
    req.actor = { userId: s.user_id, orgId, role: role ?? 'member', displayName: principal.displayName };
    // CSRF：写请求要求携带自定义头（SameSite=Lax 已阻断跨站表单，此为第二层）
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.header('X-FlowMate-Client') !== 'web') {
      throw AppError.forbidden('缺少客户端标识，疑似跨站请求');
    }
    return true;
  }
}

export function actorOf(req: Request & { actor?: Actor }): Actor {
  if (!req.actor) throw AppError.auth();
  return req.actor;
}
