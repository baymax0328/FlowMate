// FlowMate · 通知控制器（PRD §03 通知入口、§19 通知接口）
// 已读 ≠ 已处理：两组 PUT 分开，前端点击定位后回执 handled。
import { Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { actorOf } from '../../core/auth';
import type { AuthedRequest } from '../auth/auth.service';
import { NotificationsService } from './notifications.service';

const bool = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  /** 字面量路由先声明，避免被 :id 吞掉 */

  @Get('unread-count')
  async unreadCount(@Req() req: AuthedRequest, @Query('inbox') inbox?: string) {
    const actor = actorOf(req);
    const unread = await this.svc.unreadCount(actor, bool(inbox));
    return { unread, label: unread > 0 ? `未读 ${unread} 条` : '无未读通知' };
  }

  @Get('summary')
  summary(@Req() req: AuthedRequest) {
    return this.svc.summary(actorOf(req));
  }

  @Put('read-all')
  markAllRead(@Req() req: AuthedRequest, @Query('inbox') inbox?: string) {
    return this.svc.readAll(actorOf(req), bool(inbox));
  }

  @Put('handled-all')
  markAllHandled(@Req() req: AuthedRequest) {
    return this.svc.markAllHandled(actorOf(req));
  }

  @Get()
  list(@Req() req: AuthedRequest,
       @Query('unread_only') unreadOnly?: string,
       @Query('type') type?: string,
       @Query('limit') limitRaw?: string,
       @Query('inbox') inbox?: string) {
    const limit = limitSchema.shape.limit.parse(limitRaw ?? undefined);
    return this.svc.list(actorOf(req), { unread_only: bool(unreadOnly), type, limit, inbox: bool(inbox) });
  }

  @Get(':id')
  one(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.one(actorOf(req), id);
  }

  @Put(':id/read')
  async markRead(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.svc.markRead(actorOf(req), id);
    return { id, read: true, message: '已标记为已读（已读不代表已处理）' };
  }

  @Put(':id/handled')
  markHandled(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.markHandled(actorOf(req), id);
  }
}
