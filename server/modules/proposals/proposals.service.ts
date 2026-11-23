// FlowMate · 多方共同确认内核（ChangeProposal / Approval / 超时挂起 / 唤醒 / 原子提交 / 签名失效）
// PRD §11.2 / §11.3 / §11 共同确认卡 / §16「共同确认正式修改」/ §17 Proposal 状态机 / §19 /proposals 接口 / §20 确认者 / §23 C10·C11·C12
//
// 四条验收底线（写死在本文件，任何重构不得移除）：
//  [底线1] 任何情况下不能超时视为同意：tick() 只有「提醒」「挂起」「失效检测」三条动作，绝无 auto-approve 分支；
//          commitFormalVersion 只可能由 decide(approve) 集齐 required_approvers 全签后触发。
//  [底线2] 协调者不能强制通过：没有绕过 required_approvers 计数的入口；decide 严格校验 actor∈required_approvers，
//          非相关人 403；协调者仅能 wake/void/remind，不能代签、不能改票。
//  [底线3] 不得删除审计签名：失效一律 approvals.active=0，永不 DELETE approvals（保留可追溯的签名记录）。
//  [底线4] 全员确认仍需「执行者当前编辑权 + 基准版本仍是 current + 文件写锁未被占 + fencing 有效」，
//          满足才转 ready_to_commit→committing→committed；否则转 stale / 返回 RESOURCE_BUSY，不写入。
//
// 状态机（§17）：draft→pending_approval→suspended→pending_approval→ready_to_commit→committing→committed；
//   修改→superseded；拒绝→rejected；基准版本变化→stale；可 cancelled。非法迁移抛 INVALID_TRANSITION。
//
// 与 files 服务的协作边界：正式文件的 current_version 全程不变（本模块只写 proposal_drafts 的独立草稿正文），
//   仅 commitFormalVersion 成功后由 files 服务原子推进 —— 这就是「正式文件写入必须过共同确认」这条底线。
import {
  appendEvent, getDb, j, nowIso, notify, queueOutbox, S, sha256, uuid, type Db,
} from '../../core/db';
import { AppError } from '../../core/errors';
import {
  aclRank, assertSessionAccess, canEdit, canRead, orgRole, resolveAcl, sessionAccess, type Actor,
} from '../../core/permissions';
import { config } from '../../core/config';
import { need, services, type FileDTO, type ID, type Json, type ProposalsService as ProposalsServiceContract, type VersionDTO } from '../../core/contracts';
import { live } from '../../core/live';
import {
  BODY_DIFFABLE_KINDS, EDITABLE_KINDS, buildBodyDiff, buildMetaDiff, buildTextDiff, computeDiffHash, computeSignedHash, type BuiltDiff, type DiffStats,
} from './proposal.diff';

const HOUR = 3600000;
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const sortUniq = (ids: ID[]): ID[] => Array.from(new Set((ids ?? []).filter(Boolean))).sort();
const TERMINAL = ['committed', 'superseded', 'rejected', 'cancelled'];

// 合法迁移表（§17）
const TRANSITIONS: Record<string, string[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['suspended', 'ready_to_commit', 'committing', 'superseded', 'rejected', 'stale', 'cancelled'],
  suspended: ['pending_approval', 'stale', 'superseded', 'rejected', 'cancelled'],
  stale: ['pending_approval', 'superseded', 'cancelled'],
  ready_to_commit: ['committing', 'stale', 'cancelled'],
  committing: ['committed', 'stale', 'ready_to_commit', 'cancelled'],
  committed: [], superseded: [], rejected: [], cancelled: [],
};

interface ProposalRow {
  id: string; organization_id: string; session_id: string; request_id: string | null; run_id: string | null;
  target_file_id: string; target_name: string; revision: number; base_version_id: string; proposed_version_id: string | null;
  diff_hash: string; diff: string; instruction_ids: string; required_approvers: string; approval_count: number; needed_count: number;
  status: string; created_by: string; executor_id: string; summary: string | null; reminder_count: number;
  next_reminder_at: string | null; suspend_deadline_at: string | null; suspended_at: string | null; woken_at: string | null;
  committed_version_id: string | null; committed_at: string | null; final_reason: string | null; revision_history: string;
  created_at: string; updated_at: string;
}
interface FileRowLite { id: string; name: string; kind: string; ext: string; mime: string; current_version_id: string | null; organization_id: string; status: string; folder_id: string | null }
interface VersionLite { id: string; file_id: string; version_no: number; size: number; sha256: string; change_source: string; author_id: string | null; base_version_id: string | null }

interface Ev { seq: number; userIds: string[] }

/** 跨模块取「通知服务」，未装配时回退到 core.notify（保证启动顺序无关，见交付报告「建议下沉」） */
function pushNotification(rec: {
  user_id: ID; organization_id: ID; type: string; title: string; body?: string; entity_type?: string;
  entity_id?: ID; actor_id?: ID | null; session_id?: ID | null; proposal_id?: ID | null; target_path?: string;
}) {
  const svc = services.notifications;
  if (svc) { void svc.emit(rec).catch(() => notify(rec)); return; }
  notify(rec);
}

export class ProposalsService implements ProposalsServiceContract {
  private d(): Db { return getDb(); }

  // ================= 内部：事件 + 实时（须在业务事务内调用 emitEv，再在事务外 deliverEv） =================
  private emitEv(col: Ev[], type: string, p: ProposalRow, actorId: ID | null, payload: Json, extraRecipients: ID[] = []) {
    const d = this.d();
    const ws = d.all<{ user_id: string }>(
      "SELECT user_id FROM session_participants WHERE session_id=? AND left_at IS NULL", p.session_id).map((r) => r.user_id);
    const userIds = sortUniq([...ws, ...extraRecipients]);
    const ev = appendEvent({
      type, organization_id: p.organization_id, entity_type: 'proposal', entity_id: p.id, revision: p.revision,
      actor_id: actorId, session_id: p.session_id, run_id: p.run_id, payload,
    });
    const recipients: { user_id: string | null; channel: string; payload?: unknown }[] = [];
    for (const u of userIds) { recipients.push({ user_id: u, channel: 'ws' }); recipients.push({ user_id: u, channel: 'notification' }); }
    queueOutbox(recipients, Number(ev.seq));
    col.push({ seq: Number(ev.seq), userIds });
  }
  private deliverEv(p: ProposalRow, evs: Ev[]) {
    for (const e of evs) {
      try { live.deliver(p.organization_id, 'proposal', p.id, e.seq, e.userIds); } catch { /* 推送失败不影响业务真相 */ }
    }
  }

  // ================= 内部：加载 + 权限 =================
  private row(id: ID): ProposalRow | undefined { return this.d().get<ProposalRow>('SELECT * FROM proposals WHERE id=?', id); }
  private mustRow(id: ID): ProposalRow {
    const r = this.row(id);
    if (!r) throw AppError.notFound('提案不存在或不可见');
    return r;
  }
  private assertVisible(actor: Actor, p: ProposalRow, min: 'read' | 'write' = 'read') {
    if (p.organization_id !== actor.orgId) throw AppError.notFound('提案不存在或不可见');
    assertSessionAccess(actor, p.session_id, min === 'write' ? 'write' : 'read');
  }
  private fileLite(id: ID): FileRowLite | undefined {
    return this.d().get<FileRowLite>('SELECT id,name,kind,ext,mime,current_version_id,organization_id,status,folder_id FROM files WHERE id=?', id);
  }
  private baseChanged(p: ProposalRow): boolean {
    const f = this.fileLite(p.target_file_id);
    return !f || f.status !== 'active' || (f.current_version_id ?? '') !== p.base_version_id;
  }
  private names(ids: ID[]): Record<string, string> {
    const uniq = sortUniq(ids);
    if (!uniq.length) return {};
    const rows = this.d().all<{ id: string; display_name: string }>(
      `SELECT id,display_name FROM users WHERE id IN (${uniq.map(() => '?').join(',')})`, ...uniq);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.id] = r.display_name;
    return map;
  }

  private assertTransition(from: string, to: string) {
    if (from === to) return;
    if (!TRANSITIONS[from]?.includes(to)) throw AppError.invalidTransition(`提案状态不允许从「${this.pill(from, 0, 0)}」迁移到「${this.pill(to, 0, 0)}」`);
  }

  // ================= 内部：草稿正文 =================
  private draftContent(p: ProposalRow): string {
    const c = this.d().get<{ content: string }>(
      'SELECT content FROM proposal_drafts WHERE proposal_id=? AND revision=?', p.id, p.revision);
    if (!c) throw AppError.notFound('提案草稿正文缺失，无法提交（需重新生成提案）');
    return c.content;
  }

  // ================= 内部：差异生成 =================
  private async buildDiff(file: FileRowLite, baseV: VersionLite, content: string): Promise<BuiltDiff> {
    const files = need('files');
    const oldLabel = `${file.name} (基准 v${baseV.version_no})`;
    const newLabel = `${file.name} (提案)`;
    const propSize = Buffer.byteLength(content, 'utf8');
    const propSha = sha256(content);
    if (EDITABLE_KINDS.includes(file.kind)) {
      const buf = (await files.readVersion(baseV.id)).buffer;
      return buildTextDiff(buf.toString('utf8'), content, oldLabel, newLabel);
    }
    if (BODY_DIFFABLE_KINDS.includes(file.kind)) {
      const t = await files.text(baseV.id);
      if (!t || t.status !== 'ready' || !t.raw_text.trim()) {
        return buildMetaDiff({
          targetName: file.name,
          base: { versionNo: baseV.version_no, size: baseV.size, sha256: baseV.sha256 },
          proposed: { versionNo: baseV.version_no + 1, size: propSize, sha256: propSha },
          reason: t?.reason ?? (t && t.status === 'pending' ? '正文抽取未完成' : '该类型无可比对文本层'),
        });
      }
      return buildBodyDiff(t.raw_text, content, oldLabel, newLabel);
    }
    return buildMetaDiff({
      targetName: file.name,
      base: { versionNo: baseV.version_no, size: baseV.size, sha256: baseV.sha256 },
      proposed: { versionNo: baseV.version_no + 1, size: propSize, sha256: propSha },
      reason: '图片等类型无文本层，正文不可比对',
    });
  }

  // ================= 相关指令人计算（§11.2） =================
  /**
   * 「参与当前变更的指令发起人」+「其仍有效指令/正在执行工作被此次变更直接影响的人」。
   * 实现：instruction_ids 对应 requests 的 creator_id ∪ 目标文件 write_set 命中且状态在
   *   running/queued/waiting_input/waiting_approval 的其他 requests 的 creator_id。
   * 不是所有在线成员、不是全团队；仅一人相关时由该发起人确认（执行者仍需文件编辑权，另行在提交处校验）。
   */
  computeRequiredApprovers(input: { session_id: ID; instruction_ids: ID[]; target_file_id: ID }): ID[] {
    const d = this.d();
    const set = new Set<ID>();
    const ids = sortUniq(input.instruction_ids);
    if (ids.length) {
      const rows = d.all<{ creator_id: string }>(`SELECT creator_id FROM requests WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      for (const r of rows) set.add(r.creator_id);
    }
    const runs = d.all<{ request_id: string }>(
      `SELECT request_id FROM runs WHERE session_id=? AND status IN ('running','queued','waiting_input','waiting_approval') AND write_set LIKE ?`,
      input.session_id, `%${input.target_file_id}%`);
    for (const r of runs) {
      const cr = d.get<{ creator_id: string }>('SELECT creator_id FROM requests WHERE id=?', r.request_id);
      if (cr) set.add(cr.creator_id);
    }
    return Array.from(set).sort();
  }

  // ================= create：先生成独立草稿，正式文件不变（§11.2） =================
  async create(input: {
    actor: Actor; session_id: ID; request_id?: ID | null; run_id?: ID | null;
    target_file_id: ID; base_version_id: ID; content: string; summary: string;
    instruction_ids: ID[]; required_approvers: ID[]; executor_id: ID;
  }): Promise<Json> {
    const d = this.d();
    const { actor, session_id, target_file_id, base_version_id } = input;
    assertSessionAccess(actor, session_id, 'write');
    const sess = d.get<{ id: string; organization_id: string }>('SELECT id,organization_id FROM agent_sessions WHERE id=?', session_id);
    if (!sess || sess.organization_id !== actor.orgId) throw AppError.notFound('会话不存在或不可见');
    const file = this.fileLite(target_file_id);
    if (!file || file.organization_id !== actor.orgId || file.status !== 'active') throw AppError.notFound('目标正式文件不存在');
    const baseV = d.get<VersionLite>('SELECT id,file_id,version_no,size,sha256,change_source,author_id,base_version_id FROM file_versions WHERE id=? AND file_id=?', base_version_id, target_file_id);
    if (!baseV) throw AppError.notFound('基准版本不存在或不属于目标文件');
    if ((file.current_version_id ?? '') !== base_version_id) throw AppError.versionConflict({ current_version_id: file.current_version_id });

    const instructionIds = sortUniq(input.instruction_ids);
    let approvers = sortUniq(input.required_approvers);
    if (!approvers.length) approvers = this.computeRequiredApprovers({ session_id, instruction_ids: instructionIds, target_file_id });
    if (!approvers.length) approvers = sortUniq([input.executor_id]);

    const built = await this.buildDiff(file, baseV, input.content);
    const diffHash = computeDiffHash({
      patch: built.patch, baseVersionId: base_version_id, targetFileId: target_file_id,
      instructionIds, requiredApprovers: approvers,
    });

    const proposalId = uuid();
    const t = nowIso();
    const evs: Ev[] = [];
    d.tx(() => {
      d.run(`INSERT INTO proposals(id,organization_id,session_id,request_id,run_id,target_file_id,target_name,revision,
          base_version_id,proposed_version_id,diff_hash,diff,instruction_ids,required_approvers,approval_count,needed_count,
          status,created_by,executor_id,summary,reminder_count,next_reminder_at,suspend_deadline_at,revision_history,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        proposalId, actor.orgId, session_id, input.request_id ?? null, input.run_id ?? null, target_file_id, file.name,
        1, base_version_id, null, diffHash, built.patch, S(instructionIds), S(approvers), 0, approvers.length,
        'pending_approval', actor.userId, input.executor_id, input.summary ?? null, 0,
        isoIn(config.approval.firstReminderHours * HOUR), isoIn(config.approval.suspendHours * HOUR),
        S([{ revision: 1, cause: 'created', diff_hash: diffHash, base_version_id, at: t }]), t, t);
      // 独立草稿正文（不写进目标文件版本链 → 正式文件 current_version 不变）
      d.run('INSERT INTO proposal_drafts(proposal_id,revision,content,base_version_id,created_by,created_at) VALUES(?,?,?,?,?,?)',
        proposalId, 1, input.content, base_version_id, actor.userId, t);
      d.run(`INSERT INTO proposal_revisions(id,proposal_id,revision,diff_hash,base_version_id,proposed_version_id,instruction_ids,required_approvers,cause,created_by,created_at)
        VALUES(?,?,1,?,?,NULL,?,?, 'created',?,?)`, uuid(), proposalId, diffHash, base_version_id, S(instructionIds), S(approvers), actor.userId, t);
      // 受影响 Run → waiting_approval（等待期不长时间占执行槽/写锁；本模块未持有 file 写锁）
      if (input.run_id) {
        d.run(`UPDATE runs SET status='waiting_approval', queue_reason='共同确认：等待相关指令人确认后原子提交', lease_owner=NULL, updated_at=?
          WHERE id=? AND status IN ('running','queued','planning','recovering')`, t, input.run_id);
      }
      // 关联产物 → proposed
      const arows = input.run_id ? { k: 'run_id', v: input.run_id } : (input.request_id ? { k: 'request_id', v: input.request_id } : null);
      if (arows) d.run(`UPDATE artifacts SET status='proposed', updated_at=? WHERE ${arows.k}=? AND target_file_id=? AND status='draft'`, t, arows.v, target_file_id);

      const p = this.mustRow(proposalId);
      this.writeOrUpdateCardTx(p);
      this.emitEv(evs, 'proposal.created', p, actor.userId, { target_file_id, base_version_id, needed: approvers.length, mode: built.mode });
      for (const u of approvers) {
        pushNotification({
          user_id: u, organization_id: actor.orgId, type: 'pending_approval', actor_id: actor.userId,
          title: `共同确认待办：${file.name}`, body: `有正式变更等待你确认（0/${approvers.length}）：${input.summary ?? ''}`,
          entity_type: 'proposal', entity_id: proposalId, session_id, proposal_id: proposalId, target_path: `/team/proposals/${proposalId}`,
        });
      }
      return undefined;
    });
    const created = this.mustRow(proposalId);
    this.deliverEv(created, evs);
    return this.assemble(actor, created, built.stats);
  }

  // ================= decide：签名 / 拒绝 / 提出修改（§11.2） =================
  async decide(actor: Actor, input: { proposal_id: ID; decision: 'approve' | 'reject' | 'request_changes'; reason?: string; diff_hash?: string }): Promise<Json> {
    const d = this.d();
    let p = this.mustRow(input.proposal_id);
    this.assertVisible(actor, p, 'write');

    // 底线1/2 前置：committed 幂等返回首次结果，绝不重复写入
    if (p.status === 'committed') return this.assemble(actor, p);

    // 只有 required_approvers 能表态（单一协调者不能代签）
    const approvers = j<ID[]>(p.required_approvers, []);
    if (!approvers.includes(actor.userId)) {
      throw AppError.forbidden('你不是本提案的相关指令人，不能表态；协调者不能代签');
    }
    // 审批人缺目标文件 viewer（diff 访问）权 → 403，明确说明先解决授权
    const file = this.fileLite(p.target_file_id)!;
    if (!canRead(actor, 'file', p.target_file_id)) {
      throw AppError.forbidden('你对目标正式文件缺少查看（diff）权限：已阻塞本提案，请先由文件管理者授予 viewer 权限后再确认');
    }
    // 基准失效守卫（C11：旧签名不得批准新内容）
    if (this.baseChanged(p)) { this.markStale(p, actor.userId, 'decide 时检测到基准版本已变化'); throw AppError.proposalStale('基准版本已变化，需重新生成差异后再确认'); }
    if (input.diff_hash && input.diff_hash !== p.diff_hash) {
      throw AppError.proposalStale('你查看的差异与当前提案签名不一致（内容/基准/相关人已变），需按新版本重新确认');
    }
    if (p.status === 'suspended') p = this.doWake(d, p, actor, '相关指令人表态自动唤醒');
    if (!['pending_approval', 'ready_to_commit'].includes(p.status)) {
      throw AppError.invalidTransition(`提案当前为「${this.pill(p.status, p.approval_count, p.needed_count)}」，不能表态`);
    }

    const evs: Ev[] = [];
    let commitNow = false;
    d.tx(() => {
      const t = nowIso();
      // 提出修改：不写入本修订的 approve；旧签名全部失效（active=0，保留审计），等待重新生成提案（supersede）
      if (input.decision === 'request_changes') {
        d.run('UPDATE approvals SET active=0 WHERE proposal_id=? AND active=1', p.id);
        d.run(`UPDATE proposals SET approval_count=0, final_reason=?, updated_at=? WHERE id=?`, this.reasonOf('提出修改', input.reason), t, p.id);
        d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), p.id, 'changes_requested', actor.userId, input.reason ?? null, t);
        const np = this.mustRow(p.id);
        this.writeOrUpdateCardTx(np);
        this.emitEv(evs, 'approval.updated', np, actor.userId, { decision: 'request_changes', invalidated: true });
        pushNotification({
          user_id: np.created_by, organization_id: np.organization_id, type: 'pending_approval', actor_id: actor.userId,
          title: `${file.name} 的提案被要求修改`, body: `相关指令人要求修改：${input.reason ?? '（未填写）'}。请重新生成差异后再次确认。`,
          entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}`,
        });
        return undefined;
      }
      // 拒绝：立即暂停并记录理由，status=rejected，旧签名全部失效（不删除审计签名）
      if (input.decision === 'reject') {
        d.run('UPDATE approvals SET active=0 WHERE proposal_id=? AND active=1', p.id);
        this.assertTransition(p.status, 'rejected');
        d.run(`UPDATE proposals SET status='rejected', approval_count=0, final_reason=?, updated_at=? WHERE id=?`, this.reasonOf('拒绝', input.reason), t, p.id);
        d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), p.id, 'rejected', actor.userId, input.reason ?? null, t);
        if (p.run_id) d.run(`UPDATE runs SET status='blocked', queue_reason=?, updated_at=? WHERE id=? AND status IN ('waiting_approval','running','queued')`, `提案被拒绝：${input.reason ?? ''}`, t, p.run_id);
        const np = this.mustRow(p.id);
        this.writeOrUpdateCardTx(np);
        this.emitEv(evs, 'proposal.rejected', np, actor.userId, { reason: input.reason ?? null });
        for (const u of sortUniq([...j<ID[]>(np.required_approvers, []), np.executor_id, np.created_by])) {
          pushNotification({
            user_id: u, organization_id: np.organization_id, type: 'pending_approval', actor_id: actor.userId,
            title: `${np.target_name} 的共同确认已被拒绝`, body: input.reason ?? '', entity_type: 'proposal', entity_id: np.id,
            session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}`,
          });
        }
        return undefined;
      }
      // 同意：幂等写入签名（重复点击不重复计数）—— (proposal,revision,user,decision) 唯一
      const dup = d.get<{ id: string }>('SELECT id FROM approvals WHERE proposal_id=? AND revision=? AND user_id=? AND decision=?', p.id, p.revision, actor.userId, 'approve');
      if (dup && d.get('SELECT 1 AS x FROM approvals WHERE id=? AND active=1', dup.id)) {
        return undefined; // 已有有效同意，幂等返回
      }
      // 该用户此前在本修订的其它表态失效，但保留（不得删除审计签名）
      d.run('UPDATE approvals SET active=0 WHERE proposal_id=? AND revision=? AND user_id=? AND active=1', p.id, p.revision, actor.userId);
      const signedFor = computeSignedHash(p.diff_hash, p.revision);
      if (dup) {
        d.run(`UPDATE approvals SET active=1, reason=?, signed_for_hash=?, diff_hash=?, created_at=? WHERE id=?`, input.reason ?? null, signedFor, p.diff_hash, t, dup.id);
      } else {
        d.run(`INSERT INTO approvals(id,proposal_id,organization_id,revision,diff_hash,user_id,decision,reason,signed_for_hash,active,created_at)
          VALUES(?,?,?,?,?,?,?, ?,?,1,?)`, uuid(), p.id, p.organization_id, p.revision, p.diff_hash, actor.userId, 'approve', input.reason ?? null, signedFor, t);
      }
      const cnt = Number(d.val<number>(
        'SELECT COUNT(DISTINCT user_id) FROM approvals WHERE proposal_id=? AND revision=? AND decision=? AND active=1 AND diff_hash=?',
        p.id, p.revision, 'approve', p.diff_hash) ?? 0);
      d.run('UPDATE proposals SET approval_count=?, updated_at=? WHERE id=?', cnt, t, p.id);
      const needed = j<ID[]>(p.required_approvers, []).length;
      const np = this.mustRow(p.id);
      this.writeOrUpdateCardTx(np);
      this.emitEv(evs, 'proposal.approved', np, actor.userId, { decision: 'approve', count: cnt, needed });
      this.emitEv(evs, 'approval.updated', np, actor.userId, { count: cnt, needed });
      if (needed > 0 && cnt >= needed) {
        commitNow = true;
        d.run(`UPDATE proposals SET status='ready_to_commit', updated_at=? WHERE id=? AND status='pending_approval'`, t, p.id);
      }
      return undefined;
    });
    const after = this.mustRow(p.id);
    this.deliverEv(after, evs);
    if (commitNow) {
      try {
        return await this.commit(after);
      } catch (e) {
        // 提交失败：版本冲突→已转 stale；锁忙/瞬时故障→保留 ready_to_commit 供幂等重试，把错误透传给调用方
        const cur = this.mustRow(p.id);
        if (e instanceof AppError && (e.code === 'RESOURCE_BUSY' || e.code === 'FORBIDDEN')) {
          // 未提交，返回当前态（含禁用原因）让前端展示「再点提交」
          return this.assemble(actor, cur);
        }
        throw e;
      }
    }
    return this.assemble(actor, after);
  }

  // ================= 原子提交（§11.2 全部确认 / §11.4 短暂取锁再校验 / 底线4） =================
  /** 幂等：仅当 ready_to_commit（或重试自 committing）才推进；已 committed 直接返回首次结果，绝不产生新版本 */
  async commit(p: ProposalRow): Promise<Json> {
    const d = this.d();
    const cur = this.mustRow(p.id);
    if (cur.status === 'committed') {
      // 幂等：已提交再点提交必须返回首次结果，不重复写入
      return this.getActorless(cur);
    }
    this.assertTransition(cur.status, 'committing');

    // 重校验：每个审批人当前授权、基准仍是 current、执行者编辑权、fencing
    const approvers = j<ID[]>(cur.required_approvers, []);
    const execActor: Actor = { userId: cur.executor_id, orgId: cur.organization_id, role: orgRole(cur.executor_id, cur.organization_id) ?? 'member', displayName: '' };
    if (!canEdit(execActor, 'file', cur.target_file_id)) {
      const t = nowIso();
      d.tx(() => { d.run(`UPDATE proposals SET status='stale', final_reason=?, updated_at=? WHERE id=?`, '执行者当前已无文件编辑权，无法提交', t, cur.id); });
      this.markStale(cur, cur.executor_id, '执行者编辑权已失效');
      throw AppError.forbidden('实际执行者当前不具备目标文件编辑权，无法正式提交（普通参与人的同意不授予写权）');
    }
    if (this.baseChanged(cur)) { this.markStale(cur, cur.executor_id, '提交前检测到基准版本已变化'); throw AppError.proposalStale('基准版本已变化，需重新生成差异后再确认'); }
    for (const u of approvers) {
      const aActor: Actor = { userId: u, orgId: cur.organization_id, role: orgRole(u, cur.organization_id) ?? 'member', displayName: '' };
      if (resolveAcl(aActor, 'file', cur.target_file_id).allow < aclRank.viewer) {
        this.markStale(cur, u, `审批人 ${u} 已失去文件查看权`);
        throw AppError.proposalStale('部分确认人已失去该文件的查看权限，需重新授权并重审');
      }
    }
    // 锁占探测（文件级资源锁：若被别的 Run/Proposal 长期占用 → 幂等重试，不写入）
    const lk = d.get<{ expires_at: string | null; owner_run_id: string | null; owner_proposal_id: string | null }>(
      'SELECT expires_at, owner_run_id, owner_proposal_id FROM resource_locks WHERE resource_key=?', `file:${cur.target_file_id}`);
    if (lk && lk.expires_at && new Date(lk.expires_at).getTime() > Date.now() && lk.owner_proposal_id !== cur.id) {
      throw AppError.busy('目标文件正被其它正式提交占用，提案已就绪，稍后自动/手动重试即可（不重复写入）', { proposal_id: cur.id, holder: lk.owner_run_id });
    }

    // → committing
    const t0 = nowIso();
    d.run(`UPDATE proposals SET status='committing', updated_at=? WHERE id=? AND status IN ('ready_to_commit','committing','pending_approval')`, t0, cur.id);

    const files = need('files');
    const content = this.draftContent(cur);
    let version: VersionDTO;
    try {
      version = await files.commitFormalVersion({
        file_id: cur.target_file_id, content: Buffer.from(content, 'utf8'), base_version_id: cur.base_version_id,
        actor: execActor, run_id: cur.run_id, lease_token: this.fencingToken(cur), summary: cur.summary ?? '共同确认正式修改', proposal_id: cur.id,
      });
    } catch (e) {
      if (e instanceof AppError && e.code === 'VERSION_CONFLICT') {
        this.markStale(cur, null, '提交时版本冲突');
        return this.getActorless(this.mustRow(cur.id));
      }
      if (e instanceof AppError && e.code === 'RESOURCE_BUSY') {
        // 瞬时故障：回退到 ready_to_commit，同一提案/权限/基准仍有效可幂等重试（不重复写入）
        d.run(`UPDATE proposals SET status='ready_to_commit', updated_at=? WHERE id=? AND status='committing'`, nowIso(), cur.id);
        throw e;
      }
      throw e;
    }

    // committed：写 committed_version_id + 事件/通知/卡片 + artifacts + Run
    const evs: Ev[] = [];
    d.tx(() => {
      const t = nowIso();
      d.run(`UPDATE proposals SET status='committed', committed_version_id=?, committed_at=?, final_reason=NULL, updated_at=? WHERE id=?`, version.id, t, t, cur.id);
      d.run(`UPDATE artifacts SET status='committed', updated_at=? WHERE target_file_id=? AND (run_id=? OR (request_id IS NOT NULL AND request_id=?)) AND status IN ('draft','proposed')`,
        t, cur.target_file_id, cur.run_id, cur.request_id);
      if (cur.run_id) {
        const others = Number(d.val<number>(
          "SELECT COUNT(*) FROM runs WHERE request_id=(SELECT request_id FROM runs WHERE id=?) AND id<>? AND status NOT IN ('succeeded','failed','cancelled')",
          cur.run_id, cur.run_id) ?? 0);
        const next = others > 0 ? 'running' : 'succeeded';
        d.run(`UPDATE runs SET status=?, queue_reason=NULL, finished_at=CASE WHEN ?='succeeded' THEN ? ELSE finished_at END, updated_at=? WHERE id=? AND status IN ('waiting_approval','blocked','committing')`,
          next, next, t, t, cur.run_id);
      }
      const np = this.mustRow(cur.id);
      this.writeOrUpdateCardTx(np);
      this.emitEv(evs, 'proposal.committed', np, execActor.userId, { committed_version_id: version.id, version_no: version.version_no });
      for (const u of sortUniq([...approvers, np.created_by, np.executor_id])) {
        pushNotification({
          user_id: u, organization_id: np.organization_id, type: 'review_result', actor_id: execActor.userId,
          title: `${np.target_name} 的共同确认已通过并正式写入`, body: `全部相关指令人确认，正式版本 v${version.version_no} 已生成（采用即生效）。`,
          entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}`,
        });
      }
      return undefined;
    });
    const done = this.mustRow(cur.id);
    this.deliverEv(done, evs);
    return this.getActorless(done);
  }

  /** fencing token：优先用关联 Run 的当前 lease_token（拒绝迟到写入），否则退化为提案创建毫秒时间戳 */
  private fencingToken(p: ProposalRow): number {
    if (p.run_id) {
      const r = this.d().get<{ lease_token: number; cancel_epoch: number }>('SELECT lease_token, cancel_epoch FROM runs WHERE id=?', p.run_id);
      if (r) return r.lease_token;
    }
    return new Date(p.created_at).getTime();
  }

  // ================= wake / void / remind =================
  async wake(actor: Actor, proposal_id: ID): Promise<Json> {
    const p0 = this.mustRow(proposal_id);
    this.assertVisible(actor, p0, 'write');
    const role = sessionAccess(actor, p0.session_id)?.role;
    const approvers = j<ID[]>(p0.required_approvers, []);
    if (role !== 'coordinator' && !approvers.includes(actor.userId)) throw AppError.forbidden('仅协调者或相关指令人可唤醒提案');
    if (p0.status === 'suspended') { const w = this.doWake(this.d(), p0, actor, '手动唤醒'); return this.assemble(actor, w); }
    if (p0.status === 'pending_approval') return this.assemble(actor, p0);
    throw AppError.invalidTransition(`提案为「${this.pill(p0.status, p0.approval_count, p0.needed_count)}」，无需/不能唤醒`);
  }

  private doWake(d: Db, p: ProposalRow, actor: Actor | null, why: string): ProposalRow {
    const evs: Ev[] = [];
    d.tx(() => {
      const t = nowIso();
      if (this.baseChanged(p)) {
        // 唤醒期间基准已变 → 自动转 stale 并要求重新生成差异再确认（§11.3）
        d.run(`UPDATE proposals SET status='stale', updated_at=? WHERE id=?`, t, p.id);
        const np = this.mustRow(p.id);
        this.writeOrUpdateCardTx(np);
        this.emitEv(evs, 'proposal.stale', np, actor?.userId ?? null, { reason: `${why}：基准版本已变化` });
        for (const u of sortUniq([...j<ID[]>(np.required_approvers, []), np.created_by])) {
          pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', title: `${np.target_name} 提案基准已变，需重新确认`, body: '期间基准版本已变化，请重新生成差异后再确认。', entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id });
        }
      } else {
        this.assertTransition(p.status, 'pending_approval');
        d.run(`UPDATE proposals SET status='pending_approval', woken_at=?, next_reminder_at=?, updated_at=? WHERE id=?`,
          t, isoIn(config.approval.reminderIntervalHours * HOUR), t, p.id);
        if (p.run_id) d.run(`UPDATE runs SET status='waiting_approval', queue_position=NULL, queue_reason='共同确认：等待相关指令人确认', updated_at=? WHERE id=? AND status='blocked'`, t, p.run_id);
        const np = this.mustRow(p.id);
        this.writeOrUpdateCardTx(np);
        d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), np.id, 'woken', actor?.userId ?? null, why, t);
        this.emitEv(evs, 'proposal.woken', np, actor?.userId ?? null, { reason: why });
      }
      return undefined;
    });
    const after = this.mustRow(p.id);
    this.deliverEv(after, evs);
    return after;
  }

  async void(actor: Actor, input: { proposal_id: ID; action: 'void' | 'withdraw'; reason?: string }): Promise<Json> {
    const p = this.mustRow(input.proposal_id);
    this.assertVisible(actor, p, 'write');
    const role = sessionAccess(actor, p.session_id)?.role;
    const isRequestCreator = !!p.request_id && this.d().get<{ id: string }>('SELECT id FROM requests WHERE id=? AND creator_id=?', p.request_id, actor.userId);
    const isInstrCreator = j<ID[]>(p.instruction_ids, []).some((rid) => !!this.d().get('SELECT 1 AS x FROM requests WHERE id=? AND creator_id=?', rid, actor.userId));
    if (role !== 'coordinator' && !isRequestCreator && !isInstrCreator) {
      throw AppError.forbidden('仅协调者或原指令发起人可作废/撤回提案（不存在超时自动采纳，也不能删人凑票）');
    }
    if (TERMINAL.includes(p.status)) throw AppError.invalidTransition(`提案已为「${this.pill(p.status, p.approval_count, p.needed_count)}」终态，不能再作废`);
    const evs: Ev[] = [];
    d_tx(this.d(), () => {
      const t = nowIso();
      this.assertTransition(p.status, 'cancelled');
      this.d().run(`UPDATE proposals SET status='cancelled', approval_count=0, final_reason=?, updated_at=? WHERE id=?`,
        this.reasonOf(input.action === 'withdraw' ? '原指令撤回' : '作废提案', input.reason), t, p.id);
      this.d().run('UPDATE approvals SET active=0 WHERE proposal_id=? AND active=1', p.id); // 保留审计，不删除
      this.d().run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), p.id, input.action === 'withdraw' ? 'withdrawn' : 'voided', actor.userId, input.reason ?? null, t);
      if (p.run_id) this.d().run(`UPDATE runs SET status='blocked', queue_position=NULL, queue_reason=?, updated_at=? WHERE id=? AND status IN ('waiting_approval','blocked')`, input.action === 'withdraw' ? '原指令已撤回，需重新规划重审' : '提案已作废，需重新规划重审', t, p.run_id);
      const np = this.mustRow(p.id);
      this.writeOrUpdateCardTx(np);
      this.emitEv(evs, 'proposal.voided', np, actor.userId, { action: input.action, reason: input.reason ?? null });
      for (const u of sortUniq([...j<ID[]>(np.required_approvers, []), np.created_by, np.executor_id])) {
        pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', actor_id: actor.userId, title: `${np.target_name} 的提案已${input.action === 'withdraw' ? '撤回' : '作废'}`, body: `${input.reason ?? ''}（需重新规划并重审）`, entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id });
      }
      return undefined;
    });
    const after = this.mustRow(p.id);
    this.deliverEv(after, evs);
    return this.assemble(actor, after);
  }

  async remindNow(actor: Actor, proposal_id: ID): Promise<Json> {
    const p = this.mustRow(proposal_id);
    this.assertVisible(actor, p, 'write');
    const role = sessionAccess(actor, p.session_id)?.role;
    if (role !== 'coordinator' && !j<ID[]>(p.required_approvers, []).includes(actor.userId)) throw AppError.forbidden('仅协调者或相关指令人可催办');
    if (!['pending_approval', 'suspended'].includes(p.status)) throw AppError.invalidTransition('仅等待确认中的提案可催办');
    const evs: Ev[] = [];
    const outstanding = this.outstandingIds(p);
    d_tx(this.d(), () => {
      const t = nowIso();
      this.d().run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), p.id, 'reminded', actor.userId, '手动催办（不计入自动提醒节奏）', t);
      const np = this.mustRow(p.id);
      this.emitEv(evs, 'proposal.reminded', np, actor.userId, { manual: true, outstanding });
      for (const u of outstanding) {
        pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', actor_id: actor.userId, title: `催办：${np.target_name} 待你确认`, body: `协调者催办（确认 ${np.approval_count}/${np.needed_count}）。`, entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}` });
      }
      return undefined;
    });
    // 手动催办【不改 next_reminder_at / reminder_count】→ 不计入自动提醒节奏
    this.deliverEv(p, evs);
    return this.assemble(actor, this.mustRow(p.id));
  }

  // ================= 失效：supersede / regenerateDiff =================
  /** 内容/基准/新增相关人变化 → 新 diff_hash、旧 approvals active=0、旧签名不可批准新内容、重算相关人、重新确认（§11.2 / C11） */
  async supersede(actor: Actor, proposal_id: ID, o: { reason: string; new_content?: string; new_base_version_id?: ID; added_instruction_ids?: ID[] }): Promise<Json> {
    const d = this.d();
    const p = this.mustRow(proposal_id);
    this.assertVisible(actor, p, 'write');
    if (TERMINAL.includes(p.status)) throw AppError.invalidTransition('终态提案不能再修订');
    const file = this.fileLite(p.target_file_id);
    if (!file || file.status !== 'active') throw AppError.notFound('目标正式文件不可用');
    const newBase = o.new_base_version_id ?? p.base_version_id;
    const baseV = d.get<VersionLite>('SELECT id,file_id,version_no,size,sha256,change_source,author_id,base_version_id FROM file_versions WHERE id=? AND file_id=?', newBase, p.target_file_id);
    if (!baseV) throw AppError.notFound('新基准版本不存在或不属于目标文件');
    const instructionIds = sortUniq([...j<ID[]>(p.instruction_ids, []), ...(o.added_instruction_ids ?? [])]);
    const content = o.new_content ?? this.draftContent(p);
    // 新增相关指令 → 重算受影响成员
    let approvers = j<ID[]>(p.required_approvers, []);
    if (o.added_instruction_ids?.length || o.new_base_version_id || (o.new_content && o.new_content !== this.draftContent(p))) {
      const recomputed = this.computeRequiredApprovers({ session_id: p.session_id, instruction_ids: instructionIds, target_file_id: p.target_file_id });
      approvers = sortUniq([...approvers, ...recomputed]) ;
      if (!approvers.length) approvers = sortUniq([p.executor_id]);
    }
    const built = await this.buildDiff(file, baseV, content);
    const diffHash = computeDiffHash({ patch: built.patch, baseVersionId: newBase, targetFileId: p.target_file_id, instructionIds, requiredApprovers: approvers });
    const cause = o.new_content ? 'content_change' : (o.new_base_version_id ? 'base_change' : 'new_instruction');
    const evs: Ev[] = [];
    d.tx(() => {
      const t = nowIso();
      const newRev = p.revision + 1;
      d.run(`UPDATE proposals SET revision=?, base_version_id=?, diff_hash=?, diff=?, instruction_ids=?, required_approvers=?, needed_count=?,
          approval_count=0, status='pending_approval', final_reason=NULL, next_reminder_at=?, suspend_deadline_at=?,
          revision_history=?, updated_at=? WHERE id=?`,
        newRev, newBase, diffHash, built.patch, S(instructionIds), S(approvers), approvers.length,
        isoIn(config.approval.firstReminderHours * HOUR), isoIn(config.approval.suspendHours * HOUR),
        S([...j<Json[]>(p.revision_history, []), { revision: newRev, cause, diff_hash: diffHash, base_version_id: newBase, at: t }]), t, p.id);
      d.run('UPDATE approvals SET active=0 WHERE proposal_id=? AND active=1', p.id); // 旧签名全部失效，保留审计（不得删除）
      d.run('INSERT INTO proposal_drafts(proposal_id,revision,content,base_version_id,created_by,created_at) VALUES(?,?,?,?,?,?)', p.id, newRev, content, newBase, actor.userId, t);
      d.run(`INSERT INTO proposal_revisions(id,proposal_id,revision,diff_hash,base_version_id,proposed_version_id,instruction_ids,required_approvers,cause,created_by,created_at)
        VALUES(?,?,?,?,?,NULL,?,?,?,?,?)`, uuid(), p.id, newRev, diffHash, newBase, S(instructionIds), S(approvers), cause, actor.userId, t);
      d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), p.id, cause, actor.userId, o.reason, t);
      const np = this.mustRow(p.id);
      this.writeOrUpdateCardTx(np);
      this.emitEv(evs, 'proposal.superseded', np, actor.userId, { cause, reason: o.reason, revision: newRev });
      for (const u of approvers) {
        pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', actor_id: actor.userId, title: `${np.target_name} 提案已更新，请重新确认`, body: `${o.reason}（旧确认已全部失效，需重新签名）`, entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}` });
      }
      return undefined;
    });
    const after = this.mustRow(p.id);
    this.deliverEv(after, evs);
    return this.assemble(actor, after, built.stats);
  }

  /** 基准变化后重算差异与新 base（POST /:id/regenerate-diff）：revision+1，cause='base_change' */
  async regenerateDiff(actor: Actor, proposal_id: ID): Promise<Json> {
    const p = this.mustRow(proposal_id);
    this.assertVisible(actor, p, 'write');
    if (!['stale', 'pending_approval', 'suspended'].includes(p.status)) throw AppError.invalidTransition('当前状态不能重新生成差异');
    const file = this.fileLite(p.target_file_id);
    const current = file?.current_version_id;
    if (!current) throw AppError.notFound('目标正式文件无当前版本');
    return this.supersede(actor, proposal_id, { reason: '基准版本已变化，重新生成差异并按新版本再确认', new_base_version_id: current });
  }

  // ================= 查询：list / get / diff =================
  async list(actor: Actor, opts?: { session_id?: ID; status?: string }): Promise<Json[]> {
    const d = this.d();
    const where = ['organization_id=?'];
    const params: unknown[] = [actor.orgId];
    if (opts?.session_id) { where.push('session_id=?'); params.push(opts.session_id); }
    if (opts?.status) { where.push('status=?'); params.push(opts.status); }
    const rows = d.all<ProposalRow>(`SELECT * FROM proposals WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, ...params);
    return rows.filter((r) => !!sessionAccess(actor, r.session_id)).map((r) => this.summaryDto(actor, r));
  }

  async get(actor: Actor, proposal_id: ID): Promise<Json> {
    let p = this.mustRow(proposal_id);
    this.assertVisible(actor, p);
    if (!TERMINAL.includes(p.status) && p.status !== 'committing' && this.baseChanged(p)) {
      this.markStale(p, null, '查看时检测到基准版本已变化');
      p = this.mustRow(proposal_id);
    }
    return this.assemble(actor, p);
  }

  async getDiff(actor: Actor, proposal_id: ID): Promise<Json> {
    const p = this.mustRow(proposal_id);
    this.assertVisible(actor, p);
    if (!canRead(actor, 'file', p.target_file_id)) throw AppError.forbidden('缺少目标文件查看权，无法查看差异');
    const stats = this.diffStats(p.diff);
    return {
      proposal_id: p.id, revision: p.revision, diff_hash: p.diff_hash, mode: this.diffMode(p.diff),
      comparable: this.diffMode(p.diff) !== 'meta', base_version_id: p.base_version_id,
      target_file_id: p.target_file_id, target_name: p.target_name, patch: p.diff, stats,
      note: p.diff ? this.diffNote(p) : null,
    };
  }

  private async getActorless(p: ProposalRow): Promise<Json> {
    // 内部返回给 orchestrator（无 HTTP actor）：以执行者身份组装权限动作
    const actor: Actor = { userId: p.executor_id, orgId: p.organization_id, role: orgRole(p.executor_id, p.organization_id) ?? 'member', displayName: '' };
    return this.assemble(actor, p);
  }

  // ================= tick（§11.3 超时挂起，由 scheduler 'proposal-tick' 每 60s 调一次） =================
  // 【底线1】本方法绝无「超时视为同意」的任何分支：只有 提醒 / 挂起 / 失效检测 三类动作。
  async tick(): Promise<{ reminded: number; suspended: number }> {
    const d = this.d();
    const now = Date.now();
    let reminded = 0;
    let suspended = 0;
    const waiting = d.all<ProposalRow>(`SELECT * FROM proposals WHERE status IN ('pending_approval','ready_to_commit','suspended','stale') ORDER BY suspend_deadline_at`);
    for (const p of waiting) {
      try {
        // stale / suspended：非终态也非同意，等人工重生成差异或唤醒；tick 不再推进（底线1：无自动通过）
        if (p.status === 'stale' || p.status === 'suspended') continue;
        // 1) 失效检测：基准变了 → stale（pending_approval / ready_to_commit 都要查，C11/C12）
        if (this.baseChanged(p)) { this.markStale(p, null, '定时检测到基准版本已变化'); continue; }
        // 就绪但未提交（上次瞬时失败）→ 幂等重试（同一提案/权限/基准仍有效，不重复写入）；不受超时挂起影响
        if (p.status === 'ready_to_commit') { await this.commit(p).catch(() => { /* 锁忙等瞬时故障，下轮再试 */ }); continue; }
        // —— 以下仅 pending_approval ——
        // 2) 超阈值挂起（默认 72h 未集齐）：不进失败、不自动通过、不丢草稿，Run 转 blocked 并释放排队位
        if (p.suspend_deadline_at && now >= new Date(p.suspend_deadline_at).getTime()) {
          this.suspend(p);
          suspended++;
          continue;
        }
        // 3) 自动提醒节奏：第 1 小时一次，此后每 24 小时（由 next_reminder_at 控制；手动催办不动此字段 → 不计入自动节奏）
        if (p.next_reminder_at && now >= new Date(p.next_reminder_at).getTime()) {
          this.autoRemind(p);
          reminded++;
        }
      } catch (e) {
        console.error(`[proposals] tick ${p.id} 失败：${(e as Error).message}`);
      }
    }
    return { reminded, suspended };
  }

  private autoRemind(p: ProposalRow) {
    const d = this.d();
    const evs: Ev[] = [];
    const outstanding = this.outstandingIds(p);
    d.tx(() => {
      const t = nowIso();
      d.run(`UPDATE proposals SET reminder_count=reminder_count+1, next_reminder_at=?, updated_at=? WHERE id=?`,
        isoIn(config.approval.reminderIntervalHours * HOUR), t, p.id);
      d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), p.id, 'reminded', null, `自动提醒 #${p.reminder_count + 1}`, t);
      const np = this.mustRow(p.id);
      this.emitEv(evs, 'proposal.reminded', np, null, { auto: true, outstanding, count: np.approval_count, needed: np.needed_count });
      for (const u of outstanding) {
        pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', title: `提醒：${np.target_name} 待你确认`, body: `已确认 ${np.approval_count}/${np.needed_count}，请尽快表态（超 ${config.approval.suspendHours} 小时未集齐将自动挂起，不会视为同意）。`, entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}` });
      }
      return undefined;
    });
    this.deliverEv(p, evs);
  }

  private suspend(p: ProposalRow) {
    const d = this.d();
    const evs: Ev[] = [];
    const names = this.names(this.outstandingIds(p));
    const waitList = Object.values(names).join('、') || '相关指令人';
    d.tx(() => {
      const t = nowIso();
      this.assertTransition(p.status, 'suspended');
      d.run(`UPDATE proposals SET status='suspended', suspended_at=?, next_reminder_at=NULL, updated_at=? WHERE id=?`, t, t, p.id);
      if (p.run_id) d.run(`UPDATE runs SET status='blocked', queue_position=NULL, queue_reason=?, updated_at=? WHERE id=? AND status IN ('waiting_approval','running','queued')`, `提案已搁置，等待${waitList}确认`, t, p.run_id);
      const np = this.mustRow(p.id);
      d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), np.id, 'suspended', null, `超 ${config.approval.suspendHours} 小时未集齐确认，已挂起（不失败、不自动通过、不丢弃草稿成果）`, t);
      this.writeOrUpdateCardTx(np);
      this.emitEv(evs, 'proposal.suspended', np, null, { outstanding: this.outstandingIds(np) });
      for (const u of sortUniq([...j<ID[]>(np.required_approvers, []), np.created_by, np.executor_id])) {
        pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', title: `已搁置·等待${waitList}确认`, body: `${np.target_name} 的正式修改超时未集齐确认，已挂起。任一相关指令人表态或协调者唤醒可继续。`, entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}` });
      }
      return undefined;
    });
    this.deliverEv(p, evs);
  }

  private markStale(p: ProposalRow, actorId: ID | null, why: string) {
    if (TERMINAL.includes(p.status) || p.status === 'stale') return;
    const d = this.d();
    const evs: Ev[] = [];
    d.tx(() => {
      const t = nowIso();
      d.run(`UPDATE proposals SET status='stale', updated_at=? WHERE id=? AND status NOT IN ('committed','superseded','rejected','cancelled')`, t, p.id);
      const np = this.mustRow(p.id);
      d.run('INSERT INTO proposal_events(id,proposal_id,type,actor_id,note,created_at) VALUES(?,?,?,?,?,?)', uuid(), np.id, 'stale', actorId, why, t);
      this.writeOrUpdateCardTx(np);
      this.emitEv(evs, 'proposal.stale', np, actorId, { reason: why });
      for (const u of sortUniq([...j<ID[]>(np.required_approvers, []), np.created_by])) {
        pushNotification({ user_id: u, organization_id: np.organization_id, type: 'pending_approval', actor_id: actorId, title: `${np.target_name} 提案需重新确认`, body: `基准版本已变化（${why}）。旧确认不再有效，请重新生成差异后再确认。`, entity_type: 'proposal', entity_id: np.id, session_id: np.session_id, proposal_id: np.id, target_path: `/team/proposals/${np.id}` });
      }
      return undefined;
    });
    this.deliverEv(p, evs);
  }

  // ================= 展示装配 =================
  private outstandingIds(p: ProposalRow): ID[] {
    const approvers = j<ID[]>(p.required_approvers, []);
    const signed = new Set(this.d().all<{ user_id: string }>(
      'SELECT user_id FROM approvals WHERE proposal_id=? AND revision=? AND decision=? AND active=1', p.id, p.revision, 'approve').map((r) => r.user_id));
    return approvers.filter((u) => !signed.has(u));
  }
  private diffStats(patch: string): DiffStats {
    let added = 0; let removed = 0;
    for (const l of patch.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++; }
    return { added, removed };
  }
  private diffMode(patch: string): 'text' | 'body' | 'meta' {
    if (patch.startsWith('元信息级差异')) return 'meta';
    if (patch.startsWith('# 目标为首版不支持在线编辑')) return 'body';
    return 'text';
  }
  private diffNote(p: ProposalRow): string | null {
    const m = this.diffMode(p.diff);
    if (m === 'meta') return '正文不可比对，元信息级整体替换提案';
    if (m === 'body') return '目标为首版不支持在线编辑的类型，以下为正文级差异，原文件将整体替换为新版本';
    return null;
  }
  private pill(status: string, count: number, needed: number): string {
    switch (status) {
      case 'draft': return '草稿';
      case 'pending_approval': return `确认 ${count}/${needed}`;
      case 'suspended': return '已搁置';
      case 'stale': return '需重新生成差异';
      case 'ready_to_commit': return `确认 ${needed}/${needed}·待提交`;
      case 'committing': return '正在提交';
      case 'committed': return '已正式写入';
      case 'superseded': return '已被新版本取代';
      case 'rejected': return '已拒绝';
      case 'cancelled': return '已作废';
      default: return status;
    }
  }
  private reasonOf(label: string, reason?: string): string { return `${label}：${reason ?? '（未填写理由）'}`; }

  private summaryDto(actor: Actor, p: ProposalRow): Json {
    const outstandingNames = Object.values(this.names(this.outstandingIds(p)));
    const pill = p.status === 'suspended' ? `已搁置·等待${outstandingNames.join('、') || '相关指令人'}确认` : this.pill(p.status, p.approval_count, p.needed_count);
    return {
      id: p.id, proposal_id: p.id, session_id: p.session_id, target_file_id: p.target_file_id, target_name: p.target_name,
      revision: p.revision, status: p.status, status_pill: pill, approval_count: p.approval_count, needed_count: p.needed_count,
      summary: p.summary, created_at: p.created_at, updated_at: p.updated_at, suspend_deadline_at: p.suspend_deadline_at,
      is_relevant_approver: j<ID[]>(p.required_approvers, []).includes(actor.userId),
    };
  }

  private assemble(actor: Actor, p: ProposalRow, statsOverride?: DiffStats): Json {
    const d = this.d();
    const required = j<ID[]>(p.required_approvers, []);
    const instructionIds = j<ID[]>(p.instruction_ids, []);
    const nmap = this.names([...required, p.created_by, p.executor_id, ...instructionIds.length ? d.all<{ creator_id: string }>(`SELECT creator_id FROM requests WHERE id IN (${instructionIds.map(() => '?').join(',')})`, ...instructionIds).map((r) => r.creator_id) : []]);
    const approvals = d.all<{ user_id: string; decision: string; revision: number; active: number; created_at: string; diff_hash: string }>(
      `SELECT user_id,decision,revision,active,created_at,diff_hash FROM approvals WHERE proposal_id=? ORDER BY revision DESC, created_at`, p.id);
    const activeSigned = approvals.filter((a) => a.active === 1 && a.revision === p.revision && a.decision === 'approve').map((a) => a.user_id);
    const outstanding = required.filter((u) => !activeSigned.includes(u));
    const baseV = d.get<VersionLite>('SELECT id,file_id,version_no,size,sha256,change_source,author_id,base_version_id FROM file_versions WHERE id=?', p.base_version_id);
    const file = this.fileLite(p.target_file_id);
    const currentV = file?.current_version_id ? d.get<VersionLite>('SELECT id,file_id,version_no,size,sha256,change_source,author_id,base_version_id FROM file_versions WHERE id=?', file.current_version_id) : undefined;
    const role = sessionAccess(actor, p.session_id)?.role ?? null;
    const hasViewer = canRead(actor, 'file', p.target_file_id);
    const isApprover = required.includes(actor.userId);
    const already = activeSigned.includes(actor.userId);
    const actions: Json[] = [
      this.action('approve', isApprover && ['pending_approval', 'suspended'].includes(p.status) && hasViewer, !hasViewer ? '缺少 diff 查看权，先解决授权' : already ? '你已确认' : !isApprover ? '非相关指令人' : ''),
      this.action('reject', isApprover && ['pending_approval', 'suspended'].includes(p.status), !isApprover ? '非相关指令人' : ''),
      this.action('request_changes', isApprover && ['pending_approval', 'suspended'].includes(p.status), !isApprover ? '非相关指令人' : ''),
      this.action('wake', (role === 'coordinator' || isApprover) && p.status === 'suspended', p.status !== 'suspended' ? '仅挂起态可唤醒' : ''),
      this.action('regenerate_diff', (role === 'coordinator' || p.created_by === actor.userId || isApprover) && (p.status === 'stale' || this.baseChanged(p)), p.status !== 'stale' && !this.baseChanged(p) ? '基准未变化' : ''),
      this.action('remind', (role === 'coordinator' || isApprover) && ['pending_approval', 'suspended'].includes(p.status), ''),
      this.action('void', (role === 'coordinator' || p.created_by === actor.userId || isApprover) && !TERMINAL.includes(p.status), TERMINAL.includes(p.status) ? '终态不可作废' : ''),
    ];
    const instructions = instructionIds.length
      ? d.all<{ id: string; goal: string; creator_id: string; status: string; instruction_revision: number }>(`SELECT id,goal,creator_id,status,instruction_revision FROM requests WHERE id IN (${instructionIds.map(() => '?').join(',')})`, ...instructionIds)
        .map((r) => ({ id: r.id, goal: r.goal, creator_id: r.creator_id, creator_name: nmap[r.creator_id] ?? null, status: r.status, instruction_revision: r.instruction_revision }))
      : [];
    const run = p.run_id ? d.get<{ id: string; status: string; subtask_name: string; queue_position: number | null; queue_reason: string | null }>('SELECT id,status,subtask_name,queue_position,queue_reason FROM runs WHERE id=?', p.run_id) : undefined;
    return {
      id: p.id, proposal_id: p.id, organization_id: p.organization_id, session_id: p.session_id, request_id: p.request_id, run_id: p.run_id,
      target_file_id: p.target_file_id, target_name: p.target_name, target_kind: file?.kind ?? null,
      revision: p.revision, diff_hash: p.diff_hash, status: p.status,
      status_pill: p.status === 'suspended' ? `已搁置·等待${(Object.values(this.names(outstanding)).join('、')) || '相关指令人'}确认` : this.pill(p.status, p.approval_count, p.needed_count),
      summary: p.summary, created_by: p.created_by, created_by_name: nmap[p.created_by] ?? null,
      executor_id: p.executor_id, executor_name: nmap[p.executor_id] ?? null,
      base_version: baseV ? { id: baseV.id, version_no: baseV.version_no, size: baseV.size, sha256: baseV.sha256 } : null,
      current_version: currentV ? { id: currentV.id, version_no: currentV.version_no, size: currentV.size, sha256: currentV.sha256 } : null,
      base_changed: this.baseChanged(p),
      affected: { file_id: p.target_file_id, file_name: p.target_name, run: run ? { id: run.id, status: run.status, subtask_name: run.subtask_name, queue_position: run.queue_position, queue_reason: run.queue_reason } : null },
      approval_count: activeSigned.length, needed_count: required.length,
      approvals: approvals.filter((a) => a.revision === p.revision && a.active === 1).map((a) => ({ user_id: a.user_id, name: nmap[a.user_id] ?? null, decision: a.decision, revision: a.revision, created_at: a.created_at })),
      outstanding_user_ids: outstanding,
      outstanding_names: outstanding.map((u) => nmap[u] ?? u),
      required_approvers: required.map((u) => ({ user_id: u, name: nmap[u] ?? null })),
      instructions,
      diff: hasViewer ? p.diff : null,
      diff_mode: this.diffMode(p.diff),
      diff_stats: statsOverride ?? this.diffStats(p.diff),
      diff_note: this.diffNote(p),
      diff_blocked_reason: hasViewer ? null : '缺少目标文件查看权，无法查看差异，请先解决授权',
      history: j<Json[]>(p.revision_history, []),
      final_reason: p.final_reason,
      suspended_at: p.suspended_at, woken_at: p.woken_at, committed_version_id: p.committed_version_id, committed_at: p.committed_at,
      next_reminder_at: p.next_reminder_at, suspend_deadline_at: p.suspend_deadline_at, reminder_count: p.reminder_count,
      created_at: p.created_at, updated_at: p.updated_at,
      available_actions: actions,
    };
  }
  private action(action: string, enabled: boolean, disabled_reason = ''): Json { return { action, enabled, disabled_reason: enabled ? '' : disabled_reason }; }

  // ================= 会话内共同确认卡（§11 共同确认卡；seq 事务内自增） =================
  private writeOrUpdateCardTx(p: ProposalRow) {
    const d = this.d();
    const outstanding = this.outstandingIds(p);
    const names = this.names(outstanding);
    const waitList = Object.values(names).join('、') || '相关指令人';
    const pill = p.status === 'suspended' ? `已搁置·等待${waitList}确认` : this.pill(p.status, p.approval_count, p.needed_count);
    const approvers = j<ID[]>(p.required_approvers, []);
    const nmAll = this.names(approvers);
    const body = [
      `共同确认 · ${p.target_name}`,
      `状态：${pill}`,
      `相关指令人：${approvers.map((u) => nmAll[u] ?? u).join('、')}`,
      p.summary ? `拟变更：${p.summary}` : '',
      `差异：${this.diffMode(p.diff) === 'meta' ? '元信息级（正文不可比对）' : this.diffMode(p.diff) === 'body' ? '正文级（原文件将整体替换）' : '文本级'}（+${this.diffStats(p.diff).added} / -${this.diffStats(p.diff).removed}）`,
      '说明：正式文件在全部相关指令人确认前不变；任何内容或基准变化都会使旧确认失效；不存在超时自动采纳。',
    ].filter(Boolean).join('\n');
    const aux: Json = {
      proposal_id: p.id, target_file_id: p.target_file_id, target_name: p.target_name, status: p.status, status_pill: pill,
      approval_count: p.approval_count, needed_count: approvers.length, revision: p.revision,
      required_approvers: approvers.map((u) => ({ user_id: u, name: nmAll[u] ?? u })), outstanding_user_ids: outstanding,
      outstanding_names: outstanding.map((u) => nmAll[u] ?? u), diff_mode: this.diffMode(p.diff),
    };
    const t = nowIso();
    const existing = d.get<{ id: string }>('SELECT id FROM session_messages WHERE ref_type=? AND ref_id=? AND kind=? ORDER BY seq DESC LIMIT 1', 'proposal', p.id, 'approval_card');
    if (existing) {
      d.run('UPDATE session_messages SET body=?, aux=? WHERE id=?', body, S(aux), existing.id);
      return;
    }
    d.run('UPDATE agent_sessions SET last_message_seq=last_message_seq+1, updated_at=? WHERE id=?', t, p.session_id);
    const seq = Number(d.val<number>('SELECT last_message_seq FROM agent_sessions WHERE id=?', p.session_id) ?? 1);
    d.run(`INSERT INTO session_messages(id,session_id,organization_id,seq,sender_user_id,sender_label,role,kind,body,ref_type,ref_id,aux,created_at)
      VALUES(?,?,?, ?,NULL,'FlowMate Agent','agent','approval_card',?,?,?,?,?)`,
      uuid(), p.session_id, p.organization_id, seq, body, 'proposal', p.id, S(aux), t);
  }
}

// 与 Db.tx 等价的简写（保持单处调用点可读）
function d_tx<T>(d: Db, fn: () => T): T { return d.tx(fn); }

// 契约对齐：本类 implements ProposalsServiceContract；decide 额外接受可选 diff_hash（前端回传其查看到的
// 签名，服务端不一致 → 409 PROPOSAL_STALE），属对接口方法入参的合法放宽（结构化双变，调用方传窄类型亦可）。

let instance: ProposalsService | null = null;
export function getProposalsService(): ProposalsService {
  if (!instance) instance = new ProposalsService();
  return instance;
}
