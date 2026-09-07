import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { NotificationModule } from '../notifications/notification.module';
import { ExecuterFactory } from './executers/executer.factory';
import { NotificationExecuter } from './executers/notification.executer';
import { SchedulerModule } from './scheduler.module';
import { SchedulerRunner } from './scheduler.runner';

/**
 * **Phase 7b** — the runner half: the cron, the executer factory and the `repeat` cloning.
 * Together with {@link SchedulerModule} (7a, the write half) it replaces v1's
 * `celery -A api beat` **and** its worker container.
 *
 * ## Why this is a second module and not more providers on `SchedulerModule`
 *
 * `NotificationModule` already imports `SchedulerModule`, because
 * `NotificationService.scheduleNotification` needs `SchedulerTaskRepository` (7a). The
 * runner needs the dependency the other way round — `NotificationExecuter` calls
 * `NotificationService.sendNotification` — so putting it on `SchedulerModule` would make the
 * two modules mutually dependent and need a `forwardRef`. Splitting the *runner* out keeps
 * the graph acyclic and matches v1's own layout, where `fondo_api/scheduler/` imports
 * `fondo_api/services/notification.py` and nothing imports back.
 *
 * ⚠️ Registering this module does **not** start anything by itself. The cron is declared
 * unconditionally so that its expression and time zone are inspectable through
 * `SchedulerRegistry` in every environment, but `SchedulerRunner.handleCron` returns
 * immediately unless `SCHEDULER_ENABLED` is set — the v2 equivalent of "this container is
 * the beat container". See `env.schema.ts`.
 */
@Module({
  imports: [AppConfigModule, SchedulerModule, NotificationModule],
  providers: [NotificationExecuter, ExecuterFactory, SchedulerRunner],
  exports: [SchedulerRunner, ExecuterFactory],
})
export class SchedulerRunnerModule {}
