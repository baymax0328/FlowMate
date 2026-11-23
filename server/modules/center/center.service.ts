// FlowMate · Agent / Center（PRD §12）
// 运行、变更、冲突、事件、用量；全部按当前用户授权过滤；用量未知显示 null（不写 0）。
import { Injectable } from '@nestjs/common';
import { getDb, j } from '../../core/db';
import { assertSessionAccess, isOrgManager, type Actor } from '../../core/permissions';
import type { CenterService as CenterContract, Json } from '../../core/contracts';
import { need } from '../../core/contracts';

@Injectable()
export class CenterService implements CenterContract {
  private d = () => getDb();

  async overview(actor: Actor, filters: Json): Promise<Json> {
    const orch = need('orchestrator') as unknown as { centerOverview(a: Actor): Json };
    const base = orch.centerOverview(actor);
    const d = this.d();
    const proposals = d.all<Json>(
      `SELECT status, COUNT(*) AS n FROM proposals WHERE organization_id=? GROUP BY status`, actor.orgId);
    const byStatus: Json = {};
    for (const p of proposals) byStatus[String(p.status)] = Number(p.n);
    const visibleSessions = this.visibleSessionIds(actor);
    return {
      ...base,
      pending_approval: byStatus.pending_approval ?? 0,
      suspended: byStatus.suspended ?? 0,
      stale: byStatus.stale ?? 0,
      committed_today: byStatus.committed ?? 0,
      changes: Number(byStatus.pending_approval ?? 0) + Number(byStatus.ready_to_commit ?? 0) + Number(byStatus.suspended ?? 0),
      sessions_visible: visibleSessions.length,
      filters_applied: filters ?? {},
      note: '实时状态与期间完成量分开标注（§12）',
    };
  }

  async runs(actor: Actor, filters: Json): Promise<Json[]> {
    const orch = need('orchestrator') as unknown as {
      centerRuns(a: Actor, f: never): Json[];
    };
    return orch.centerRuns(actor, (filters ?? {}) as never);
  }

  /** 文件变更：提案 + 采用状态（§12 Changes） */
  async changes(actor: Actor, filters: Json): Promise<Json[]> {
    const f = (filters ?? {}) as { status?: string; session_id?: string; file_id?: string };
    const rows = this.d().all<Json>(
      `SELECT p.id, p.target_file_id, p.target_name, p.base_version_id, p.proposed_version_id, p.committed_version_id,
              p.status, p.revision, p.approval_count, p.needed_count, p.summary, p.created_at, p.updated_at,
              p.session_id, p.run_id, p.final_reason, p.suspend_deadline_at, p.suspended_at,
              u.display_name AS creator_name, s.title AS session_title
       FROM proposals p JOIN users u ON u.id=p.created_by JOIN agent_sessions s ON s.id=p.session_id
       WHERE p.organization_id=?
         ${f.status ? 'AND p.status=?' : ''} ${f.session_id ? 'AND p.session_id=?' : ''} ${f.file_id ? 'AND p.target_file_id=?' : ''}
       ORDER BY p.created_at DESC LIMIT 200`,
      actor.orgId, ...[f.status, f.session_id, f.file_id].filter(Boolean) as string[]);
    return rows.filter((r) => this.canSeeSession(actor, String(r.session_id))).map((r) => ({
      ...r,
      base_version_no: this.d().val<number>('SELECT version_no FROM file_versions WHERE id=?', r.base_version_id as string) ?? null,
      committed_version_no: r.committed_version_id
        ? this.d().val<number>('SELECT version_no FROM file_versions WHERE id=?', r.committed_version_id as string) ?? null : null,
      required_approvers: j<string[]>(r.required_approvers ?? '[]', []),
    }));
  }

  async conflicts(actor: Actor, filters: Json): Promise<Json[]> {
    const orch = need('orchestrator') as unknown as { listConflicts(a: Actor, f: Json): Json[] };
    return orch.listConflicts(actor, (filters ?? {}) as Json);
  }

  /** 协作事件时间线：按对象过滤，事件可直达实体（§12） */
  async events(actor: Actor, filters: Json): Promise<Json[]> {
    const f = (filters ?? {}) as { entity_type?: string; entity_id?: string; session_id?: string; type?: string; limit?: number };
    const where = ['e.organization_id=?'];
    const p: (string | number)[] = [actor.orgId];
    if (f.entity_type) { where.push('e.entity_type=?'); p.push(f.entity_type); }
    if (f.entity_id) { where.push('e.entity_id=?'); p.push(f.entity_id); }
    if (f.session_id) { where.push('e.session_id=?'); p.push(f.session_id); }
    if (f.type) { where.push('e.type LIKE ?'); p.push(`${f.type}%`); }
    const rows = this.d().all<Json>(
      `SELECT e.*, u.display_name AS actor_name FROM events e LEFT JOIN users u ON u.id=e.actor_id
       WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT ?`, ...p, Math.min(f.limit ?? 120, 500));
    return rows.filter((r) => !r.session_id || this.canSeeSession(actor, String(r.session_id))).map((r) => ({
      ...r, payload: j<Json>(r.payload as string, {}),
    }));
  }

  /** 用量抽屉：本版仅透明展示，不做配额与治理，也不作人员绩效排名（§12 / §24） */
  async usage(actor: Actor, filters: Json): Promise<Json> {
    const f = (filters ?? {}) as { session_id?: string; from?: string; to?: string };
    const d = this.d();
    const where = ['organization_id=?'];
    const p: (string | number)[] = [actor.orgId];
    if (f.session_id) { where.push('session_id=?'); p.push(f.session_id); }
    if (f.from) { where.push('created_at>=?'); p.push(f.from); }
    if (f.to) { where.push('created_at<=?'); p.push(f.to); }
    const rows = d.all<Json>(`SELECT * FROM usage_records WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, ...p);
    const sum = (k: string) => rows.reduce((acc, r) => acc + (r[k] === null || r[k] === undefined ? 0 : Number(r[k])), 0);
    const known = rows.some((r) => r.input_tokens !== null && r.input_tokens !== undefined);
    return {
      provider: rows[0]?.provider ?? null,
      model: rows[0]?.model ?? null,
      calls: sum('calls'),
      failures: sum('failures'),
      input_tokens: known ? sum('input_tokens') : null,
      output_tokens: known ? sum('output_tokens') : null,
      cost_estimate: rows.some((r) => r.cost_estimate !== null && r.cost_estimate !== undefined) ? sum('cost_estimate') : null,
      tokens_note: known ? null : '未获取（模型未返回 usage 字段）',
      note: '仅透明展示，不做配额治理与绩效排名',
    };
  }

  private canSeeSession(actor: Actor, sessionId: string): boolean {
    try {
      assertSessionAccess(actor, sessionId, 'read');
      return true;
    } catch {
      return false;
    }
  }

  private visibleSessionIds(actor: Actor): string[] {
    const d = this.d();
    const rows = d.all<{ id: string }>(
      `SELECT s.id FROM agent_sessions s
       WHERE s.organization_id=? AND (s.owner_id=? OR EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id=s.id AND sp.user_id=? AND sp.left_at IS NULL))`,
      actor.orgId, actor.userId, actor.userId);
    const list = rows.map((r) => r.id);
    return isOrgManager(actor) ? list : list;
  }
}

let instance: CenterService | null = null;
export function getCenterService(): CenterService {
  if (!instance) instance = new CenterService();
  return instance;
}
