// FlowMate · Task 接口（任务板块重设计：创建 / 接收 / 负责 / 验收 + 经手人链）
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { ZodPipe } from '../../core/http';
import { actorOf } from '../../core/auth';
import { getTasksService } from './tasks.service';

const criteria = z.array(z.object({ id: z.string().optional(), text: z.string().min(1).max(300), required: z.boolean().optional() })).max(20).optional();
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent', 't0', 't1', 't2', 't3']).optional();
const handlersField = z.array(z.string().min(1)).min(1).max(7);
// 环节化经手人：外层＝环节（≤5），内层＝该环节经手人（≥1、≤5）。与老的线性 handlers 并存兼容。
const stagesField = z.array(z.array(z.string().min(1)).min(1).max(5)).min(1).max(5);

@Controller('api/v1/tasks')
export class TasksController {
  private svc = getTasksService();

  @Get()
  async list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list(actorOf(req), {
      scope: (q.scope === 'team' ? 'team' : 'mine'),
      team_id: q.team_id, status: q.status, sub: q.sub as never, q: q.q,
      tab: q.tab,
      priority: q.priority, due: q.due, project: q.project, limit: q.limit ? Number(q.limit) : undefined,
    });
  }

  @Post()
  create(@Req() req: Request, @Body(new ZodPipe(z.object({
    title: z.string().min(1).max(180), description: z.string().max(4000).optional(),
    task_type: z.string().trim().max(120).optional(), project: z.string().max(120).optional(), expected_deliverable: z.string().max(500).optional(),
    reviewer_id: z.string().optional().nullable(), team_id: z.string().optional().nullable(),
    priority: priorityEnum,
    due_at: z.string().optional().nullable(), criteria, status: z.enum(['draft', 'ready_to_assign']).optional(),
    handlers: z.array(z.string().min(1)).max(7).optional(), stages: stagesField.optional(), folder_id: z.string().optional().nullable(),
    source: z.enum(['manual', 'message', 'candidate', 'handoff', 'agent']).optional(), source_ref: z.record(z.unknown()).optional(),
  }))) body: never) {
    return this.svc.create(actorOf(req), body as never);
  }

  @Get('history')
  history(@Req() req: Request, @Query() q: Record<string,string|undefined>) {
    return this.svc.history(actorOf(req), {scope:q.scope==='team'?'team':'mine', q:q.q?.slice(0,180),status:q.status,type:q.type?.slice(0,120),page:Number(q.page)||1});
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.svc.get(actorOf(req), id);
  }

  /** 自动排期：把「负责」里当前用户的任务按优先级排进目标日的工作时段（确定性时段；配了模型再补理由） */
  @Post('auto-schedule')
  autoSchedule(@Req() req: Request, @Body(new ZodPipe(z.object({ date: z.string().optional() }))) body: { date?: string }) {
    return this.svc.autoSchedule(actorOf(req), { date: body?.date });
  }

  @Patch(':id')
  patch(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.record(z.unknown()))) body: Jsonish) {
    return this.svc.update(actorOf(req), { task_id: id, patch: body });
  }

  @Post(':id/publish')
  publish(@Req() req: Request, @Param('id') id: string, @Body() body: Jsonish) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'publish', payload: body, idempotency_key: req.header('Idempotency-Key') ?? undefined });
  }

  /** 指派：把草稿/待指派（含退回）任务连同经手人链派下去，落进第一个经手人的「接收」 */
  @Post(':id/assign')
  assign(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    handlers: handlersField.optional(), stages: stagesField.optional(), reviewer_id: z.string().min(1),
    expected_deliverable: z.string().max(500).optional().nullable(), due_at: z.string().optional().nullable(),
    criteria, folder_id: z.string().optional().nullable(), note: z.string().max(500).optional(),
  }))) body: never) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'assign', payload: body as never });
  }

  /** 接收任务：必须先填预估时长（分钟），之后在「负责」可改，供智能排期使用 */
  @Post(':id/accept')
  accept(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ estimate_min: z.coerce.number().int().min(1).max(1440) }))) body: { estimate_min: number }) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'accept', payload: body });
  }

  @Post(':id/request-adjustment')
  adjust(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().min(1).max(1000) }))) body: { note: string }) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'request_adjustment', payload: body });
  }

  /** 接收人退回（必填原因）→ 带「退回」色回到创建人的「创建」tab */
  @Post(':id/reject')
  reject(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().min(1).max(1000) }))) body: { note: string }) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'reject', payload: body });
  }

  @Post(':id/transfer')
  transfer(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ assignee_id: z.string().min(1), note: z.string().max(500).optional() }))) body: never) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'transfer', payload: body as never });
  }

  @Post(':id/start')
  start(@Req() req: Request, @Param('id') id: string) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'start' });
  }

  @Post(':id/submit')
  submit(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ file_version_ids: z.array(z.string()).min(1).max(20), note: z.string().max(1000).optional() }))) body: { file_version_ids: string[]; note?: string }) {
    return this.svc.transition(actorOf(req), {
      task_id: id, action: 'submit', payload: body,
      idempotency_key: req.header('Idempotency-Key') ?? undefined,
    });
  }

  /** 下游交接：交给链上下一位经手人；只剩交付人时进入「验收」 */
  @Post(':id/handoff-next')
  handoffNext(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().max(500).optional() }))) body: { note?: string }) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'handoff_next', payload: body });
  }

  /** 完成验收（approve） */
  @Post(':id/review')
  review(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    decision: z.enum(['approve']).default('approve'), note: z.string().max(1000).optional(),
    per_criteria: z.array(z.object({ criterion_id: z.string(), pass: z.boolean(), note: z.string().max(300).optional() })).optional(),
  }))) body: never) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'review', payload: body as never });
  }

  /** 验收不通过 → 重设经手人重新指派（回到接收，保留历史） */
  @Post(':id/reassign')
  reassign(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    handlers: handlersField.optional(), stages: stagesField.optional(), reviewer_id: z.string().optional().nullable(),
    due_at: z.string().optional().nullable(), note: z.string().max(1000).optional(),
  }))) body: never) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'reassign', payload: body as never });
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(1).max(500) }))) body: { reason: string }) {
    return this.svc.transition(actorOf(req), { task_id: id, action: 'cancel', payload: body });
  }

  @Post(':id/archive')
  archive(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ archived: z.boolean().default(true) }))) body: { archived: boolean }) {
    return this.svc.transition(actorOf(req), { task_id: id, action: body.archived ? 'archive' : 'unarchive' });
  }

  @Post(':id/progress')
  progress(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    done_text: z.string().max(2000).optional(), blocked_text: z.string().max(2000).optional(), progress: z.number().min(0).max(100).optional(),
  }))) body: { done_text?: string; blocked_text?: string; progress?: number }) {
    return this.svc.addProgress(actorOf(req), { task_id: id, ...body });
  }

  /** 「在个人办公中处理」：优先复用该工作区下的个人会话，没有就新开一个 */
  @Post(':id/agent-session')
  agentSession(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    mode: z.enum(['personal', 'team']).optional(), folder_id: z.string().optional(), team_id: z.string().optional(),
  }))) body: { mode?: 'personal' | 'team'; folder_id?: string; team_id?: string }) {
    return this.svc.agentSessionFor(actorOf(req), { task_id: id, choice: body?.mode ? { mode: body.mode, folder_id: body.folder_id, team_id: body.team_id } : undefined });
  }
}

type Jsonish = Record<string, unknown>;
