// FlowMate · Message 模块装配（PRD §18 后端结构）
// services 注册表在启动时装配一次；实例无状态，业务真相在数据库。
import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';

/** 模块级单例：注册表与 Nest DI 共用同一实例，避免两套口径 */
const messagesService = new MessagesService();

/** 主控在 bootstrap 里调用：把实例写入跨模块契约注册表（key = messages） */
export function registerMessagesModules(): MessagesService {
  services.messages = messagesService;
  return messagesService;
}

@Module({
  controllers: [MessagesController],
  providers: [{ provide: MessagesService, useValue: messagesService }],
  exports: [MessagesService],
})
export class MessagesModule {}

export { MessagesService } from './messages.service';
export { MessagesController } from './messages.controller';
