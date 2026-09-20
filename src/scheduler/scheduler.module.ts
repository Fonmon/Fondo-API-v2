import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SchedulerTaskRepository } from './scheduler-task.repository';

/**
 * **Phase 7a** — the `SchedulerTask` *write* half, landed early because Phases 3 and 4 both
 * write rows and Phase 7 runs after both (review finding **S9**, condition **C24**).
 *
 * ✅ **Phase 7b landed** — but in a **sibling** module, {@link SchedulerRunnerModule}, not in
 * this one. `NotificationModule` imports *this* module (for
 * `NotificationService.scheduleNotification`), and the runner needs the dependency the other
 * way round (`NotificationExecuter` calls `NotificationService.sendNotification`), so adding
 * the runner here would make the two modules mutually dependent and require a `forwardRef`.
 * The split matches v1's own layout, where `fondo_api/scheduler/` imports
 * `fondo_api/services/notification.py` and nothing imports back.
 *
 * This module still owns the *data*: reads, writes, the atomic claim and the repeat clone all
 * live in {@link SchedulerTaskRepository}, which remains the second and last raw-SQL hstore
 * repository (plan §2).
 */
@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [SchedulerTaskRepository],
  exports: [SchedulerTaskRepository],
})
export class SchedulerModule {}
