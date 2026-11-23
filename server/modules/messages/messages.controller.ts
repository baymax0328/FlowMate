// FlowMate · Message 控制器（PRD §05 控件的服务端支撑、§19 Message 路由）
// 权限一律服务端判定；无权对象不返回标题、摘要或计数（§15 / C20）。
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { actorOf } from '../../core/auth';
import { ZodPipe } from '../../core/http';
import type { AuthedRequest } from '../auth/auth.service';
import { MessagesService } from './messages.service';

const conversationQuery = z.object({
  type: z.enum(['dm', 'project']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(300).optional(),
});
const createConversationSchema = z.object({
  type: z.enum(['dm', 'project']),
  member_ids: z.array(z.string().trim().max(64)).min(1, '请选择成员').max(60),
  name: z.string().trim().max(60).optional(),
  team_id: z.string().trim().max(64).nullable().optional(),
});
const patchConversationSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  status: z.enum(['active', 'archived']).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '没有需要变更的字段' });
const viewerSettingsSchema = z.object({
  pinned: z.boolean().optional(), muted: z.boolean().optional(),
  unread: z.literal(true).optional(), remove: z.literal(true).optional(),
}).strict();
const shareFileSchema = z.object({
  conversation_id: z.string().trim().min(1).max(64).optional(),
  user_id: z.string().trim().min(1).max(64).optional(),
  client_msg_id: z.string().trim().min(1).max(128),
}).refine((input) => !!input.conversation_id !== !!input.user_id, { message: '请选择一位成员或一个会话' });
const messagesQuery = z.object({
  before: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  around: z.string().trim().max(64).optional(),
});
const sendSchema = z.object({
  body: z.string().max(20000, '消息过长，单条上限 20000 字').default(''),
  parent_id: z.string().trim().max(64).nullable().optional(),
  mentions: z.array(z.string().trim().max(64)).max(50).default([]),
  attachments: z.array(z.object({
    file_id: z.string().trim().min(1).max(64),
    version_id: z.string().trim().max(64).nullable().optional(),
  })).max(20, '单条消息最多附带 20 个附件').default([]),
  client_msg_id: z.string().trim().max(64).optional(),
  card_type: z.enum(['task', 'file_version', 'session']).optional(),
  card_id: z.string().trim().max(64).optional(),
});
const editSchema = z.object({ body: z.string().min(1, '请输入内容').max(20000, '消息过长，单条上限 20000 字') });
const addMembersSchema = z.object({
  user_ids: z.array(z.string().trim().max(64)).min(1, '请选择成员').max(60),
  role: z.enum(['admin', 'member']).default('member'),
});
const roleSchema = z.object({ role: z.enum(['admin', 'member']) });
const cardSchema = z.object({
  card_type: z.enum(['task', 'file_version', 'session']),
  card_id: z.string().trim().min(1, '缺少卡片对象 ID').max(64),
  note: z.string().trim().max(2000).optional(),
});
const accessRequestSchema = z.object({
  card_type: z.enum(['task', 'file_version', 'session']),
  card_id: z.string().trim().min(1).max(64),
});
const handoffSchema = z.object({
  message_ids: z.array(z.string().trim().max(64)).min(1, '请选择消息').max(50),
  target: z.enum(['personal', 'team']),
  team_id: z.string().trim().max(64).nullable().optional(),
  folder_id: z.string().trim().max(64).nullable().optional(),
  goal: z.string().trim().max(2000).optional(),
});
const searchQuery = z.object({
  q: z.string().trim().min(1, '请输入检索关键词').max(100),
  conversation_id: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

@Controller('api/v1')
export class MessagesController {
  constructor(private readonly svc: MessagesService) {}

  // ---------- 会话 ----------

  @Get('conversations')
  conversations(@Req() req: AuthedRequest, @Query(new ZodPipe(conversationQuery)) q: z.infer<typeof conversationQuery>) {
    return this.svc.list(actorOf(req), q);
  }

  // 供最左侧「消息」导航红点：本组织内所有活跃会话的未读消息总数
  @Get('messages/unread-count')
  unreadMessageCount(@Req() req: AuthedRequest) {
    return this.svc.unreadMessageCount(actorOf(req));
  }

  @Post('conversations')
  createConversation(@Req() req: AuthedRequest,
                     @Body(new ZodPipe(createConversationSchema)) body: z.infer<typeof createConversationSchema>) {
    return this.svc.createConversation(actorOf(req), body);
  }

  @Get('conversations/:id/messages')
  messages(@Req() req: AuthedRequest, @Param('id') id: string,
           @Query(new ZodPipe(messagesQuery)) q: z.infer<typeof messagesQuery>) {
    return this.svc.messages(actorOf(req), id, q);
  }

  @Post('conversations/:id/messages')
  send(@Req() req: AuthedRequest, @Param('id') id: string,
       @Body(new ZodPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.svc.send(actorOf(req), { conversation_id: id, ...body });
  }

  @Get('conversations/:id/members')
  members(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.detail(actorOf(req), id);
  }

  @Post('conversations/:id/members')
  addMembers(@Req() req: AuthedRequest, @Param('id') id: string,
             @Body(new ZodPipe(addMembersSchema)) body: { user_ids: string[]; role: 'admin' | 'member' }) {
    return this.svc.addMembersWithRole(actorOf(req), id, body.user_ids, body.role);
  }

  @Patch('conversations/:id/members/:user_id')
  setMemberRole(@Req() req: AuthedRequest, @Param('id') id: string, @Param('user_id') userId: string,
                @Body(new ZodPipe(roleSchema)) body: { role: 'admin' | 'member' }) {
    return this.svc.setMemberRole(actorOf(req), id, userId, body.role);
  }

  @Delete('conversations/:id/members/:user_id')
  removeMember(@Req() req: AuthedRequest, @Param('id') id: string, @Param('user_id') userId: string) {
    return this.svc.removeMemberAndReport(actorOf(req), id, userId);
  }

  @Post('conversations/:id/dissolve')
  dissolve(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.dissolveConversation(actorOf(req), id);
  }

  @Post('conversations/:id/leave')
  leave(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.leave(actorOf(req), id);
  }

  @Patch('conversations/:id/preferences')
  updateViewerSettings(@Req() req: AuthedRequest, @Param('id') id: string,
                       @Body(new ZodPipe(viewerSettingsSchema)) body: z.infer<typeof viewerSettingsSchema>) {
    return this.svc.updateViewerSettings(actorOf(req), id, body);
  }

  @Put('conversations/:id/read')
  markRead(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.markReadAndReport(actorOf(req), id);
  }

  @Patch('conversations/:id')
  patchConversation(@Req() req: AuthedRequest, @Param('id') id: string,
                    @Body(new ZodPipe(patchConversationSchema)) body: { name?: string; status?: 'active' | 'archived' }) {
    return this.svc.updateConversation(actorOf(req), id, body);
  }

  @Post('files/:id/share')
  shareFile(@Req() req: AuthedRequest, @Param('id') id: string,
            @Body(new ZodPipe(shareFileSchema)) body: z.infer<typeof shareFileSchema>) {
    return this.svc.shareFile(actorOf(req), id, body);
  }

  @Post('conversations/:id/cards')
  createCard(@Req() req: AuthedRequest, @Param('id') id: string,
             @Body(new ZodPipe(cardSchema)) body: { card_type: string; card_id: string; note?: string }) {
    return this.svc.createCard(actorOf(req), id, body);
  }

  @Post('conversations/:id/access-requests')
  requestAccess(@Req() req: AuthedRequest, @Param('id') id: string,
                @Body(new ZodPipe(accessRequestSchema)) body: { card_type: string; card_id: string }) {
    return this.svc.requestAccess(actorOf(req), id, body);
  }

  @Post('conversations/:id/agent-handoff')
  handoff(@Req() req: AuthedRequest, @Param('id') id: string,
          @Body(new ZodPipe(handoffSchema)) body: z.infer<typeof handoffSchema>) {
    return this.svc.handoffToAgent(actorOf(req), { conversation_id: id, ...body });
  }

  // ---------- 检索（P1 正文：会话内 + 跨会话，命中可定位） ----------

  @Get('messages/search')
  search(@Req() req: AuthedRequest, @Query(new ZodPipe(searchQuery)) q: z.infer<typeof searchQuery>) {
    return this.svc.searchMessages(actorOf(req), q.q, { conversation_id: q.conversation_id, limit: q.limit });
  }

  // ---------- 单条消息 ----------

  @Patch('messages/:id')
  edit(@Req() req: AuthedRequest, @Param('id') id: string, @Body(new ZodPipe(editSchema)) body: { body: string }) {
    return this.svc.edit(actorOf(req), { message_id: id, body: body.body });
  }

  @Delete('messages/:id')
  retract(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.retractAndReport(actorOf(req), id);
  }

  @Post('messages/:id/task-draft')
  taskDraft(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.createTaskDraftFromMessage(actorOf(req), id);
  }

  /** 会话导航里「成员」标签用的纯成员列表（不含共享文件与任务聚合） */
  @Get('conversations/:id/participants')
  participants(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.members(actorOf(req), id);
  }
}
