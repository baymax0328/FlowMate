// FlowMate · 多方共同确认模块装配入口（PRD §18.1 modules/proposals）
// - ProposalsModule：向 Nest 注册 ProposalsController + ProposalsService（供 HTTP /api/v1/proposals）。
// - registerProposals()：把服务单例写入跨模块注册表 services.proposals，供 orchestrator 等 need('proposals')。
// - startProposalTick()：注册并首推 'proposal-tick'（§11.3 超时挂起节奏）。
// 建议 app 启动顺序：files → sessions → orchestrator → proposals（proposals 只经注册表调用 files/notifications）。
import { Module } from '@nestjs/common';
import { ProposalsService, getProposalsService } from './proposals.service';
import { ProposalsController } from './proposals.controller';
import { services } from '../../core/contracts';
import { startProposalTick } from './proposal.tick';

export { ProposalsService } from './proposals.service';
export { startProposalTick } from './proposal.tick';

const PROPOSALS_PROVIDER = {
  provide: ProposalsService,
  useFactory: () => getProposalsService(),
};

@Module({
  controllers: [ProposalsController],
  providers: [PROPOSALS_PROVIDER],
  exports: [PROPOSALS_PROVIDER],
})
export class ProposalsModule {}

/** 写入跨模块注册表：services.proposals（create/decide/get/tick 等）。返回实例供 Nest provider 复用同单例 */
export function registerProposals(): ProposalsService {
  const svc = getProposalsService();
  services.proposals = svc;
  return svc;
}
