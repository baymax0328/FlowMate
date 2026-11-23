import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { DiscoveryService, getDiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';

const discovery = getDiscoveryService();

export function registerDiscovery(): DiscoveryService {
  services.discovery = discovery;
  return discovery;
}

@Module({
  controllers: [DiscoveryController],
  providers: [{ provide: DiscoveryService, useValue: discovery }],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}

export { DiscoveryService, getDiscoveryService, startDiscoveryWorker } from './discovery.service';
