// FlowMate · 组织模块装配（PRD §18：server/modules/organizations 的落地目录为 org）
import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { OrgService } from './org.service';
import { OrgController } from './org.controller';

const orgService = new OrgService();

/** 主控在 bootstrap 里调用：把实例写入跨模块契约注册表（key = org） */
export function registerOrgModules(): OrgService {
  services.org = orgService;
  return orgService;
}

@Module({
  controllers: [OrgController],
  providers: [{ provide: OrgService, useValue: orgService }],
  exports: [OrgService],
})
export class OrgModule {}

export { OrgService } from './org.service';
export { OrgController } from './org.controller';
