// FlowMate · 编排层的行读写原语（供 service 与 runner 共用，列名以 002 + 007 迁移为准）
import { getDb, nowIso, S, uuid } from '../../core/db';
import type { Json } from '../../core/contracts';

export interface RequestRow extends Json {
  id: string; organization_id: string; session_id: string; creator_id: string; goal: string;
  instruction_revision: number; output_kind: string; write_scope: string; risk: string; status: string;
  plan: string; clarification: string | null; idempotency_key: string | null; source_message_id: string | null;
  planner: string | null; instruction_log: string; created_at: string; updated_at: string;
}

export interface RunRowLite extends Json {
  id: string; organization_id: string; request_id: string; session_id: string;
  subtask_id: string; subtask_name: string; status: string; attempt: number; slot: number | null;
  lease_token: number; queue_position: number | null; queue_reason: string | null;
  planner: string | null; output_kind: string; cancel_epoch: number;
}

export function readRunRow(runId: string): RunRowLite | undefined {
  return getDb().get<RunRowLite>('SELECT * FROM runs WHERE id=?', runId);
}

export function requestRow(requestId: string): RequestRow | undefined {
  return getDb().get<RequestRow>('SELECT * FROM requests WHERE id=?', requestId);
}

/** 排队位置：会话内单调递增（公平轮转的排序键） */
export function nextQueuePosition(sessionId: string): number {
  const d = getDb();
  const cur = Number(d.val<number>('SELECT COALESCE(MAX(queue_position),0) FROM runs WHERE session_id=? AND queue_position IS NOT NULL', sessionId) ?? 0);
  const rows = d.all<{ id: string }>('SELECT id FROM runs WHERE session_id=? AND status=\'queued\' ORDER BY queue_position', sessionId);
  if (rows.length >= 1000) d.run('UPDATE runs SET queue_position=NULL WHERE session_id=? AND queue_position IS NOT NULL', sessionId);
  return cur + 1;
}

export function insertRequest(input: {
  id?: string;
  organizationId: string; sessionId: string; creatorId: string; goal: string;
  outputKind: string; writeScope: Json[]; risk: string; status: string;
  plan: Json[]; clarification: string | null; idempotencyKey: string | null;
  sourceMessageId: string | null; planner: string; auxIds?: string[]; chatMode?: boolean;
}): string {
  const id = input.id ?? uuid();
  const now = nowIso();
  // 19 列：前 5 个 ?，instruction_revision 用字面量 1，后 13 个 ?（含 chat_mode）
  getDb().run(
    `INSERT INTO requests
      (id, organization_id, session_id, creator_id, goal, instruction_revision, output_kind, write_scope,
       risk, status, plan, clarification, idempotency_key, source_message_id, created_at, updated_at,
       planner, instruction_log, chat_mode)
     VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, input.organizationId, input.sessionId, input.creatorId, input.goal,
    input.outputKind, S(input.writeScope), input.risk, input.status, S(input.plan), input.clarification,
    input.idempotencyKey, input.sourceMessageId, now, now, input.planner,
    S([{ revision: 1, goal: input.goal, at: now, by: input.creatorId, aux_ids: input.auxIds ?? [] }]),
    input.chatMode ? 1 : 0);
  return id;
}

export function insertRun(input: {
  organizationId: string; requestId: string; sessionId: string;
  subtaskId: string; subtaskName: string; queuePosition: number; queueReason: string | null;
  dependsOn: string[]; readSet: Json[]; writeSet: Json[]; planner: string; outputKind: string;
}): string {
  const id = uuid();
  const now = nowIso();
  getDb().run(
    `INSERT INTO runs
      (id, organization_id, request_id, session_id, subtask_id, subtask_name, slot, attempt, status,
       lease_token, lease_owner, lease_expires_at, cancel_epoch, queue_position, queue_reason,
       depends_on, read_set, write_set, context_snapshot, planner, output_kind, heartbeat_at, created_at, updated_at)
     VALUES (?,?,?, ?,?,?, NULL, 1, 'queued', 0, NULL, NULL, 0, ?,?, ?,?,?, ?,?,?, NULL, ?,?)`,
    id, input.organizationId, input.requestId, input.sessionId, input.subtaskId, input.subtaskName,
    input.queuePosition, input.queueReason,
    S(input.dependsOn), S(input.readSet), S(input.writeSet), S({ planner: input.planner, output_kind: input.outputKind }),
    input.planner, input.outputKind, now, now,
  );
  return id;
}

export function runCountForSession(sessionId: string): { active: number; queued: number } {
  const d = getDb();
  return {
    active: Number(d.val<number>(
      "SELECT COUNT(*) FROM runs WHERE session_id=? AND status IN ('planning','running','waiting_input','recovering')", sessionId) ?? 0),
    queued: Number(d.val<number>("SELECT COUNT(*) FROM runs WHERE session_id=? AND status='queued'", sessionId) ?? 0),
  };
}
