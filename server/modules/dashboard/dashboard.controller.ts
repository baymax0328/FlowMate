// FlowMate · 看板接口：GET /api/v1/dashboard?scope=mine|team&period=day|week|month
import { Body, Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorOf } from '../../core/auth';
import { getDashboardService } from './dashboard.service';

@Controller('api/v1/dashboard')
export class DashboardController {
  private svc = getDashboardService();

  @Get()
  summary(@Req() req: Request, @Body() _b: never,
    @Query() q: Record<string, string | undefined>) {
    const scope = q.scope === 'team' ? 'team' : 'mine';
    const period = q.period === 'day' || q.period === 'month' ? q.period : 'week';
    return this.svc.summary(actorOf(req), scope, period);
  }

  @Get('calendar')
  calendar(@Req() req: Request, @Query() q: Record<string,string|undefined>) {
    return this.svc.calendar(actorOf(req),q.scope==='team'?'team':'mine',q.month);
  }

  @Get('insights')
  insights(@Req() req: Request, @Query() q: Record<string,string|undefined>) {
    return this.svc.insights(actorOf(req), q.period==='day'||q.period==='month'?q.period:'week', [7,14,30].includes(Number(q.days))?Number(q.days):14,q.scope==='team'?'team':'mine');
  }

  // 点日历某一天：拉当天的任务日程（与日历联动，避免把整月塞进主响应）
  @Get('agenda')
  agenda(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    const scope = q.scope === 'team' ? 'team' : 'mine';
    return this.svc.agenda(actorOf(req), scope, q.date ?? '', q.responsible==='1');
  }
}
