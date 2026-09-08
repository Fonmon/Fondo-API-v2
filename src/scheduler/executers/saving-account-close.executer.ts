import { Injectable } from '@nestjs/common';
import type { HstoreMap } from '../../common/utils/hstore.codec';
import { pythonInt } from '../../common/utils/python-obj';
import { SavingAccountService } from '../../saving-accounts/saving-account.service';
import type { SchedulerExecuter } from './scheduler-executer';

/**
 * **Phase 6 / D12** — the CAP auto-close. `SchedulerTask.type = 1`.
 *
 * ⚠️ **This has no v1 counterpart at all.** `fondo_api/services/saving_account.py` carries a
 * literal `# TODO: schedule task for closing CAP` and nothing else: v1 never built the
 * auto-close, so CAPs close only when a treasurer sends `PUT { state: 1 }`. There is no v1
 * behaviour to parity-check this against; it is specified by operator answers **Q20** (a CAP
 * closes automatically on its `end_date`), **Q22** (no member notification) and **Q38** (a CAP
 * already past `end_date` on ship day is closed by the backfill).
 *
 * ## ⚠️ Why the return type is `{ ok: true; … }` and not `SchedulerExecuterOutcome`
 *
 * The interface's `ok` is `boolean`; this implementation narrows it to the literal `true`,
 * which TypeScript permits and which makes `return { ok: false, … }` a **compile error in
 * this file** rather than something a reviewer has to catch.
 *
 * That is condition **C74**, made structural. The runner offers two failure channels and
 * they are not interchangeable:
 *
 * | channel | row | retried? | clone |
 * |---|---|---|---|
 * | `return { ok: false }` | marked `processed` | **never** | still written |
 * | `throw` | claim released, unprocessed | next 10:00/14:00 pass | **not** written on this pass |
 *
 * `ok: false` was chosen by **Q6** for a *lost push*: one missed notification beats retrying
 * a bad credential twice a day forever and never cloning the successor, so the `repeat` chain
 * survives and next month's message goes out. **It does not transfer here.** "Task processed,
 * CAP still open, one `WARN` in the log" is a financial-state divergence that no later pass
 * repairs — nothing else closes the CAP, and the row that would have driven the retry is
 * gone.
 *
 * ⚠️ **And the rule is a function of `repeat`, not of money** (condition **C77**). `throw` is
 * the right channel for a `repeat = 0` task, where the worst case is a row that keeps being
 * retried and keeps being visible. For a *repeating* task the same `throw` trades one
 * occurrence for the whole chain, which is Q6's case. D12's task carries `repeat = 0` — see
 * {@link SchedulerTaskRepository.createCloseSavingAccountTask}, which has no `repeat`
 * parameter for exactly this reason. *Money is why D12's one occurrence must not be dropped;
 * `repeat = 0` is why throwing costs nothing else.*
 *
 * ## Idempotent, and independently reconcilable
 *
 * The runner **claims the row before running it** (`docs/phase-7b-deviations.md` §4
 * **P7-D2**), so a process that dies between the claim and the close leaves the row
 * `processed` with the CAP still open — silently, with no throw and no log line. This
 * executer therefore does not treat "the task row is processed" as evidence:
 *
 *  * the close is a compare-and-set (`SavingAccountService.closeAccount`), a no-op on rerun;
 *  * the independent check is `SavingAccountService.findUnclosedPastDue`, which shares no
 *    code with this path and is the ship-day backfill as well.
 *
 * ## ⚠️ Q39 — the 10:00 pass, and there is deliberately **no code** for it
 *
 * The close runs on the 10:00 Bogota pass, and nothing here schedules it there. Selection is
 * date-granularity with no time component
 * (`(run_date AT TIME ZONE zone)::date <= today`), and the 10:00 pass **claims** the row and
 * marks it `processed`, so the 14:00 pass's `processed = false` filter already excludes it.
 * The 14:00 pass re-attempts **only** when the 10:00 close threw and released the claim —
 * which is the retry path the `throw` rule above depends on. Adding per-type pass scheduling
 * would be building a mechanism to produce behaviour the design already produces.
 */
@Injectable()
export class SavingAccountCloseExecuter implements SchedulerExecuter {
  constructor(private readonly accounts: SavingAccountService) {}

  /**
   * Closes the CAP the payload names.
   *
   * The payload key is read the way `NotificationExecuter` reads its own — explicitly, and
   * failing **closed** on an absent key (condition **C23**): a decoder that failed open would
   * turn a loud error into a task that reports success having closed nothing, which is the
   * one outcome this whole design is arranged to prevent.
   *
   * Every hstore value is text (`HStoreField.get_prep_value` calls `str()`), so the id goes
   * through {@link pythonInt} — the same CPython `int()` semantics the query-string readers
   * use, whitespace set included (**C63**).
   */
  async run(payload: HstoreMap): Promise<{ ok: true; detail: string }> {
    const id = pythonInt(requireText(payload, 'saving_account_id'));
    const result = await this.accounts.closeAccount(id);
    return { ok: true, detail: result };
  }
}

/**
 * `payload["saving_account_id"]`, with the same two failure modes
 * `NotificationExecuter.requireText` keeps.
 *
 * An **absent** key throws `KeyError: '…'`, which the runner catches, logs as
 * `Error processing task with id: …` and leaves unprocessed for the next pass — v1's shape,
 * modulo the log-text difference registered as **P7-D6**. A **SQL NULL** value is refused
 * rather than coerced: Django's `str()` on the way in means a Python `None` is stored as the
 * *string* `'None'`, never SQL NULL, so a NULL here can only come from a hand-edit, and
 * `int(None)` would be a `TypeError` in v1 anyway.
 */
function requireText(payload: HstoreMap, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw new Error(`KeyError: '${key}'`);
  }
  const value = payload[key];
  if (value === null) {
    throw new TypeError(`scheduler payload key '${key}' is NULL`);
  }
  return value;
}
