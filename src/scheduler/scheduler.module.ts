import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SchedulerTaskRepository } from './scheduler-task.repository';

/**
 * **Phase 7a** — the `SchedulerTask` *write* half, landed early because Phases 3 and 4 both
 * write rows and Phase 7 runs after both (review finding **S9**, condition **C24**).
 *
 * Phase 7b adds the cron runner, the executer factory and the `repeat` cloning to this
 * module. Nothing here reads or executes a task.
 */
@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [SchedulerTaskRepository],
  exports: [SchedulerTaskRepository],
})
export class SchedulerModule {}
