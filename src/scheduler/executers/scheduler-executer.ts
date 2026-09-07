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
 *
 * ⚠️ **Neither failure channel below — `throw` nor `ok: false` — covers the claim-then-crash
 * window, and a new executer must not assume the runner does.** v2 claims the row *before*
 * running it — `resolve → claim → run → clone`,
 * `docs/phase-7b-deviations.md` §4 **P7-D2** — so a process that dies between the claim and the
 * side effect leaves the row `processed` with the work never done: no throw, no `ok: false`, no
 * log line, and no later pass will see the row again. For a notification that is one missed
 * push. For Phase 6's **D12** it is a CAP that stays open with its task marked done.
 *
 * What follows for **D12** is a design constraint, not a caution: the auto-close must be
 * **idempotent and independently reconcilable** — the closed state also derivable from
 * `end_date` at read time, or a reconciliation query that finds CAPs past `end_date` still
 * open — rather than treating "the task row is processed" as proof that the close happened.
 * Re-running the close over an already-closed CAP must be a no-op. Do not design D12 on the
 * assumption that a processed row means the side effect occurred; it does not.
 */
export interface SchedulerExecuterOutcome {
  /**
   * `false` when the executer's side effect demonstrably did not happen **and dropping it
   * outright is the better trade**. This is *not* the general "report a failure" channel. The
   * runner gives an executer exactly two, and they differ in what survives:
   *
   * * `return { ok: false }` → the row is marked `processed`, the runner logs one `WARN` naming
   *   the task id, the `repeat` successor is still cloned, and the work is **never retried**.
   * * `throw` → the claim is released, the row stays unprocessed, and the next 10:00/14:00 pass
   *   retries it. See `SchedulerExecuter` below.
   *
   * `ok: false` was decided by **Q6** for a *lost push*: a reminder that is not sent is one
   * missed message, whereas retrying a bad credential twice a day forever would never clone the
   * successor and would break the whole reminder/birthday chain rather than one link of it. That
   * trade holds only because the side effect is **recoverable next month** — the chain survives,
   * so the next occurrence sends.
   *
   * ⚠️ **It does not transfer to Phase 6's D12 (CAP auto-close), whose executer must `throw`.**
   * For a CAP that failed to close, "task processed, CAP still open, one `WARN` in the log" is a
   * **financial-state divergence that no later pass repairs**: nothing re-derives the close and
   * the row that would have driven the retry is gone. A lost push is recoverable next month; an
   * unclosed CAP is not. Any future executer whose side effect changes money or account state
   * belongs on the `throw` side of this choice. `docs/phase-7b-deviations.md` §7.4.
   */
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
 * the next 10:00/14:00 pass retries it. v2 keeps that: a throw releases the claim. It is
 * therefore the **correct** channel for any side effect that must not be silently dropped —
 * see `SchedulerExecuterOutcome.ok` for which failures belong on which channel, and why.
 */
export interface SchedulerExecuter {
  run(payload: HstoreMap): Promise<SchedulerExecuterOutcome>;
}
