import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { OrchestratorService, getOrchestratorService } from './orchestrator.service';
import { OrchestratorController } from './orchestrator.controller';
import { startOrchestratorWorker, recoverOrchestrator } from './scheduler.runner';

const orch = getOrchestratorService();

export function registerOrchestrator(): OrchestratorService {
  services.orchestrator = orch;
  return orch;
}

export { startOrchestratorWorker, recoverOrchestrator };

@Module({
  controllers: [OrchestratorController],
  providers: [{ provide: OrchestratorService, useValue: orch }],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
