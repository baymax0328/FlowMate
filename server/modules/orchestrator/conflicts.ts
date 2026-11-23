// FlowMate · 冲突识别两层（PRD §11.4 / §12 / C09）
// 1) 确定性：同 file_id 写集交集 / 版本基准 / 路径 / 依赖 → 立即写 conflicts（basis='deterministic'），
//    相关 Run 置 blocked 或带 queue_reason 排队；同一文件正式提交资源级串行。
// 2) 语义矛盾：两个请求目标互相矛盾 → 有模型时模型辅助标记 basis='model_assisted'
//    （模型判断不作为唯一锁，必须人来 resolve）；无模型时跳过语义层并在冲突 detail 中注明未检测。
// 业务矛盾展示双方请求并暂停相关部分，不采用「最后消息优先」。
import { getDb, j, nowIso, S, uuid } from '../../core/db';
import { AppError } from '../../core/errors';
import { modelStatus, chatJson } from '../../adapters/model.adapter';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted, assertNoCredential } from './tools';
import type { PlanSubtask } from './planner';
import { z } from 'zod';

export interface NewRunLike {
  id: string;
  request_id: string;
  session_id: string;
  organization_id: string;
  subtask_id: string;
  output_kind: string;
  write_file_ids: string[];
  creator_id: string;
}

const ACTIVE_RUN = `('queued','planning','running','waiting_input','waiting_approval','blocked','recovering')`;

export function insertConflict(c: {
  organization_id: string; session_id: string | null; type: 'resource' | 'version' | 'path' | 'write_set' | 'dependency' | 'semantic';
  resource_key: string; affected_ids: string[]; waiting_on: string[]; detail: string; basis: 'deterministic' | 'model_assisted';
}): string {
  const d = getDb();
  // 同资源同类型 open 冲突合并，避免重复刷屏
  const dup = d.get<{ id: string; affected_ids: string; detail: string }>(
    'SELECT id, affected_ids, detail FROM conflicts WHERE organization_id=? AND type=? AND resource_key=? AND status=\'open\'',
    c.organization_id, c.type, c.resource_key);
  if (dup) {
    const affected = Array.from(new Set([...j<string[]>(dup.affected_ids, []), ...c.affected_ids]));
    const detail = dup.detail.includes(c.detail) ? dup.detail : `${dup.detail}\n${c.detail}`;
    d.run('UPDATE conflicts SET affected_ids=?, detail=?, updated_at=? WHERE id=?', S(affected), detail, nowIso(), dup.id);
    return dup.id;
  }
  const id = uuid();
  d.run(
    `INSERT INTO conflicts(id,organization_id,session_id,type,resource_key,affected_ids,waiting_on,detail,basis,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?, 'open', ?, ?)`,
    id, c.organization_id, c.session_id, c.type, c.resource_key, S(c.affected_ids), S(c.waiting_on),
    c.detail, c.basis, nowIso(), nowIso());
  return id;
}

/**
 * 确定性冲突检测 + 资源级串行排队。
 * 返回被置 blocked 的 run_id 集合（调用方据此写 queue_reason）。
 */
export function detectDeterministic(newRuns: NewRunLike[]): Set<string> {
  const d = getDb();
  const blocked = new Set<string>();
  for (const run of newRuns) {
    if (run.output_kind !== 'formal_change' || run.write_file_ids.length === 0) continue;
    for (const fileId of run.write_file_ids) {
      // 写集交集：同文件正式提交 → 与更早创建的活跃 Run 冲突，后来者排队（公平轮转按请求创建时间）
      const prior = d.all<{ id: string; request_id: string; created_at: string }>(
        `SELECT id, request_id, created_at FROM runs WHERE organization_id=? AND id!=?
           AND output_kind='formal_change' AND status IN ${ACTIVE_RUN}
           AND write_set LIKE ? ORDER BY created_at ASC`,
        run.organization_id, run.id, `%"${fileId}"%`)
        .filter((r) => r.request_id !== run.request_id || r.id !== run.id);
      const realPrior = prior.filter((r) => {
        const ws = j<{ file_id: string }[]>(d.get<{ write_set: string }>('SELECT write_set FROM runs WHERE id=?', r.id)?.write_set ?? '[]', []);
        return ws.some((w) => w.file_id === fileId);
      });
      if (realPrior.length) {
        const cid = insertConflict({
          organization_id: run.organization_id, session_id: run.session_id, type: 'write_set',
          resource_key: `file:${fileId}`,
          affected_ids: [...realPrior.map((p) => p.id), run.id],
          waiting_on: realPrior.map((p) => p.id),
          detail: `两个请求共同影响正式文件 ${fileId}：先前 Run ${realPrior.map((p) => p.id).join('、')} 的变更在进行中，本 Run 排队等待；`
            + '同一文件正式提交资源级串行；双方请求见 affected_ids，不采用「最后消息优先」。'
            + (modelStatus().configured ? '' : '（语义层未检测：模型未配置）'),
          basis: 'deterministic',
        });
        d.run("UPDATE runs SET status='blocked', queue_reason=?, updated_at=? WHERE id=? AND status='queued'",
          `等待前序 Run ${realPrior[0].id} 对同一文件的正式提交完成（冲突 ${cid}）`, nowIso(), run.id);
        blocked.add(run.id);
      }
      // 版本基准：目标文件当前版本已被他人在飞提案改走 → version 冲突
      const file = d.get<{ current_version_id: string }>('SELECT current_version_id FROM files WHERE id=?', fileId);
      const openProp = d.get<{ id: string }>(
        "SELECT id FROM proposals WHERE target_file_id=? AND status IN ('pending_approval','ready_to_commit','suspended') AND run_id!=?",
        fileId, run.id);
      if (file && openProp) {
        insertConflict({
          organization_id: run.organization_id, session_id: run.session_id, type: 'version',
          resource_key: `file_version:${fileId}`, affected_ids: [run.id, openProp.id], waiting_on: [openProp.id],
          detail: `目标文件存在在途提案（${openProp.id}），本 Run 的基准版本需在其后重新校验`,
          basis: 'deterministic',
        });
      }
      // 路径冲突：同目录同名草稿在两个活跃 Run 的 write_paths 中相遇
      const pathHits = d.all<{ id: string; write_set: string }>(
        `SELECT id, write_set FROM runs WHERE organization_id=? AND id!=? AND status IN ${ACTIVE_RUN} AND write_set LIKE '%"path%"'`,
        run.organization_id, run.id);
      const myPaths = j<{ path?: string }[]>(d.get<{ write_set: string }>('SELECT write_set FROM runs WHERE id=?', run.id)?.write_set ?? '[]', [])
        .map((w) => w.path).filter(Boolean) as string[];
      for (const other of pathHits) {
        const otherPaths = j<{ path?: string }[]>(other.write_set, []).map((w) => w.path).filter(Boolean) as string[];
        const shared = myPaths.filter((p) => otherPaths.includes(p));
        if (shared.length) {
          insertConflict({
            organization_id: run.organization_id, session_id: run.session_id, type: 'path',
            resource_key: `path:${shared[0]}`, affected_ids: [other.id, run.id], waiting_on: [other.id],
            detail: `两个活跃 Run 写入同一路径 ${shared[0]}，后者排队`,
            basis: 'deterministic',
          });
          if (!blocked.has(run.id)) {
            d.run("UPDATE runs SET status='blocked', queue_reason=?, updated_at=? WHERE id=? AND status='queued'",
              `等待前序 Run ${other.id} 完成对路径 ${shared[0]} 的写入`, nowIso(), run.id);
            blocked.add(run.id);
          }
        }
      }
    }
    // 依赖冲突：depends_on 指向已失败/取消的 Run → dependency 冲突（不自动通过）
    const dep = j<string[]>(d.get<{ depends_on: string }>('SELECT depends_on FROM runs WHERE id=?', run.id)?.depends_on ?? '[]', []);
    for (const depId of dep) {
      const dr = d.get<{ status: string }>('SELECT status FROM runs WHERE id=?', depId);
      if (dr && ['failed', 'cancelled'].includes(dr.status)) {
        insertConflict({
          organization_id: run.organization_id, session_id: run.session_id, type: 'dependency',
          resource_key: `dep:${depId}->${run.id}`, affected_ids: [run.id], waiting_on: [depId],
          detail: `前置 Run ${depId} 已 ${dr.status}，本步骤无法基于其结果继续，需人工处理`,
          basis: 'deterministic',
        });
        d.run("UPDATE runs SET status='blocked', queue_reason=?, updated_at=? WHERE id=? AND status='queued'",
          `前置 Run ${depId} 已失败/取消，等待冲突处理`, nowIso(), run.id);
        blocked.add(run.id);
      }
    }
  }
  return blocked;
}

const SemanticSchema = z.object({
  contradiction: z.boolean(),
  explanation: z.string().max(600).default(''),
});

/**
 * 语义矛盾检测（模型辅助，不作为唯一锁）：
 * 仅当会话中存在其他活跃请求且模型可用。命中 → conflicts(type='semantic', basis='model_assisted')，
 * 新请求相关 Run 暂停（waiting_input）并展示双方请求；无模型 → 跳过，且在既有 deterministic
 * 冲突 detail 与 plan.updated 事件里注明「语义层未检测」（由调用方通过返回值传递）。
 */
export async function detectSemantic(input: {
  organization_id: string; session_id: string;
  newRequestId: string; newGoal: string;
  otherRequests: { id: string; goal: string }[];
  newRunIds: string[];
}): Promise<{ conflict_id: string | null; paused: string[]; skipped_reason: string | null }> {
  if (!modelStatus().configured) {
    return { conflict_id: null, paused: [], skipped_reason: '语义矛盾未检测：模型未配置（确定性层已覆盖同文件/版本/路径/依赖）' };
  }
  if (!input.otherRequests.length) return { conflict_id: null, paused: [], skipped_reason: null };
  const prompt = [
    '判断以下同一团队会话中的两条请求是否在业务目标上相互矛盾（例如一条要求保留某文件旧版本、另一条要求以新内容覆盖同一文件；或结论互斥）。',
    UNTRUSTED_SYSTEM_RULE,
    '只输出 JSON：{"contradiction": boolean, "explanation": string}',
    `## 请求 A（在先）\n${wrapUntrusted(input.otherRequests.map((r) => `[${r.id}] ${r.goal}`).join('\n'), 'request_A')}`,
    `## 请求 B（新提交）\n${wrapUntrusted(input.newGoal, 'request_B')}`,
  ].join('\n');
  assertNoCredential(prompt);
  let verdict;
  try {
    const r = await chatJson(
      { messages: [{ role: 'system', content: '你是协作冲突审计器，只输出 JSON。' }, { role: 'user', content: prompt }],
        purpose: 'conflict-semantic', session_id: input.session_id, maxTokens: 400 },
      (raw) => SemanticSchema.parse(raw));
    verdict = r.value;
  } catch (e) {
    if (e instanceof AppError && e.code === 'MODEL_OUTPUT_INVALID') throw e;
    return { conflict_id: null, paused: [], skipped_reason: '语义矛盾检测调用失败，本轮仅确定性层生效' };
  }
  if (!verdict.contradiction) return { conflict_id: null, paused: [], skipped_reason: null };
  const id = insertConflict({
    organization_id: input.organization_id, session_id: input.session_id, type: 'semantic',
    resource_key: `session:${input.session_id}`,
    affected_ids: [...input.otherRequests.map((r) => r.id), input.newRequestId],
    waiting_on: input.otherRequests.map((r) => r.id),
    detail: `模型辅助判断双方请求目标矛盾（判断不作为唯一锁，需人工在冲突队列选择顺序/方案或澄清）：\n${verdict.explanation}\n`
      + `请求 A：${input.otherRequests.map((r) => `${r.id}: ${r.goal.slice(0, 80)}`).join(' | ')}\n请求 B：${input.newRequestId}: ${input.newGoal.slice(0, 80)}`,
    basis: 'model_assisted',
  });
  // 暂停相关部分：新请求的 Run 置 waiting_input（不影响 A 已独立执行的部分）
  const d = getDb();
  const paused: string[] = [];
  for (const rid of input.newRunIds) {
    const r = d.run("UPDATE runs SET status='waiting_input', queue_reason=?, updated_at=? WHERE id=? AND status='queued'",
      `等待语义冲突 ${id} 的人工处理（双方请求均展示，不采用最后消息优先）`, nowIso(), rid);
    if (r.changes) paused.push(rid);
  }
  if (paused.length) {
    d.run("UPDATE requests SET status='needs_clarification', updated_at=? WHERE id=? AND status IN ('planned','running','submitted')",
      nowIso(), input.newRequestId);
  }
  return { conflict_id: id, paused, skipped_reason: null };
}

/**
 * resolveConflict：order / option_a / option_b / clarify。
 * 正式修改仍须相关指令人全部确认，不能强制覆盖 —— 本函数只做排队与暂停，绝不直接写正式文件。
 */
export function resolveConflictSync(actor: { userId: string; orgId: string; role: string }, input: {
  conflict_id: string; resolution: 'order' | 'option_a' | 'option_b' | 'clarify'; note?: string;
}): { unblocked: string[]; cancelled: string[]; conflict: unknown } {
  void actor;
  const d = getDb();
  const cf = d.get<Record<string, unknown>>('SELECT * FROM conflicts WHERE id=?', input.conflict_id);
  if (!cf) throw AppError.notFound('冲突不存在');
  if (cf.status !== 'open') throw AppError.invalidTransition('该冲突已处理');
  const affected = j<string[]>(cf.affected_ids, []);
  const unblocked: string[] = [];
  const cancelled: string[] = [];
  const now = nowIso();

  const requeue = (ids: string[], reason: string) => {
    ids.forEach((rid, i) => {
      const r = d.run("UPDATE runs SET status='queued', queue_position=?, queue_reason=?, updated_at=? WHERE id=? AND status IN ('blocked','waiting_input')",
        Date.now() + i, reason, now, rid);
      if (r.changes) unblocked.push(rid);
    });
  };

  if (input.resolution === 'order') {
    // 确认顺序：affected_ids 即用户给定的先后顺序，逐个放行排队位（前序完成后由调度器接力）
    requeue(affected, `冲突 ${input.conflict_id} 按人工确认顺序执行：${input.note ?? '顺序即 affected_ids 列表'}`);
  } else if (input.resolution === 'option_a' || input.resolution === 'option_b') {
    // 选方案：受影响请求按 affected 顺序视为 [A..., B...]；选 a 保留先发起方、取消后发冲突 Run；反之亦然。
    const firstHalf = affected.slice(0, Math.ceil(affected.length / 2));
    const secondHalf = affected.slice(Math.ceil(affected.length / 2));
    const keep = input.resolution === 'option_a' ? firstHalf : secondHalf;
    const drop = input.resolution === 'option_a' ? secondHalf : firstHalf;
    requeue(keep, `冲突 ${input.conflict_id} 人工选择方案 ${input.resolution === 'option_a' ? 'A' : 'B'} 后继续`);
    for (const rid of drop) {
      const r = d.run(
        `UPDATE runs SET status='cancelled', cancel_epoch=cancel_epoch+1, cancel_reason=?, finished_at=?, updated_at=?
         WHERE id=? AND status IN ('blocked','waiting_input','queued')`,
        `冲突处理：落选方案（${input.resolution}）。${input.note ?? ''}`, now, now, rid);
      if (r.changes) cancelled.push(rid);
    }
  } else {
    // clarify：受影响 Run 保持暂停，双方请求转 needs_clarification 等待指令人补充
    for (const rid of affected) {
      d.run("UPDATE runs SET queue_reason=?, updated_at=? WHERE id=? AND status IN ('blocked','waiting_input')",
        `等待澄清：${input.note ?? '双方请求目标需指令人澄清后才继续'}`, now, rid);
      const runRow = d.get<{ request_id: string }>('SELECT request_id FROM runs WHERE id=?', rid);
      if (runRow) {
        d.run("UPDATE requests SET status='needs_clarification', clarification=?, updated_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled')",
          input.note ?? '存在语义/资源冲突，等待相关指令人澄清', now, runRow.request_id);
      }
    }
  }
  d.run("UPDATE conflicts SET status='resolved', resolution=?, resolved_by=?, resolved_at=?, updated_at=? WHERE id=?",
    `${input.resolution}${input.note ? `：${input.note}` : ''}`, actor.userId, now, now, input.conflict_id);
  return { unblocked, cancelled, conflict: { ...cf, status: 'resolved' } };
}

/** 依赖满足判定（调度器领取前调用） */
export function depsSatisfied(runId: string): { ok: boolean; waiting_on: string[]; dead: string[] } {
  const d = getDb();
  const depends = j<string[]>(d.get<{ depends_on: string }>('SELECT depends_on FROM runs WHERE id=?', runId)?.depends_on ?? '[]', []);
  const waiting_on: string[] = []; const dead: string[] = [];
  for (const dep of depends) {
    const st = d.get<{ status: string }>('SELECT status FROM runs WHERE id=?', dep)?.status;
    if (!st || st === 'succeeded') continue;
    if (['failed', 'cancelled'].includes(st)) dead.push(dep);
    else waiting_on.push(dep);
  }
  return { ok: waiting_on.length === 0 && dead.length === 0, waiting_on, dead };
}
