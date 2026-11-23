import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { TasksService, getTasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

const tasks = getTasksService();

export function registerTasks(): TasksService {
  services.tasks = tasks;
  return tasks;
}

@Module({
  controllers: [TasksController],
  providers: [{ provide: TasksService, useValue: tasks }],
  exports: [TasksService],
})
export class TasksModule {}

export { TasksService, getTasksService, statusLabel, STAGE_OF, STAGES } from './tasks.service';
