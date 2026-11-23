// FlowMate · Task 模块（任务板块重设计：创建 / 接收 / 负责 / 验收 四段 + 经手人链）
// 经手人链：创建人 →(≥1 中间经手人，最多 7)→ 交付人(验收人)。当前该处理的人 = handlers[handler_index]，
// 同步写入既有 assignee_id，使列表 / 权限 / 可见性等既有逻辑无需改动即可继续工作。
import { Injectable } from '@nestjs/common';
import { appendEvent, getDb, j, nowIso, notify, queueOutbox, S, uuid } from '../../core/db';
import { AppError } from '../../core/errors';
import { isOrgManager, teamRole, userTeams, type Actor } from '../../core/permissions';
import type { Json, TasksService as TasksContract } from '../../core/contracts';
import { need } from '../../core/contracts';
import { sanitizeName } from '../../core/paths';
import { planWeek } from './week-scheduler';
import { chatJson, modelStatus } from '../../adapters/model.adapter';

/** 四段流程带：status → 流程带阶段（done = 归档，不在四个 tab 里） */
export const STAGE_OF: Record<string, string> = {
  draft: 'create',
  ready_to_assign: 'create',   // 含「退回」回到创建人的草稿（returned=1，看板换色）
  pending_accept: 'receive',
  accepted: 'work',
  in_progress: 'work',
  pending_transfer: 'work',    // 兼容旧状态
  pending_review: 'review',
  completed: 'done',
  cancelled: 'done',
};
export const STAGES = ['create', 'receive', 'work', 'review'] as const;

export const MAX_HANDLERS = 5;
export const MAX_STAGES = 5;
export const MAX_PER_STAGE = 5;

/** 环节内单个经手人的状态；state ∈ pending / accepted / handed_off / rejected */
type Member = { id: string; state: string; accepted_at: string | null; ended_at: string | null; duration_ms: number | null };
/** stages 落库形态：外层＝环节先后，内层＝该环节的经手人集合 */
type Stage = Member[];

const ALLOWED: Record<string, string[]> = {
  publish: ['draft'],
  assign: ['draft', 'ready_to_assign'],
  accept: ['pending_accept'],
  reject: ['pending_accept'],
  request_adjustment: ['pending_accept', 'accepted', 'in_progress'],
  transfer: ['accepted', 'in_progress'],
  submit: ['accepted', 'in_progress'],
  handoff_next: ['accepted', 'in_progress'],
  review: ['pending_review'],
  reassign: ['pending_review'],
  cancel: ['draft', 'ready_to_assign', 'pending_accept', 'accepted', 'in_progress', 'pending_transfer', 'pending_review'],
  archive: ['completed', 'cancelled'],
  unarchive: ['completed', 'cancelled'],
};

const TERMINAL = ['completed', 'cancelled'];

/** 供单测与界面共用：某状态下某动作是否合法 */
export function canTransition(from: string, action: string): boolean {
  return (ALLOWED[action] ?? []).includes(from);
}
export const TRANSITION_TABLE: Record<string, string[]> = ALLOWED;

// ---------- 优先级：界面用 T0>T1>T2>T3，底层沿用既有四档编码（不改 CHECK，零风险） ----------
const T_TO_DB: Record<string, string> = { t0: 'urgent', t1: 'high', t2: 'normal', t3: 'low' };
const DB_TO_T: Record<string, string> = { urgent: 'T0', high: 'T1', normal: 'T2', low: 'T3' };
export function priorityToDb(p: unknown): string {
  const v = String(p ?? 't2').toLowerCase();
  if (T_TO_DB[v]) return T_TO_DB[v];
  if (['low', 'normal', 'high', 'urgent'].includes(v)) return v;
  return 'normal';
}
export function priorityToT(db: unknown): string {
  return DB_TO_T[String(db)] ?? 'T2';
}

@Injectable()
export class TasksService implements TasksContract {
  private d = () => getDb();

  // ---------- 列表与四段计数 ----------
  async list(actor: Actor, opts: {
    scope: 'mine' | 'team'; team_id?: string; status?: string; sub?: string;
    tab?: string;
    q?: string; priority?: string; due?: string; project?: string; limit?: number;
  }): Promise<{ items: Json[]; stage_counts: Record<string, number>; snapshot_id: string }> {
    const d = this.d();
    const teams = userTeams(actor.userId, actor.orgId);
    const u = actor.userId;

    // 通用文本 / 元数据过滤
    const extra: string[] = [];
    const extraP: (string | number)[] = [];
    if (opts.priority) { extra.push('t.priority=?'); extraP.push(priorityToDb(opts.priority)); }
    if (opts.project) { extra.push(`lower(IFNULL(t.project,''))=?`); extraP.push(opts.project.toLowerCase()); }
    if (opts.due === 'overdue') { extra.push(`t.due_at IS NOT NULL AND t.due_at<? AND t.status NOT IN ('completed','cancelled')`); extraP.push(nowIso()); }
    if (opts.due === 'week') { extra.push('t.due_at IS NOT NULL AND t.due_at<=?'); extraP.push(new Date(Date.now() + 7 * 86400000).toISOString()); }
    if (opts.q) {
      const like = `%${opts.q.toLowerCase()}%`;
      extra.push('(lower(t.title) LIKE ? OR lower(IFNULL(t.description,\'\')) LIKE ? OR lower(IFNULL(t.project,\'\')) LIKE ?)');
      extraP.push(like, like, like);
    }
    const extraSql = extra.length ? ' AND ' + extra.join(' AND ') : '';

    // 每一段的归属条件（与所选 tab 一致）；team scope 只按团队可见、不要求「我是某人」
    const stageWhere = (stage: string): { sql: string; params: (string | number)[] } => {
      const org = 't.organization_id=?';
      if (opts.scope === 'team') {
        const vis = opts.team_id
          ? ['t.team_id=?']
          : (teams.length && !isOrgManager(actor)
            ? [`(t.team_id IN (${teams.map(() => '?').join(',')}) OR t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=?)`]
            : [org.replace('t.organization_id=?', '1=1')]);
        const vp = opts.team_id ? [opts.team_id] : (teams.length && !isOrgManager(actor) ? [...teams, u, u, u] : []);
        const st = STAGE_STATUS_SQL[stage];
        return { sql: `${st.sql} AND ${vis.join(' AND ')}`, params: [...st.params, ...vp] };
      }
      // mine：按当前用户的视角归属
      // mine：按当前用户的视角归属。经手/负责改为「当前环节里有我」 membership 判定；
      // 老数据（stages 为空）仍用 assignee_id 线性归属，保证改版前后都能显示。
      // membership 判定限定在活跃流转状态（pending_accept/accepted/in_progress），草稿/待指派不进接收列表。
      // 验收 tab 额外并入「我创建、当前仍在他人经手」的任务（在验收版块里显示为进行中）。
      const FLOW = `t.status IN ('pending_accept','accepted','in_progress')`;
      const MINE: Record<string, { sql: string; params: (string | number)[] }> = {
        create: { sql: "t.creator_id=? AND t.status IN ('draft','ready_to_assign')", params: [u] },
        receive: { sql: `((${FLOW} AND t.stages<>'[]' AND ${SQL_MEMBER_PENDING}) OR (t.stages='[]' AND t.assignee_id=? AND t.status='pending_accept'))`, params: [u, u] },
        work: { sql: `((${FLOW} AND t.stages<>'[]' AND ${SQL_MEMBER_ACCEPTED}) OR (t.stages='[]' AND t.assignee_id=? AND t.status IN ('accepted','in_progress')))`, params: [u, u] },
        review: { sql: `((t.reviewer_id=? AND t.status='pending_review') OR (t.creator_id=? AND ${FLOW}))`, params: [u, u] },
      };
      const m = MINE[stage];
      return { sql: `${m.sql} AND ${org}`, params: [...m.params, actor.orgId] };
    };

    const stage_counts: Record<string, number> = { create: 0, receive: 0, work: 0, review: 0 };
    for (const stage of STAGES) {
      const w = stageWhere(stage);
      stage_counts[stage] = Number(d.val<number>(`SELECT COUNT(*) FROM tasks t WHERE ${w.sql}${extraSql}`, ...w.params, ...extraP) ?? 0);
    }

    // 当前要取出的列表条件
    let where: { sql: string; params: (string | number)[] };
    const tab = opts.tab && STAGE_STATUS_SQL[opts.tab] ? opts.tab : (opts.status ? null : null);
    if (opts.tab === 'done') {
      where = opts.scope === 'team'
        ? { sql: `t.status IN ('completed','cancelled')`, params: [] }
        : { sql: `((t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=?) AND t.status IN ('completed','cancelled'))`, params: [u, u, u] };
    } else if (opts.status) {
      where = opts.scope === 'team'
        ? { sql: `t.status=?`, params: [opts.status] }
        : { sql: '1=1', params: [] };
    } else if (tab) {
      where = stageWhere(tab);
    } else {
      // 没指定 tab：mine 取与我相关的全部活跃任务；team 取团队可见
      if (opts.scope === 'team') {
        const vis = opts.team_id
          ? { sql: 't.team_id=?', params: [opts.team_id] as (string | number)[] }
          : (teams.length && !isOrgManager(actor)
            ? { sql: `(t.team_id IN (${teams.map(() => '?').join(',')}) OR t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=?)`, params: [...teams, u, u, u] as (string | number)[] }
            : { sql: '1=1', params: [] as (string | number)[] });
        where = vis;
      } else {
        where = {
          sql: `(
            (t.creator_id=? AND t.status IN ('draft','ready_to_assign'))
            OR (t.assignee_id=? AND t.status IN ('pending_accept','accepted','in_progress'))
            OR (t.reviewer_id=? AND t.status='pending_review')
            OR (t.status NOT IN ('completed','cancelled') AND (${SQL_MEMBER_PENDING} OR ${SQL_MEMBER_ACCEPTED}))
            OR (t.creator_id=? AND t.status IN ('pending_accept','accepted','in_progress'))
          )`,
          params: [u, u, u, u, u, u],
        };
      }
    }
    const orgClause = opts.scope === 'mine' || tab === undefined ? '' : '';
    const whereSql = `t.organization_id=? AND ${where.sql}${extraSql}${orgClause}`;
    const orderCase = tab ? 't.updated_at DESC'
      : `CASE t.status WHEN 'pending_review' THEN 0 WHEN 'pending_accept' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'accepted' THEN 2 ELSE 3 END, t.due_at IS NULL, t.due_at, t.updated_at DESC`;

    const items = d.all<Json>(
      `SELECT t.*, cu.display_name AS creator_name, au.display_name AS assignee_name, ru.display_name AS reviewer_name, tm.name AS team_name
       FROM tasks t
       LEFT JOIN users cu ON cu.id=t.creator_id LEFT JOIN users au ON au.id=t.assignee_id
       LEFT JOIN users ru ON ru.id=t.reviewer_id LEFT JOIN teams tm ON tm.id=t.team_id
       WHERE ${whereSql}
       ORDER BY ${orderCase}
       LIMIT ?`, actor.orgId, ...where.params, ...extraP, Math.min(opts.limit ?? 200, 500));

    return {
      items: items.map((t) => this.shape(t)),
      stage_counts,
      snapshot_id: uuid().slice(0, 8),
    };
  }

  async get(actor: Actor, task_id: string): Promise<Json> {
    const t = this.taskRowOr404(actor, task_id);
    const d = this.d();
    const transitions = d.all<Json>('SELECT * FROM task_transitions WHERE task_id=? ORDER BY created_at', task_id)
      .map((x) => ({ ...x, fields: j<Json>(x.fields as string, {}), actor_name: d.val<string>('SELECT display_name FROM users WHERE id=?', x.actor_id) }));
    const submissions = d.all<Json>('SELECT * FROM task_submissions WHERE task_id=? ORDER BY seq', task_id)
      .map((s) => ({ ...s, file_version_ids: j<string[]>(s.file_version_ids as string, []), file_snapshot: j<Json[]>(s.file_snapshot as string, []) }));
    const reviews = d.all<Json>('SELECT * FROM task_reviews WHERE task_id=? ORDER BY created_at', task_id)
      .map((r) => ({ ...r, per_criteria: j<Json[]>(r.per_criteria as string, []), reviewer_name: d.val<string>('SELECT display_name FROM users WHERE id=?', r.reviewer_id) }));
    const progress = d.all<Json>('SELECT p.*, u.display_name AS user_name FROM task_progress p JOIN users u ON u.id=p.user_id WHERE task_id=? ORDER BY created_at', task_id);
    const myName = actor.userId;
    const folderName = t.folder_id ? this.d().val<string>('SELECT name FROM folders WHERE id=?', String(t.folder_id)) : null;
    return {
      ...this.shape(t),
      creator_name: d.val<string>('SELECT display_name FROM users WHERE id=?',t.creator_id) ?? '',
      assignee_name: d.val<string>('SELECT display_name FROM users WHERE id=?',t.assignee_id) ?? '',
      reviewer_name: d.val<string>('SELECT display_name FROM users WHERE id=?',t.reviewer_id) ?? '',
      progress: Number(t.progress ?? 0),
      folder_name: folderName ?? null,
      criteria: j<Json[]>(t.criteria as string, []),
      source_ref: j<Json>(t.source_ref as string, {}),
      transitions, submissions, reviews, progress_history: progress,
      chain: this.buildChain(t),
      allowed_actions: this.allowedActions(actor, t),
      can_assign: ['draft', 'ready_to_assign'].includes(String(t.status)) && (t.creator_id === myName || isOrgManager(actor) || (!!t.team_id && teamRole(myName, String(t.team_id)) === 'lead')),
      can_accept: memberInStage(t, myName)?.state === 'pending',
      can_work: memberInStage(t, myName)?.state === 'accepted',
      can_review: t.status === 'pending_review' && t.reviewer_id === myName,
      agent_session_id: t.agent_session_id ?? null,
      stage: STAGE_OF[String(t.status)],
    };
  }

  private allowedActions(actor: Actor, t: Json): string[] {
    const out: string[] = [];
    const mine = (f: string) => t[f] === actor.userId;
    const st = String(t.status);
    const member = memberInStage(t, actor.userId);
    if (mine('creator_id') && (st === 'draft' || st === 'ready_to_assign')) out.push('assign', 'edit', 'cancel');
    // 接收阶段：我是当前环节里「还没接手」的成员
    if (member?.state === 'pending') out.push('accept', 'adjust', 'reject');
    // 负责阶段：我是当前环节里「已接手未交接」的成员
    if (member?.state === 'accepted') out.push('progress', 'handoff_next', 'submit', 'agent', 'folder', 'schedule');
    if (st === 'pending_review' && mine('reviewer_id')) out.push('review', 'reassign');
    if (!TERMINAL.includes(st) && (mine('creator_id') || isOrgManager(actor))) out.push('cancel');
    if (TERMINAL.includes(st)) out.push('archive', 'unarchive');
    return Array.from(new Set(out));
  }

  // ---------- 创建 / 编辑 ----------
  history(actor: Actor, opts: {scope:string; q?:string; status?:string; type?:string; page:number}): Json {
    const d=this.d();const args:unknown[]=[actor.orgId];const where=["t.organization_id=?", "t.status IN ('completed','cancelled')"];
    if(opts.scope!=='team'){where.push('(t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=?)');args.push(actor.userId,actor.userId,actor.userId);}
    else if(!isOrgManager(actor)){const teams=userTeams(actor.userId,actor.orgId);where.push(`(t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=?${teams.length?` OR t.team_id IN (${teams.map(()=>'?').join(',')})`:''})`);args.push(actor.userId,actor.userId,actor.userId,...teams);}
    const base=where.join(' AND ');const baseArgs=[...args];
    if(opts.q){where.push('(t.title LIKE ? OR t.description LIKE ?)');args.push(`%${opts.q}%`,`%${opts.q}%`);}
    if(['completed','cancelled'].includes(opts.status??'')){where.push('t.status=?');args.push(opts.status);}
    if(opts.type){where.push("COALESCE(t.task_type,'未分类')=?");args.push(opts.type);}
    const sql=where.join(' AND ');const total=Number(d.val<number>(`SELECT COUNT(*) FROM tasks t WHERE ${sql}`,...args)??0);
    const pages=Math.max(1,Math.ceil(total/30)), page=Math.min(pages,Math.max(1,Math.floor(opts.page)||1));
    const items=d.all<Json>(`SELECT t.*,u.display_name AS creator_name FROM tasks t LEFT JOIN users u ON u.id=t.creator_id WHERE ${sql} ORDER BY t.updated_at DESC,t.id LIMIT 30 OFFSET ?`,...args,(page-1)*30).map(t=>this.shape(t));
    const types=d.all<{type:string}>(`SELECT DISTINCT COALESCE(t.task_type,'未分类') AS type FROM tasks t WHERE ${base} ORDER BY type`,...baseArgs).map(r=>r.type);
    return {items,total,page,pages,types};
  }

  async create(actor: Actor, input: Json): Promise<Json> {
    const d = this.d();
    const title = sanitizeName(String(input.title ?? ''));
    if (!title || title === '未命名') throw AppError.validation('请填写任务标题');
    const status = (input.status as string) ?? 'draft';
    if (!['draft', 'ready_to_assign'].includes(status)) throw AppError.invalidTransition('新任务只能是草稿或待指派');
    if (input.team_id && !userTeams(actor.userId, actor.orgId).includes(String(input.team_id)) && !isOrgManager(actor)) {
      throw AppError.forbidden('不是该团队成员，不能在团队下建任务');
    }
    const stages = normalizeStages(input);
    const folder_id = str(input.folder_id);
    const id = uuid();
    const now = nowIso();
    d.tx(() => {
      d.run(`INSERT INTO tasks(id,organization_id,title,description,project,expected_deliverable,status,creator_id,
        assignee_id,reviewer_id,team_id,priority,due_at,criteria,source,source_ref,pending_assignee_id,progress,revision,
        handlers,handler_index,returned,folder_id,review_round,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,'[]',0,0,?,1,?,?)`,
        id, actor.orgId, title, str(input.description), str(input.project), str(input.expected_deliverable), status, actor.userId,
        null, str(input.reviewer_id), str(input.team_id), priorityToDb(input.priority),
        str(input.due_at), S(Array.isArray(input.criteria) ? input.criteria : []),
        str(input.source) ?? 'manual', S(input.source_ref ?? {}), null,
        folder_id, now, now);
      if(input.task_type) d.run('UPDATE tasks SET task_type=? WHERE id=?', String(input.task_type).trim().slice(0,120), id);
      // 草稿可携带经手环节建议（指派时落到 stages 列）；此处仅在显式带了 stages/handlers 时暂存建议
      if (stages.length) { const cols = stageColumns(stages, 0); d.run('UPDATE tasks SET stages=?, handlers=? WHERE id=?', cols.stages, cols.handlers, id); }
      this.log(id, null, status, actor.userId, 'create', '创建任务', {});
      this.event(id, actor.orgId, 'task.created', actor.userId, { title, status });
    });
    return this.get(actor, id);
  }

  async update(actor: Actor, input: { task_id: string; patch: Json }): Promise<Json> {
    const t = this.taskRowOr404(actor, input.task_id);
    const allowed = ['task_type', 'title', 'description', 'project', 'expected_deliverable', 'priority', 'due_at', 'criteria', 'reviewer_id', 'handlers', 'stages', 'folder_id',
      'schedule_date', 'schedule_start', 'schedule_end', 'schedule_note', 'estimate_min'];
    const patch = input.patch ?? {};
    if(patch.task_type !== undefined && (typeof patch.task_type !== 'string' || patch.task_type.length>120)) throw AppError.validation('任务类型最多120个字符');
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) throw AppError.validation('没有可修改的字段');
    const isCreator = t.creator_id === actor.userId;
    const editableByCreator = isCreator && (t.status === 'draft' || t.status === 'ready_to_assign');
    const editableByHandler = memberInStage(t, actor.userId)?.state === 'pending'; // 接收人「调整」（本环节还没接手的成员）
    // 负责阶段：当前环节已接手（未交接）的经手人可改关联工作区与排期，供「关联工作区」「排期」「自动排期」按钮使用
    const WORK_HANDLER_FIELDS = ['folder_id', 'schedule_date', 'schedule_start', 'schedule_end', 'schedule_note', 'estimate_min'];
    const editableByWorkHandler = memberInStage(t, actor.userId)?.state === 'accepted' && keys.every((k) => WORK_HANDLER_FIELDS.includes(k));
    if (!editableByCreator && !editableByHandler && !editableByWorkHandler) {
      throw AppError.forbidden('只有创建人可在指派前编辑、接收人可在「接收」调整、或当前经手人改关联工作区与排期');
    }
    const d = this.d();
    d.tx(() => {
      const chainTouched = patch.stages !== undefined || patch.handlers !== undefined;
      if (chainTouched) {
        const st = normalizeStages(patch);
        if (st.length) {
          const cols = stageColumns(st, 0);
          d.run('UPDATE tasks SET stages=?, handlers=?, handler_index=0, assignee_id=NULL WHERE id=?', cols.stages, cols.handlers, input.task_id);
        } else {
          d.run("UPDATE tasks SET stages='[]', handlers='[]', handler_index=0, assignee_id=NULL WHERE id=?", input.task_id);
        }
      }
      for (const k of keys) {
        if (k === 'handlers' || k === 'stages') continue; // 已上面统一处理
        const v = (k === 'criteria') ? S(patch[k])
          : (k === 'priority') ? priorityToDb(patch[k])
          : (k === 'estimate_min') ? (patch[k] === null || patch[k] === '' || patch[k] === undefined ? null : Math.max(1, Math.min(1440, Math.round(Number(patch[k]) || 0))))
          : str(patch[k]);
        d.run(`UPDATE tasks SET ${k}=? WHERE id=?`, v, input.task_id);
      }
      if (chainTouched && t.status === 'ready_to_assign') {
        // 编辑经手环节但不自动指派（仍留在创建 tab，由创建人点「确认并指派」）
      }
      d.run('UPDATE tasks SET revision=revision+1, updated_at=? WHERE id=?', nowIso(), input.task_id);
      this.log(input.task_id, String(t.status), String(t.status), actor.userId, 'update', `更新：${keys.join('、')}`, patch);
      this.event(input.task_id, String(t.organization_id), 'task.updated', actor.userId, { fields: keys });
    });
    return this.get(actor, input.task_id);
  }

  // ---------- 流转 ----------
  async transition(actor: Actor, input: { task_id: string; action: string; payload?: Json; idempotency_key?: string }): Promise<Json> {
    const t = this.taskRowOr404(actor, input.task_id);
    const action = input.action;
    const payload = input.payload ?? {};
    const from = String(t.status);
    if (!ALLOWED[action]) throw AppError.invalidTransition(`不支持的动作：${action}`);
    // 环节化流转：这些动作按「我在当前环节里的成员状态」放行，而非只看全局 status——
    // 同一环节里 A 先接收后全局会变 accepted/in_progress，B 仍可各自接收 / 交接 / 退回。
    const member = memberInStage(t, actor.userId);
    const memberGated: Record<string, boolean> = {
      accept: !!member && member.state === 'pending',
      reject: !!member && member.state === 'pending',
      handoff_next: !!member && member.state === 'accepted',
      submit: !!member && member.state === 'accepted',
    };
    if (!memberGated[action] && !ALLOWED[action].includes(from)) {
      throw AppError.invalidTransition(`当前阶段（${statusLabel(from)}）不能执行「${actionLabel(action)}」`);
    }
    if (TERMINAL.includes(from) && (memberGated[action] === true)) {
      throw AppError.invalidTransition(`任务已结束，不能${actionLabel(action)}`);
    }
    const d = this.d();
    if (input.idempotency_key && action === 'submit') {
      const hit = d.get<Json>('SELECT * FROM task_transitions WHERE task_id=? AND action=? AND note=? AND fields=?',
        input.task_id, action, input.idempotency_key, S(payload));
      if (hit) return this.get(actor, input.task_id);
    }
    switch (action) {
      case 'assign': {
        const stages = normalizeStages(payload);
        if (!stages.length) throw AppError.validation('至少需要安排一个经手环节，否则任务没人做', { handlers: '至少 1 人' });
        const reviewer = str(payload.reviewer_id) ?? str(t.reviewer_id);
        const due = str(payload.due_at) ?? str(t.due_at);
        const deliverable = str(payload.expected_deliverable) ?? str(t.expected_deliverable);
        const folder_id = payload.folder_id !== undefined ? str(payload.folder_id) : str(t.folder_id);
        if (!reviewer) throw AppError.validation('需要指定任务交付人（验收人）', { reviewer_id: '必填' });
        for (const s of stages) for (const m of s) this.assertMember(m.id, String(t.organization_id));
        this.assertMember(reviewer, String(t.organization_id));
        const cols = stageColumns(stages, 0);
        d.tx(() => {
          d.run(`UPDATE tasks SET stages=?, handlers=?, handler_index=0, assignee_id=?, reviewer_id=?, due_at=?, expected_deliverable=?, folder_id=?,
            criteria=?, status='pending_accept', returned=0, reject_reason=NULL, handler_log='[]', revision=revision+1, updated_at=? WHERE id=?`,
            cols.stages, cols.handlers, cols.assignee_id, reviewer, due, deliverable, folder_id,
            S(Array.isArray(payload.criteria) && payload.criteria.length ? payload.criteria : j(t.criteria as string, [])),
            nowIso(), input.task_id);
          this.log(input.task_id, from, 'pending_accept', actor.userId, 'assign',
            `指派：第 1 环节 ${stages[0].map((m) => nameOf(m.id)).join('、')}（共 ${stages.length} 个环节）`, { stages, reviewer });
          this.event(input.task_id, String(t.organization_id), 'task.assigned', actor.userId, { stages: flattenStages(stages), reviewer });
          for (const m of stages[0]) {
            if (m.id === actor.userId) continue;
            this.notifyTask(m.id, t, 'task_assigned', `${actor.displayName} 指派任务给你：${t.title}`,
              `交付人：${nameOf(reviewer)}${due ? `；期限：${due.slice(0, 10)}` : '（未设期限）'}`, input.task_id);
          }
        });
        break;
      }
      case 'accept': {
        const stages = readStages(t);
        const idx = Number(t.handler_index ?? 0);
        const me = stages[idx]?.find((m) => m.id === actor.userId);
        if (!me || me.state !== 'pending') throw AppError.forbidden('只有本环节还没接手的经手人可以接收');
        // 接收前必须填预估时长（分钟），之后在「负责」可改，供智能排期按它分配时间块
        const est = Number(payload.estimate_min);
        if (!Number.isFinite(est) || est <= 0 || est > 24 * 60) throw AppError.validation('接收任务需要先填写预估时长（1–1440 分钟）', { estimate_min: '必填' });
        const now = nowIso();
        me.state = 'accepted'; me.accepted_at = now;
        const cols = stageColumns(stages, idx);
        // 有人接手即整环节进入负责；若已是 in_progress（同环节有人已推进）不回退
        const to = from === 'pending_accept' ? 'accepted' : from;
        d.tx(() => {
          d.run('UPDATE tasks SET stages=?, handlers=?, assignee_id=?, status=?, returned=0, estimate_min=?, revision=revision+1, updated_at=? WHERE id=?',
            cols.stages, cols.handlers, cols.assignee_id, to, Math.round(est), now, input.task_id);
          this.log(input.task_id, from, to, actor.userId, 'accept', `${actor.displayName} 接收了本环节`, { estimate_min: est });
          this.event(input.task_id, String(t.organization_id), 'task.accepted', actor.userId, {});
          if (t.creator_id !== actor.userId) {
            this.notifyTask(String(t.creator_id), t, 'task_transition', `${actor.displayName} 已接收任务：${t.title}`, '', input.task_id);
          }
        });
        break;
      }
      case 'reject': {
        const note = str(payload.note) ?? str(payload.reason);
        if (!note) throw AppError.validation('退回需要说明原因', { note: '必填' });
        const stages = readStages(t);
        const idx = Number(t.handler_index ?? 0);
        const me = stages[idx]?.find((m) => m.id === actor.userId);
        if (!me || me.state !== 'pending') throw AppError.forbidden('只有本环节还没接手的经手人可以退回');
        const now = nowIso();
        me.state = 'rejected'; me.ended_at = now;
        const stage = stages[idx];
        // 单人不退回整链：只要还有人接手，任务不回创建人；仅当本环节全部退回才回退
        const backToCreator = stageAllRejected(stage);
        const cols = stageColumns(stages, idx);
        if (backToCreator) {
          d.tx(() => {
            d.run('UPDATE tasks SET stages=?, handlers=?, assignee_id=NULL, status=\'ready_to_assign\', returned=1, reject_reason=?, revision=revision+1, updated_at=? WHERE id=?',
              cols.stages, cols.handlers, note, now, input.task_id);
            this.log(input.task_id, from, 'ready_to_assign', actor.userId, 'reject', `本环节 ${stage.length} 人均退回：${note}`, { note });
            this.event(input.task_id, String(t.organization_id), 'task.rejected', actor.userId, { note });
            this.notifyTask(String(t.creator_id), t, 'task_transition', `${actor.displayName} 等退回了任务「${t.title}」`, note, input.task_id);
          });
        } else {
          const to = from === 'pending_accept' && stage.some((m) => m.state === 'accepted') ? 'accepted' : from;
          d.tx(() => {
            d.run('UPDATE tasks SET stages=?, handlers=?, assignee_id=?, status=?, reject_reason=?, revision=revision+1, updated_at=? WHERE id=?',
              cols.stages, cols.handlers, cols.assignee_id, to, note, now, input.task_id);
            this.log(input.task_id, from, to, actor.userId, 'reject', `${actor.displayName} 退回（本环节仍有人接手）：${note}`, { note });
            this.event(input.task_id, String(t.organization_id), 'task.rejected', actor.userId, { note });
            this.notifyTask(String(t.creator_id), t, 'task_transition', `${actor.displayName} 退回了任务「${t.title}」`, note, input.task_id);
          });
        }
        break;
      }
      case 'request_adjustment': {
        const note = str(payload.note);
        if (!note) throw AppError.validation('请求调整需要说明要调整什么', { note: '必填' });
        d.tx(() => {
          this.log(input.task_id, from, from, actor.userId, 'request_adjustment', note, payload);
          this.event(input.task_id, String(t.organization_id), 'task.adjustment_requested', actor.userId, { note });
          const target = String(t.creator_id ?? '');
          if (target && target !== actor.userId) {
            this.notifyTask(target, t, 'task_transition', `${actor.displayName} 对任务「${t.title}」请求调整`, note, input.task_id);
          }
        });
        break;
      }
      case 'start': {
        d.run('UPDATE tasks SET status=\'in_progress\', updated_at=? WHERE id=?', nowIso(), input.task_id);
        this.log(input.task_id, from, 'in_progress', actor.userId, 'start', '开始负责', payload);
        break;
      }
      case 'submit': {
        const versionIds = Array.isArray(payload.file_version_ids) ? (payload.file_version_ids as string[]) : [];
        if (!versionIds.length) throw AppError.validation('请至少选择一个工作区文件版本作为产物');
        if (versionIds.length > 20) throw AppError.validation('单次提交最多 20 个产物版本');
        if (memberInStage(t, actor.userId)?.state !== 'accepted') throw AppError.forbidden('只有本环节已接手的经手人可以提交产物');
        const note = str(payload.note);
        const files = await this.assertVersionsOwned(actor, versionIds);
        const seq = Number(d.val<number>('SELECT COALESCE(MAX(seq),0) FROM task_submissions WHERE task_id=?', input.task_id) ?? 0) + 1;
        d.tx(() => {
          const sid = uuid();
          d.run('INSERT INTO task_submissions(id,task_id,seq,submitter_id,file_version_ids,file_snapshot,note,status,created_at) VALUES(?,?,?,?,?,?,?,\'pending\',?)',
            sid, input.task_id, seq, actor.userId, S(versionIds), S(files), note ?? null, nowIso());
          // 提交产物不改变阶段（仍在「负责」里）；是否进入验收由「下游交接」推进
          d.run('UPDATE tasks SET status=\'in_progress\', updated_at=? WHERE id=?', nowIso(), input.task_id);
          this.log(input.task_id, from, 'in_progress', actor.userId, 'submit', note ?? `提交产物 v${seq}（${files.length} 个版本）`, { submission_id: sid, files });
          this.event(input.task_id, String(t.organization_id), 'submission.created', actor.userId, { submission_id: sid, seq });
        });
        break;
      }
      case 'handoff_next': {
        const stages = readStages(t);
        const idx = Number(t.handler_index ?? 0);
        const stage = stages[idx] ?? [];
        const me = stage.find((m) => m.id === actor.userId);
        if (!me || me.state !== 'accepted') throw AppError.forbidden('只有本环节已接手、还未交接的经手人可以下游交接');
        const note = str(payload.note);
        const now = nowIso();
        me.state = 'handed_off'; me.ended_at = now; me.duration_ms = me.accepted_at ? msBetween(me.accepted_at, now) : null;
        const allResolved = stageAllResolved(stage); // 本环节没人还停在 pending/accepted
        const advanced = idx + 1;
        const isLastStage = advanced >= stages.length;
        const cols = stageColumns(stages, idx);
        d.tx(() => {
          if (!allResolved) {
            // 还有人没交接：先结算我的这一手，任务停留在本环节等待其余经手人
            d.run('UPDATE tasks SET stages=?, handlers=?, assignee_id=?, revision=revision+1, updated_at=? WHERE id=?',
              cols.stages, cols.handlers, cols.assignee_id, now, input.task_id);
            this.log(input.task_id, from, from, actor.userId, 'handoff_next', `${actor.displayName} 已交接（本环节仍待其他经手人）${note ? '：' + note : ''}`,
              { waiting: stage.filter((m) => m.state === 'pending' || m.state === 'accepted').map((m) => m.id) });
          } else if (!isLastStage) {
            const nextStage = stages[advanced];
            const nextCols = stageColumns(stages, advanced);
            d.run('UPDATE tasks SET stages=?, handlers=?, handler_index=?, assignee_id=?, status=\'pending_accept\', revision=revision+1, updated_at=? WHERE id=?',
              nextCols.stages, nextCols.handlers, advanced, nextCols.assignee_id, now, input.task_id);
            const names = nextStage.map((m) => nameOf(m.id)).join('、');
            this.log(input.task_id, from, 'pending_accept', actor.userId, 'handoff_next', `本环节完成，交接给下一环节 ${names}${note ? '：' + note : ''}`, { next: nextStage.map((m) => m.id) });
            this.event(input.task_id, String(t.organization_id), 'task.handoff', actor.userId, { next: nextStage.map((m) => m.id) });
            for (const m of nextStage) { if (m.id !== actor.userId) this.notifyTask(m.id, t, 'task_assigned', `${actor.displayName} 把任务交接给你：${t.title}`, note ?? '', input.task_id); }
          } else {
            // 最后环节全部交接 → 交给交付人验收
            d.run('UPDATE tasks SET stages=?, handlers=?, status=\'pending_review\', revision=revision+1, updated_at=? WHERE id=?', S(stages), S(flattenStages(stages)), now, input.task_id);
            this.log(input.task_id, from, 'pending_review', actor.userId, 'handoff_next', `全部环节交接完成，提交交付人 ${nameOf(String(t.reviewer_id))} 验收${note ? '：' + note : ''}`, {});
            this.event(input.task_id, String(t.organization_id), 'task.submitted_review', actor.userId, {});
            this.notifyTask(String(t.reviewer_id), t, 'task_review', `待你验收：${t.title}`, note ?? '', input.task_id);
          }
        });
        break;
      }
      case 'review': {
        const decision = str(payload.decision) ?? 'approve';
        if (decision !== 'approve') throw AppError.validation('验收通过请用「完成验收」，不满意请「重新指派」');
        if (t.reviewer_id !== actor.userId) throw AppError.forbidden('只有任务交付人可以验收');
        const sub = d.get<Json>('SELECT * FROM task_submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1', input.task_id);
        const note = str(payload.note);
        const perCriteria = Array.isArray(payload.per_criteria) ? (payload.per_criteria as Json[]) : [];
        d.tx(() => {
          // 没有提交产物时也允许验收通过：task_reviews.submission_id 有非空外键，缺提交就不写这条历史行（验收结论仍记在 transitions）
          if (sub) {
            d.run('INSERT INTO task_reviews(id,task_id,submission_id,reviewer_id,decision,per_criteria,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
              uuid(), input.task_id, sub.id, actor.userId, 'approve', S(perCriteria), note ?? null, nowIso());
            d.run('UPDATE task_submissions SET status=\'approved\' WHERE id=?', sub.id);
          }
          d.run('UPDATE tasks SET status=\'completed\', progress=100, revision=revision+1, updated_at=? WHERE id=?', nowIso(), input.task_id);
          this.finalizeHandlerLog(input.task_id, 'review');
          this.log(input.task_id, from, 'completed', actor.userId, 'review', `完成验收：${note ?? ''}`, { decision: 'approve' });
          this.event(input.task_id, String(t.organization_id), 'review.created', actor.userId, { decision: 'approve' });
          this.notifyTask(String(t.assignee_id), t, 'review_result', `任务验收通过：${t.title}`, note ?? '', input.task_id);
          if (String(t.creator_id) !== String(t.assignee_id)) this.notifyTask(String(t.creator_id), t, 'review_result', `任务已完成：${t.title}`, '', input.task_id);
        });
        break;
      }
      case 'reassign': {
        if (t.reviewer_id !== actor.userId) throw AppError.forbidden('只有任务交付人可以重新指派');
        const stages = normalizeStages(payload);
        if (!stages.length) throw AppError.validation('重新指派需要至少一个经手环节', { handlers: '至少 1 人' });
        const reviewer = str(payload.reviewer_id) ?? str(t.reviewer_id);
        const due = str(payload.due_at) ?? str(t.due_at);
        const note = str(payload.note);
        if (!reviewer) throw AppError.validation('需要指定任务交付人', { reviewer_id: '必填' });
        for (const s of stages) for (const m of s) this.assertMember(m.id, String(t.organization_id));
        const round = Number(t.review_round ?? 1) + 1;
        const cols = stageColumns(stages, 0);
        const sub = d.get<Json>('SELECT * FROM task_submissions WHERE task_id=? ORDER BY seq DESC LIMIT 1', input.task_id);
        d.tx(() => {
          // 历史保留：有提交产物时记一条「退回/重新指派」验收记录；没有提交就不写这条外键行，旧 transitions 仍在
          if (sub) {
            d.run('INSERT INTO task_reviews(id,task_id,submission_id,reviewer_id,decision,per_criteria,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
              uuid(), input.task_id, sub.id, actor.userId, 'return', S([]), note ?? '验收不通过，重新指派', nowIso());
            d.run('UPDATE task_submissions SET status=\'returned\' WHERE id=?', sub.id);
          }
          d.run(`UPDATE tasks SET stages=?, handlers=?, handler_index=0, assignee_id=?, reviewer_id=?, due_at=?,
            status='pending_accept', returned=0, reject_reason=NULL, review_round=?, handler_log='[]', revision=revision+1, updated_at=? WHERE id=?`,
            cols.stages, cols.handlers, cols.assignee_id, reviewer, due, round, nowIso(), input.task_id);
          this.log(input.task_id, from, 'pending_accept', actor.userId, 'reassign',
            `重新指派（第 ${round} 轮）：第 1 环节 ${stages[0].map((m) => nameOf(m.id)).join('、')}（共 ${stages.length} 环节）${note ? '；原因：' + note : ''}`, { stages, round });
          this.event(input.task_id, String(t.organization_id), 'task.reassigned', actor.userId, { round, stages: flattenStages(stages) });
          for (const m of stages[0]) { if (m.id !== actor.userId) this.notifyTask(m.id, t, 'task_assigned', `${actor.displayName} 重新把任务指派给你：${t.title}`, note ?? '', input.task_id); }
        });
        break;
      }
      case 'transfer': {
        const to = str(payload.assignee_id);
        if (!to) throw AppError.validation('转派需要新经手人', { assignee_id: '必填' });
        if (to === actor.userId) throw AppError.validation('不能转给自己');
        this.assertMember(to, String(t.organization_id));
        const stages = readStages(t);
        const idx = Number(t.handler_index ?? 0);
        const stage = stages[idx] ?? [];
        const me = stage.find((m) => m.id === actor.userId);
        if (!me) throw AppError.forbidden('你不是本环节的经手人');
        if (stage.some((m) => m.id === to)) throw AppError.validation('该成员已在本环节');
        d.tx(() => {
          me.id = to; me.state = 'pending'; me.accepted_at = null; me.ended_at = null; me.duration_ms = null;
          const cols = stageColumns(stages, idx);
          d.run('UPDATE tasks SET stages=?, handlers=?, assignee_id=?, status=\'pending_accept\', revision=revision+1, updated_at=? WHERE id=?',
            cols.stages, cols.handlers, cols.assignee_id, nowIso(), input.task_id);
          this.log(input.task_id, from, 'pending_accept', actor.userId, 'transfer', `转派给 ${nameOf(to)}`, { to });
          this.notifyTask(to, t, 'task_assigned', `${actor.displayName} 转派任务给你：${t.title}`, str(payload.note) ?? '', input.task_id);
        });
        break;
      }
      case 'cancel': {
        const reason = str(payload.reason) ?? str(payload.note);
        if (!reason) throw AppError.validation('取消任务需要原因', { reason: '必填' });
        if (!(t.creator_id === actor.userId || isOrgManager(actor) || (!!t.team_id && teamRole(actor.userId, String(t.team_id)) === 'lead'))) {
          throw AppError.forbidden('只有创建者、团队负责人或组织管理员可以取消');
        }
        d.tx(() => {
          d.run('UPDATE tasks SET status=\'cancelled\', cancelled_reason=?, revision=revision+1, updated_at=? WHERE id=?', reason, nowIso(), input.task_id);
          this.log(input.task_id, from, 'cancelled', actor.userId, 'cancel', reason, payload);
          this.event(input.task_id, String(t.organization_id), 'task.cancelled', actor.userId, { reason });
        });
        break;
      }
      case 'archive':
      case 'unarchive': {
        d.run('UPDATE tasks SET archived_at=?, updated_at=? WHERE id=?', action === 'archive' ? nowIso() : null, nowIso(), input.task_id);
        this.log(input.task_id, from, from, actor.userId, action, action === 'archive' ? '归档' : '取消归档', payload);
        break;
      }
      default:
        throw AppError.invalidTransition(`不支持的动作：${action}`);
    }
    return this.get(actor, input.task_id);
  }

  async addProgress(actor: Actor, input: { task_id: string; done_text?: string; blocked_text?: string; progress?: number }): Promise<Json> {
    const t = this.taskRowOr404(actor, input.task_id);
    if (t.assignee_id !== actor.userId && memberInStage(t, actor.userId)?.state !== 'accepted') throw AppError.forbidden('只有本环节已接手、未交接的经手人可以更新进度');
    if (!['accepted', 'in_progress', 'pending_review'].includes(String(t.status))) throw AppError.invalidTransition('当前阶段不能更新进度');
    if (!input.done_text && !input.blocked_text && input.progress === undefined) throw AppError.validation('请填写完成事项、阻塞或进度');
    const d = this.d();
    d.tx(() => {
      d.run('INSERT INTO task_progress(id,task_id,user_id,done_text,blocked_text,progress,created_at) VALUES(?,?,?,?,?,?,?)',
        uuid(), input.task_id, actor.userId, input.done_text ?? null, input.blocked_text ?? null,
        Math.max(0, Math.min(100, Number(input.progress ?? t.progress ?? 0))), nowIso());
      d.run('UPDATE tasks SET status=CASE WHEN status=\'accepted\' THEN \'in_progress\' ELSE status END, progress=?, blocked_note=?, updated_at=? WHERE id=?',
        Math.max(0, Math.min(100, Number(input.progress ?? t.progress ?? 0))), input.blocked_text ?? null, nowIso(), input.task_id);
      this.event(input.task_id, String(t.organization_id), 'task.progressed', actor.userId, { blocked: !!input.blocked_text });
    });
    return this.get(actor, input.task_id);
  }

  /** 某日期所在「周一~周日」的 7 个 ISO 日期 */
  private weekOf(date: string): string[] {
    const d0 = new Date(date + 'T00:00:00');
    const dow = (d0.getDay() + 6) % 7; // 0=Mon..6=Sun
    d0.setDate(d0.getDate() - dow);
    const out: string[] = [];
      for (let i = 0; i < 7; i++) { const dd = new Date(d0); dd.setDate(d0.getDate() + i); out.push(`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`); }
    return out;
  }

  /**
   * 「自动排期」：把当前用户「负责」里的任务，结合 **预估时长 + 优先级 + 期限(due)** 智能排进「本周」的工作时段
   * （每天上午 09:00–12:00 / 下午 14:00–18:00）。规则：期限近的、优先级高的先占靠前的时段；不排到过去、不排到晚于期限；
   * 时间块长度 = 预估时长（没填则按优先级兜底），确定性分配（不重叠、可复现）。理由在配了模型时用 AI 生成、没配用确定性文案——绝不伪造模型结果。
   */
  async autoSchedule(actor: Actor, opts: { date?: string }): Promise<Json> {
    const d = this.d();
    const localNow=new Date();
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date ?? '')) ? String(opts.date) : `${localNow.getFullYear()}-${String(localNow.getMonth()+1).padStart(2,'0')}-${String(localNow.getDate()).padStart(2,'0')}`;
    const week = this.weekOf(anchor);
    const rows = d.all<Json>(
      `SELECT t.* FROM tasks t WHERE t.organization_id=? AND t.status IN ('accepted','in_progress')
       AND ((t.stages<>'[]' AND ${SQL_MEMBER_ACCEPTED}) OR (t.stages='[]' AND t.assignee_id=?))`,
      actor.orgId, actor.userId, actor.userId);
    if (!rows.length) return { anchor, week, scheduled: 0, unscheduled: 0, used_model: false, note: '「负责」里暂无你的任务' };

    const dueOf = (r:Json)=>r.due_at?String(r.due_at).slice(0,10):null;
    const reserved=d.all<Json>(`SELECT id,schedule_date,schedule_start,schedule_end FROM tasks WHERE organization_id=? AND assignee_id=? AND status='completed' AND schedule_date>=? AND schedule_date<=? AND schedule_start IS NOT NULL AND schedule_end IS NOT NULL`,actor.orgId,actor.userId,week[0],week[6]).map(t=>({id:String(t.id),date:String(t.schedule_date),start:String(t.schedule_start),end:String(t.schedule_end)}));
    const candidates=rows.filter(r=>!r.schedule_date || String(r.schedule_date)<=week[6]);
    const {placed,overflow}=planWeek(candidates.map(r=>({id:r.id,priority:r.priority,due_at:r.due_at,estimate_min:r.estimate_min,created_at:r.created_at})),week,new Date(),reserved);

    const detReason = (r: Json) => {
      const p = priorityToT(r.priority); const due = dueOf(r); const e = Number(r.estimate_min);
      const h = e ? (e % 60 === 0 ? `${e / 60}` : (e / 60).toFixed(1)) : '';
      return `${p}${h ? `·预估${h}小时` : ''}${due ? `·${due.slice(5)} 前交付` : ''}，结合期限与空闲时段安排`;
    };
    const reasons = new Map<string, string>();
    if (modelStatus().configured && placed.length) {
      try {
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const items = placed.map((x) => { const r = byId.get(x.id) as Json; return { id: x.id, title: String(r.title ?? ''), day: x.date, start: x.start, end: x.end, priority: priorityToT(r.priority), due: dueOf(r), estimate_min: Number(r.estimate_min) || null }; });
        const { value } = await chatJson<{ reasons?: { id: string; reason: string }[] }>(
          { messages: [
            { role: 'system', content: '你是任务排期助手。结合优先级、期限(due)、预估时长，给每个任务一句不超过 16 字的中文排期理由，只依据给定信息不得杜撰。输出 JSON：{"reasons":[{"id":"","reason":""}]}' },
            { role: 'user', content: JSON.stringify({ items }) },
          ], json: true, temperature: 0.3, maxTokens: 800, purpose: 'auto_schedule' },
          (raw) => raw as { reasons?: { id: string; reason: string }[] });
        for (const x of (value?.reasons ?? [])) if (x && x.id && x.reason) reasons.set(String(x.id), String(x.reason).slice(0, 40));
      } catch { /* 模型失败 → 用确定性理由，不阻断排期 */ }
    }

    d.tx(() => {
      for (const taskId of overflow) {
        const task=rows.find(r=>String(r.id)===taskId);
        if(task?.schedule_date && String(task.schedule_date)>=week[0] && String(task.schedule_date)<=week[6]) {
          d.run('UPDATE tasks SET schedule_date=NULL,schedule_start=NULL,schedule_end=NULL,schedule_note=NULL,updated_at=? WHERE id=?',nowIso(),taskId);
          this.log(taskId,String(task.status),String(task.status),actor.userId,'schedule','本周容量不足，退回未排期',{});
        }
      }
      for (const x of placed) {
        const r = rows.find((rr) => String(rr.id) === x.id) as Json;
        const note = reasons.get(x.id) ?? detReason(r);
        d.run('UPDATE tasks SET schedule_date=?, schedule_start=?, schedule_end=?, schedule_note=?, updated_at=? WHERE id=?',
          x.date, x.start, x.end, note, nowIso(), x.id);
        this.log(x.id, String(r.status), String(r.status), actor.userId, 'schedule', `自动排期 ${x.date} ${x.start}-${x.end}`, { note });
      }
    });
    return { anchor, week, scheduled: placed.length, unscheduled: overflow.length, used_model: reasons.size > 0 };
  }

  /**
   * 「在个人办公中处理」：任务绑定了工作区（folder_id）时，优先复用该用户在这个工作区下的个人会话，
   * 没有就新开一个属于该工作区的个人会话。没有关联工作区时，回落到任务默认标题会话（仍可手选）。
   */
  async agentSessionFor(actor: Actor, input: { task_id: string; choice?: { mode: 'personal' | 'team'; folder_id?: string; team_id?: string } }): Promise<{ session_id: string; created: boolean }> {
    const t = this.taskRowOr404(actor, input.task_id);
    if (t.agent_session_id) {
      const exists = this.d().get<{ id: string; folder_id: string }>('SELECT id, folder_id FROM agent_sessions WHERE id=?', t.agent_session_id);
      // 已绑定的会话仍在，且工作区没换 → 直接打开
      if (exists && String(exists.folder_id ?? '') === String(t.folder_id ?? '')) return { session_id: String(t.agent_session_id), created: false };
    }
    const folderId = str(input.choice?.folder_id) ?? str(t.folder_id);
    if (!folderId) throw AppError.validation('这个任务还没关联工作区，请先在编辑里选择工作区再处理', { folder_id: '需要工作区' });
    const sessions = need('sessions');
    // 复用：该用户在该工作区下已有的个人会话
    const existing = this.d().get<{ id: string }>(
      `SELECT id FROM agent_sessions WHERE mode='personal' AND folder_id=? AND id IN
         (SELECT session_id FROM session_participants WHERE user_id=?)
       ORDER BY updated_at DESC LIMIT 1`, folderId, actor.userId);
    if (existing && !input.choice) {
      this.d().run('UPDATE tasks SET agent_session_id=?, updated_at=? WHERE id=?', existing.id, nowIso(), input.task_id);
      return { session_id: String(existing.id), created: false };
    }
    const s = await sessions.createPersonal(actor, { title: `${String(t.title)}`, folder_id: folderId, include_children: true });
    const sessionId = String(s.id ?? s.session_id);
    this.d().run('UPDATE tasks SET agent_session_id=?, updated_at=? WHERE id=?', sessionId, nowIso(), input.task_id);
    this.log(input.task_id, String(t.status), String(t.status), actor.userId, 'agent', '在工作区开启处理会话', { session_id: sessionId, folder_id: folderId });
    return { session_id: sessionId, created: true };
  }

  // ---------- 内部 ----------
  private taskRowOr404(actor: Actor, id: string): Json {
    const t = this.d().get<Json>('SELECT * FROM tasks WHERE id=?', id);
    if (!t || t.organization_id !== actor.orgId) throw AppError.notFound('任务不存在');
    const teams = userTeams(actor.userId, actor.orgId);
    const visible = t.creator_id === actor.userId || t.assignee_id === actor.userId || t.reviewer_id === actor.userId
      || t.pending_assignee_id === actor.userId
      || isCurrentHandlerRow(t, actor.userId)
      || (!!t.team_id && teams.includes(String(t.team_id))) || isOrgManager(actor);
    if (!visible) throw AppError.notFound('任务不存在');
    return t;
  }

  private assertMember(userId: string, orgId: string) {
    if (!this.d().get('SELECT 1 AS x FROM memberships WHERE user_id=? AND organization_id=? AND status=\'active\'', userId, orgId)) {
      throw AppError.validation('所选人员不是本组织有效成员', { handler: '无效成员' });
    }
  }

  private async assertVersionsOwned(actor: Actor, versionIds: string[]): Promise<Json[]> {
    const d = this.d();
    const out: Json[] = [];
    for (const vid of versionIds) {
      const v = d.get<Json>(`SELECT fv.*, f.name, f.status AS file_status, f.organization_id, f.owner_id, f.space
        FROM file_versions fv JOIN files f ON f.id=fv.file_id WHERE fv.id=?`, vid);
      if (!v || v.organization_id !== actor.orgId) throw AppError.notFound('产物版本不存在');
      if (v.file_status !== 'active') throw AppError.busy('该文件已在回收站，不能作为产物提交', { file_id: v.file_id });
      let readable = false;
      try { await need('files').getFile(actor, String(v.file_id), { require: 'viewer' }); readable = true; } catch { readable = false; }
      if (!readable) throw AppError.forbidden('没有该产物版本的读取权');
      out.push({ file_id: v.file_id, version_id: vid, name: v.name, version_no: v.version_no, sha256: v.sha256, size: v.size, change_source: v.change_source });
    }
    return out;
  }

  /** 本环开始：若最后一条 log 还开着，先结算，再开新环 */
  private pushHandlerLog(taskId: string, userId: string, action: string, endedAt: string | null) {
    const d = this.d();
    const row = d.get<{ handler_log: string }>('SELECT handler_log FROM tasks WHERE id=?', taskId);
    const log = j<Json[]>(row?.handler_log ?? '[]', []);
    const now = nowIso();
    if (log.length && !log[log.length - 1].ended_at) {
      log[log.length - 1] = { ...log[log.length - 1], ended_at: now, action: action, duration_ms: msBetween(String(log[log.length - 1].accepted_at), now) };
    }
    log.push({ user_id: userId, accepted_at: now, ended_at: endedAt, action: 'accept', duration_ms: null });
    d.run('UPDATE tasks SET handler_log=? WHERE id=?', S(log), taskId);
  }

  /** 本环结束：结算最后一条 log 的用时 */
  private finalizeHandlerLog(taskId: string, action: string) {
    const d = this.d();
    const row = d.get<{ handler_log: string }>('SELECT handler_log FROM tasks WHERE id=?', taskId);
    const log = j<Json[]>(row?.handler_log ?? '[]', []);
    const now = nowIso();
    if (log.length && !log[log.length - 1].ended_at) {
      const last = log[log.length - 1];
      log[log.length - 1] = { ...last, ended_at: now, action, duration_ms: msBetween(String(last.accepted_at), now) };
      d.run('UPDATE tasks SET handler_log=? WHERE id=?', S(log), taskId);
    }
  }

  /** 详情 / 验收：拼出「创建人 →（环节1 [多人] → 环节2 …）→ 交付人」，每环含各经手人状态与用时 */
  private buildChain(t: Json): Json[] {
    const avatarOf=(id:string)=>j<Json>(this.d().val<string>('SELECT prefs FROM users WHERE id=?',id)??'{}',{}).avatar??null;
    const status = String(t.status);
    const stages = readStages(t);
    const idx = Number(t.handler_index ?? 0);
    const out: Json[] = [];
    out.push({ role: 'creator', user_id: String(t.creator_id), name: nameOf(String(t.creator_id)), avatar:avatarOf(String(t.creator_id)), state: 'done', duration_ms: null });
    stages.forEach((stage, i) => {
      const stageState = i < idx ? 'done'
        : i > idx ? (['pending_review', 'completed'].includes(status) ? 'done' : 'pending')
          : (['pending_review', 'completed'].includes(status) ? 'done'
            : stage.some((m) => m.state === 'accepted') ? 'active'
              : stage.some((m) => m.state === 'pending') ? 'waiting'
                : 'done');
      const members = stage.map((m) => ({
        user_id: m.id, name: nameOf(m.id), avatar:avatarOf(m.id),
        state: m.state === 'handed_off' ? 'done' : m.state === 'rejected' ? 'rejected' : m.state === 'accepted' ? 'active' : 'waiting',
        accepted_at: m.accepted_at, ended_at: m.ended_at, duration_ms: m.duration_ms ?? null,
      }));
      out.push({ role: 'stage', index: i, state: stageState, members });
    });
    out.push({ role: 'reviewer', user_id: String(t.reviewer_id ?? ''), name: t.reviewer_id ? nameOf(String(t.reviewer_id)) : '未指定交付人',avatar:avatarOf(String(t.reviewer_id??'')),
      state: status === 'pending_review' ? 'active' : status === 'completed' ? 'done' : 'pending',
      duration_ms: status === 'completed' ? msBetween(String(j<Json[]>(t.handler_log as string, [])[0]?.accepted_at ?? String(t.created_at)), String(t.updated_at)) : null });
    return out;
  }

  private log(taskId: string, from: string | null, to: string, actorId: string, action: string, note: string, fields: Json) {
    this.d().run('INSERT INTO task_transitions(id,task_id,from_status,to_status,actor_id,action,note,fields,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      uuid(), taskId, from, to, actorId, action, note, S(fields ?? {}), nowIso());
  }

  private notifyTask(userId: string, t: Json, type: string, title: string, body: string, taskId: string) {
    if (!userId) return;
    notify({
      user_id: userId, organization_id: String(t.organization_id), type, title, body,
      entity_type: 'task', entity_id: taskId, task_id: taskId, target_path: `/task?tab=${STAGE_OF[String(t.status)] ?? 'create'}&focus=${taskId}`,
    });
  }

  private event(taskId: string, orgId: string, type: string, actorId: string, payload: Json) {
    const ev = appendEvent({ type, organization_id: orgId, entity_type: 'task', entity_id: taskId, actor_id: actorId, task_id: taskId, payload });
    const recipients = this.d().all<{ assignee_id: string; creator_id: string; reviewer_id: string }>(
      'SELECT assignee_id, creator_id, reviewer_id FROM tasks WHERE id=?', taskId)[0];
    const users = recipients ? Array.from(new Set([recipients.assignee_id, recipients.creator_id, recipients.reviewer_id].filter(Boolean) as string[])) : [];
    queueOutbox(users.map((u) => ({ user_id: u, channel: 'ws' })), ev.seq);
  }

  private shape(t: Json): Json {
    const status = String(t.status);
    const stages = readStages(t);
    return {
      ...t,
      handlers: j<string[]>(t.handlers as string, []),
      handler_log: j<Json[]>(t.handler_log as string, []),
      stages,                                             // 环节化结构：[[{id,state,...}], ...]
      stage_users: stages.map((s) => s.map((m) => m.id)),  // 编辑器友好的 string[][]（每环节的 user_id 列表）
      stage: STAGE_OF[status] ?? 'create',
      status_label: statusLabel(status),
      priority_label: priorityToT(t.priority),
      criteria: j<Json[]>(t.criteria as string, []),
      source_ref: j<Json>(t.source_ref as string, {}),
      returned: Number(t.returned ?? 0) === 1,
      scheduled: !!(t.schedule_date && t.schedule_start),
      schedule_label: t.schedule_date && t.schedule_start ? `${String(t.schedule_start)}-${String(t.schedule_end ?? '')}` : null,
      is_overdue: !!t.due_at && status !== 'completed' && status !== 'cancelled' && String(t.due_at) < nowIso(),
    };
  }
}

const STAGE_STATUS_SQL: Record<string, { sql: string; params: (string | number)[] }> = {
  create: { sql: "t.status IN ('draft','ready_to_assign')", params: [] },
  receive: { sql: "t.status='pending_accept'", params: [] },
  work: { sql: "t.status IN ('accepted','in_progress')", params: [] },
  review: { sql: "t.status='pending_review'", params: [] },
};

function isCurrentHandlerRow(t: Json, userId: string): boolean {
  const handlers = j<string[]>(t.handlers as string, []);
  const idx = Number(t.handler_index ?? 0);
  return handlers.includes(userId);
}

function normHandlers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x) out.push(x);
    else if (x && typeof x === 'object') { const id = String((x as Json).user_id ?? (x as Json).id ?? ''); if (id) out.push(id); }
  }
  return out.slice(0, MAX_HANDLERS);
}

// ==================== 环节化经手人（多经手人协作）helper ====================

/** 空的经手人成员行 */
function newMember(id: string): Member { return { id, state: 'pending', accepted_at: null, ended_at: null, duration_ms: null }; }

/** 校验并规范化环节结构：接受 stages(string[][]) 或老的线性 handlers(string[]→每人一个环节)。返回去空、去重后限幅的 Stage[] */
export function normalizeStages(payload: Json): Stage[] {
  let groups: unknown[];
  if (Array.isArray(payload?.stages)) groups = payload.stages;
  else if (Array.isArray(payload?.handlers)) groups = (payload.handlers as unknown[]).map((h) => [h]); // 线性：每人自成环节
  else groups = [];
  const out: Stage[] = [];
  for (const g of groups) {
    const ids = Array.isArray(g) ? g : [g];
    const seen = new Set<string>();
    const members: Member[] = [];
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw : String((raw as Json)?.id ?? (raw as Json)?.user_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      members.push(newMember(id));
      if (members.length >= MAX_PER_STAGE) break;
    }
    if (members.length) out.push(members);
    if (out.length >= MAX_STAGES) break;
  }
  return out;
}

/** 环节并集（有序去重），写进既有 handlers 列供姓名/可见性等老逻辑复用 */
export function flattenStages(stages: Stage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stages) for (const m of s) if (!seen.has(m.id)) { seen.add(m.id); out.push(m.id); }
  return out;
}

/** 当前环节的「代表处理人」：第一个还没处理完（pending/accepted）的成员 */
function representativeOf(stage: Stage | undefined): string | null {
  if (!stage || !stage.length) return null;
  return stage.find((m) => m.state === 'pending' || m.state === 'accepted')?.id ?? stage[0]?.id ?? null;
}

/**
 * 读取任务环节结构。新任务读 stages 列；
 * 老任务（stages 为空但有线性 handlers）即时折算成「每人一个环节」，并按 handler_log/status/handler_index 回填状态，
 * 保证改版前的演示数据与历史任务无需迁移也能正确显示与流转。
 */
function readStages(t: Json): Stage[] {
  const stored = j<Stage[]>(t.stages as string, []);
  if (Array.isArray(stored) && stored.length) return stored;
  const handlers = j<string[]>(t.handlers as string, []);
  if (!handlers.length) return [];
  const idx = Number(t.handler_index ?? 0);
  const log = j<Json[]>(t.handler_log as string, []);
  const status = String(t.status);
  const rec = (uid: string) => log.find((x) => String(x.user_id) === uid);
  return handlers.map((h, i): Stage => {
    const r = rec(h) as Json | undefined;
    let state = 'pending';
    if (i < idx) state = 'handed_off';
    else if (i === idx) {
      if (['completed'].includes(status)) state = 'handed_off';
      else if (['pending_review'].includes(status)) state = 'handed_off';
      else if (['accepted', 'in_progress'].includes(status)) state = 'accepted';
      else if (status === 'ready_to_assign' && Number(t.returned ?? 0) === 1) state = 'rejected';
      else state = 'pending';
    }
    return [{ id: h, state, accepted_at: (r?.accepted_at as string) ?? null, ended_at: (r?.ended_at as string) ?? null, duration_ms: (r?.duration_ms as number) ?? null }];
  });
}

/** 当前环节 */
function currentStage(t: Json): Stage { const s = readStages(t); return s[Number(t.handler_index ?? 0)] ?? []; }

/** 某用户在当前环节的成员行（没有返回 null） */
function memberInStage(t: Json, uid: string): Member | null { return currentStage(t).find((m) => m.id === uid) ?? null; }

/** 本环节是否已「全体处理完」（没有人还停在 pending/accepted） */
function stageAllResolved(stage: Stage): boolean { return stage.length > 0 && stage.every((m) => m.state === 'handed_off' || m.state === 'rejected'); }
/** 本环节是否「全体退回」（没有任何人接手过） */
function stageAllRejected(stage: Stage): boolean { return stage.length > 0 && stage.every((m) => m.state === 'rejected'); }

/** 列表归属判定用：当前环节里「我还没接手（pending）」 */
export const SQL_MEMBER_PENDING = `(EXISTS(SELECT 1 FROM json_each(json_extract(t.stages,'$['||CAST(t.handler_index AS TEXT)||']')) u
  WHERE json_extract(u.value,'$.id')=? AND json_extract(u.value,'$.state')='pending'))`;
/** 列表归属判定用：当前环节里「我已接手但未交接（accepted）」 */
export const SQL_MEMBER_ACCEPTED = `(EXISTS(SELECT 1 FROM json_each(json_extract(t.stages,'$['||CAST(t.handler_index AS TEXT)||']')) u
  WHERE json_extract(u.value,'$.id')=? AND json_extract(u.value,'$.state')='accepted'))`;

/** 写回 stages/handlers/assignee/handler_index（保持老列语义同步），返回新的 tasks 更新对 */
function stageColumns(stages: Stage[], stageIndex: number): { stages: string; handlers: string; handler_index: number; assignee_id: string | null } {
  return { stages: S(stages), handlers: S(flattenStages(stages)), handler_index: stageIndex, assignee_id: representativeOf(stages[stageIndex]) };
}


function msBetween(a: string, b: string): number {
  const x = Date.parse(a), y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.max(0, y - x);
}

/** 分钟数 → 'HH:MM'（夹在 0–24h） */
function fmtMin(min: number): string {
  const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

export function statusLabel(status: string): string {
  return ({
    draft: '草稿', ready_to_assign: '待指派', pending_accept: '待接收', accepted: '已接收',
    in_progress: '进行中', pending_transfer: '转派待接收', pending_review: '待验收',
    completed: '已完成', cancelled: '已取消',
  } as Record<string, string>)[status] ?? status;
}

function actionLabel(action: string): string {
  return ({
    publish: '发布', assign: '指派', accept: '接收', request_adjustment: '请求调整', reject: '退回',
    transfer: '转派', start: '开始', submit: '提交产物', review: '完成验收', reassign: '重新指派', cancel: '取消',
    handoff_next: '下游交接', archive: '归档', unarchive: '取消归档',
  } as Record<string, string>)[action] ?? action;
}

function nameOf(userId: string): string {
  if (!userId) return '未知成员';
  return getDb().val<string>('SELECT display_name FROM users WHERE id=?', userId) ?? '未知成员';
}

let instance: TasksService | null = null;
export function getTasksService(): TasksService {
  if (!instance) instance = new TasksService();
  return instance;
}
