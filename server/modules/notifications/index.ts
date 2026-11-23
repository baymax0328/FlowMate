// FlowMate · 通知与事件投递模块装配（PRD §18 worker/outbox 的应用内落地）
import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { OutboxWorker } from './outbox.worker';

const notificationsService = new NotificationsService();

/** 主控在 bootstrap 里调用：把实例写入跨模块契约注册表（key = notifications） */
export function registerNotificationsModules(): NotificationsService {
  services.notifications = notificationsService;
  return notificationsService;
}

@Module({
  controllers: [NotificationsController],
  providers: [
    { provide: NotificationsService, useValue: notificationsService },
    OutboxWorker,
  ],
  exports: [NotificationsService, OutboxWorker],
})
export class NotificationsModule {}

export { NotificationsService, pushNotification, pushNotificationSync } from './notifications.service';
export { NotificationsController } from './notifications.controller';
export { OutboxWorker, flushPending, drainPending, outboxStats } from './outbox.worker';
