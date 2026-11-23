import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { CenterService, getCenterService } from './center.service';
import { CenterController } from './center.controller';

const center = getCenterService();

export function registerCenter(): CenterService {
  services.center = center;
  return center;
}

@Module({
  controllers: [CenterController],
  providers: [{ provide: CenterService, useValue: center }],
  exports: [CenterService],
})
export class CenterModule {}
