// FlowMate · Team 分支与分享服务（PRD §09 分享 / §10 创建 Team 分支）
// 「分支与分享可拆」：本文件把这条业务线作为独立模块边界暴露，实现委托给 SessionsService 单例，
// 保证 loadSession / 事件 / seq 取号等原语只有一处真相；其他模块可只依赖 BranchService 这一面。
import type { Actor } from '../../core/permissions';
import type { Json, ID } from '../../core/contracts';
import { getSessionService, type BranchInput } from './sessions.service';

const svc = getSessionService();

export class BranchService {
  /** §10 三步：选团队 / 预览上下文 / 确认创建；幂等；固定快照与来源 */
  createTeamBranch(actor: Actor, input: BranchInput): Promise<Json> {
    return svc.createTeamBranch(actor, input);
  }

  /** §10：只读分享者/查看者发出「请求协作」，仅通知所有者，不扩大共享 */
  collabRequest(actor: Actor, session_id: ID, note?: string): Promise<Json> {
    return svc.collabRequest(actor, session_id, note);
  }

  /** §09 分享 Personal：创建只读快照 */
  share(actor: Actor, input: {
    session_id: ID; grantee_user_id: ID; range_type: 'all' | 'until' | 'selected';
    range_payload?: Json; aux_image_ids?: ID[]; days?: number;
  }): Promise<Json> {
    return svc.share(actor, input);
  }

  listShares(actor: Actor, session_id: ID): Promise<Json[]> {
    return svc.listShares(actor, session_id);
  }

  revokeShare(actor: Actor, share_id: ID): Promise<void> {
    return svc.revokeShare(actor, share_id);
  }

  revokeShareBySession(actor: Actor, session_id: ID, share_id: ID): Promise<void> {
    return svc.revokeShareBySession(actor, session_id, share_id);
  }

  /** 分享预览：只返回范围统计与图片清单，不返回正文 */
  sharePreview(actor: Actor, share_id: ID): Promise<Json> {
    return svc.sharePreview(actor, share_id);
  }
}

let instance: BranchService | null = null;
export function getBranchService(): BranchService {
  if (!instance) instance = new BranchService();
  return instance;
}
