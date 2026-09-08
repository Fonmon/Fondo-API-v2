import { Injectable } from '@nestjs/common';
import {
  SCHEDULER_TASK_CLOSE_SAVING_ACCOUNT,
  SCHEDULER_TASK_NOTIFICATIONS,
} from '../scheduler-task.repository';
import { NotificationExecuter } from './notification.executer';
import { SavingAccountCloseExecuter } from './saving-account-close.executer';
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
 * deploy now that Phase 6's **D12** has added the second task type: an old replica that
 * resolved-after-claiming would silently consume every new-type row it saw, marking the CAP
 * close done without closing anything. The ordering in `scheduler.runner.ts` is what makes
 * that impossible, and it is ordered that way on purpose
 * (`docs/phase-7b-deviations.md` §7.4 item 2).
 *
 * ✅ **Phase 6 added `type = 1`** — {@link SavingAccountCloseExecuter}. v1's factory knows
 * only `type == 0`; a v1 process that loaded a `type = 1` row raises the same
 * `Executer type 1 does not exist.` message this class throws, leaves it unprocessed and logs
 * it, so the two versions fail identically on each other's rows during a cutover.
 */
@Injectable()
export class ExecuterFactory {
  constructor(
    private readonly notificationExecuter: NotificationExecuter,
    private readonly savingAccountCloseExecuter: SavingAccountCloseExecuter,
  ) {}

  get(type: number): SchedulerExecuter {
    if (type === SCHEDULER_TASK_NOTIFICATIONS) {
      return this.notificationExecuter;
    }
    // Phase 6 / D12.
    if (type === SCHEDULER_TASK_CLOSE_SAVING_ACCOUNT) {
      return this.savingAccountCloseExecuter;
    }
    throw new Error(`Executer type ${type} does not exist.`);
  }
}
