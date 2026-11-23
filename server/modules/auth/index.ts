// FlowMate · Auth 模块装配（PRD §18：认证在 server/modules/auth，全局守卫由主控在 main.ts 注册）
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}

export { AuthService } from './auth.service';
export { AuthController } from './auth.controller';
