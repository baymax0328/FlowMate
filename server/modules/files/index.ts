import { Module } from '@nestjs/common';
import { FilesService, getFilesService } from './files.service';
import { FilesController } from './files.controller';
import { services } from '../../core/contracts';

/** 正文抽取任务的注册与启动 */
export { startExtractionWorker, recoverExtractions } from './extract.worker';
export { FilesService, getFilesService };

export function registerFiles(): FilesService {
  const svc = getFilesService();
  services.files = svc;
  return svc;
}

@Module({
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
