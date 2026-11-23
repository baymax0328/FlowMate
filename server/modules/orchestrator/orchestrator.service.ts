// FlowMate · 编排服务（PRD §08 / §11 / §12 / §17）
// 服务层负责：请求落库 → 计划生成 → 子任务 Run 入队 → 查询/取消/重试/澄清/冲突处理。
// 真实执行与并发在 scheduler.runner.ts，工具白名单与围栏在 tools.ts。
import { Injectable } from '@nestjs/common';
import { appendEvent, getDb, j, nowIso, queueOutbox, S, uuid } from '../../core/db';
import { config } from '../../core/config';
import { AppError } from '../../core/errors';
import { assertSessionAccess, canEdit, type Actor } from '../../core/permissions';
import type { OrchestratorService as OrchestratorContract, Json } from '../../core/contracts';
import { need } from '../../core/contracts';
import { generatePlan, detectAmbiguity, goalPaths, planFromRow, type PlanSubtask } from './planner';
import { resolveConflictSync, insertConflict } from './conflicts';
import {
  appendSessionMessage, kickScheduler, setRunStatus, reconcileRequest,
} from './scheduler.runner';
import { readRunRow, requestRow, nextQueuePosition, insertRequest, insertRun } from './orchestrator.rows';
import { TOOL_NAMES, DISABLED_TOOLS, PERMANENTLY_FORBIDDEN } from './tools';

const TERMINAL_RUN = ['succeeded', 'failed', 'cancelled'];

@Injectable()
export class OrchestratorService implements OrchestratorContract {
  private d = () => getDb();

  /** 工具白名单（供界面与审计展示：不在表内的能力一律不存在） */
  toolCatalog() {
    return {
      allowed: TOOL_NAMES,
      disabled_first_release: Object.entries(DISABLED_TOOLS).map(([k, v]) => ({ tool: k, message: v })),
      never_implemented: PERMANENTLY_FORBIDDEN,
      note: 'Agent 只处理会话绑定的工作区与会话内数据；不执行命令、不联网、不读凭据、不删文件。',
    };
  }

  async createRequest(actor: Actor, input: {
    session_id: string; goal: string; output_kind?: 'draft' | 'formal_change' | 'answer';
    target_file_id?: string | null; source_message_id?: string | null; aux_ids?: string[]; idempotency_key?: string;
    /** 对话外观（工作模式）：不写请求卡、结果按普通回答气泡落库，但仍可读工作区与执行改动 */
    chat_mode?: boolean;
  }): Promise<{ request: Json; runs: Json[]; clarification?: string }> {
    const access = assertSessionAccess(actor, input.session_id, 'write');
    const d = this.d();
    const session = d.get<Json>('SELECT * FROM agent_sessions WHERE id=?', input.session_id);
    if (!session) throw AppError.notFound('会话不存在');
    const goal = (input.goal ?? '').trim();
    if (!goal) throw AppError.validation('请输入问题或任务');

    // 幂等：同一 Idempotency-Key 或同会话内完全相同的进行中请求不重复建
    if (input.idempotency_key) {
      const hit = d.get<Json>('SELECT * FROM requests WHERE session_id=? AND idempotency_key=?', input.session_id, input.idempotency_key);
      if (hit) return { request: this.requestJson(hit), runs: this.runsOfRequest(String(hit.id)), clarification: undefined };
    }

    const binding = await need('sessions').bindingInfo(actor, input.session_id);
    const outputKind = input.output_kind ?? (input.target_file_id ? 'formal_change' : 'draft');
    if (outputKind === 'formal_change' && !input.target_file_id) throw AppError.validation('正式变更需要指定目标文件');
    if (input.target_file_id && !canEdit(actor, 'file', input.target_file_id)) {
      // 无编辑权仍可发起请求，但提案阶段执行者必须具备编辑权（§11.2）
      void 0;
    }
    // 对话外观 + 有工作区 = 「能读能干的问答」：规划成一个带读范围的 answer 子任务，
    // 结果是一句普通回答，而不是一堆卡片与草稿文件。
    const chatMode = input.chat_mode === true && outputKind !== 'formal_change';
    const ambiguity = chatMode || outputKind === 'answer' ? null : detectAmbiguity(goal, outputKind, input.target_file_id ?? null);
    const plan = await generatePlan({
      goal, outputKind: chatMode ? 'answer' : outputKind, targetFileId: input.target_file_id ?? null,
      sessionId: input.session_id, organizationId: String(session.organization_id), actorId: actor.userId,
      rootFolderId: binding.folder_id ? String(binding.folder_id) : null,
      includeChildren: !!binding.include_children,
      grounded: chatMode,
    });

    // 指令里显式写了路径时，服务端把它并入首个只读子任务的 read_paths：
    // 越界防护不能依赖模型「愿不愿意」去读那个路径——工具层的 canonical 校验必须真的被触发并留下 denied 步骤。
    const explicitPaths = goalPaths(goal);
    if (explicitPaths.length) {
      const gather = plan.subtasks.find((st) => st.exec === 'gather') ?? plan.subtasks[0];
      if (gather) gather.read_paths = Array.from(new Set([...(gather.read_paths ?? []), ...explicitPaths])).slice(0, 3);
    }
    ensureFormalStep(plan.subtasks, outputKind, input.target_file_id ?? null);

    const requestId = uuid();
    const now = nowIso();
    const clarification = ambiguity ?? plan.clarification;
    const writeScope = outputKind === 'formal_change' && input.target_file_id
      ? [{ file_id: input.target_file_id, kind: 'formal_file' }]
      : plan.subtasks.flatMap((s) => (s.write_paths ?? []).map((p) => ({ path: p, kind: 'draft' })));

    d.tx(() => {
      const requestId2 = insertRequest({
        id: requestId,
        organizationId: String(session.organization_id), sessionId: input.session_id, creatorId: actor.userId,
        goal, outputKind, writeScope, risk: riskOf(plan.subtasks),
        status: clarification ? 'needs_clarification' : 'planned',
        plan: plan.subtasks as unknown as Json[], clarification: clarification ?? null,
        idempotencyKey: input.idempotency_key ?? null, sourceMessageId: input.source_message_id ?? null,
        planner: plan.planner, auxIds: input.aux_ids ?? [], chatMode,
      });
      void requestId2;

      if (!clarification) this.insertRuns(actor, requestId, input.session_id, String(session.organization_id), plan.subtasks, plan.planner, outputKind);

      // 工作模式（对话外观）：用户那句按普通消息落库，不产出请求卡；
      // 其余（显式交给 Agent 干活、正式变更）仍用卡片，让审计看得见「这是一次执行」。
      appendSessionMessage({
        session_id: input.session_id, organization_id: String(session.organization_id), actor_id: actor.userId,
        role: 'user', kind: chatMode ? 'message' : 'request_card', body: goal, ref_type: 'request', ref_id: requestId,
        aux: chatMode
          ? { parent_id:input.source_message_id??null, request_id: requestId, goal, chat_mode: true, output_kind: outputKind, creator_name: actor.displayName, planner: plan.planner }
          : {
            request_id: requestId, goal, output_kind: outputKind,
            write_scope: writeScope, risk: riskOf(plan.subtasks),
            stage: clarification ? '待补充' : '已规划',
            creator_name: actor.displayName, planner: plan.planner,
          },
      });
      if (clarification) {
        appendSessionMessage({
          session_id: input.session_id, organization_id: String(session.organization_id),
          role: 'system', kind: 'clarification', body: clarification, ref_type: 'request', ref_id: requestId,
          aux: { request_id: requestId },
        });
      }
      const ev = appendEvent({
        type: clarification ? 'request.needs_clarification' : 'request.created',
        organization_id: String(session.organization_id), entity_type: 'session', entity_id: input.session_id,
        actor_id: actor.userId, session_id: input.session_id, run_id: null,
        payload: { request_id: requestId, status: clarification ? 'needs_clarification' : 'planned', planner: plan.planner },
      });
      queueOutbox(wsOf(input.session_id), ev.seq);
    });

    if (!clarification) kickScheduler('新请求已规划');
    const reqJson = this.requestJson(d.get<Json>('SELECT * FROM requests WHERE id=?', requestId)!);
    return { request: reqJson, runs: this.runsOfRequest(requestId), clarification: clarification ?? undefined };
  }

  private insertRuns(actor: Actor, requestId: string, sessionId: string, orgId: string, subtasks: PlanSubtask[], planner: string, outputKind: string) {
    const d = this.d();
    const idBySub = new Map<string, string>();
    for (const st of subtasks) idBySub.set(st.subtask_id, uuid());
    let pos = nextQueuePosition(sessionId);
    for (const st of subtasks) {
      const deps = (st.depends_on ?? []).map((x) => idBySub.get(x)).filter(Boolean) as string[];
      const queueReason = deps.length
        ? `等待前序子任务完成：${(st.depends_on ?? []).join('、')}`
        : st.parallel_reason ?? (st.exec === 'formal_change' ? '同一文件的正式提交按资源级串行' : null);
      insertRun({
        organizationId: orgId, requestId, sessionId,
        subtaskId: st.subtask_id, subtaskName: st.name,
        queuePosition: pos++, queueReason,
        dependsOn: deps,
        readSet: (st.read_paths ?? []).map((p) => ({ path: p })),
        writeSet: [...(st.write_paths ?? []).map((p) => ({ path: p })), ...(st.write_file_ids ?? []).map((f) => ({ file_id: f }))],
        planner, outputKind: st.output_kind ?? outputKind,
      });
    }
    const ev = appendEvent({
      type: 'plan.updated', organization_id: orgId, entity_type: 'session', entity_id: sessionId,
      payload: { request_id: requestId, subtasks: subtasks.length, planner },
    });
    queueOutbox(wsOf(sessionId), ev.seq);
    void d; void actor;
  }

  private runsOfRequest(requestId: string): Json[] {
    return this.d().all<Json>('SELECT * FROM runs WHERE request_id=? ORDER BY created_at', requestId).map((r) => this.runJson(r));
  }

  async runsOfSession(actor: Actor, session_id: string): Promise<Json[]> {
    assertSessionAccess(actor, session_id, 'read');
    return this.d().all<Json>(
      `SELECT r.*, u.display_name AS creator_name FROM runs r JOIN requests q ON q.id=r.request_id JOIN users u ON u.id=q.creator_id
       WHERE r.session_id=? ORDER BY r.created_at DESC LIMIT 200`, session_id).map((r) => this.runJson(r));
  }

  async runDetail(actor: Actor, run_id: string): Promise<Json> {
    const row = readRunRow(run_id);
    if (!row) throw AppError.notFound('运行不存在');
    assertSessionAccess(actor, row.session_id, 'read');
    const d = this.d();
    const steps = d.all<Json>('SELECT * FROM run_steps WHERE run_id=? ORDER BY attempt, step_index', run_id);
    const artifacts = d.all<Json>('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at', run_id);
    const req = requestRow(row.request_id);
    const readManifest = collectManifest(steps);
    return {
      ...this.runJson(row as unknown as Json),
      goal: req?.goal ?? '', planner: row.planner ?? req?.planner ?? null,
      creator_name: req ? d.val<string>('SELECT display_name FROM users WHERE id=?', req.creator_id) : null,
      steps: steps.map((s) => ({
        step_index: s.step_index, attempt: s.attempt, tool_name: s.tool_name,
        args_digest: j<Json>(s.args_digest, {}), read_version_ids: j<string[]>(s.read_version_ids, []),
        output_digest: s.output_digest, output_bytes: s.output_bytes, duration_ms: s.duration_ms,
        status: s.status, error_code: s.error_code, planner: s.planner, created_at: s.created_at,
      })),
      read_manifest: readManifest,
      artifacts: artifacts.map((a) => this.artifactJson(a)),
      request_status: req?.status ?? null,
      source_message_id: req?.source_message_id ?? null,
      session_message_id: d.val<string>('SELECT id FROM session_messages WHERE ref_type=\'request\' AND ref_id=? ORDER BY seq LIMIT 1', row.request_id) ?? null,
    };
  }

  async cancelRun(actor: Actor, run_id: string, reason?: string): Promise<Json> {
    const row = readRunRow(run_id);
    if (!row) throw AppError.notFound('运行不存在');
    const access = assertSessionAccess(actor, row.session_id, 'read');
    const req = requestRow(row.request_id);
    const isOwn = req?.creator_id === actor.userId;
    if (!isOwn && access.role !== 'coordinator') throw AppError.forbidden('只能取消本人发起的请求');
    if (TERMINAL_RUN.includes(row.status)) throw AppError.invalidTransition(`该运行已是终态（${row.status}），不能取消`);
    const d = this.d();
    d.tx(() => {
      d.run('UPDATE runs SET cancel_epoch=cancel_epoch+1, lease_expires_at=?, updated_at=? WHERE id=?',
        nowIso(), nowIso(), run_id);
      setRunStatus(run_id, 'cancelled', { error_message: reason ?? '本人取消', actor_id: actor.userId });
      d.run('UPDATE runs SET cancel_reason=? WHERE id=?', reason ?? '用户取消', run_id);
      const ev = appendEvent({
        type: 'run.cancelled', organization_id: row.organization_id, entity_type: 'run', entity_id: run_id,
        actor_id: actor.userId, session_id: row.session_id, run_id, payload: { reason: reason ?? '用户取消' },
      });
      queueOutbox(wsOf(row.session_id), ev.seq);
      reconcileRequest(row.request_id);
    });
    kickScheduler('运行已取消');
    return this.runDetail(actor, run_id);
  }

  async retryRun(actor: Actor, run_id: string): Promise<Json> {
    const row = readRunRow(run_id);
    if (!row) throw AppError.notFound('运行不存在');
    const access = assertSessionAccess(actor, row.session_id, 'read');
    const req = requestRow(row.request_id);
    if (req?.creator_id !== actor.userId && access.role !== 'coordinator') throw AppError.forbidden('只能重试本人发起的请求');
    if (!['failed', 'cancelled'].includes(row.status)) throw AppError.invalidTransition('只有失败或已取消的运行可以重试');
    const d = this.d();
    d.tx(() => {
      // 重试 = 新 attempt，不重复提交已产生的正式写入（§17）
      d.run(`UPDATE runs SET status='queued', attempt=attempt+1, slot=NULL, queue_position=?, queue_reason=?,
        error_code=NULL, error_message=NULL, started_at=NULL, finished_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`,
        nextQueuePosition(row.session_id), '重试（新 attempt）', nowIso(), run_id);
      const ev = appendEvent({
        type: 'run.retried', organization_id: row.organization_id, entity_type: 'run', entity_id: run_id,
        actor_id: actor.userId, session_id: row.session_id, run_id, payload: { attempt: row.attempt + 1 },
      });
      queueOutbox(wsOf(row.session_id), ev.seq);
    });
    kickScheduler('重试入队');
    return this.runDetail(actor, run_id);
  }

  async answerClarification(actor: Actor, input: { request_id: string; answer: string }): Promise<Json> {
    const d = this.d();
    const req = requestRow(input.request_id);
    if (!req) throw AppError.notFound('请求不存在');
    assertSessionAccess(actor, String(req.session_id), 'write');
    if (req.status !== 'needs_clarification') throw AppError.invalidTransition('该请求当前不在待补充状态');
    const answer = (input.answer ?? '').trim();
    if (!answer) throw AppError.validation('请填写补充说明');
    const session = d.get<Json>('SELECT * FROM agent_sessions WHERE id=?', req.session_id)!;
    const binding = await need('sessions').bindingInfo(actor, String(req.session_id));
    const plan = await generatePlan({
      goal: `${req.goal}\n\n补充说明：${answer}`,
      outputKind: Number(req.chat_mode) === 1 ? 'answer' : String(req.output_kind) as 'draft' | 'formal_change' | 'answer',
      targetFileId: (j<Json[]>(req.write_scope, [])[0] as { file_id?: string } | undefined)?.file_id ?? null,
      sessionId: String(req.session_id), organizationId: String(session.organization_id), actorId: actor.userId,
      rootFolderId: binding.folder_id ? String(binding.folder_id) : null,
      includeChildren: !!binding.include_children,
      grounded: Number(req.chat_mode) === 1,
    });
    const newRevision = Number(req.instruction_revision) + 1;
    // 先把「对目标正式文件生成变更提案」这一步补进计划，再落库。
    // 曾经顺序写反（先 UPDATE plan=旧数组，再对内存数组 ensureFormalStep）：库里永远少这条子任务，
    // 调度器按 subtask_id 查不到就回退去跑 plan[0]，于是「生成提案」被当成只读盘点跑成 succeeded，
    // 提案一个都没产生——共同确认被静默跳过（e2e C10c 偶发失败的真实原因）。
    ensureFormalStep(plan.subtasks, String(req.output_kind), (j<Json[]>(req.write_scope, [])[0] as { file_id?: string } | undefined)?.file_id ?? null);
    d.tx(() => {
      d.run(`UPDATE requests SET instruction_revision=?, goal=?, plan=?, status='planned', clarification=NULL,
        planner=?, instruction_log=?, updated_at=? WHERE id=?`,
        newRevision, `${req.goal}\n\n补充说明：${answer}`, S(plan.subtasks), plan.planner,
        S([...j<Json[]>(req.instruction_log, []), { revision: newRevision, answer, at: nowIso(), by: actor.userId }]),
        nowIso(), input.request_id);
      // 只补齐受影响步骤：已有 Run 不改写，未产生的子任务新入队
      const existing = new Set(d.all<{ subtask_id: string }>('SELECT subtask_id FROM runs WHERE request_id=?', input.request_id).map((r) => r.subtask_id));
      const missing = plan.subtasks.filter((s) => !existing.has(s.subtask_id));
      if (missing.length) this.insertRuns(actor, input.request_id, String(req.session_id), String(session.organization_id), missing, plan.planner, String(req.output_kind));
      appendSessionMessage({
        session_id: String(req.session_id), organization_id: String(session.organization_id), actor_id: actor.userId,
        role: 'user', kind: 'message', body: `补充：${answer}`, ref_type: 'request', ref_id: input.request_id,
        aux: { request_id: input.request_id, revision: newRevision },
      });
      const ev = appendEvent({
        type: 'plan.updated', organization_id: String(session.organization_id), entity_type: 'session',
        entity_id: String(req.session_id), actor_id: actor.userId, session_id: String(req.session_id),
        payload: { request_id: input.request_id, revision: newRevision },
      });
      queueOutbox(wsOf(String(req.session_id)), ev.seq);
    });
    kickScheduler('补充说明后继续');
    return { request: this.requestJson(d.get<Json>('SELECT * FROM requests WHERE id=?', input.request_id)!), runs: this.runsOfRequest(input.request_id) };
  }

  async resolveConflict(actor: Actor, input: { conflict_id: string; resolution: 'order' | 'option_a' | 'option_b' | 'clarify'; note?: string }): Promise<Json> {
    const d = this.d();
    const c = d.get<Json>('SELECT * FROM conflicts WHERE id=?', input.conflict_id);
    if (!c) throw AppError.notFound('冲突不存在');
    if (c.session_id) assertSessionAccess(actor, String(c.session_id), 'read');
    const before = Number(j<string[]>(c.affected_ids, []).length);
    resolveConflictSync(actor, input);
    if (input.resolution === 'clarify') {
      insertConflict({
        organization_id: String(c.organization_id), session_id: c.session_id ? String(c.session_id) : null,
        type: 'semantic', resource_key: String(c.resource_key), affected_ids: j<string[]>(c.affected_ids, []),
        waiting_on: [], detail: input.note ?? '需要相关指令人澄清目标后再排定顺序', basis: 'deterministic',
      });
    }
    void before;
    return d.get<Json>('SELECT * FROM conflicts WHERE id=?', input.conflict_id) as Json;
  }

  async artifactsOf(actor: Actor, session_id: string): Promise<Json[]> {
    assertSessionAccess(actor, session_id, 'read');
    return this.d().all<Json>(
      `SELECT a.*, u.display_name AS creator_name FROM artifacts a LEFT JOIN users u ON u.id=a.creator_id
       WHERE a.session_id=? ORDER BY a.created_at DESC LIMIT 100`, session_id).map((a) => this.artifactJson(a));
  }

  async readArtifact(actor: Actor, artifact_id: string): Promise<{ content: string; file_id?: string; version_id?: string }> {
    const a = this.d().get<Json>('SELECT * FROM artifacts WHERE id=?', artifact_id);
    if (!a) throw AppError.notFound('成果不存在');
    assertSessionAccess(actor, String(a.session_id), 'read');
    const versionId = a.draft_version_id ? String(a.draft_version_id) : null;
    if (!versionId) return { content: String(j<Json>(a.meta ?? '{}', {})?.text ?? '') };
    const { buffer } = await need('files').readVersion(versionId);
    return { content: buffer.toString('utf8'), file_id: a.draft_file_id ? String(a.draft_file_id) : undefined, version_id: versionId };
  }

  /** Center 用：全组织 Run 列表（按授权过滤，仅协作者可见范围） */
  /** 冲突队列（§12）：只返回有权看到的会话的冲突 */
  listConflicts(actor: Actor, filters: { session_id?: string; status?: string }): Json[] {
    const d = this.d();
    const where = ['c.organization_id=?'];
    const p: (string | number)[] = [actor.orgId];
    if (filters.session_id) { where.push('c.session_id=?'); p.push(filters.session_id); }
    if (filters.status) { where.push('c.status=?'); p.push(filters.status); }
    const rows = d.all<Json>(
      `SELECT c.*, s.title AS session_title FROM conflicts c LEFT JOIN agent_sessions s ON s.id=c.session_id
       WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 200`, ...p);
    return rows.filter((r) => !r.session_id || !!sessionAccessQuiet(actor, String(r.session_id)));
  }

  centerRuns(actor: Actor, filters: { status?: string; session_id?: string; requester_id?: string; from?: string; to?: string; limit?: number }): Json[] {
    const d = this.d();
    const where = ['r.organization_id=?'];
    const p: (string | number)[] = [actor.orgId];
    if (filters.status) { where.push('r.status=?'); p.push(filters.status); }
    if (filters.session_id) { where.push('r.session_id=?'); p.push(filters.session_id); }
    if (filters.requester_id) { where.push('q.creator_id=?'); p.push(filters.requester_id); }
    if (filters.from) { where.push('r.created_at>=?'); p.push(filters.from); }
    if (filters.to) { where.push('r.created_at<=?'); p.push(filters.to); }
    const rows = d.all<Json>(
      `SELECT r.*, q.goal, u.display_name AS creator_name, s.title AS session_title, s.mode AS session_mode
       FROM runs r JOIN requests q ON q.id=r.request_id JOIN users u ON u.id=q.creator_id
       JOIN agent_sessions s ON s.id=r.session_id
       WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`,
      ...p, Math.min(filters.limit ?? 100, 500));
    // 会话权限过滤：看不到的会话的 Run 不返回标题也不计数
    return rows.filter((r) => !!sessionAccessQuiet(actor, String(r.session_id)));
  }

  centerOverview(actor: Actor): Json {
    const rows = this.centerRuns(actor, { limit: 500 });
    const count = (pred: (r: Json) => boolean) => rows.filter(pred).length;
    return {
      running: count((r) => ['running', 'planning'].includes(String(r.status))),
      queued: count((r) => r.status === 'queued'),
      waiting_input: count((r) => r.status === 'waiting_input'),
      waiting_approval: count((r) => r.status === 'waiting_approval'),
      blocked: count((r) => r.status === 'blocked'),
      recovering: count((r) => r.status === 'recovering'),
      succeeded: count((r) => r.status === 'succeeded'),
      failed: count((r) => r.status === 'failed'),
      cancelled: count((r) => r.status === 'cancelled'),
      conflicts_open: this.d().val<number>(`SELECT COUNT(*) FROM conflicts WHERE organization_id=? AND status='open'`, actor.orgId) ?? 0,
      slots_per_session: config.runSlotsPerSession,
      note: 'AI 运行成功不等于任务完成（§13 / §17）',
    };
  }

  private requestJson(r: Json): Json {
    return {
      id: r.id, session_id: r.session_id, goal: r.goal, instruction_revision: r.instruction_revision,
      output_kind: r.output_kind, risk: r.risk, status: r.status, clarification: r.clarification,
      planner: r.planner, write_scope: j(r.write_scope, []), plan: planFromRow(j<Json[]>(r.plan as string, []) as never, (r.planner as never) ?? null),
      source_message_id: r.source_message_id, created_at: r.created_at, updated_at: r.updated_at,
      model_note: String(r.output_kind) === 'answer'
        ? (r.planner === 'model' ? '本轮为直接回答：未拆读写子任务，回答正文由配置的模型生成' : '本轮为直接回答：模型未配置，回复为工作区内真实检索摘要')
        : (r.planner === 'model' ? '计划由配置的模型生成' : '计划由本地确定性规划器生成（未调用模型）'),
    };
  }

  private runJson(r: Json): Json {
    return {
      id: r.id, request_id: r.request_id, session_id: r.session_id, subtask_id: r.subtask_id,
      subtask_name: r.subtask_name, status: r.status, attempt: r.attempt, slot: r.slot,
      queue_position: r.queue_position, queue_reason: r.queue_reason, planner: r.planner,
      output_kind: r.output_kind, depends_on: j(r.depends_on, []), read_set: j(r.read_set, []),
      write_set: j(r.write_set, []), error_code: r.error_code, error_message: r.error_message,
      cancel_reason: r.cancel_reason, started_at: r.started_at, finished_at: r.finished_at,
      created_at: r.created_at, lease_expires_at: r.lease_expires_at,
      goal: r.goal, creator_name: r.creator_name, session_title: r.session_title, session_mode: r.session_mode,
    };
  }

  private artifactJson(a: Json): Json {
    return {
      id: a.id, kind: a.kind, name: a.name, format: a.format, status: a.status,
      run_id: a.run_id, request_id: a.request_id, session_id: a.session_id,
      draft_file_id: a.draft_file_id, draft_version_id: a.draft_version_id,
      target_file_id: a.target_file_id, base_version_id: a.base_version_id, proposal_id: a.proposal_id,
      saved_file_id: a.saved_file_id, creator_name: a.creator_name, created_at: a.created_at, updated_at: a.updated_at,
    };
  }
}

/**
 * 结构性保证：用户明确要改正式文件时，计划里必须存在 formal_change 子任务。
 * 模型有时只规划到草稿为止，那样请求会以「成功」收场却什么都没改（提案也不会生成）。
 */
export function ensureFormalStep(subs: PlanSubtask[], outputKind: string, targetFileId: string | null): void {
  if (outputKind !== 'formal_change' || !targetFileId) return;
  if (subs.some((st) => st.exec === 'formal_change')) return;
  const last = subs[subs.length - 1];
  subs.push({
    subtask_id: uuid(), name: '对目标正式文件生成变更提案（共同确认后提交）',
    exec: 'formal_change', depends_on: last ? [last.subtask_id] : [], read_paths: [], search_queries: [],
    write_paths: [], write_file_ids: [targetFileId],
    output_kind: 'formal_change', risk: 'high',
    parallel_reason: '同一文件的正式提交按资源级串行', ambiguous: false,
  } as PlanSubtask);
}

function riskOf(subtasks: PlanSubtask[]): 'low' | 'medium' | 'high' {
  if (subtasks.some((s) => s.risk === 'high')) return 'high';
  if (subtasks.some((s) => s.risk === 'medium')) return 'medium';
  return 'low';
}

function wsOf(sessionId: string) {
  return getDb().all<{ user_id: string }>('SELECT user_id FROM session_participants WHERE session_id=? AND left_at IS NULL', sessionId)
    .map((r) => ({ user_id: r.user_id, channel: 'ws' as const }));
}

function sessionAccessQuiet(actor: Actor, sessionId: string) {
  try {
    return assertSessionAccess(actor, sessionId, 'read');
  } catch {
    return null;
  }
}

/** 本次读取（固定版本清单）：RunStep.read_version_ids 聚合（§08.4） */
function collectManifest(steps: Json[]): { file_id: string; version_id: string; name?: string; version_no?: number; times: number }[] {
  const d = getDb();
  const map = new Map<string, { file_id: string; version_id: string; times: number }>();
  for (const s of steps) {
    for (const vid of j<string[]>(s.read_version_ids, [])) {
      const key = vid;
      const cur = map.get(key);
      if (cur) cur.times += 1;
      else {
        const v = d.get<{ file_id: string; version_no: number }>('SELECT file_id, version_no FROM file_versions WHERE id=?', vid);
        map.set(key, { file_id: v?.file_id ?? '', version_id: vid, times: 1 });
      }
    }
  }
  return Array.from(map.values()).map((m) => {
    const v = d.get<{ version_no: number }>('SELECT version_no FROM file_versions WHERE id=?', m.version_id);
    const f = d.get<{ name: string }>('SELECT name FROM files WHERE id=?', m.file_id);
    return { ...m, version_no: v?.version_no, name: f?.name };
  });
}

let instance: OrchestratorService | null = null;
export function getOrchestratorService(): OrchestratorService {
  if (!instance) instance = new OrchestratorService();
  return instance;
}
