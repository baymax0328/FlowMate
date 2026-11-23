// FlowMate · 共同确认接口（PRD §19 /proposals 与错误码 409 PROPOSAL_STALE / 423 RESOURCE_BUSY）
// 前缀 /api/v1；写接口由全局 Idempotency-Key 守卫覆盖（重复点击不重复计数：靠 approvals 唯一索引 + 幂等键）。
// 鉴权：AuthGuard 注入 req.actor；确认者权限在 service 内逐条判定（非相关人 403、缺 diff 查看权阻塞提案先解决授权）。
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { actorOf } from '../../core/auth';
import { z as zodPipe } from '../../core/http';
import { getProposalsService } from './proposals.service';

const svc = getProposalsService();

const DecideSchema = z.object({
  reason: z.string().max(2000).optional(),
  diff_hash: z.string().optional(),          // 前端回传其查看到的签名，不一致 → 409 PROPOSAL_STALE
});
const VoidSchema = z.object({ action: z.enum(['void', 'withdraw']), reason: z.string().max(2000).optional() });
const RemindSchema = z.object({ manual: z.boolean().optional() });

@Controller('api/v1/proposals')
export class ProposalsController {
  @Get()
  async list(@Req() req: Request, @Query('session_id') session_id?: string, @Query('status') status?: string) {
    return svc.list(actorOf(req), { session_id, status });
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    return svc.get(actorOf(req), id);
  }

  @Get(':id/diff')
  async diff(@Req() req: Request, @Param('id') id: string) {
    return svc.getDiff(actorOf(req), id);
  }

  @Post(':id/approve')
  async approve(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(DecideSchema)) body: { reason?: string; diff_hash?: string }) {
    return svc.decide(actorOf(req), { proposal_id: id, decision: 'approve', reason: body.reason, diff_hash: body.diff_hash });
  }

  @Post(':id/reject')
  async reject(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(DecideSchema)) body: { reason?: string; diff_hash?: string }) {
    return svc.decide(actorOf(req), { proposal_id: id, decision: 'reject', reason: body.reason, diff_hash: body.diff_hash });
  }

  @Post(':id/request-changes')
  async requestChanges(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(DecideSchema)) body: { reason?: string }) {
    return svc.decide(actorOf(req), { proposal_id: id, decision: 'request_changes', reason: body.reason });
  }

  @Post(':id/wake')
  async wake(@Req() req: Request, @Param('id') id: string) {
    return svc.wake(actorOf(req), id);
  }

  @Post(':id/void')
  async void(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(VoidSchema)) body: { action: 'void' | 'withdraw'; reason?: string }) {
    return svc.void(actorOf(req), { proposal_id: id, action: body.action, reason: body.reason });
  }

  @Post(':id/remind')
  async remind(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(RemindSchema)) _body: { manual?: boolean }) {
    return svc.remindNow(actorOf(req), id);
  }

  @Post(':id/regenerate-diff')
  async regenerate(@Req() req: Request, @Param('id') id: string) {
    return svc.regenerateDiff(actorOf(req), id);
  }
}
