import type { HstoreMap } from '../../common/utils/hstore.codec';

/**
 * What an executer reports back about a run that did **not** throw.
 *
 * ⚠️ **v1 has no such thing, and that is this phase's headline risk.**
 * `NotificationExecuter.run` returns `None` whether SQS accepted the message, the member had
 * no devices, or the publish failed and `celery/tasks.py:send_notification` swallowed the
 * exception — and `scheduler/tasks.py:24` then sets `processed = True` on all three. A failed
 * publish is *recorded as a success*, in the subsystem that is the only delivery path for
 * loan payment reminders.
 *
 * v2 reproduces the **outcome** (the row is still marked processed) and drops the
 * **silence** (the runner logs a warning naming the task id, and the run summary counts it).
 * See `docs/phase-7b-deviations.md` §3.
 */
export interface SchedulerExecuterOutcome {
  /** `false` when the executer's side effect demonstrably did not happen. */
  readonly ok: boolean;
  /** Short tag for the log line and the run summary. */
  readonly detail: string;
}

/**
 * `fondo_api/scheduler/executers/abstract_executer.py`:
 *
 * ```python
 * class AbstractExecuter(ABC):
 *     @abstractmethod
 *     def run(self, payload):
 *         pass
 * ```
 *
 * An interface rather than an abstract class: v1's base declares one abstract method and no
 * state, and Nest injects the concrete executers by type, so there is nothing for a shared
 * superclass to carry.
 *
 * `payload` arrives exactly as the hstore column stores it — **every value a string or
 * SQL NULL**. Decoding is the executer's job, because it is the executer that knows which
 * keys are encoded (`NotificationExecuter` `json.loads`es `user_ids` and nothing else).
 *
 * **Throwing is meaningful.** v1's loop wraps `executer.run(...)` in `try/except`, logs
 * `Error processing task with id: {id}, exception: {ex}` and leaves the row unprocessed, so
 * the next 10:00/14:00 pass retries it. v2 keeps that: a throw releases the claim.
 */
export interface SchedulerExecuter {
  run(payload: HstoreMap): Promise<SchedulerExecuterOutcome>;
}
