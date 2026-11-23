// FlowMate · 组织控制器（PRD §19 Auth/组织路由、§03 组织切换与新建）
import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { actorOf, Public } from '../../core/auth';
import { ZodPipe } from '../../core/http';
import { EMAIL_RE, type AuthedRequest } from '../auth/auth.service';
import { OrgService } from './org.service';

const createOrgSchema = z.object({
  name: z.string().trim().min(1, '请输入组织名称').max(60),
  timezone: z.string().trim().max(60).optional(),
});
const teamCreateSchema = z.object({
  name: z.string().trim().min(1, '请输入团队名称').max(60),
  lead_id: z.string().trim().max(64).optional(),
  member_ids: z.array(z.string().trim().max(64)).max(60).default([]),
});
const teamPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  lead_id: z.string().trim().max(64).nullable().optional(),
  member_ids: z.array(z.string().trim().max(64)).max(60).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '没有需要变更的字段' });
const memberPatchSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '没有需要变更的字段' });
const inviteSchema = z.object({
  email: z.string().trim().regex(EMAIL_RE, '邮箱格式不正确'),
  role: z.enum(['admin', 'member']).default('member'),
  team_ids: z.array(z.string().trim().max(64)).max(20).default([]),
  display_name: z.string().trim().max(60).optional(),
  password: z.string().max(200).optional(),
});
const acceptSchema = z.object({
  code: z.string().trim().min(4).max(32, '邀请码格式不正确'),
  email: z.string().trim().regex(EMAIL_RE, '邮箱格式不正确'),
  password: z.string().min(1, '请输入密码').max(200),
  display_name: z.string().trim().max(60).optional(),
});

@Controller('api/v1')
export class OrgController {
  constructor(private readonly svc: OrgService) {}

  // ---------- 组织 ----------
  // 字面量子路由先于参数路由声明，避免 'catalog' / 'members' 被当成 id

  @Get('organizations/catalog')
  catalog(@Req() req: AuthedRequest) {
    return this.svc.catalog(actorOf(req));
  }

  @Get('organizations/members')
  members(@Req() req: AuthedRequest) {
    return this.svc.members(actorOf(req));
  }

  @Get('organizations')
  organizations(@Req() req: AuthedRequest) {
    return this.svc.organizationsFor(actorOf(req).userId);
  }

  @Post('organizations')
  createOrganization(@Req() req: AuthedRequest,
                     @Body(new ZodPipe(createOrgSchema)) body: { name: string; timezone?: string }) {
    return this.svc.createOrganization(actorOf(req), body);
  }

  // ---------- 团队 ----------

  @Get('teams')
  teams(@Req() req: AuthedRequest, @Query('organization_id') organizationId?: string) {
    return this.svc.teamsOfOrg(actorOf(req), organizationId ?? null);
  }

  @Post('teams')
  createTeam(@Req() req: AuthedRequest,
             @Body(new ZodPipe(teamCreateSchema)) body: { name: string; lead_id?: string; member_ids: string[] }) {
    return this.svc.createTeam(actorOf(req), { name: body.name, member_ids: body.member_ids, lead_id: body.lead_id ?? null });
  }

  @Patch('teams/:id')
  updateTeam(@Req() req: AuthedRequest, @Param('id') id: string,
             @Body(new ZodPipe(teamPatchSchema)) body: { name?: string; lead_id?: string | null; member_ids?: string[] }) {
    return this.svc.updateTeam(actorOf(req), { team_id: id, ...body });
  }

  // ---------- 成员 ----------

  @Patch('members/:id')
  updateMember(@Req() req: AuthedRequest, @Param('id') id: string,
               @Body(new ZodPipe(memberPatchSchema)) body: { role?: string; status?: string }) {
    return this.svc.updateMember(actorOf(req), { user_id: id, ...body });
  }

  // ---------- 邀请 ----------

  @Get('invites')
  invites(@Req() req: AuthedRequest) {
    return this.svc.invites(actorOf(req));
  }

  @Post('invites')
  invite(@Req() req: AuthedRequest,
         @Body(new ZodPipe(inviteSchema)) body: { email: string; role: string; team_ids: string[] }) {
    return this.svc.invite(actorOf(req), body);
  }

  /** 免登录：被邀请人用邀请码建号/挂账号并进组织（§20 邀请接受） */
  @Public()
  @Post('invites/accept')
  accept(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response,
         @Body(new ZodPipe(acceptSchema)) body: { code: string; email: string; password: string; display_name?: string }) {
    return this.svc.acceptInvite(req, res, body);
  }

  @Post('invites/:id/revoke')
  revokeInvite(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.revokeInvite(actorOf(req), id);
  }
}
