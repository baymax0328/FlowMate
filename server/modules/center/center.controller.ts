import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorOf } from '../../core/auth';
import { getCenterService } from './center.service';

@Controller('api/v1/center')
export class CenterController {
  private svc = getCenterService();

  private filters(q: Record<string, string | undefined>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of ['team_id', 'folder_id', 'session_id', 'task_id', 'requester_id', 'status', 'entity_type', 'entity_id', 'type', 'from', 'to', 'file_id']) {
      if (q[k]) out[k] = q[k];
    }
    if (q.limit) out.limit = Number(q.limit);
    return out;
  }

  @Get('overview')
  overview(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.overview(actorOf(req), this.filters(q));
  }

  @Get('runs')
  runs(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.runs(actorOf(req), this.filters(q));
  }

  @Get('changes')
  changes(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.changes(actorOf(req), this.filters(q));
  }

  @Get('conflicts')
  conflicts(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.conflicts(actorOf(req), this.filters(q));
  }

  @Get('events')
  events(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.events(actorOf(req), this.filters(q));
  }

  @Get('usage')
  usage(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.usage(actorOf(req), this.filters(q));
  }
}
