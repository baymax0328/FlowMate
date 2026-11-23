// FlowMate · 两槽并发调度与真实执行（PRD §11.4 / §12 / §17 Run 状态机 / C09 / C13）
// 真实并发：进程内调度器（queue.ts）驱动 agent-run 任务；每个 Session 最多
// config.runSlotsPerSession(=2) 个活跃 Run；领取用 runs.lease_token 自增 + lease_owner +
// lease_expires_at 租约，步骤粒度心跳续租；丢心跳 → recovering → attempt+1 重新领取；
// 排队记录 queue_reason 与前序 run_id，按请求创建时间公平轮转；同一文件正式提交经
// resource_locks 资源级串行；cancel_epoch + lease_token 双 fencing 拒绝迟到写入。
// 绝不使用 setTimeout 模拟调度：业务真相始终在数据库，推进由事件/完成回调触发。
import { config } from '../../core/config';
import { appendEvent, getDb, j, nowIso, queueOutbox, S, uuid } from '../../core/db';
import { scheduler, type Job } from '../../core/queue';
import { live } from '../../core/live';
import { AppError } from '../../core/errors';
import { modelStatus, chat, chatStream } from '../../adapters/model.adapter';
import type { Actor } from '../../core/permissions';
import {
  executeToolCall, assertFence, releaseRunLocks, wrapUntrusted, assertNoCredential,
  UNTRUSTED_SYSTEM_RULE, collectReadVersions, resolveWriteTarget, tryResolvePath, type ToolBox, type PlannerSource,
} from './tools';
import { planFromRow, deterministicDraft, goalKeyword, type PlanSubtask } from './planner';
import { depsSatisfied } from './conflicts';
import { need } from '../../core/contracts';

const JOB = 'agent-run' as const;

interface RunRow {
  id: string; organization_id: string; request_id: string; session_id: string;
  subtask_id: string; subtask_name: string; slot: number | null; attempt: number;
  status: string; lease_token: number; lease_owner: string | null; lease_expires_at: string | null;
  cancel_epoch: number; queue_position: number | null; queue_reason: string | null;
  depends_on: string; read_set: string; write_set: string; planner: string | null;
  output_kind: string; error_code: string | null; error_message: string | null;
  started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
}

const OWNER_ID = `p${process.pid}-${uuid().slice(0, 8)}`;

function wsRecipients(sessionId: string): { user_id: string | null; channel: string }[] {
  const rows = getDb().all<{ user_id: string }>(
    'SELECT user_id FROM session_participants WHERE session_id=? AND left_at IS NULL', sessionId);
  return rows.map((r) => ({ user_id: r.user_id, channel: 'ws' as const }));
}

/** 事件 + outbox(ws) + 即时 live 推送（订阅该 run/session 的端） */
export function emitRunEvent(run: { id: string; organization_id: string; session_id: string }, type: string, payload: Record<string, unknown>, actorId?: string | null): void {
  const ev = appendEvent({
    type, organization_id: run.organization_id, entity_type: 'run', entity_id: run.id,
    actor_id: actorId ?? null, session_id: run.session_id, run_id: run.id, payload,
  });
  queueOutbox(wsRecipients(run.session_id), ev.seq);
  try { live.deliver(run.organization_id, 'run', run.id, ev.seq); } catch { /* 推送失败不影响业务 */ }
}

/** 终态不可被迟到事件改写（§17） */
export function setRunStatus(runId: string, status: string, extra: {
  error_code?: string | null; error_message?: string | null; queue_reason?: string | null;
  finished?: boolean; actor_id?: string | null;
} = {}): boolean {
  const d = getDb();
  return d.tx(() => {
    const cur = d.get<{ status: string; organization_id: string; session_id: string; attempt: number }>(
      'SELECT status, organization_id, session_id, attempt FROM runs WHERE id=?', runId);
    if (!cur) return false;
    if (['succeeded', 'failed', 'cancelled'].includes(cur.status)) {
      return cur.status === status; // 迟到的同态可重入，异态一律拒绝改写
    }
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
    const finishedAt = extra.finished ?? terminal;
    d.run(
      `UPDATE runs SET status=?,
         error_code=CASE WHEN ? THEN ? ELSE error_code END,
         error_message=CASE WHEN ? THEN ? ELSE error_message END,
         queue_reason=COALESCE(?, queue_reason),
         lease_owner=CASE WHEN ? THEN NULL ELSE lease_owner END,
         finished_at=CASE WHEN ? AND finished_at IS NULL THEN ? ELSE finished_at END,
         updated_at=? WHERE id=?`,
      status,
      extra.error_code !== undefined ? 1 : 0, extra.error_code ?? null,
      extra.error_message !== undefined ? 1 : 0, extra.error_message ?? null,
      extra.queue_reason ?? null,
      terminal || status === 'waiting_approval' ? 1 : 0,
      finishedAt ? 1 : 0, nowIso(), nowIso(), runId);
    if (terminal) releaseRunLocks(runId);
    emitRunEvent({ id: runId, organization_id: cur.organization_id, session_id: cur.session_id },
      'run.updated', { status, error_code: extra.error_code ?? null, attempt: cur.attempt }, extra.actor_id ?? null);
    return true;
  });
}

/** 权威会话消息（分片非持久真相，最终消息权威）；seq 事务内基于 agent_sessions.last_message_seq 自增 */
export function appendSessionMessage(input: {
  session_id: string; organization_id: string; role: 'user' | 'agent' | 'system'; kind: string; body: string;
  ref_type?: string | null; ref_id?: string | null; aux?: Record<string, unknown>; actor_id?: string | null;
  /** 不传时按 role 推导：user → 发起人本人（名字 + user_id），agent/system → FlowMate Agent */
  sender_label?: string | null; sender_user_id?: string | null;
}): { id: string; seq: number } {
  const d = getDb();
  // 「我发的话」以前也写死 sender_label='FlowMate Agent' 且 user_id 为 null，
  // 于是会话里自己提的问题显示成 Agent 说的，前端 mine 判定也永远为假。这里按角色补齐。
  const isUser = input.role === 'user';
  const uid = input.sender_user_id ?? (isUser ? (input.actor_id ?? null) : null);
  const label = input.sender_label
    ?? (isUser
      ? (uid ? d.val<string>('SELECT display_name FROM users WHERE id=?', uid) ?? '我' : '我')
      : 'FlowMate Agent');
  const out = d.tx(() => {
    d.run('UPDATE agent_sessions SET last_message_seq=last_message_seq+1, updated_at=? WHERE id=?', nowIso(), input.session_id);
    const seq = d.val<number>('SELECT last_message_seq FROM agent_sessions WHERE id=?', input.session_id)!;
    const id = uuid();
    d.run(
      `INSERT INTO session_messages(id,session_id,organization_id,seq,sender_user_id,sender_label,role,kind,body,ref_type,ref_id,aux,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.session_id, input.organization_id, seq, uid, label, input.role, input.kind,
      input.body, input.ref_type ?? null, input.ref_id ?? null, S({ ...(input.aux ?? {}), ...(input.role === 'agent' && input.actor_id ? { reply_to_user_id: input.actor_id } : {}) }), nowIso());
    return { id, seq };
  });
  const ev = appendEvent({
    type: 'session.message.created', organization_id: input.organization_id, entity_type: 'session',
    entity_id: input.session_id, actor_id: input.actor_id ?? null, session_id: input.session_id,
    payload: { seq: out.seq, kind: input.kind, ref_type: input.ref_type ?? null, ref_id: input.ref_id ?? null },
  });
  queueOutbox(wsRecipients(input.session_id), ev.seq);
  try { live.deliver(input.organization_id, 'session', input.session_id, ev.seq); } catch { /* noop */ }
  return out;
}

export function actorForUser(userId: string, orgId: string): Actor {
  const d = getDb();
  const u = d.get<{ display_name: string }>('SELECT display_name FROM users WHERE id=?', userId);
  const role = d.get<{ role: string }>(
    'SELECT role FROM memberships WHERE user_id=? AND organization_id=? AND status=\'active\'', userId, orgId)?.role ?? 'member';
  return { userId, orgId, role: role as Actor['role'], displayName: u?.display_name ?? '' };
}

// ---------- 领取（租约 + 两槽 + 公平轮转） ----------
interface Claim { runId: string; leaseToken: number }

function claimNext(): Claim | null {
  const d = getDb();
  return d.tx<Claim | null>(() => {
    const slots = config.runSlotsPerSession;
    const now = nowIso();
    const exp = new Date(Date.now() + config.runLeaseSeconds * 1000).toISOString();
    // 公平轮转：按请求创建时间轮转，避免一人饿死；同请求内按 queue_position
    const candidates = d.all<{ id: string; session_id: string }>(
      `SELECT r.id, r.session_id FROM runs r JOIN requests q ON q.id=r.request_id
       WHERE r.status='queued' ORDER BY q.created_at ASC, r.queue_position ASC, r.created_at ASC LIMIT 40`);
    for (const c of candidates) {
      const dep = depsSatisfied(c.id);
      if (!dep.ok) {
        if (dep.dead.length) {
          setRunStatus(c.id, 'failed', {
            error_code: 'DEPENDENCY_FAILED', error_message: `前置 Run ${dep.dead.join('、')} 已失败或取消`,
            queue_reason: '',
          });
        } else {
          d.run('UPDATE runs SET queue_reason=?, updated_at=? WHERE id=? AND status=\'queued\'',
            `等待依赖 Run ${dep.waiting_on.join('、')} 完成（排队位置按请求创建时间公平轮转）`, now, c.id);
        }
        continue;
      }
      const active = d.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM runs WHERE session_id=? AND status IN ('running','planning')", c.session_id);
      if ((active?.n ?? 0) >= slots) {
        d.run('UPDATE runs SET queue_reason=?, updated_at=? WHERE id=? AND status=\'queued\'',
          `会话执行槽已满（每会话 ${slots} 槽；前序活跃 Run 完成后续排）`, now, c.id);
        continue;
      }
      const usedSlots = d.all<{ slot: number }>(
        "SELECT slot FROM runs WHERE session_id=? AND status IN ('running','planning') AND slot IS NOT NULL", c.session_id)
        .map((r) => r.slot);
      let slot = 0;
      while (usedSlots.includes(slot) && slot < slots) slot++;
      const r = d.run(
        `UPDATE runs SET status='running', slot=?, lease_owner=?, lease_token=lease_token+1, lease_expires_at=?,
           heartbeat_at=?, started_at=COALESCE(started_at,?), queue_reason=NULL, updated_at=?
         WHERE id=? AND status='queued'`,
        slot, OWNER_ID, exp, now, now, now, c.id);
      if (!r.changes) continue;
      const fresh = d.get<{ lease_token: number; organization_id: string }>('SELECT lease_token, organization_id FROM runs WHERE id=?', c.id)!;
      emitRunEvent({ id: c.id, organization_id: fresh.organization_id, session_id: c.session_id },
        'run.updated', { status: 'running', slot, lease_token: fresh.lease_token });
      return { runId: c.id, leaseToken: fresh.lease_token };
    }
    return null;
  });
}

// ---------- 清扫：租约过期恢复 / waiting_approval 对账 / blocked 提升 / 锁回收 ----------
export function sweepRuns(): boolean {
  const d = getDb();
  let changed = false;
  const now = nowIso();
  // 1) 丢心跳 → recovering → queued（attempt+1，可被重新领取；旧 worker 由 fencing 挡住）
  const stale = d.all<{ id: string }>(
    `SELECT id FROM runs WHERE status IN ('running','planning') AND (lease_expires_at IS NULL OR lease_expires_at < ?)`, now);
  for (const s of stale) {
    d.run(`UPDATE runs SET status='recovering', lease_owner=NULL, lease_token=lease_token+1, updated_at=? WHERE id=? AND status IN ('running','planning')`, now, s.id);
    d.run(`UPDATE runs SET status='queued', attempt=attempt+1, queue_position=?, queue_reason=?, updated_at=? WHERE id=? AND status='recovering'`,
      Date.now(), '心跳丢失：进入 recovering 并重新领取（attempt+1，不重复提交由 fencing 与租约保证）', now, s.id);
    changed = true;
  }
  // 2) waiting_approval 与提案状态对账（提案模块拥有 proposals 行，这里只读）
  const waiting = d.all<{ id: string; prop_status: string | null }>(
    `SELECT r.id, (SELECT p.status FROM proposals p WHERE p.run_id=r.id ORDER BY p.created_at DESC LIMIT 1) AS prop_status
     FROM runs r WHERE r.status='waiting_approval'`);
  for (const w of waiting) {
    if (!w.prop_status) { setRunStatus(w.id, 'succeeded', { queue_reason: '' }); changed = true; continue; }
    if (w.prop_status === 'committed') {
      d.run(`UPDATE artifacts SET status='committed', updated_at=? WHERE run_id=? AND kind='draft' AND status='draft'`, now, w.id);
      setRunStatus(w.id, 'succeeded', { queue_reason: '' });
      appendSessionMessage({
        session_id: d.val<string>('SELECT session_id FROM runs WHERE id=?', w.id)!,
        organization_id: d.val<string>('SELECT organization_id FROM runs WHERE id=?', w.id)!,
        role: 'system', kind: 'execution_card',
        body: '提案已获相关指令人全部确认并提交，正式文件产生新版本。', ref_type: 'run', ref_id: w.id,
      });
      changed = true;
    } else if (['rejected', 'cancelled', 'superseded'].includes(w.prop_status)) {
      setRunStatus(w.id, 'failed', {
        error_code: `PROPOSAL_${w.prop_status.toUpperCase()}`,
        error_message: `提案${w.prop_status === 'rejected' ? '被拒绝' : w.prop_status === 'superseded' ? '被新提案取代' : '被取消'}，正式文件未变更`,
      });
      changed = true;
    } else if (['suspended', 'stale'].includes(w.prop_status)) {
      // §11.3 / C12：超时挂起 → Run 转 blocked 释放排队位，不进失败、不丢成果
      d.run(`UPDATE runs SET status='blocked', queue_reason=?, updated_at=? WHERE id=? AND status='waiting_approval'`,
        w.prop_status === 'suspended' ? '提案超时挂起：已搁置·等待确认（不占用执行槽与写锁）' : '提案基准过期：需重新生成差异再确认', now, w.id);
      changed = true;
    }
  }
  // 3) blocked：open 冲突已清且依赖满足 → 回 queued
  const blocked = d.all<{ id: string; request_id: string }>('SELECT id, request_id FROM runs WHERE status=\'blocked\'');
  for (const b of blocked) {
    const openConflict = d.get<{ id: string }>(
      `SELECT id FROM conflicts WHERE status='open' AND (affected_ids LIKE ? OR waiting_on LIKE ?)`,
      `%"${b.id}"%`, `%"${b.id}"%`);
    if (openConflict) continue;
    const openOnRequest = d.get<{ id: string }>(
      `SELECT c.id FROM conflicts c WHERE c.status='open' AND c.type IN ('semantic','write_set','version')
       AND EXISTS (SELECT 1 FROM runs r2 WHERE r2.request_id=? AND (c.affected_ids LIKE '%'||r2.id||'%' OR c.affected_ids LIKE '%'||?||'%'))`,
      b.request_id, b.request_id);
    if (openOnRequest) continue;
    const dep = depsSatisfied(b.id);
    if (dep.ok) {
      d.run(`UPDATE runs SET status='queued', queue_position=?, updated_at=? WHERE id=? AND status='blocked'`, Date.now(), now, b.id);
      changed = true;
    }
  }
  // 4) 资源锁回收：持有者已非活跃且已过期（等待确认期不长占写锁）
  const locks = d.all<{ resource_key: string; owner_run_id: string | null; expires_at: string | null }>('SELECT resource_key, owner_run_id, expires_at FROM resource_locks');
  for (const l of locks) {
    const ownerActive = l.owner_run_id ? d.get<{ id: string }>(
      `SELECT id FROM runs WHERE id=? AND status IN ('running','planning')`, l.owner_run_id) : null;
    const expired = !l.expires_at || new Date(l.expires_at).getTime() < Date.now();
    if (!ownerActive && expired) { d.run('DELETE FROM resource_locks WHERE resource_key=?', l.resource_key); changed = true; }
  }
  // 5) request 收尾对账
  for (const rq of d.all<{ id: string }>(`SELECT id FROM requests WHERE status IN ('planned','running')`)) reconcileRequest(rq.id);
  return changed;
}

export function reconcileRequest(requestId: string): void {
  const d = getDb();
  const runs = d.all<{ status: string }>('SELECT status FROM runs WHERE request_id=?', requestId);
  if (!runs.length) return;
  const req = d.get<{ status: string; organization_id: string; session_id: string }>(
    'SELECT status, organization_id, session_id FROM requests WHERE id=?', requestId);
  if (!req || ['completed', 'failed', 'cancelled'].includes(req.status)) return;
  const all = (sts: string[]) => runs.every((r) => sts.includes(r.status));
  let next: string | null = null;
  if (all(['succeeded'])) next = 'completed';
  else if (all(['cancelled'])) next = 'cancelled';
  else if (all(['succeeded', 'failed', 'cancelled']) && runs.some((r) => r.status === 'failed')) next = 'failed';
  if (next) {
    d.run('UPDATE requests SET status=?, updated_at=? WHERE id=?', next, nowIso(), requestId);
    const ev = appendEvent({
      type: 'request.updated', organization_id: req.organization_id, entity_type: 'request', entity_id: requestId,
      session_id: req.session_id, payload: { status: next },
    });
    queueOutbox(wsRecipients(req.session_id), ev.seq);
  }
}

// ---------- 执行 ----------
export interface ExecOutcome { kind: 'succeeded' | 'waiting' | 'failed' | 'fenced' }

async function executeClaimedRun(claim: Claim, beat: () => void): Promise<ExecOutcome> {
  const d = getDb();
  const run = d.get<RunRow>('SELECT * FROM runs WHERE id=?', claim.runId);
  if (!run || run.status !== 'running' || run.lease_token !== claim.leaseToken) return { kind: 'fenced' };
  const request = d.get<{ id: string; goal: string; creator_id: string; output_kind: string; plan: string; write_scope: string; chat_mode: number }>(
    'SELECT id, goal, creator_id, output_kind, plan, write_scope, chat_mode FROM requests WHERE id=?', run.request_id)!;
  const session = d.get<{ folder_id: string | null; include_children: number }>(
    'SELECT folder_id, include_children FROM agent_sessions WHERE id=?', run.session_id)!;
  const plan = planFromRow(request.plan, (run.planner as PlannerSource | null) ?? 'deterministic');
  const subtask = plan.find((s) => s.subtask_id === run.subtask_id);
  if (!subtask) {
    // 查不到就绝不回退去跑 plan[0]：那样「生成变更提案」这一步会被当成只读盘点跑成 succeeded，
    // 提案不产生、共同确认被跳过，而且日志里看不出任何异常（历史上 C10 链路就是这么静默失效的）。
    setRunStatus(run.id, 'failed', {
      error_code: 'SUBTASK_NOT_IN_PLAN',
      error_message: `请求计划里没有子任务 ${String(run.subtask_id).slice(0, 8)}（${run.subtask_name ?? ''}）`,
      actor_id: request.creator_id,
    });
    appendSessionMessage({
      session_id: run.session_id, organization_id: run.organization_id, role: 'system', kind: 'execution_card',
      body: `子任务「${run.subtask_name ?? ''}」没有执行：计划里找不到它（SUBTASK_NOT_IN_PLAN）。请重试这条请求；重试会产生新 attempt 并按当前计划重新排队。`,
      ref_type: 'run', ref_id: run.id, actor_id: request.creator_id,
    });
    return { kind: 'failed' };
  }
  const actor = actorForUser(request.creator_id, run.organization_id);
  const box: ToolBox = {
    actor, organizationId: run.organization_id, sessionId: run.session_id, requestId: run.request_id,
    runId: run.id, attempt: run.attempt, leaseToken: claim.leaseToken, cancelEpoch: run.cancel_epoch,
    planner: (run.planner as PlannerSource) ?? 'deterministic',
    rootFolderId: session.folder_id, includeChildren: !!session.include_children,
    readBytes: 0,
    stepIndex: d.val<number>('SELECT COALESCE(MAX(step_index),-1)+1 FROM run_steps WHERE run_id=? AND attempt=?', run.id, run.attempt) ?? 0,
  };
  try {
    return await runSubtask(box, subtask, request, run, beat);
  } catch (e) {
    const err = e as AppError;
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    const msg = (err as Error).message ?? '执行失败';
    const fresh = d.get<{ status: string }>('SELECT status FROM runs WHERE id=?', run.id);
    if (fresh && ['cancelled', 'succeeded', 'failed'].includes(fresh.status)) return { kind: 'fenced' };
    if (code === 'FORBIDDEN' && /迟到|租约|cancel_epoch|fencing/.test(msg)) {
      setRunStatus(run.id, 'failed', { error_code: 'FENCE_LOST', error_message: '执行租约失效或已取消，写入被 fencing 拒绝' });
      return { kind: 'failed', };
    }
    setRunStatus(run.id, 'failed', { error_code: code, error_message: msg.slice(0, 400), actor_id: request.creator_id });
    appendSessionMessage({
      session_id: run.session_id, organization_id: run.organization_id, role: 'system', kind: 'execution_card',
      body: `子任务「${run.subtask_name}」执行失败（${code}）：${msg}。原输入已保留，可重试（产生新 attempt，不重复提交）。`,
      ref_type: 'run', ref_id: run.id, actor_id: request.creator_id,
    });
    return { kind: 'failed' };
  }
}

interface Gathered { listing: string[]; hits: string[]; excerpts: { name: string; version_no: number; text: string }[]; summary: string }

/** 单个子任务的工具编排：gather → draft → (formal_change | answer) */
async function runSubtask(
  box: ToolBox, subtask: PlanSubtask,
  request: { goal: string; creator_id: string; write_scope: string; chat_mode?: number },
  run: RunRow, beat: () => void,
): Promise<ExecOutcome> {
  const d = getDb();
  const exec = subtask.exec;
  // 对话模式刻意不汇聚任何材料：gatherMaterial 一上来就会 fs.list 列工作区，
  // 那等于把「工作区里有哪些文件」泄漏给纯问答 —— 与「对话模式看不到工作区文件」的产品口径矛盾。
  // 工作模式（chat_mode）相反：外观是问答，但要能读工作区、能按要求执行。
  const chatMode = Number(request.chat_mode ?? 0) === 1;
  const gathered: Gathered = (exec === 'answer' && !chatMode)
    ? { listing: [], hits: [], excerpts: [], summary: '' }
    : await gatherMaterial(box, subtask, beat, request.goal);
  beat();

  if (exec === 'gather') {
    finishRunCommon(box, run, request, gathered.summary, 'message');
    d.run(`UPDATE runs SET status='succeeded', finished_at=?, updated_at=? WHERE id=? AND status='running'`, nowIso(), nowIso(), run.id);
    emitRunEvent(run, 'run.updated', { status: 'succeeded', step_count: box.stepIndex, read_versions: collectReadVersions(run.id, run.attempt).length });
    return { kind: 'succeeded' };
  }

  // 工作模式（chat_mode）刻意不改动文件：按产品口径它只做「读工作区 + 依据内容问答」。
  // 改动能力仍然保留给显式的执行类请求（output_kind=draft/formal_change 且非对话外观），
  // 例如从消息页「交给 Agent」进来的任务；不能因为用户问了句「文件里的答案」就去写文件。
  const editIntent = (exec === 'draft' || exec === 'formal_change') && !chatMode
    ? await detectNamedEditTarget(box, request.goal)
    : null;

  if (exec === 'draft' || exec === 'formal_change' || editIntent) {
    const branch: 'draft' | 'formal_change' = exec === 'formal_change' || editIntent ? 'formal_change' : 'draft';
    if (editIntent) { subtask.write_file_ids = [editIntent.fileId]; subtask.output_kind = 'formal_change'; }
    // 改正式文件（formal_change）与产草稿（draft）要的内容不一样：
    // 草稿要的是「一篇结构化正文」，改文件要的是「目标文件的完整新内容」。
    // 以前两者都走 modelCompose，提案里装的其实是一篇草稿 —— 提交后原文件内容会被草稿整篇替换。
    let content: string;
    let formal: { fileId: string; baseVersion: string; name: string; base: string } | null = null;
    if (branch === 'formal_change') {
      const prepared = await prepareFormalTarget(box, subtask, request);
      formal = prepared;
      if (box.planner !== 'model') {
        throw AppError.providerUnavailable(
          `要修改「${prepared.name}」需要模型生成新内容，当前未配置模型：工作模式仍可读取与产出草稿，但不会改动正式文件。配好 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME 后重试。`);
      }
      content = await modelEdit(box, request.goal, prepared.name, prepared.base, beat);
    } else {
      content = box.planner === 'model'
        ? await modelCompose(box, request.goal, gathered.excerpts, beat)
        : deterministicDraft({
          goal: request.goal, keyword: subtask.search_queries[0] ?? goalKeyword(request.goal),
          listing: gathered.listing, hits: gathered.hits, excerpts: gathered.excerpts,
        });
    }
    // 工作模式（对话外观）不再顺手产一篇草稿文件：提案本身就带差异，
    // 多一个「XX 改动预览.md」只会让会话看起来到处是文件，与「还是正常问答」的口径冲突。
    const made = (formal && chatMode) ? null : await executeToolCall(box, 'draft.create', {
      name: subtask.draft_name ?? (formal ? `${formal.name} 改动预览` : request.goal.slice(0, 24)), format: 'markdown', content,
    }) as { draft_file_id: string; version_id: string };
    beat();
    const artifactRow = made ? d.get<{ id: string }>('SELECT id FROM artifacts WHERE draft_file_id=? AND run_id=?', made.draft_file_id, run.id) : null;
    const ev = appendEvent({
      type: 'artifact.created', organization_id: run.organization_id, entity_type: 'artifact',
      entity_id: artifactRow?.id ?? made?.draft_file_id ?? run.id, actor_id: request.creator_id,
      session_id: run.session_id, run_id: run.id,
      payload: { draft_file_id: made?.draft_file_id ?? null, version_id: made?.version_id ?? null, planner: box.planner },
    });
    queueOutbox(wsRecipients(run.session_id), ev.seq);

    if (branch === 'draft') {
      // draft 分支必有草稿（只有 formal+chat 才跳过 draft.create）
      finishRunCommon(box, run, request, content.slice(0, 6000), chatMode ? 'message' : 'artifact', made?.draft_file_id, made?.version_id);
      d.run(`UPDATE runs SET status='succeeded', finished_at=?, updated_at=? WHERE id=? AND status='running'`, nowIso(), nowIso(), run.id);
      emitRunEvent(run, 'run.updated', { status: 'succeeded', artifact: made?.draft_file_id ?? null });
      return { kind: 'succeeded' };
    }

    // formal_change：风险「高」——不得直接写正式文件，一律经提案（共同确认后由提案模块原子提交）
    if (!formal) throw AppError.validation('内部错误：formal_change 缺少目标文件');
    const targetFileId = formal.fileId;
    // 基准版本以准备阶段读到的为准；期间有人改过就交给 file.writeVersion 做乐观锁判定（VERSION_CONFLICT）
    const baseVersion = formal.baseVersion;
    // 模型没改出任何差异时不要制造一个空提案让人去确认 —— 直接说明结论并结束
    if (content.trim() === formal.base.trim()) {
      finishRunCommon(box, run, { goal: request.goal, creator_id: request.creator_id },
        `按这条指令检查后，「${formal.name}」不需要改动（内容与当前版本一致）。文件未作任何修改。`, 'message');
      d.run(`UPDATE runs SET status='succeeded', finished_at=?, updated_at=? WHERE id=? AND status='running'`, nowIso(), nowIso(), run.id);
      emitRunEvent(run, 'run.updated', { status: 'succeeded', no_change: true });
      return { kind: 'succeeded' };
    }
    // 相关指令人 = 写同一文件的活跃请求发起人集合（全部确认才可提交）
    const peers = d.all<{ creator_id: string; request_id: string }>(
      `SELECT DISTINCT q.creator_id, q.id AS request_id FROM runs r2 JOIN requests q ON q.id=r2.request_id
       WHERE r2.output_kind='formal_change' AND r2.write_set LIKE ? AND r2.status NOT IN ('cancelled','failed')`,
      `%"${targetFileId}"%`);
    const approvers = Array.from(new Set(peers.map((p) => p.creator_id)));
    if (!approvers.includes(request.creator_id)) approvers.push(request.creator_id);
    const instructionIds = Array.from(new Set(peers.map((p) => p.request_id).concat([box.requestId])));
    let proposalId = '';
    const result0 = await executeToolCall(box, 'file.writeVersion', {
      file_id: targetFileId, content, base_version: baseVersion,
      summary: `Agent 变更提案（planner=${box.planner}）：${request.goal.slice(0, 60)}`,
      instruction_ids: instructionIds, required_approvers: approvers,
    });
    proposalId = String((result0 as unknown as { proposal_id?: string }).proposal_id ?? '');
    // 等待期不占写锁（锁在工具内即取即放）；Run 让出执行槽
    const released = d.run(
      `UPDATE runs SET status='waiting_approval', slot=NULL, lease_owner=NULL, lease_expires_at=NULL, queue_reason=?, updated_at=?
       WHERE id=? AND lease_token=? AND status='running'`,
      `等待共同确认（提案 ${proposalId}，需 ${approvers.length} 位相关指令人全部确认；0/${approvers.length}）`, nowIso(), run.id, box.leaseToken);
    if (!released.changes) throw AppError.forbidden('租约已失效，提案创建后的状态写入被 fencing 拒绝');
    // 工作模式没有草稿文件可关联，跳过这一步（提案自己带差异与会话卡片）
    if (made) d.run('UPDATE artifacts SET proposal_id=?, status=\'proposed\', updated_at=? WHERE draft_file_id=? AND run_id=?', proposalId, nowIso(), made.draft_file_id, run.id);
    emitRunEvent(run, 'run.updated', { status: 'waiting_approval', proposal_id: proposalId, required_approvers: approvers });
    appendSessionMessage({
      session_id: run.session_id, organization_id: run.organization_id, role: 'system', kind: 'approval_card',
      body: `正式文件变更已生成提案（0/${approvers.length} 确认）。文件当前内容未变；全部相关指令人确认后才提交。planner=${box.planner}。`,
      ref_type: 'proposal', ref_id: proposalId, actor_id: request.creator_id,
      aux: { planner: box.planner, read_versions: collectReadVersions(run.id, run.attempt) },
    });
    return { kind: 'waiting' };
  }

  // answer：流式分片仅事件；最终权威落 session_messages
  const answerText = box.planner === 'model'
    ? await modelAnswer(box, run, request.goal, gathered.excerpts, beat, gathered.hits, gathered.summary)
    : [
      '（本回复由确定性流程生成，planner=deterministic，未调用模型，不是 AI 生成内容。）',
      `与请求「${request.goal}」相关的真实检索与读取结果摘要：`,
      gathered.summary,
      ...gathered.hits.map((h) => `- ${h}`),
      ...gathered.excerpts.map((e) => `- 《${e.name}》v${e.version_no}：${e.text.slice(0, 300)}…`),
    ].join('\n');
  assertFence(box); // 权威写入前再次 fencing
  // 回答落成普通对话消息（kind='message'）：之前落 kind='artifact'，前端按「成果卡」渲染，
  // 表现为「问了半天只冒出一张卡片、没有回复正文」——问答链路看着像没通。
  finishRunCommon(box, run, request, answerText, 'message');
  const artifactId = uuid();
  d.run(
    `INSERT INTO artifacts(id,organization_id,run_id,request_id,session_id,creator_id,kind,name,format,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    artifactId, run.organization_id, run.id, box.requestId, run.session_id, request.creator_id, 'answer',
    `回答：${request.goal.slice(0, 40)}`, 'markdown', 'draft', nowIso(), nowIso());
  d.run(`UPDATE runs SET status='succeeded', finished_at=?, updated_at=? WHERE id=? AND status='running'`, nowIso(), nowIso(), run.id);
  const ev = appendEvent({
    type: 'artifact.created', organization_id: run.organization_id, entity_type: 'artifact', entity_id: artifactId,
    actor_id: request.creator_id, session_id: run.session_id, run_id: run.id,
    payload: { kind: 'answer', planner: box.planner },
  });
  queueOutbox(wsRecipients(run.session_id), ev.seq);
  emitRunEvent(run, 'run.updated', { status: 'succeeded', output_kind: 'answer' });
  return { kind: 'succeeded' };
}

export function namedWorkspaceFileIds(entries: { name: string; file_id?: string }[], goal: string): string[] {
  const question = goal.normalize('NFKC').toLocaleLowerCase();
  return entries.filter((entry) => {
    if (!entry.file_id) return false;
    const name = entry.name.normalize('NFKC').toLocaleLowerCase();
    const stem = name.replace(/\.[^.]+$/, '');
    return question.includes(name) || (stem.length >= 2 && question.includes(stem));
  }).map((entry) => entry.file_id!);
}

async function gatherMaterial(box: ToolBox, subtask: PlanSubtask, beat: () => void, goal: string): Promise<Gathered> {
  const d = getDb();
  const listing: string[] = []; const hits: string[] = []; const excerpts: Gathered['excerpts'] = [];
  if (box.rootFolderId) {
    const listed = await executeToolCall(box, 'fs.list', { path: '/', recursive: box.includeChildren, limit: 60 }) as {
      entries: { name: string; kind: string; file_id?: string }[];
      file_count: number; folder_count: number; counts_by_kind: Record<string, number>; truncated: boolean;
    };
    listing.push(`当前绑定范围内共有 ${listed.file_count} 个可访问文件、${listed.folder_count} 个文件夹。按文件类型统计：${JSON.stringify(listed.counts_by_kind)}。此数量来自目录，不依赖正文是否已解析。范围：${box.includeChildren ? '包含子目录' : '仅本层'}。`);
    if (listed.truncated) listing.push('下方文件名列表仅为部分条目，完整数量以上方目录统计为准。');
    for (const e of (listed.entries ?? []).slice(0, 40)) {
      listing.push(`${e.kind === 'folder' ? '[文件夹] ' : ''}${e.name}${e.file_id ? ` (${e.file_id})` : ''}`);
    }
    beat();
    for (const q of subtask.search_queries.slice(0, 3)) {
      const sr = await executeToolCall(box, 'search.content', { query: q, limit: 10 }) as { hits: Record<string, unknown>[] };
      for (const h of (sr.hits ?? []).slice(0, 8)) {
        hits.push(`${String(h.name ?? h.file_id ?? '')}：${String(h.snippet ?? h.text ?? '').slice(0, 160)}`);
      }
    }
    beat();
    // 固定读取版本清单：plan 的 read_paths + 本步检索命中的文件（执行时定版，事后差异可算清）
    const namedIds = namedWorkspaceFileIds(listed.entries ?? [], goal);
    const targets = new Set<string>(namedIds);
    // 走工具本身，而不是绕过它自己解析路径：被拒的调用才会按 §8.4 留下 denied 步骤，
    // 「谁试图越界」在 Center 与审计里可查（此前只有会话文本里提一句，事后无法追责）。
    for (const p of subtask.read_paths.slice(0, 3)) {
      try {
        const resolved = await tryResolvePath(box, p);
        if (resolved && d.val<string>('SELECT kind FROM files WHERE id=?', resolved) === 'image') {
          targets.add(resolved);
          continue;
        }
        const r = await executeToolCall(box, 'fs.read', { path: p, offset: 0, max_bytes: 16384 }) as Record<string, unknown>;
        const fid = typeof r.file_id === 'string' ? r.file_id
          : (r.version_id
            ? d.get<{ file_id: string }>('SELECT file_id FROM file_versions WHERE id=?', String(r.version_id))?.file_id
            : null);
        if (fid) targets.add(String(fid));
      } catch (e) {
        hits.push(`（读取「${p}」被拒：${(e as Error).message}）`);
      }
    }
    const searchVersions = d.all<{ read_version_ids: string }>(
      `SELECT read_version_ids FROM run_steps WHERE run_id=? AND tool_name='search.content'`, box.runId)
      .flatMap((r) => j<string[]>(r.read_version_ids, []));
    const searchFileIds = searchVersions.map((vid) =>
      d.get<{ file_id: string }>('SELECT file_id FROM file_versions WHERE id=?', vid)?.file_id).filter(Boolean) as string[];
    if (!namedIds.length) {
      for (const fid of Array.from(new Set(searchFileIds)).slice(0, 3)) targets.add(fid);
    }

    // 兜底（关键）：关键词检索命中不了就直接把工作区里的文本文件读进来。
    // 用户问「文件中的答案是多少」时，关键词往往是「答案」「多少」这种文件里根本没有的词，
    // 只靠 search.content 会一条都读不到，回答就变成「我没看到任何资料」——
    // 演示规模的工作区本来就不大，宁可多读几个文件，也不要把答案问成空。
    if (!targets.size) {
      const readable = (listed.entries ?? []).filter((entry) => entry.file_id
        && ['markdown', 'text', 'html', 'word', 'pdf', 'excel', 'ppt', 'image'].includes(entry.kind));
      for (const entry of readable.slice(0, 12)) targets.add(String(entry.file_id));
    }

    const pinned: { file_id: string; version_id: string }[] = [];
    let filesRead = 0;
    for (const fileId of Array.from(targets)) {
      if (filesRead >= 4) break;
      try {
        const file = d.get<{ name: string; kind: string; current_version_id: string }>(
          'SELECT name, kind, current_version_id FROM files WHERE id=?', fileId);
        if (file?.kind === 'image') {
          const image = await executeToolCall(box, 'image.read', { file_id: fileId }) as { ok: boolean; description?: string; message?: string };
          if (image.ok) {
            pinned.push({ file_id: fileId, version_id: file.current_version_id });
            const version = d.val<number>('SELECT version_no FROM file_versions WHERE id=?', file.current_version_id) ?? 0;
            excerpts.push({ name: file.name, version_no: version, text: image.description ?? '' });
            filesRead++;
          } else hits.push(`「${file.name}」：${image.message ?? '图片无法读取'}`);
          beat();
          continue;
        }
        const r = await executeToolCall(box, 'fs.read', { file_id: fileId, offset: 0, max_bytes: 16384 }) as {
          version_id: string; name: string; content: string;
        };
        pinned.push({ file_id: fileId, version_id: r.version_id });
        const vn = d.get<{ version_no: number }>('SELECT version_no FROM file_versions WHERE id=?', r.version_id)?.version_no ?? 0;
        excerpts.push({ name: r.name ?? '', version_no: vn, text: String(r.content ?? '') });
        filesRead++;
      } catch (e) {
        if (e instanceof AppError && ['EXTRACT_FAILED', 'UNSUPPORTED_FILE_TYPE', 'READ_BUDGET_EXCEEDED', 'NOT_FOUND'].includes(e.code)) {
          hits.push(`（${(e as Error).message}）`);
        } else {
          throw e;
        }
      }
      beat();
    }
    if (pinned.length) {
      d.run('UPDATE runs SET read_set=?, updated_at=? WHERE id=?', S(pinned), nowIso(), box.runId);
    }
  }
  const summary = [
    `工作区条目 ${listing.length} 项；检索命中 ${hits.length} 条；固定读取版本 ${excerpts.length} 个。`,
    ...listing.slice(0, 20).map((l) => `- ${l}`),
    ...hits.slice(0, 20).map((h) => `- ${h}`),
  ].join('\n');
  return { listing, hits, excerpts, summary };
}

/**
 * 服务端兜底：用户在指令里点名了工作区里真实存在的文件，又用了改动类动词，
 * 那么无论模型把这一步规划成 draft 还是 formal_change，都必须按「正式文件变更」走提案。
 * 不这么做的话：用户说「把 X.md 第一行加 123」，模型规划成 draft，用户得到一篇新草稿，
 * 原文件一个字节没变 —— 看起来像功能坏了。关键步骤不能交给模型自由发挥。
 *
 * 只认「带扩展名的文件名」且必须能在绑定内解析到真实文件，避免把「写一份说明」这类话误判成改文件。
 */
async function detectNamedEditTarget(box: ToolBox, goal: string): Promise<{ fileId: string; name: string } | null> {
  if (!box.rootFolderId) return null;                       // 没工作区谈不上改文件
  if (!/(改成|改为|加上|加一行|加个|补上|补充|第一行|末尾|开头|重写|写入|覆盖|改一下|编辑|删掉这行|替换)/.test(goal)) return null;
  // 文件名里可以有空格（「评审纪要 第3次.md」），所以字符类允许空格；
  // 代价是中文指令里紧邻的动词也会被吞进来（实测抽出过「把 探针目标xx.md」）。
  // 不靠词表去猜中文边界，改成对每个匹配生成尾部变体，从最短的可能名开始逐个试解析。
  const matched = (String(goal).match(/[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\- ]*\.(?:md|markdown|txt|html|htm|docx|pdf|xlsx|csv|pptx)/gi) ?? [])
    .map((s) => s.trim());
  const names = Array.from(new Set(matched.flatMap((raw) => {
    const parts = raw.split(/\s+/).filter(Boolean);
    return parts.map((_, i) => parts.slice(i).join(' '));
  }))).slice(0, 6);
  for (const raw of names) {
    const fileId = await tryResolvePath(box, raw);
    if (!fileId) continue;
    const f = getDb().get<{ name: string; kind: string; status: string }>('SELECT name, kind, status FROM files WHERE id=?', fileId);
    if (!f || f.status !== 'active') continue;
    const rule = config.types.find((t) => t.kind === f.kind);
    if (!rule?.editable) {
      // 点名要改 word/pdf 这类不可回写文件：明确拒绝并说原因，不能悄悄降级成草稿骗过去
      throw AppError.unsupported(
        `「${f.name}」是 ${f.kind} 类型，本版只能读取与提取正文，不支持回写（把抽取正文写回去会破坏原文件格式）。要改内容请针对 md / txt / html 文件，或让我基于它另存一份 Markdown。`);
    }
    return { fileId, name: f.name };
  }
  return null;
}

/**
 * 准备一次「正式文件变更」：解析目标 → 校验可回写 → 读全量基准内容。
 *
 * 三条硬约束，都是为了让"改文件"这件事不毁数据：
 * 1. 只有可编辑文本类（markdown / text / html）才允许回写。word/pdf/excel/ppt 的 fs.read
 *    拿到的是「抽取正文」，把它当新内容写回去等于把 .docx 变成纯文本 —— 那是毁文件不是改文件。
 * 2. 必须读到完整基准内容。读不全就拒绝：否则提案会静默删掉没读到的那部分。
 * 3. 路径解析走工具层，越界/不是文件都会留下 denied 步骤（§8.4），不静默。
 */
async function prepareFormalTarget(
  box: ToolBox, subtask: PlanSubtask, request: { goal: string; write_scope: string },
): Promise<{ fileId: string; baseVersion: string; name: string; base: string }> {
  const d = getDb();
  const scope = j<{ file_id?: string }[]>(request.write_scope, []);
  let fileId = subtask.write_file_ids[0] ?? scope[0]?.file_id ?? null;
  const tried: string[] = [];
  if (!fileId) {
    for (const p of subtask.write_paths.slice(0, 2)) {
      tried.push(p);
      const r = await resolveWriteTarget(box, p);
      if (r) { fileId = r; break; }
    }
  }
  if (!fileId) {
    const hint = tried.length ? tried.map((p) => `「${p}」`).join('、') : '（计划里没给出文件名）';
    throw AppError.validation(
      `没找到要修改的文件：${hint}。请在工作区里确认文件名后重说一次，例如「把 需求说明书-v1.md 的第一行开头加上 123」。`);
  }
  const f = d.get<{ name: string; kind: string; current_version_id: string | null; status: string }>(
    'SELECT name, kind, current_version_id, status FROM files WHERE id=?', fileId);
  if (!f || f.status !== 'active') throw AppError.notFound('目标文件不存在或已回收');
  const rule = config.types.find((t) => t.kind === f.kind);
  if (!rule?.editable) {
    throw AppError.unsupported(
      `「${f.name}」是 ${f.kind} 类型，本版只能读取与提取正文，不支持回写（把抽取正文写回去会破坏原文件格式）。要改内容请另存一份 Markdown，或改用 md / txt / html 文件测试。`);
  }
  if (!f.current_version_id) throw AppError.notFound('目标文件尚无可用版本');
  const read = await executeToolCall(box, 'fs.read', { file_id: fileId, offset: 0, max_bytes: 65536 }) as {
    content: string; version_id: string; total_chars: number; returned_chars: number; truncated: boolean; from_extraction: boolean;
  };
  if (read.truncated) {
    throw AppError.validation(
      `「${f.name}」有 ${read.total_chars} 字，超出单次可读取范围（本次只拿到 ${read.returned_chars} 字）。基于不完整内容改文件会丢掉没读到的部分，已拒绝。请把它拆分小一些，或改用「产出草稿」。`);
  }
  return { fileId, baseVersion: read.version_id ?? f.current_version_id, name: f.name, base: String(read.content ?? '') };
}

/**
 * 生成目标文件的「完整新内容」。与 modelCompose 的区别是刻意的：
 * 这里要求逐字保留未提及的部分，输出整份文件，不包 markdown 代码围栏，不写解释。
 * 输出与原文完全一致时由调用方判为「无改动」，不会制造空提案。
 */
async function modelEdit(box: ToolBox, goal: string, name: string, base: string, beat: () => void): Promise<string> {
  const prompt = [
    UNTRUSTED_SYSTEM_RULE,
    `目标文件：${name}`,
    `修改指令：${goal}`,
    `当前完整内容（数据围栏，逐字保留未被指令要求改动的部分）：`,
    wrapUntrusted(base, name),
    '',
    '输出要求：只输出修改后的完整文件内容本身。不要解释、不要 diff 标记、不要加代码围栏、不要改变其它行的文字与顺序。',
  ].join('\n');
  assertNoCredential(prompt);
  const res = await chat({
    messages: [
      { role: 'system', content: '你是文件编辑器：按指令对给定文件做最小改动，并返回改完的完整文件内容。' },
      { role: 'user', content: prompt },
    ],
    purpose: 'file-edit', session_id: box.sessionId, run_id: box.runId,
  });
  beat();
  let out = String(res.text ?? '');
  // 模型常把整篇包在 ``` 里；脱掉外层围栏，否则会把围栏本身写进文件
  const fence = out.match(/^\s*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) out = fence[1];
  return out;
}

async function modelCompose(box: ToolBox, goal: string, excerpts: Gathered['excerpts'], beat: () => void): Promise<string> {
  const ctx = excerpts.map((e) => wrapUntrusted(`【${e.name}】\n${e.text.slice(0, 6000)}`, e.name)).join('\n\n');
  const prompt = `${UNTRUSTED_SYSTEM_RULE}\n用户目标：${goal}\n以下为绑定目录中真实读取的文件内容（数据围栏）：\n${ctx || '(无可读内容，请说明局限)'}\n请产出结构化 Markdown 草稿正文。`;
  assertNoCredential(prompt);
  const res = await chat({
    messages: [{ role: 'system', content: '你是 FlowMate 的工作区写作助手。' }, { role: 'user', content: prompt }],
    purpose: 'draft-compose', session_id: box.sessionId, run_id: box.runId, maxTokens: 2000,
  });
  beat();
  return res.text;
}

async function modelAnswer(box: ToolBox, run: RunRow, goal: string, excerpts: Gathered['excerpts'], beat: () => void, readNotes: string[] = [], workspaceSummary = ''): Promise<string> {
  const ctx = excerpts.map((e) => wrapUntrusted(`【${e.name}】\n${e.text.slice(0, 6000)}`, e.name)).join('\n\n');
  const prompt = `${UNTRUSTED_SYSTEM_RULE}\n用户问题：${goal}\n目录统计与列表：\n${wrapUntrusted(workspaceSummary || '(未获取目录)', 'workspace_listing')}\n可参考的真实读取内容（数据围栏）：\n${ctx || '(无)'}\n读取情况：\n${wrapUntrusted(readNotes.join('\n') || '(无)', 'read_notes')}\n请回答。统计文件数量时使用目录统计，不能以本轮读取成功的正文份数代替。HTML、Word 等文件解析失败不代表文件不存在。涉及正文无法读取时说明原因，普通问答直接作答。`;
  assertNoCredential(prompt);
  let full = ''; let buf = ''; let deltaIndex = 0;
  const stream = chatStream({
    messages: [{
      role: 'system',
      content: excerpts.length
        // 「题目+答案」是用户的原话诉求：文件里写着「1+1=？」这类内容时，
        // 回答要能把那条题目连同答案一起说清楚，并点明出自哪个文件，而不是只丢一个数字。
        ? '你是 FlowMate 会话助手。依据下面给出的真实文件内容回答：先给结论，再引用相关原文（标明文件名与版本）；'
          + '如果问的是文件里的题目，请把题目和答案一起说清楚。资料里没有的就说没有，绝不编造，也不声称读取了未提供的文件。'
        : '你是 FlowMate 会话助手。目录统计可用于回答文件数量与类型，正文没有成功读取时不要声称已读正文。普通问题直接回答。',
    }, { role: 'user', content: prompt }],
    purpose: 'answer', session_id: box.sessionId, run_id: run.id,
  });
  for await (const part of stream) {
    if (part.done) break;
    full += part.delta; buf += part.delta;
    if (buf.length >= 60) {
      assertFence(box); // 取消后禁止继续吐分片
      const ev = appendEvent({
        type: 'output.delta', organization_id: run.organization_id, entity_type: 'run', entity_id: run.id,
        session_id: run.session_id, run_id: run.id, payload: { index: deltaIndex++, text: buf.slice(0, 240) },
      });
      queueOutbox(wsRecipients(run.session_id), ev.seq);
      try { live.deliver(run.organization_id, 'run', run.id, ev.seq); } catch { /* noop */ }
      buf = '';
    }
    beat();
  }
  return full;
}

function finishRunCommon(
  box: ToolBox, run: RunRow, request: { goal: string; creator_id: string },
  body: string, kind: 'message' | 'artifact', draftFileId?: string, draftVersionId?: string,
): void {
  appendSessionMessage({
    session_id: run.session_id, organization_id: run.organization_id, role: 'agent',
    kind, body, ref_type: 'run', ref_id: run.id,
    aux: {
      planner: box.planner, read_versions: collectReadVersions(run.id, run.attempt),
      draft_file_id: draftFileId ?? null, draft_version_id: draftVersionId ?? null,
    },
    actor_id: request.creator_id,
  });
}

// ---------- 调度器接入 ----------
async function pumpHandler(job: Job, ctx: { leaseToken: number; heartbeat: () => void }): Promise<void> {
  void job;
  ctx.heartbeat();
  const changed = sweepRuns();
  ctx.heartbeat();
  // 一次泵内并行领取至多「每会话槽位数」个 Run（真实并发：Promise.all 同时推进，
  // 会话内 active<runSlotsPerSession 的领取约束在 claimNext 事务内强制）
  const claims: Claim[] = [];
  for (let i = 0; i < config.runSlotsPerSession; i++) {
    const c = claimNext();
    if (!c) break;
    claims.push(c);
  }
  let ranAny = claims.length > 0;
  if (claims.length) {
    await Promise.all(claims.map((c) => executeClaimedRun(c, () => ctx.heartbeat())));
  }
  const d = getDb();
  const remaining = d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','blocked')`)?.n ?? 0;
  const anyActive = d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('running','planning','recovering','waiting_approval')`)?.n ?? 0;
  if ((ranAny && remaining > 0) || changed || (anyActive === 0 && remaining > 0)) {
    scheduler.push(JOB, { reason: 'post-pump' }, { delayMs: 120 });
  }
}

/** 服务启动恢复：running/planning 一律 recovering→queued（attempt+1），租约令牌作废旧 worker（C13） */
export function recoverOrchestrator(): number {
  const d = getDb();
  const stale = d.all<{ id: string }>(`SELECT id FROM runs WHERE status IN ('running','planning','recovering')`);
  const now = nowIso();
  for (const s of stale) {
    d.run('UPDATE runs SET lease_token=lease_token+1, lease_owner=NULL WHERE id=?', s.id);
    d.run(`UPDATE runs SET status='queued', attempt=attempt+1, queue_position=?, queue_reason=?, updated_at=? WHERE id=?`,
      Date.now(), '服务重启：恢复重领（attempt+1；fencing 保证不重复提交）', now, s.id);
  }
  d.run('DELETE FROM resource_locks WHERE expires_at IS NULL OR expires_at < ?', now);
  return stale.length;
}

let workerStarted = false;

/** 暴露给主控：注册 agent-run 消费与启动期恢复（index.ts 的 startOrchestratorWorker） */
export function startOrchestratorWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  scheduler.define(JOB, { concurrency: Math.max(2, config.runSlotsPerSession * 2), retryBackoffMs: [1000, 4000] });
  scheduler.onJob(JOB, pumpHandler);
  const prevRecover = scheduler.recover;
  scheduler.recover = async (push) => {
    await prevRecover(push);
    const n = recoverOrchestrator();
    if (n > 0) push(JOB, { reason: 'orchestrator-recovered' });
    else push(JOB, { reason: 'orchestrator-boot' });
  };
  scheduler.push(JOB, { reason: 'boot' });
}

/** 新请求 / 取消 / 重试 / 解阻后推动调度（供 service 调用；真实事件驱动） */
export function kickScheduler(reason: string): void {
  scheduler.push(JOB, { reason });
}

/** 模型配置只影响规划路径选择，不影响调度真实性 */
export function plannerSourceFor(): PlannerSource {
  return modelStatus().configured ? 'model' : 'deterministic';
}
