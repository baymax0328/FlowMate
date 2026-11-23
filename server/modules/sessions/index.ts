// FlowMate · Sessions 模块装配入口（PRD §18.1 modules/sessions）
// 供 Nest 引导：SessionsModule 提供 controller + service；
// 供跨模块注册表：registerSessions() 把实例写入 services.sessions，使其它模块可 need('sessions')。
import { Module } from '@nestjs/common';
import { SessionsService, getSessionService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { services } from '../../core/contracts';

export { SessionsService } from './sessions.service';
export { BranchService } from './branch.service';

const SESSIONS_PROVIDER = {
  provide: SessionsService,
  useFactory: () => getSessionService(),
};

@Module({
  controllers: [SessionsController],
  providers: [SESSIONS_PROVIDER],
  exports: [SESSIONS_PROVIDER],
})
export class SessionsModule {}

/** 写入跨模块注册表（app 启动顺序建议：files → sessions → orchestrator → proposals） */
export function registerSessions(): SessionsService {
  const svc = getSessionService();
  services.sessions = svc;
  return svc;
}
