import { Injectable } from '@nestjs/common';
import { SCHEDULER_TASK_NOTIFICATIONS } from '../scheduler-task.repository';
import { NotificationExecuter } from './notification.executer';
import type { SchedulerExecuter } from './scheduler-executer';

/**
 * `fondo_api/scheduler/executers/factory.py`:
 *
 * ```python
 * def get_executer(type):
 *     if type == 0:
 *         return NotificationExecuter(NotificationService())
 *     raise Exception("Executer type {} does not exist.".format(type))
 * ```
 *
 * A provider rather than a module-level function, for the reason v1's version is the one
 * place in that file that constructs a `NotificationService()` by hand: the executers need
 * dependencies, and Nest already owns their lifecycle.
 *
 * ⚠️ **The message text is transcribed, not paraphrased.** It ends up in the scheduler's
 * `Error processing task with id: {id}, exception: {ex}` log line, which is the only trace an
 * unknown task type leaves in either version.
 *
 * ⚠️ **Resolution happens *before* the runner claims the row.** An unknown type therefore
 * leaves the task unprocessed and retried, exactly as in v1 — which matters for a rolling
 * deploy in Phase 6, where D12's CAP auto-close introduces a **second** task type: an old
 * replica that resolved-after-claiming would silently consume every new-type row it saw.
 */
@Injectable()
export class ExecuterFactory {
  constructor(private readonly notificationExecuter: NotificationExecuter) {}

  get(type: number): SchedulerExecuter {
    if (type === SCHEDULER_TASK_NOTIFICATIONS) {
      return this.notificationExecuter;
    }
    throw new Error(`Executer type ${type} does not exist.`);
  }
}
