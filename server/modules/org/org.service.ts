// FlowMate · 组织与团队服务（PRD §19 Auth/组织、§20 组织角色与权限、§03 组织切换）
// 权限矩阵：组织 owner/admin 管成员；团队负责人管本团队；owner 的管理权不外溢到他人私有内容（§20）。
import type { Response } from 'express';
import crypto from 'node:crypto';
import { appendEvent, getDb, nowIso, S, uuid, j } from '../../core/db';
import { AppError } from '../../core/errors';
import {
  buildPrincipal, hashPassword, issueSession, revokeUserSessions, setSessionCookie, throttleLogin, clearThrottle,
} from '../../core/auth';
import { isOrgManager, orgRole, teamRole, type Actor } from '../../core/permissions';
import { live } from '../../core/live';
import { sanitizeName } from '../../core/paths';
import type { ID, Json, OrgService as OrgContract } from '../../core/contracts';
import { AuthService, EMAIL_RE, publicUser, type UserRow, buildMePayload, type AuthedRequest } from '../auth/auth.service';
import { pushNotification } from '../notifications/notifications.service';

interface OrgRow {
  id: string; name: string; slug: string; timezone: string; owner_id: string | null;
  role?: string; member_status?: string; joined_at?: string;
}
interface MemberRow {
  prefs?: string;
  membership_id: string; user_id: string; role: string; member_status: string; joined_at: string;
  email: string; display_name: string; title: string | null; account_status: string;
}
interface InviteRow {
  id: string; organization_id: string; email: string; role: string; team_ids: string;
  code: string; status: string; created_by: string | null; created_at: string; accepted_at: string | null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(): string {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'org';
}

function inClause(n: number) {
  return Array.from({ length: n }, () => '?').join(',');
}

export class OrgService implements OrgContract {
  // ---------- 身份与组织 ----------

  /** 与 GET /auth/me 同源，避免两套「当前用户」口径 */
  async me(actor: Actor): Promise<Json> {
    return buildMePayload(actor);
  }

  async organizationsFor(userId: ID): Promise<Json[]> {
    const d = getDb();
    return d.all<OrgRow>(
      `SELECT o.id, o.name, o.slug, o.timezone, m.role, m.status AS member_status, m.created_at AS joined_at
       FROM organizations o JOIN memberships m ON m.organization_id=o.id
       WHERE m.user_id=? ORDER BY o.name`, userId)
      .map((o) => ({
        ...o,
        member_status_label: o.member_status === 'active' ? '正常' : '已停用',
        teams: d.all<{ id: string; name: string; my_role: string }>(
          `SELECT t.id, t.name, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id=t.id
           WHERE t.organization_id=? AND tm.user_id=? ORDER BY t.name`, o.id, userId),
      }));
  }

  /** GET /organizations/catalog —— 组织切换菜单；未保存内容提示由前端处理 */
  async catalog(actor: Actor): Promise<Json> {
    const orgs = await this.organizationsFor(actor.userId);
    const d = getDb();
    return {
      organizations: orgs.map((o) => ({
        ...o,
        member_count: Number(d.val<number>('SELECT COUNT(*) FROM memberships WHERE organization_id=? AND status=\'active\'', String(o.id)) ?? 0),
        team_count: Number(d.val<number>('SELECT COUNT(*) FROM teams WHERE organization_id=?', String(o.id)) ?? 0),
        is_current: o.id === actor.orgId,
      })),
      current_org_id: actor.orgId,
      switch_header: 'X-Organization-Id',
      switch_note: '切换组织会清空上一组织的检索与订阅；未保存内容由界面先行确认（§03）。',
    };
  }

  /** POST /organizations —— §03 全局外壳「新建」入口里的新建组织 */
  async createOrganization(actor: Actor, input: { name: string; timezone?: string }): Promise<Json> {
    const name = sanitizeName(input.name);
    if (!name) throw AppError.validation('组织名称不能为空', { name: '请输入组织名称' });
    const d = getDb();
    let slug = slugify(name);
    for (let i = 2; d.get('SELECT 1 AS x FROM organizations WHERE slug=?', slug); i++) slug = `${slugify(name)}-${i}`;
    const id = uuid();
    const now = nowIso();
    d.tx(() => {
      d.run('INSERT INTO organizations(id,name,slug,timezone,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        id, name, slug, input.timezone ?? 'Asia/Shanghai', actor.userId, now, now);
      d.run('INSERT INTO memberships(id,organization_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)',
        uuid(), id, actor.userId, 'owner', 'active', now);
      appendEvent({
        type: 'organization.created', organization_id: id, entity_type: 'organization', entity_id: id,
        actor_id: actor.userId, payload: { name, slug },
      });
    });
    return { id, name, slug, timezone: input.timezone ?? 'Asia/Shanghai', role: 'owner', created_at: now };
  }

  // ---------- 团队 ----------

  async teams(actor: Actor): Promise<Json[]> {
    return this.teamsOfOrg(actor, actor.orgId);
  }

  /** GET /teams?organization_id= —— 参数组织必须是调用者已加入的组织 */
  async teamsOfOrg(actor: Actor, organizationId: ID | null | undefined): Promise<Json[]> {
    const orgId = organizationId || actor.orgId;
    if (orgId !== actor.orgId && !orgRole(actor.userId, orgId)) {
      throw AppError.forbidden('你不属于该组织，无法查看其团队列表');
    }
    const d = getDb();
    return d.all<Json>(
      `SELECT t.id, t.name, t.lead_id, t.created_at, t.updated_at,
              u.display_name AS lead_name, tm.role AS my_role,
              (SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS member_count
       FROM teams t LEFT JOIN users u ON u.id=t.lead_id
       LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=?
       WHERE t.organization_id=? ORDER BY t.name`, actor.userId, orgId)
      .map((t) => ({
        ...t,
        my_role: t.my_role ?? null,
        can_manage: isOrgManager(actor) || t.my_role === 'lead',
        members: d.all<{ user_id: string; display_name: string; role: string }>(
          `SELECT tm.user_id, u.display_name, tm.role FROM team_members tm JOIN users u ON u.id=tm.user_id
           WHERE tm.team_id=? ORDER BY tm.role, u.display_name`, String(t.id)),
      }));
  }

  private ledTeams(userId: ID, orgId: ID): ID[] {
    return getDb().all<{ id: string }>(
      `SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id=t.id
       WHERE tm.user_id=? AND tm.role='lead' AND t.organization_id=?`, userId, orgId).map((r) => r.id);
  }

  private assertCanCreateTeam(actor: Actor) {
    if (isOrgManager(actor)) return;
    if (this.ledTeams(actor.userId, actor.orgId).length) return;
    throw AppError.forbidden('新建团队需要组织管理员或团队负责人权限');
  }

  async createTeam(actor: Actor, input: { name: string; member_ids: ID[]; lead_id?: ID | null }): Promise<Json> {
    this.assertCanCreateTeam(actor);
    const name = sanitizeName(input.name);
    if (!name) throw AppError.validation('团队名称不能为空', { name: '请输入团队名称' });
    const d = getDb();
    const leadId = input.lead_id ?? actor.userId;
    const ids = Array.from(new Set([leadId, actor.userId, ...(input.member_ids ?? [])]));
    this.assertOrgMembers(actor.orgId, ids);
    const id = uuid();
    const now = nowIso();
    d.tx(() => {
      d.run('INSERT INTO teams(id,organization_id,name,lead_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        id, actor.orgId, name, leadId, now, now);
      for (const uid of ids) {
        d.run(`INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,?,?)
               ON CONFLICT(team_id,user_id) DO NOTHING`, id, uid, uid === leadId ? 'lead' : 'member', now);
      }
      appendEvent({
        type: 'team.created', organization_id: actor.orgId, entity_type: 'team', entity_id: id,
        actor_id: actor.userId, payload: { name, member_count: ids.length },
      });
    });
    return { id, name, organization_id: actor.orgId, lead_id: leadId, member_ids: ids, created_at: now };
  }

  async updateTeam(actor: Actor, input: { team_id: ID; name?: string; lead_id?: ID | null; member_ids?: ID[] }): Promise<Json> {
    const d = getDb();
    const t = d.get<{ id: string; name: string; lead_id: string | null; organization_id: string }>(
      'SELECT * FROM teams WHERE id=?', input.team_id);
    if (!t || t.organization_id !== actor.orgId) throw AppError.notFound('团队不存在或不可见');
    if (!isOrgManager(actor) && teamRole(actor.userId, t.id) !== 'lead') {
      throw AppError.forbidden('管理团队需要组织管理员或本团队负责人权限');
    }
    const now = nowIso();
    const name = input.name === undefined ? t.name : sanitizeName(input.name);
    const leadId = input.lead_id ?? t.lead_id;
    if (leadId && !this.isMember(actor.orgId, leadId)) throw AppError.validation('负责人必须是组织成员');
    d.tx(() => {
      d.run('UPDATE teams SET name=?, lead_id=?, updated_at=? WHERE id=?', name, leadId ?? null, now, t.id);
      if (input.member_ids) {
        const wanted = Array.from(new Set([...input.member_ids, ...(leadId ? [leadId] : [])]));
        this.assertOrgMembers(actor.orgId, wanted);
        const current = d.all<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id=?', t.id)
          .map((r) => r.user_id);
        for (const uid of wanted) {
          d.run(`INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,?,?)
                 ON CONFLICT(team_id,user_id) DO NOTHING`, t.id, uid, 'member', now);
        }
        for (const uid of current) {
          if (!wanted.includes(uid)) d.run('DELETE FROM team_members WHERE team_id=? AND user_id=?', t.id, uid);
        }
      }
      // 负责人唯一：先全部降为 member，再抬高当前负责人（无行则补一条）
      d.run("UPDATE team_members SET role='member' WHERE team_id=?", t.id);
      if (leadId) {
        d.run(`INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,'lead',?)
               ON CONFLICT(team_id,user_id) DO UPDATE SET role='lead'`, t.id, leadId, now);
      }
      appendEvent({
        type: 'team.updated', organization_id: actor.orgId, entity_type: 'team', entity_id: t.id,
        actor_id: actor.userId, payload: { name, lead_id: leadId ?? null },
      });
    });
    return { id: t.id, name, lead_id: leadId ?? null, updated_at: now };
  }

  // ---------- 成员 ----------

  async members(actor: Actor): Promise<Json[]> {
    const d = getDb();
    const rows = d.all<MemberRow>(
      `SELECT m.id AS membership_id, m.user_id, m.role, m.status AS member_status, m.created_at AS joined_at,
              u.email, u.display_name, u.title, u.status AS account_status, u.prefs
       FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`,
      actor.orgId);
    return rows.map(({ prefs, ...r }) => ({
      ...r,
      avatar: j<Record<string, unknown>>(prefs ?? '{}', {}).avatar,
      role_label: r.role === 'owner' ? '所有者' : r.role === 'admin' ? '管理员' : '成员',
      member_status_label: r.member_status === 'active' ? '正常' : '已停用',
      account_status_label: r.account_status === 'active' ? '正常' : '账号已停用',
      disabled: r.member_status !== 'active' || r.account_status !== 'active',
      teams: d.all<{ id: string; name: string; role: string }>(
        `SELECT t.id, t.name, tm.role FROM teams t JOIN team_members tm ON tm.team_id=t.id
         WHERE t.organization_id=? AND tm.user_id=? ORDER BY t.name`, actor.orgId, r.user_id),
      can_be_managed_by_me: this.canManageTarget(actor, r),
    }));
  }

  /** 成员管理判定：owner 可管一切；admin 可管普通成员；任何人不可改自己或组织所有者 */
  private canManageTarget(actor: Actor, target: { role: string; user_id: string }): string | null {
    if (!isOrgManager(actor)) return '需要组织管理员权限';
    if (target.user_id === actor.userId) return '不能修改自己的角色或状态';
    if (target.role === 'owner') return '组织所有者的角色不可由接口变更';
    if (target.role === 'admin' && actor.role !== 'owner') return '只有组织所有者可以管理员角色';
    return null;
  }

  private isMember(orgId: ID, userId: ID): boolean {
    return !!getDb().get('SELECT 1 AS x FROM memberships WHERE organization_id=? AND user_id=?', orgId, userId);
  }

  private assertOrgMembers(orgId: ID, userIds: ID[]) {
    if (!userIds.length) return;
    const d = getDb();
    const ok = d.all<{ id: string }>(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id
       WHERE u.status='active' AND m.status='active' AND m.organization_id=? AND u.id IN (${inClause(userIds.length)})`,
      orgId, ...userIds).map((r) => r.id);
    const bad = userIds.filter((u) => !ok.includes(u));
    if (bad.length) throw AppError.validation(`以下成员不在本组织或已停用：${bad.join('，')}`, { member_ids: '存在无效成员' });
  }

  async updateMember(actor: Actor, input: { user_id: ID; role?: string; status?: string }): Promise<Json> {
    if (!isOrgManager(actor)) throw AppError.forbidden('管理成员需要组织管理员权限');
    if (!input.role && !input.status) throw AppError.validation('没有需要变更的字段');
    if (input.role && !['owner', 'admin', 'member'].includes(input.role)) throw AppError.validation('角色只能是 owner / admin / member');
    if (input.status && !['active', 'disabled'].includes(input.status)) throw AppError.validation('状态只能是 active / disabled');
    const d = getDb();
    const target = d.get<MemberRow & { organization_id: string }>(
      `SELECT m.id AS membership_id, m.user_id, m.role, m.status AS member_status, m.created_at AS joined_at,
              m.organization_id, u.email, u.display_name, u.title, u.status AS account_status
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.user_id=?`,
      actor.orgId, input.user_id);
    if (!target) throw AppError.notFound('成员不存在或不可见');
    const block = this.canManageTarget(actor, target);
    if (block) throw AppError.forbidden(block);
    if (input.role && input.role !== 'member' && actor.role !== 'owner') {
      throw AppError.forbidden('只有组织所有者可以授予管理员或所有者角色');
    }
    if (input.role && input.role !== 'owner') {
      const owners = Number(d.val<number>(
        "SELECT COUNT(*) FROM memberships WHERE organization_id=? AND role='owner' AND status='active'", actor.orgId) ?? 0);
      if (owners <= 1 && target.role === 'owner') throw AppError.validation('组织必须保留至少一名所有者');
    }
    const org = d.get<{ owner_id: string | null }>('SELECT owner_id FROM organizations WHERE id=?', actor.orgId);
    if (org?.owner_id === input.user_id && (input.role || input.status === 'disabled')) {
      throw AppError.forbidden('不能通过接口降级或停用组织所有者账号，请先转移所有权');
    }

    const now = nowIso();
    let disabled = false;
    d.tx(() => {
      if (input.role) d.run('UPDATE memberships SET role=? WHERE id=?', input.role, target.membership_id);
      if (input.status) {
        d.run('UPDATE memberships SET status=? WHERE id=?', input.status, target.membership_id);
        d.run('UPDATE users SET status=?, updated_at=? WHERE id=?', input.status, now, input.user_id);
        disabled = input.status === 'disabled';
        if (disabled) {
          // §20 停用账号撤登录与 WS；§19 停用要断 WS
          d.run('UPDATE conversations SET updated_at=? WHERE organization_id=?', now, actor.orgId);
          revokeUserSessions(input.user_id);
          live.disconnectUser(input.user_id);
        }
      }
      appendEvent({
        type: 'organization.member.updated', organization_id: actor.orgId, entity_type: 'organization',
        entity_id: actor.orgId, actor_id: actor.userId,
        payload: { user_id: input.user_id, role: input.role ?? target.role, status: input.status ?? target.member_status },
      });
    });
    const after = d.get<MemberRow>(
      `SELECT m.id AS membership_id, m.user_id, m.role, m.status AS member_status, m.created_at AS joined_at,
              u.email, u.display_name, u.title, u.status AS account_status
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?`, target.membership_id)!;
    return {
      ...after,
      member_status_label: after.member_status === 'active' ? '正常' : '已停用',
      account_status_label: after.account_status === 'active' ? '正常' : '账号已停用',
      disabled,
      message: disabled ? '该成员已停用，登录会话与实时连接已撤销' : '成员信息已更新',
    };
  }

  // ---------- 邀请 ----------

  async invite(actor: Actor, input: { email: string; role: string; team_ids: ID[]; display_name?: string; password?: string }): Promise<Json> {
    if (!isOrgManager(actor)) throw AppError.forbidden('生成邀请需要组织管理员权限');
    const email = (input.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw AppError.validation('邮箱格式不正确', { email: '请输入有效邮箱' });
    const role = input.role === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && actor.role !== 'owner') throw AppError.forbidden('只有组织所有者可以邀请管理员');
    const teamIds = Array.from(new Set(input.team_ids ?? []));
    const d = getDb();
    if (teamIds.length) {
      const known = d.all<{ id: string }>(
        `SELECT id FROM teams WHERE organization_id=? AND id IN (${inClause(teamIds.length)})`, actor.orgId, ...teamIds)
        .map((r) => r.id);
      const bad = teamIds.filter((t) => !known.includes(t));
      if (bad.length) throw AppError.validation(`团队不存在或不属于本组织：${bad.join('，')}`, { team_ids: '存在无效团队' });
    }
    const now = nowIso();
    const existing = d.get<InviteRow>('SELECT * FROM invites WHERE organization_id=? AND lower(email)=? AND status=\'pending\'', actor.orgId, email);
    if (existing) {
      d.run('UPDATE invites SET role=?, team_ids=?, created_by=?, created_at=? WHERE id=?',
        role, S(teamIds), actor.userId, now, existing.id);
      return {
        id: existing.id, code: existing.code, email, role, team_ids: teamIds, status: 'pending',
        reused: true, accept_path: '/api/v1/invites/accept',
        message: '该邮箱已有待接受邀请，已更新角色与团队范围并沿用原邀请码',
      };
    }
    const id = uuid();
    const code = makeCode();
    d.tx(() => {
      d.run(`INSERT INTO invites(id,organization_id,email,role,team_ids,code,status,created_by,created_at)
             VALUES(?,?,?,?,?,?,?,?,?)`, id, actor.orgId, email, role, S(teamIds), code, 'pending', actor.userId, now);
      appendEvent({
        type: 'organization.invite.created', organization_id: actor.orgId, entity_type: 'organization',
        entity_id: actor.orgId, actor_id: actor.userId, payload: { role, team_count: teamIds.length },
      });
    });
    const already = d.get<{ id: string }>('SELECT id FROM users WHERE lower(email)=?', email);
    if (already) {
      await pushNotification({
        user_id: already.id, organization_id: actor.orgId, type: 'invite_received',
        title: '你收到一个新的组织邀请', body: '管理员再次向你发出了邀请，可在成员管理中接受。',
        entity_type: 'invite', entity_id: id, actor_id: actor.userId, target_path: '/message',
      });
    }
    return {
      id, code, email, role, team_ids: teamIds, status: 'pending', reused: false,
      accept_path: '/api/v1/invites/accept', message: '邀请已生成（本环境无邮件通道，请把邀请码交给对方）',
    };
  }

  async revokeInvite(actor: Actor, inviteId: ID): Promise<Json> {
    if (!isOrgManager(actor)) throw AppError.forbidden('撤销邀请需要组织管理员权限');
    const d = getDb();
    const inv = d.get<InviteRow>('SELECT * FROM invites WHERE id=? AND organization_id=?', inviteId, actor.orgId);
    if (!inv) throw AppError.notFound('邀请不存在或不可见');
    if (inv.status !== 'pending') throw AppError.validation('该邀请已接受或已失效，无需撤销');
    d.run("UPDATE invites SET status='revoked' WHERE id=?", inv.id);
    appendEvent({
      type: 'organization.invite.revoked', organization_id: actor.orgId, entity_type: 'organization',
      entity_id: actor.orgId, actor_id: actor.userId, payload: { role: inv.role },
    });
    return { ok: true, message: '邀请已撤销' };
  }

  /**
   * POST /invites/accept（免登录）—— 有账号则校验密码并入组织；无账号则建号。
   * 密码错误统一「邮箱或密码不正确」，不暴露账号是否存在；建号密码至少 8 位。
   */
  async acceptInvite(req: AuthedRequest, res: Response, input: { code: string; email: string; password: string; display_name?: string }): Promise<Json> {
    const d = getDb();
    const code = (input.code ?? '').trim().toUpperCase();
    const inv = d.get<InviteRow>('SELECT * FROM invites WHERE code=?', code);
    if (!inv || inv.status !== 'pending') throw AppError.notFound('邀请码无效或已被使用');
    const email = (input.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw AppError.validation('邮箱格式不正确', { email: '请输入有效邮箱' });
    if (email !== inv.email.toLowerCase()) throw new AppError('INVITE_EMAIL_MISMATCH', '邀请码与邮箱不匹配', 400);

    const key = `invite:${code}|${req.ip ?? 'local'}`;
    throttleLogin(key);
    let user = d.get<UserRow>('SELECT * FROM users WHERE lower(email)=?', email);
    if (user) {
      if (!AuthService.verify(input.password, user.password_hash)) {
        throw new AppError('AUTH_FAILED', '邮箱或密码不正确', 401);
      }
      if (user.status !== 'active') throw AppError.forbidden('账号已停用，请联系组织管理员');
    } else {
      if ((input.password ?? '').length < 8) {
        throw AppError.validation('初始密码至少 8 位', { password: '初始密码至少 8 位' });
      }
      const id = uuid();
      const now = nowIso();
      const displayName = sanitizeName(input.display_name || email.split('@')[0]);
      d.run(`INSERT INTO users(id,email,password_hash,display_name,title,status,must_change_password,created_at,updated_at)
             VALUES(?,?,?,?,?,'active',0,?,?)`, id, email, hashPassword(input.password), displayName, null, now, now);
      user = d.get<UserRow>('SELECT * FROM users WHERE id=?', id)!;
    }
    clearThrottle(key);

    const teamIds = j<ID[]>(inv.team_ids, []);
    const now = nowIso();
    d.tx(() => {
      const m = d.get<{ id: string; status: string; role: string }>(
        'SELECT id,status,role FROM memberships WHERE organization_id=? AND user_id=?', inv.organization_id, user!.id);
      if (!m) {
        d.run('INSERT INTO memberships(id,organization_id,user_id,role,status,created_at) VALUES(?,?,?,?,?,?)',
          uuid(), inv.organization_id, user!.id, inv.role, 'active', now);
      } else if (m.status !== 'active') {
        d.run("UPDATE memberships SET status='active' WHERE id=?", m.id);
        d.run("UPDATE users SET status='active', updated_at=? WHERE id=?", now, user!.id);
      }
      for (const tid of teamIds) {
        d.run(`INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,?,?)
               ON CONFLICT(team_id,user_id) DO NOTHING`, tid, user!.id, 'member', now);
      }
      d.run("UPDATE invites SET status='accepted', accepted_at=? WHERE id=?", now, inv.id);
      appendEvent({
        type: 'organization.member.joined', organization_id: inv.organization_id, entity_type: 'organization',
        entity_id: inv.organization_id, actor_id: user!.id, payload: { role: inv.role, team_count: teamIds.length },
      });
    });

    const s = issueSession(d, user!.id, req);
    setSessionCookie(res, s.token);
    const principal = buildPrincipal(d, user!.id, s.sessionId);
    return {
      user: publicUser(user!),
      organizations: principal.orgs,
      current_org_id: principal.orgs[0]?.id ?? null,
      session: { expires_at: s.expiresAt },
      message: '邀请已接受，已为你登录',
    };
  }

  /** 邀请列表（管理员排障用） */
  async invites(actor: Actor): Promise<Json[]> {
    if (!isOrgManager(actor)) throw AppError.forbidden('查看邀请需要组织管理员权限');
    return getDb().all<InviteRow>('SELECT * FROM invites WHERE organization_id=? ORDER BY created_at DESC', actor.orgId)
      .map((i) => ({
        id: i.id, email: i.email, role: i.role, code: i.code, status: i.status,
        status_label: i.status === 'pending' ? '待接受' : i.status === 'accepted' ? '已接受' : i.status === 'revoked' ? '已撤销' : '已过期',
        team_ids: j<ID[]>(i.team_ids, []), created_at: i.created_at, accepted_at: i.accepted_at,
      }));
  }
}
