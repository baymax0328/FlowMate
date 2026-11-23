// FlowMate · 根模块（PRD §18 后端结构：Controller 校验输入 / Service 执行业务事务 / Repository 访问数据 / Adapter 连外部）
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { AuthGuard } from './core/auth';
import { AppExceptionFilter, EnvelopeInterceptor, IdempotencyGuard, IdempotencySaveInterceptor } from './core/http';
import { AuthModule } from './modules/auth';
import { OrgModule } from './modules/org';
import { FilesModule } from './modules/files';
import { SearchModule } from './modules/search';
import { MessagesModule } from './modules/messages';
import { NotificationsModule } from './modules/notifications';
import { SessionsModule } from './modules/sessions';
import { OrchestratorModule } from './modules/orchestrator';
import { ProposalsModule } from './modules/proposals';
import { TasksModule } from './modules/tasks';
import { DiscoveryModule } from './modules/discovery';
import { CenterModule } from './modules/center';
import { DashboardModule } from './modules/dashboard';

@Module({
  imports: [
    AuthModule, OrgModule, FilesModule, SearchModule, MessagesModule, NotificationsModule,
    SessionsModule, OrchestratorModule, ProposalsModule, TasksModule, DiscoveryModule, CenterModule, DashboardModule,
  ],
  providers: [
    // 顺序：先认证（写 req.actor）→ 再幂等回放 → 最后统一响应信封
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: IdempotencyGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencySaveInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    Reflector,
  ],
})
export class AppModule {}
