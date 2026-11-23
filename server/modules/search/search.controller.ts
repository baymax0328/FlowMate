import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { ZodPipe } from '../../core/http';
import { actorOf } from '../../core/auth';
import { getSearchService } from './search.service';

@Controller('api/v1')
export class SearchController {
  private svc = getSearchService();

  /** 全局搜索（Ctrl/Cmd+K）：分类聚合，分页 20，无权内容不返回标题与摘要 */
  @Get('search')
  async search(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    const type = (q.type ?? 'all') as 'all' | 'members' | 'conversations' | 'messages' | 'files' | 'tasks';
    return this.svc.search(actorOf(req), String(q.q ?? ''), type, {
      cursor: q.cursor, folder_id: q.folder_id, conversation_id: q.conversation_id,
      kind: q.kind, space: q.space, status: q.status,
    });
  }

  @Post('search/binding')
  async binding(@Req() req: Request, @Body(new ZodPipe(z.object({
    query: z.string().min(1).max(200), root_folder_id: z.string().min(1),
    include_children: z.boolean().default(false), file_types: z.array(z.string()).optional(), limit: z.number().optional(),
  }))) body: { query: string; root_folder_id: string; include_children: boolean; file_types?: string[]; limit?: number }) {
    return this.svc.searchWithinBinding(actorOf(req), {
      query: body.query, root_folder_id: body.root_folder_id, include_children: body.include_children,
      fileTypes: body.file_types, limit: body.limit,
    });
  }
}
