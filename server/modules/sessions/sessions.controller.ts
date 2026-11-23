// FlowMate · Agent Sessions 控制器（PRD §19 Agent 接口行）
// 前缀 /api/v1。写入带 Idempotency-Key（全局守卫）。CSRF / 组织上下文由 AuthGuard 注入 req.actor。
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request } from 'express';
import { z } from 'zod';
import { actorOf } from '../../core/auth';
import { z as zodPipe, RequireIdempotency } from '../../core/http';
import { AppError } from '../../core/errors';
import { getSessionService } from './sessions.service';

const svc = getSessionService();

const CreateSchema = z.object({
  title: z.string().min(1).max(180),
  folder_id: z.string().nullable().optional(),
  include_children: z.boolean().optional(),
});
const TeamSchema = z.object({
  title: z.string().min(1).max(180),
  team_id: z.string().min(1),
  folder_id: z.string().min(1),
  participant_ids: z.array(z.string()).default([]),
});
const BindSchema = z.object({
  folder_id: z.string().nullable(),
  include_children: z.boolean().default(false),
});
const MsgSchema = z.object({
  body: z.string().min(1).max(20000),
  parent_id: z.string().nullable().optional(),
  mentions: z.array(z.string()).max(50).optional(),
});
const ReqSchema = z.object({
  goal: z.string().min(1).max(8000),
  output_kind: z.enum(['draft', 'formal_change', 'answer']).optional(),
  target_file_id: z.string().nullable().optional(),
  source_message_ids: z.array(z.string()).optional(),
  aux_ids: z.array(z.string()).optional(),
  idempotency_key: z.string().optional(),
  // 工作模式：外观是普通问答（不产出请求卡），但允许读工作区并按要求执行改动
  chat_mode: z.boolean().optional(),
});
const ChatSchema = z.object({ body: z.string().min(1).max(4000), parent_id:z.string().optional() });
const ShareSchema = z.object({
  grantee_user_id: z.string().min(1).optional(),
  grantee_user_ids: z.array(z.string().min(1)).max(50).optional(),
  range_type: z.enum(['all', 'until', 'selected', 'from_now']),
  range_payload: z.record(z.any()).optional(),
  aux_image_ids: z.array(z.string()).optional(),
  days: z.number().int().min(1).max(365).optional(),
  // 永久共享：不设到期时间，直到手动关闭（与 days 二选一）
  forever: z.boolean().optional(),
  // 实时共享（默认开）：全部历史 + 之后每条新消息都同步；传 false 才退回分享时刻的快照
  live: z.boolean().optional(),
});
const BranchSchema = z.object({
  team_id: z.string().min(1),
  folder_id: z.string().min(1),
  title: z.string().min(1).max(180),
  history_scope: z.enum(['all', 'until', 'selected', 'summary']),
  range_payload: z.record(z.any()).optional(),
  aux_image_ids: z.array(z.string()).optional(),
  participant_ids: z.array(z.string()).optional(),
  idempotency_key: z.string().optional(),
  copy_source_files: z.boolean().optional(),
  source_file_ids: z.array(z.string()).optional(),
  summary_confirmed: z.boolean().optional(),
});
const ParticipantSchema = z.object({
  user_id: z.string().min(1),
  role: z.enum(['coordinator', 'participant', 'viewer']),
});
const AuxSaveSchema = z.object({ folder_id: z.string().min(1) });
const ArtifactSaveSchema = z.object({ target_folder_id: z.string().min(1) });
const CollabSchema = z.object({ note: z.string().max(500).optional() });

@Controller('api/v1/agent')
export class SessionsController {
  private actor(req: Request) { return actorOf(req); }

  @Get('sessions')
  async list(@Req() req: Request, @Query('mode') mode?: string, @Query('team_id') teamId?: string) {
    const m = mode === 'team' ? 'team' : 'personal';
    return svc.list(this.actor(req), m, teamId ? { team_id: teamId } : undefined);
  }

  // 必须在 :id 之前声明，避免 open-by-id 被 :id 捕获
  @Get('sessions/open-by-id')
  async openById(@Req() req: Request, @Query('session_id') sessionId: string) {
    if (!sessionId) throw AppError.validation('缺少 session_id');
    return svc.openById(this.actor(req), sessionId);
  }

  @Post('sessions')
  @RequireIdempotency()
  async create(@Req() req: Request, @Body(zodPipe(CreateSchema)) body: z.infer<typeof CreateSchema>) {
    return svc.createPersonal(this.actor(req), body);
  }

  @Post('sessions/team')
  @RequireIdempotency()
  async createTeam(@Req() req: Request, @Body(zodPipe(TeamSchema)) body: z.infer<typeof TeamSchema>) {
    return svc.createTeamSession(this.actor(req), body);
  }

  @Get('sessions/shared-with-me')
  async sharedWithMe(@Req() req: Request) { return svc.sharedWithMe(this.actor(req)); }

  // 同样必须在 :id 之前声明，否则 /sessions/archived 会被当成 id=archived 的详情请求
  @Get('sessions/archived')
  async archived(@Req() req: Request, @Query('mode') mode?: string) {
    return svc.archivedSessions(this.actor(req), mode === 'team' ? 'team' : 'personal');
  }

  @Get('sessions/:id')
  async get(@Req() req: Request, @Param('id') id: string) { return svc.get(this.actor(req), id); }

  @Patch('sessions/:id')
  async rename(@Req() req: Request, @Param('id') id: string,
    @Body(zodPipe(z.object({ title: z.string().min(1).max(180) }))) body: { title: string }) {
    return svc.rename(this.actor(req), { session_id: id, title: body.title });
  }

  /** 删除 = 归档（进「已删除的会话」，可恢复）；有进行中的执行或待确认提案时返回 423 */
  @Delete('sessions/:id')
  async archive(@Req() req: Request, @Param('id') id: string) {
    return svc.archiveSession(this.actor(req), id);
  }

  @Post('sessions/:id/restore')
  async restore(@Req() req: Request, @Param('id') id: string) {
    return svc.restoreSession(this.actor(req), id);
  }

  @Put('sessions/:id/binding')
  @RequireIdempotency()
  async bind(@Req() req: Request, @Param('id') id: string,
    @Body(zodPipe(BindSchema)) body: z.infer<typeof BindSchema>,
    @Query('acknowledge_context_visibility') ack?: string) {
    return svc.bindFolder(this.actor(req), { session_id: id, ...body }, ack);
  }

  @Get('sessions/:id/messages')
  async messages(@Req() req: Request, @Param('id') id: string,
    @Query('after_seq') afterSeq?: string, @Query('limit') limit?: string) {
    return svc.messages(this.actor(req), id, { after_seq: afterSeq ? Number(afterSeq) : undefined, limit: limit ? Number(limit) : undefined });
  }

  @Post('sessions/:id/messages')
  @RequireIdempotency()
  async postMessage(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(MsgSchema)) body: z.infer<typeof MsgSchema>) {
    return svc.postMessage(this.actor(req), { session_id: id, ...body });
  }

  @Post('sessions/:id/requests')
  @RequireIdempotency()
  async handoff(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(ReqSchema)) body: z.infer<typeof ReqSchema>) {
    return svc.handoffToAgent(this.actor(req), { session_id: id, ...body });
  }

  /**
   * 轻量直连问答：一次模型调用、两条会话消息，不建 request / 不进队列 / 不产生 Run。
   * 与 /messages 的分界是明确的——普通聊天消息永不自动调用模型，这条路是用户主动「问 Agent」。
   */
  @Post('sessions/:id/chat')
  @RequireIdempotency()
  async chat(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(ChatSchema)) body: z.infer<typeof ChatSchema>) {
    return svc.quickChat(this.actor(req), { session_id: id, body: body.body, parent_id:body.parent_id, idempotency_key: req.header('Idempotency-Key') ?? undefined });
  }

  // ---------- 辅助图片 ----------
  @Post('sessions/:id/auxiliary-uploads')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 }, defParamCharset: 'utf8' }))
  async uploadAux(@Req() req: Request, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file || !file.buffer || !file.buffer.length) throw AppError.validation('未收到图片文件（字段名 file）');
    return svc.addAuxiliaryImage(this.actor(req), { session_id: id, buffer: file.buffer, name: file.originalname || 'image', mime: file.mimetype });
  }

  @Delete('sessions/:id/auxiliary-uploads/:aux_id')
  async removeAux(@Req() req: Request, @Param('id') id: string, @Param('aux_id') auxId: string) {
    await svc.removeAuxiliary(this.actor(req), id, auxId);
    return { ok: true };
  }

  @Post('sessions/:id/auxiliary-uploads/:aux_id/save-to-workspace')
  @RequireIdempotency()
  async saveAux(@Req() req: Request, @Param('aux_id') auxId: string, @Body(zodPipe(AuxSaveSchema)) body: z.infer<typeof AuxSaveSchema>) {
    return svc.saveAuxiliaryToWorkspace(this.actor(req), { aux_id: auxId, folder_id: body.folder_id });
  }

  // ---------- 分享 ----------
  @Get('sessions/:id/link-sharing')
  async linkSharing(@Req() req: Request, @Param('id') id: string) { return svc.linkSharing(this.actor(req),id); }

  @Put('sessions/:id/link-sharing')
  async setLinkSharing(@Req() req: Request, @Param('id') id: string,
    @Body(zodPipe(z.object({enabled:z.boolean(),range_type:z.enum(['all','from_now']),days:z.number().int().min(1).max(365).optional(),forever:z.boolean().optional()}))) body: {enabled:boolean;range_type:'all'|'from_now';days?:number;forever?:boolean}) {
    return svc.setLinkSharing(this.actor(req),id,body);
  }

  @Post('sessions/:id/personal-branch')
  @RequireIdempotency()
  async personalBranch(@Req() req: Request, @Param('id') id: string) {
    return svc.forkShared(this.actor(req),id,req.header('Idempotency-Key')!);
  }

  @Post('sessions/:id/shares')
  @RequireIdempotency()
  async share(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(ShareSchema)) body: z.infer<typeof ShareSchema>) {
    return svc.share(this.actor(req), { session_id: id, ...body });
  }

  @Get('sessions/:id/shares')
  async listShares(@Req() req: Request, @Param('id') id: string) { return svc.listShares(this.actor(req), id); }

  @Post('sessions/:id/shares/:share_id/revoke')
  async revoke(@Req() req: Request, @Param('id') id: string, @Param('share_id') shareId: string) {
    await svc.revokeShareBySession(this.actor(req), id, shareId);
    return { ok: true };
  }

  @Get('shared/:share_id/preview')
  async sharePreview(@Req() req: Request, @Param('share_id') shareId: string) { return svc.sharePreview(this.actor(req), shareId); }

  // ---------- Team 分支 / 协作请求 ----------
  @Post('sessions/:id/branch')
  @RequireIdempotency()
  async branch(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(BranchSchema)) body: z.infer<typeof BranchSchema>) {
    return svc.createTeamBranch(this.actor(req), { source_session_id: id, ...body });
  }

  @Post('sessions/:id/collab-request')
  async collab(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(CollabSchema)) body: z.infer<typeof CollabSchema>) {
    return svc.collabRequest(this.actor(req), id, body.note);
  }

  // ---------- 参与人 ----------
  @Get('sessions/:id/participants')
  async participants(@Req() req: Request, @Param('id') id: string) { return svc.participants(this.actor(req), id); }

  @Post('sessions/:id/participants')
  @RequireIdempotency()
  async addParticipant(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(ParticipantSchema)) body: z.infer<typeof ParticipantSchema>) {
    await svc.addParticipant(this.actor(req), { session_id: id, ...body });
    return { ok: true };
  }

  @Delete('sessions/:id/participants/:user_id')
  async removeParticipant(@Req() req: Request, @Param('id') id: string, @Param('user_id') userId: string) {
    await svc.removeParticipant(this.actor(req), { session_id: id, user_id: userId });
    return { ok: true };
  }

  // ---------- 预检 / 本次读取 / 运行 / 成果 / 文件栏 ----------
  @Get('sessions/:id/readiness')
  async readiness(@Req() req: Request, @Param('id') id: string) { return svc.readiness(this.actor(req), id); }

  @Get('sessions/:id/read-manifest')
  async readManifest(@Req() req: Request, @Param('id') id: string) { return svc.readManifest(this.actor(req), id); }

  @Post('sessions/:id/runs/:run_id/cancel')
  @RequireIdempotency()
  async cancelRun(@Req() req: Request, @Param('id') id: string, @Param('run_id') runId: string, @Body() body: { reason?: string }) {
    return svc.cancelRunEntry(this.actor(req), id, runId, body?.reason);
  }

  @Post('sessions/:id/runs/:run_id/retry')
  @RequireIdempotency()
  async retryRun(@Req() req: Request, @Param('id') id: string, @Param('run_id') runId: string) {
    return svc.retryRunEntry(this.actor(req), id, runId);
  }

  @Get('sessions/:id/artifacts')
  async artifacts(@Req() req: Request, @Param('id') id: string) { return svc.artifactsOf(this.actor(req), id); }

  @Get('artifacts/:id/content')
  async artifactContent(@Req() req: Request, @Param('id') id: string) { return svc.artifactContent(this.actor(req), id); }

  @Post('artifacts/:id/save-to-workspace')
  @RequireIdempotency()
  async saveArtifact(@Req() req: Request, @Param('id') id: string, @Body(zodPipe(ArtifactSaveSchema)) body: z.infer<typeof ArtifactSaveSchema>) {
    return svc.saveArtifactToWorkspace(this.actor(req), id, body.target_folder_id);
  }

  @Get('sessions/:id/files')
  async files(@Req() req: Request, @Param('id') id: string, @Query('path') path?: string) {
    return svc.sessionFiles(this.actor(req), id, path);
  }
}
