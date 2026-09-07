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
 * **silence** (the runner logs a warning naming the task id, and the run summary counts it —
 * but **today that count reaches no log**: `handleCron` discards `run()`'s return value, so
 * `ok: false` is currently *warned only*, not *warned and counted*; see condition **C68**).
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
 * **idempotent and independently reconcilable**, rather than treating "the task row is
 * processed" as proof that the close happened. The shape is fixed (condition **C78**):
 *
 * * **Close** — `UPDATE fondo_api_savingaccount SET state = 1 WHERE id = ? AND state = 0`:
 *   a no-op on rerun, race-safe, and no read-modify-write.
 * * **Reconciliation** — `SELECT id FROM fondo_api_savingaccount WHERE state = 0 AND
 *   end_date < <today, America/Bogota>`: the check that does *not* depend on the runner having
 *   succeeded. The same query is the ship-day backfill for CAPs already past `end_date`.
 *
 * ⚠️ **Closed-ness is materialised in `state`; it is never derived from `end_date` at read
 * time.** Deriving it would edit a Phase 3 path that has already passed its gate
 * (`src/users/user.service.ts` aggregates `savingAccount` at `state: 0`, porting
 * `UserFinanceSerializer.get_total_savingaccounts`); it would put two sources of truth in a
 * one-column state model that **Q21**'s `PUT { id, state, value }` writes directly; and — the
 * point — a derivation is not an independent check but a redefinition, which makes the runner's
 * failure *invisible* instead of *detectable*. Do not design D12 on the assumption that a
 * processed row means the side effect occurred; it does not.
 */
export interface SchedulerExecuterOutcome {
  /**
   * `false` when the executer's side effect demonstrably did not happen **and dropping it
   * outright is the better trade**. This is *not* the general "report a failure" channel. The
   * runner gives an executer exactly two, and they differ in what survives:
   *
   * * `return { ok: false }` → the row is marked `processed`, the runner logs one `WARN` naming
   *   the task id, the `repeat` successor is still cloned, and the work is **never retried**.
   * * `throw` → the claim is released, the row stays unprocessed, the next 10:00/14:00 pass
   *   retries it — **and no `repeat` successor is cloned on this pass**, because the
   *   release-and-rethrow in `scheduler.runner.ts` sits *before* `createRepeatInstance`. See
   *   `SchedulerExecuter` below.
   *
   * `ok: false` was decided by **Q6** for a *lost push*: a reminder that is not sent is one
   * missed message, whereas retrying a bad credential twice a day forever would never clone the
   * successor and would break the whole reminder/birthday chain rather than one link of it. That
   * trade holds only because the side effect is **recoverable next month** — the chain survives,
   * so the next occurrence sends.
   *
   * ⚠️ **It does not transfer to Phase 6's D12 (CAP auto-close), whose executer must `throw` —
   * which is safe only because a CAP closes once and its task therefore carries `repeat = 0`.**
   * For a CAP that failed to close, "task processed, CAP still open, one `WARN` in the log" is a
   * **financial-state divergence that no later pass repairs**: nothing else closes the CAP, and
   * the row that would have driven the retry is gone. A lost push is recoverable next month; an
   * unclosed CAP is not. **Do not give the close task a non-zero `repeat`**: by the `throw`
   * bullet above, a deterministically-failing repeating task throws on every pass and therefore
   * never clones its successor — the chain-breaking outcome **Q6** chose `ok: false` to avoid.
   *
   * So the rule is a function of **`repeat`**, not of money (condition **C77**). `throw` is the
   * correct channel for a task with `repeat = 0`: the worst case is a row that keeps being
   * retried and keeps being visible. For a *repeating* task it trades one lost occurrence for
   * the whole chain, which is why Q6 chose `ok: false` there. Money is why D12's one occurrence
   * must not be dropped; `repeat = 0` is why throwing costs nothing else.
   * `docs/phase-7b-deviations.md` §7.4.
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
