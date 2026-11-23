// FlowMate · Workspace 文件管理接口（PRD §06 / §07 / §19 Files 行）
// 控制器只做输入校验与转发，业务在 FilesService；响应信封 {data,request_id} 由全局拦截器加。
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../core/http';
import { actorOf } from '../../core/auth';
import type { Actor } from '../../core/permissions';
import { AppError } from '../../core/errors';
import { config, DOCUMENT_UPLOAD_MAX_BYTES } from '../../core/config';
import { notify } from '../../core/db';
import { storage } from '../../adapters/storage.adapter';
import { getFilesService } from './files.service';

const idSchema = z.string().min(1).max(64);

@Controller('api/v1')
export class FilesController {
  private svc = getFilesService();

  @Get('spaces')
  async spaces(@Req() req: Request) {
    return this.svc.spaceRoots(actorOf(req));
  }

  /** 新建空间：文档页左侧「空间」列的「新建空间」按钮走这里（不是新建文件夹） */
  @Post('spaces')
  async createSpace(@Req() req: Request,
    @Body(new ZodPipe(z.object({ name: z.string().min(1).max(180) }))) body: { name: string }) {
    return this.svc.createSpace(actorOf(req), body);
  }

  /** 删除空间：进回收站可恢复；派生根与被会话绑定的空间会被明确拒绝 */
  @Delete('spaces/:id')
  async deleteSpace(@Req() req: Request, @Param('id') id: string) {
    return this.svc.deleteSpace(actorOf(req), { id });
  }

  @Get('folders/children')
  async childrenRoot(@Req() req: Request, @Query('folder_id') folderId?: string) {
    return this.svc.listChildren(actorOf(req), folderId || null);
  }

  @Get('folders/:id/children')
  async children(@Req() req: Request, @Param('id') id: string) {
    return this.svc.listChildren(actorOf(req), id);
  }

  @Get('folders/tree')
  async tree(@Req() req: Request, @Query('root') root: string) {
    return this.svc.treeForBinding(actorOf(req), root);
  }

  @Post('folders')
  async createFolder(@Req() req: Request, @Body(new ZodPipe(z.object({
    parent_id: idSchema.nullable().optional(), name: z.string().min(1).max(180),
    space: z.enum(['personal', 'team', 'org']).optional(), team_id: idSchema.nullable().optional(),
  }))) body: never) {
    return this.svc.createFolder(actorOf(req), body);
  }

  @Patch('folders/:id')
  async renameFolder(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ name: z.string().min(1).max(180) }))) body: { name: string }) {
    return this.svc.rename(actorOf(req), { kind: 'folder', id, name: body.name });
  }

  @Post('folders/:id/trash')
  async trashFolder(@Req() req: Request, @Param('id') id: string) {
    return this.svc.trash(actorOf(req), { kind: 'folder', id });
  }

  @Post('folders/:id/restore')
  async restoreFolder(@Req() req: Request, @Param('id') id: string) {
    return this.svc.restoreWithNote(actorOf(req), { kind: 'folder', id });
  }

  @Get('recent')
  async recent(@Req() req: Request, @Query('limit') limit?: string) {
    return this.svc.recent(actorOf(req), Math.min(Number(limit) || 50, 200));
  }

  @Post('files/:id/permanent-delete')
  async permanentlyDeleteFile(@Req() req: Request, @Param('id') id: string) {
    return this.svc.permanentDelete(actorOf(req), { kind: 'file', id });
  }

  @Post('folders/:id/permanent-delete')
  async permanentlyDeleteFolder(@Req() req: Request, @Param('id') id: string) {
    return this.svc.permanentDelete(actorOf(req), { kind: 'folder', id });
  }

  @Get('trash')
  async trashList(@Req() req: Request) {
    return this.svc.trashList(actorOf(req));
  }

  /** 批量上传：一次最多 20 个，逐项返回成功与失败（§7.1） */
  @Post('uploads')
  @UseInterceptors(FilesInterceptor('files', config.batchUploadMaxFiles, {
    storage: memoryStorage(),
    limits: { fileSize: DOCUMENT_UPLOAD_MAX_BYTES + 1, files: config.batchUploadMaxFiles },
    // multer 的 defParamCharset 默认是 latin1：浏览器发来的中文文件名会被按 latin1 解码成
    // 「ä¸Šä¼¢æ–‡ä»¶.md」这种乱码并直接落库。显式声明 utf8 才是对的（实测修复）。
    defParamCharset: 'utf8',
  }))
  async upload(@Req() req: Request, @UploadedFiles() files: Express.Multer.File[],
    @Query('folder_id') folderId?: string, @Body('folder_id') folderBody?: string) {
    const actor = actorOf(req);
    const target = folderBody || folderId || null;
    if (!files || !files.length) throw AppError.validation('未收到文件（表单字段名 files）');
    return this.svc.uploadBatch(actor, target, files.map((f) => ({ originalname: f.originalname, buffer: f.buffer, mimetype: f.mimetype })),
      req.header('Idempotency-Key') ?? undefined);
  }

  @Post('files')
  async createText(@Req() req: Request, @Body(new ZodPipe(z.object({
    folder_id: idSchema.nullable().optional(),
    name: z.string().min(1).max(180),
    format: z.enum(['markdown', 'text']).default('markdown'),
    content: z.string().max(5_000_000).optional(),
  }))) body: never) {
    return this.svc.createTextFile(actorOf(req), body);
  }

  /** 短时签名链接的落地端点（§18 下载走短时签名链接且先鉴权） */
  @Get('files/download')
  async signedDownload(@Req() req: Request, @Res() res: Response,
    @Query('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string,
    @Query('file_id') fileId?: string, @Query('version_id') versionId?: string, @Query('user_id') userId?: string,
    @Query('inline') inline?: string) {
    const actor = actorOf(req);
    // 早期签发的链接用的是驼峰参数名，两种写法指向同一组签名字段，都要接住。
    fileId ??= typeof req.query.fileId === 'string' ? req.query.fileId : undefined;
    versionId ??= typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
    userId ??= typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const valid = actor.userId === userId && !!(key && exp && sig)
      && storage.verify(key, Number(exp), sig, { userId, fileId, versionId });
    let target;
    try {
      target = this.svc.resolveDownloadTarget(key, versionId, fileId);
    } catch {
      throw AppError.notFound('下载链接无效或已过期');
    }
    if (!valid) {
      if (!this.svc.actorMayRead(actor, target.file.id)) throw AppError.forbidden('无权下载该文件');
    }
    const buf = await this.svc.readObject(key);
    const showPdf = inline === '1' && target.version.mime === 'application/pdf'
      && buf.subarray(0, 5).toString('ascii') === '%PDF-';
    res.setHeader('content-type', target.version.mime || 'application/octet-stream');
    res.setHeader('content-length', String(buf.length));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-disposition', `${showPdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(target.filename)}`);
    res.setHeader('x-content-sha256', target.version.sha256 ?? '');
    res.end(buf);
  }

  @Get('files/:id')
  async get(@Req() req: Request, @Param('id') id: string) {
    return this.svc.getFile(actorOf(req), id);
  }

  @Patch('files/:id')
  async rename(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ name: z.string().min(1).max(180) }))) body: { name: string }) {
    return this.svc.rename(actorOf(req), { kind: 'file', id, name: body.name });
  }

  @Get('files/:id/content')
  async getContent(@Req() req: Request, @Param('id') id: string) {
    const actor = actorOf(req);
    const file = await this.svc.getFile(actor, id, { require: 'viewer' });
    const vid = file.current_version_id;
    if (!vid) throw AppError.notFound('文件尚无版本');
    const { buffer } = await this.svc.readVersion(vid);
    return { content: buffer.toString('utf8'), version_id: vid, editable: ['markdown', 'text', 'html'].includes(String(file.kind)) };
  }

  @Post('files/:id/content')
  async saveContent(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    content: z.string().max(5_000_000),
    base_version_id: idSchema,
    summary: z.string().max(500).optional(),
  }))) body: { content: string; base_version_id: string; summary?: string }) {
    return this.svc.patchContent(actorOf(req), { file_id: id, ...body });
  }

  @Post('files/:id/versions')
  @UseInterceptors(FilesInterceptor('file', 1, { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }))
  async addVersion(@Req() req: Request, @Param('id') id: string, @UploadedFiles() files: Express.Multer.File[],
    @Body('base_version_id') baseVersionId?: string) {
    const f = files?.[0];
    if (!f) throw AppError.validation('未收到文件（表单字段名 file）');
    return this.svc.addVersion(actorOf(req), {
      file_id: id, buffer: f.buffer, base_version_id: baseVersionId || null,
      change_source: 'upload', summary: `上传替换 ${f.originalname}`,
    });
  }

  @Get('files/:id/versions')
  async versions(@Req() req: Request, @Param('id') id: string) {
    return this.svc.versions(actorOf(req), id);
  }

  @Get('files/:id/diff')
  async diff(@Req() req: Request, @Param('id') id: string,
    @Query('from') from: string, @Query('to') to: string) {
    if (!from || !to) throw AppError.validation('需要 from 与 to 两个版本 ID');
    return this.svc.diff(actorOf(req), { file_id: id, from_version_id: from, to_version_id: to });
  }

  /** 从回收站恢复文件（与「恢复到某个历史版本」是两回事，后者见下面 files/:id/restore） */
  @Post('files/:id/restore-from-trash')
  async restoreFileFromTrash(@Req() req: Request, @Param('id') id: string) {
    return this.svc.restoreWithNote(actorOf(req), { kind: 'file', id });
  }

  @Post('files/:id/restore')
  async restoreVersion(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ version_id: idSchema }))) body: { version_id: string }) {
    const svc = this.svc;
    const actor = actorOf(req);
    const versions = await svc.versions(actor, id);
    const target = versions.find((v) => v.id === body.version_id);
    if (!target) throw AppError.notFound('版本不存在');
    const buf = await svc.readVersion(body.version_id).then((r) => r.buffer);
    const file = await svc.getFile(actor, id, { require: 'editor' });
    return svc.addVersion(actor, {
      file_id: id, buffer: buf, base_version_id: file.current_version_id ?? undefined,
      change_source: 'restore', summary: `恢复到 v${target.version_no}`,
    });
  }

  @Post('files/:id/move')
  async move(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    target_folder_id: idSchema.nullable(), accept_scope_change: z.boolean().optional(),
  }))) body: { target_folder_id: string | null; accept_scope_change?: boolean }) {
    return this.svc.move(actorOf(req), { kind: 'file', id, ...body });
  }

  @Post('folders/:id/move')
  async moveFolder(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    target_folder_id: idSchema.nullable(), accept_scope_change: z.boolean().optional(),
  }))) body: { target_folder_id: string | null; accept_scope_change?: boolean }) {
    return this.svc.move(actorOf(req), { kind: 'folder', id, ...body });
  }

  @Post('files/:id/copy')
  async copy(@Req() req: Request, @Param('id') id: string,
    @Body(new ZodPipe(z.object({ target_folder_id: idSchema.nullable().optional() }))) body: { target_folder_id?: string | null }) {
    return this.svc.copy(actorOf(req), { file_id: id, target_folder_id: body.target_folder_id ?? null });
  }

  @Post('files/:id/trash')
  async trashFile(@Req() req: Request, @Param('id') id: string) {
    return this.svc.trash(actorOf(req), { kind: 'file', id });
  }

  @Delete('files/:id')
  async deleteFile(@Req() req: Request, @Param('id') id: string) {
    return this.svc.trash(actorOf(req), { kind: 'file', id });
  }

  @Get('files/:id/extract-status')
  async extractStatus(@Req() req: Request, @Param('id') id: string) {
    return this.svc.extractStatus(actorOf(req), id);
  }

  @Get('files/:id/preview')
  async preview(@Req() req: Request, @Param('id') id: string) {
    return this.svc.preview(actorOf(req), id);
  }

  @Get('files/:id/download')
  async download(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Query('version_id') versionId?: string) {
    const actor = actorOf(req);
    await this.svc.getFile(actor, id, { require: 'viewer' });
    const file = this.svc.peekFile(actor, id);
    const versions = await this.svc.versions(actor, id);
    const v = versionId ? versions.find((x: { id: string }) => x.id === versionId) : (versions.find((x: { id: string }) => x.id === file.current_version_id) ?? versions[0]);
    if (!v) throw AppError.notFound('没有可用版本');
    const buf = await this.svc.readObject(v.object_key ?? '');
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(buf.length));
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(v.object_key ? file.name : file.name)}`);
    res.setHeader('x-content-sha256', v.sha256 ?? '');
    res.end(buf);
  }

  @Put('files/:id/acl')
  @Put('folders/:id/acl')
  async setAcl(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({
    grants: z.array(z.object({
      principal_type: z.enum(['user', 'team', 'org']),
      principal_id: idSchema,
      permission: z.enum(['viewer', 'editor', 'manager']),
      effect: z.enum(['allow', 'deny']).default('allow'),
    })).max(50),
  }))) body: { grants: never[] }, @Query('kind') kind?: 'folder') {
    return this.svc.aclSet(actorOf(req), { kind: kind === 'folder' ? 'folder' : 'file', id, grants: body.grants });
  }

  @Get('files/:id/acl')
  @Get('folders/:id/acl')
  async getAcl(@Req() req: Request, @Param('id') id: string, @Query('kind') kind?: 'folder') {
    return this.svc.aclList(actorOf(req), { kind: kind === 'folder' ? 'folder' : 'file', id });
  }

  @Post('files/:id/access-request')
  async accessRequest(@Req() req: Request, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().max(300).optional() }))) body: { note?: string }) {
    const actor = actorOf(req);
    const file = this.svc.peekFile(actor, id);
    if (!file) throw AppError.notFound('文件不存在或不可见');
    if (file.owner_id && file.owner_id !== actor.userId) {
      notify({
        user_id: file.owner_id, organization_id: actor.orgId, type: 'access_request',
        title: `${actor.displayName} 申请访问「${file.name}」`,
        body: body.note ?? '对方当前没有该文件的查看权。请前往「文档」页授予查看权。',
        entity_type: 'file', entity_id: file.id, actor_id: actor.userId,
        target_path: `/workspace?focus=${file.id}`,
      });
    }
    return { requested: true, owner: file.owner_id ?? null };
  }
}
