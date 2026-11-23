// FlowMate · 运行与冲突接口（PRD §19 Run / 提案行、§12 Center 数据源）
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { ZodPipe } from '../../core/http';
import { actorOf } from '../../core/auth';
import { getOrchestratorService } from './orchestrator.service';
import { modelStatus } from '../../adapters/model.adapter';

@Controller('api/v1')
export class OrchestratorController {
  private svc = getOrchestratorService();

  /** 模型能力状态（界面据此说明 AI 能力为何不可用，不伪造结果） */
  @Get('agent/model-status')
  modelStatus() {
    return modelStatus();
  }

  /** 工具白名单与禁用/不存在清单（§08，界面据此说明「为什么没有这个能力」） */
  @Get('agent/tools')
  tools() {
    return this.svc.toolCatalog();
  }

  @Get('agent/sessions/:id/runs')
  runs(@Req() req: Request, @Param('id') id: string) {
    return this.svc.runsOfSession(actorOf(req), id);
  }

  @Get('runs/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.runDetail(actorOf(req), id);
  }

  @Post('runs/:id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ reason: z.string().max(300).optional() }))) body: { reason?: string }) {
    return this.svc.cancelRun(actorOf(req), id, body.reason);
  }

  @Post('runs/:id/retry')
  retry(@Req() req: Request, @Param('id') id: string) {
    return this.svc.retryRun(actorOf(req), id);
  }

  @Post('requests/:id/answer')
  answer(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ answer: z.string().min(1).max(4000) }))) body: { answer: string }) {
    return this.svc.answerClarification(actorOf(req), { request_id: id, answer: body.answer });
  }

  @Post('conflicts/:id/resolve')
  resolve(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({
      resolution: z.enum(['order', 'option_a', 'option_b', 'clarify']),
      note: z.string().max(500).optional(),
    }))) body: { resolution: 'order' | 'option_a' | 'option_b' | 'clarify'; note?: string }) {
    return this.svc.resolveConflict(actorOf(req), { conflict_id: id, ...body });
  }

  @Get('conflicts')
  conflicts(@Req() req: Request, @Query('session_id') sessionId?: string, @Query('status') status?: string) {
    return { items: this.svc.listConflicts(actorOf(req), { session_id: sessionId, status }) };
  }
}
