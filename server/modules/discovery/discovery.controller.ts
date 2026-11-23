// FlowMate · 发现接口（PRD §19 发现行 / §14）
import { Body, Controller, Get, Param, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import type { Request } from 'express';
import { ZodPipe } from '../../core/http';
import { actorOf } from '../../core/auth';
import { AppError } from '../../core/errors';
import { getDiscoveryService } from './discovery.service';

@Controller('api/v1/discovery')
export class DiscoveryController {
  private svc = getDiscoveryService();

  /** 导入并分析：拖放文件或粘贴文本；分析中可关页面（服务端继续），结果在导入历史回看 */
  @Post('imports')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }))
  async create(@Req() req: Request, @UploadedFile() file: Express.Multer.File,
    @Body(new ZodPipe(z.object({
      name: z.string().max(180).optional(), pasted_text: z.string().max(500000).optional(),
      source_time: z.string().max(40).optional(), team_id: z.string().optional().nullable(),
      folder_id: z.string().optional().nullable(), mode: z.enum(['upload', 'paste']).optional(),
    }))) body: { name?: string; pasted_text?: string; source_time?: string; team_id?: string | null; folder_id?: string | null; mode?: string }) {
    const actor = actorOf(req);
    const usePaste = body.mode === 'paste' || (!file && !!body.pasted_text);
    if (usePaste) {
      return this.svc.importNow(actor, {
        name: body.name || '粘贴的会议纪要', pasted_text: body.pasted_text, source_kind: 'pasted_text',
        source_time: body.source_time, team_id: body.team_id ?? null, folder_id: body.folder_id ?? null,
      });
    }
    if (!file) throw AppError.validation('请上传文件或粘贴纪要内容');
    return this.svc.importNow(actor, {
      name: file.originalname, buffer: file.buffer, mime: file.mimetype, source_kind: 'manual_upload',
      source_time: body.source_time, team_id: body.team_id ?? null, folder_id: body.folder_id ?? null,
    });
  }

  @Get('imports')
  imports(@Req() req: Request, @Query('limit') limit?: string) {
    return this.svc.imports(actorOf(req), { limit: limit ? Number(limit) : undefined });
  }

  @Get('imports/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.importDetail(actorOf(req), id);
  }

  @Post('imports/:id/retry')
  retry(@Req() req: Request, @Param('id') id: string) {
    return this.svc.retry(actorOf(req), id);
  }

  @Get('candidates')
  candidates(@Req() req: Request, @Query('import_id') importId?: string, @Query('status') status?: string) {
    return this.svc.candidates(actorOf(req), { import_id: importId, status });
  }

  @Post('candidates/:id/confirm')
  confirm(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.confirm(actorOf(req), { candidate_id: id, patch: body ?? {} });
  }

  @Post('candidates/:id/ignore')
  ignore(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().max(500).optional() }))) body: { note?: string }) {
    return this.svc.ignore(actorOf(req), { candidate_id: id, note: body.note });
  }

  @Post('candidates/:id/clarify')
  clarify(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().min(1).max(500) }))) body: { note: string }) {
    return this.svc.clarify(actorOf(req), { candidate_id: id, note: body.note });
  }

  @Get('watch-configs')
  watch(@Req() req: Request) {
    return this.svc.watchConfigs(actorOf(req));
  }

  @Put('watch-configs')
  saveWatch(@Req() req: Request, @Body(new ZodPipe(z.object({
    id: z.string().optional(), name: z.string().min(1).max(120), folder_id: z.string().min(1),
    team_id: z.string().optional().nullable(), include_children: z.boolean().optional(),
    enabled: z.boolean().optional(), schedule_kind: z.enum(['interval', 'hourly', 'daily_at']).optional(),
    interval_minutes: z.number().int().min(5).max(1440).optional(), daily_at: z.string().max(8).optional(),
  }))) body: never) {
    return this.svc.saveWatchConfig(actorOf(req), body as never);
  }

  @Post('watch-configs/:id/run')
  runWatch(@Req() req: Request, @Param('id') id: string) {
    return this.svc.runWatchNow(actorOf(req), id);
  }
}
