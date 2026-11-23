// FlowMate · Auth 控制器（PRD §19 Auth 路由、§03 账户菜单与演示身份切换）
// 需要登录的接口由全局 AuthGuard（main.ts 注册）处理；此处只标记 @Public 的入口。
import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { actorOf, Public } from '../../core/auth';
import { ZodPipe } from '../../core/http';
import { AppError } from '../../core/errors';
import { AuthService, EMAIL_RE, type AuthedRequest } from './auth.service';

const loginSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});
const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  title: z.string().trim().max(60).nullable().optional(),
  prefs: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的资料' });
const passwordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(8, '新密码至少 8 位').max(200),
});
const resetRequestSchema = z.object({ email: z.string().trim().regex(EMAIL_RE, '邮箱格式不正确') });
const resetSchema = z.object({
  token: z.string().min(16).max(200, '重置令牌不合法'),
  new_password: z.string().min(8, '新密码至少 8 位').max(200),
});
const demoLoginSchema = z.object({ user_id: z.string().min(1).max(64) });

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public()
  @Post('login')
  login(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response,
        @Body(new ZodPipe(loginSchema)) body: { email: string; password: string }) {
    return this.svc.login(req, res, body.email, body.password);
  }

  @Post('logout')
  logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.svc.logout(req, res);
  }

  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.svc.me(actorOf(req));
  }

  @Patch('profile')
  patchProfile(@Req() req: AuthedRequest,
               @Body(new ZodPipe(profileSchema)) body: { display_name?: string; title?: string | null; prefs?: Record<string, unknown> }) {
    return this.svc.patchProfile(actorOf(req), body);
  }

  @Post('password')
  changePassword(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response,
                 @Body(new ZodPipe(passwordSchema)) body: { current_password: string; new_password: string }) {
    const actor = actorOf(req);
    return this.svc.changePassword(res, actor.userId, body.current_password, body.new_password);
  }

  /** 本地无邮件通道：202 受理，不返回令牌，不暴露账号是否存在 */
  @Public()
  @HttpCode(202)
  @Post('password/reset-request')
  resetRequest(@Body(new ZodPipe(resetRequestSchema)) body: { email: string }) {
    return this.svc.requestPasswordReset(body.email);
  }

  @Post('password/reset')
  reset(@Body(new ZodPipe(resetSchema)) body: { token: string; new_password: string }) {
    return this.svc.resetPassword(body.token, body.new_password);
  }

  /** 仅演示环境：局域网 demo 用取回令牌（生产语义 404） */
  @Public()
  @Get('password/reset-token')
  resetToken(@Query('email') email?: string) {
    if (!email) throw AppError.validation('缺少 email 参数', { email: '必填' });
    return this.svc.demoResetToken(email);
  }

  /** §03 演示身份切换：仅测试环境显示并标记 */
  @Public()
  @Get('demo-accounts')
  demoAccounts() {
    return this.svc.demoAccounts();
  }

  @Public()
  @Post('demo-login')
  demoLogin(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response,
            @Body(new ZodPipe(demoLoginSchema)) body: { user_id: string }) {
    return this.svc.demoLogin(req, res, body.user_id);
  }
}
