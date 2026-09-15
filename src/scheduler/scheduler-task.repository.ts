import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { encodeJsonbColumn, type StorableValue } from '../common/utils/jsonb-storage';
import type { SchedulerPayload } from './scheduler-payload';
import type { PlainDate } from '../common/utils/date.util';
import type { Prisma } from '../prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Either the pooled client or an interactive-transaction client.
 *
 * ⚠️ Needed because `__update_user_personal` calls `remove_sch_notitfications` and
 * `schedule_notification` **inside** `transaction.atomic()` (`services/user.py:225-236`), so
 * a failed profile write must roll the scheduler rows back with it. Passing `this.prisma`
 * there instead would leave an orphaned birthday task behind every failed edit.
 */
export type SchedulerSqlClient =
  | Pick<PrismaService, 'schedulerTask' | '$queryRaw'>
  | Pick<Prisma.TransactionClient, 'schedulerTask' | '$queryRaw'>;

/** `SchedulerTask.TASK_TYPES` — the only member v1 ever writes. */
export const SCHEDULER_TASK_NOTIFICATIONS = 0;

/**
 * The payload members that hold structured JSON after Phase 9 step 6. Everything else is
 * stored as a JSON **string**, because that is what v1 stored and what all 626 migrated rows
 * contain — see `common/utils/jsonb-storage.ts` for why `owner_id` in particular must stay
 * a string.
 */
export const SCHEDULER_PAYLOAD_NATIVE_KEYS = ['user_ids'] as const;

/**
 * **Phase 6 / D12** — the CAP auto-close. The **second** `SchedulerTask.type`, and the first
 * one v1 does not have: `SchedulerTask.TASK_TYPES` (`models.py:100-102`) declares only
 * `(0, 'NOTIFICATIONS')`, and `services/saving_account.py` still carries
 * `# TODO: schedule task for closing CAP`.
 *
 * ⚠️ `type` is `choices`-constrained **in Python only** — there is no database check
 * constraint — so writing a `1` is a schema-compatible insert on the Django-owned table
 * (plan §4: the schema is not reshaped until Phase 9). A v1 process that somehow loaded such
 * a row would raise `Exception("Executer type 1 does not exist.")` in
 * `scheduler/executers/factory.py`, leave the row unprocessed and log it — which is the same
 * fail-closed outcome v2's {@link ExecuterFactory} produces, and is why the rolling-deploy
 * note in that class matters (`docs/phase-7b-deviations.md` §7.4 item 2).
 */
export const SCHEDULER_TASK_CLOSE_SAVING_ACCOUNT = 1;

/**
 * `payload->'type'` for a D12 close task.
 *
 * Distinct from the two notification values (`'birthdate'`, `'payment_reminder'`) so that
 * `remove_sch_notitfications`-shaped deletes, which key on `owner_id` **and** `type`, can
 * never reach a close task by accident.
 */
export const CLOSE_SAVING_ACCOUNT_PAYLOAD_TYPE = 'saving_account_close';

/**
 * The payload `schedule_notification` is called with. Every value is `str()`-ed by Django's
 * `HStoreField.get_prep_value` on the way to the column; `user_ids` becomes a Python list
 * repr (`'[2, 4, 3]'`), which is why the reader `json.loads`es exactly that one key.
 */
export interface SchedulerTaskPayload extends Record<string, StorableValue> {
  type: string;
  owner_id: number;
}

/**
 * **Phase 6 / D12.** The payload of a CAP close task.
 *
 * Deliberately **not** shaped like {@link SchedulerTaskPayload}:
 *
 *  * there is no `owner_id`, because the subject of this task is a *saving account*, not a
 *    member, and reusing `owner_id` for an account id would make the two dedupe/delete
 *    queries in this class silently able to match each other's rows;
 *  * there is no `user_ids`, `message` or `target`, because **a close sends no notification
 *    at all** — operator answer **Q22**. Carrying a recipient list "for later" is how a
 *    notification gets added by a future reader who assumes the keys are there for a reason.
 *
 * Every value still goes through `HStoreField.get_prep_value`'s `str()` on the way to the
 * column, so `saving_account_id` is stored as text and read back as text.
 */
export interface CloseSavingAccountTaskPayload extends Record<string, StorableValue> {
  type: typeof CLOSE_SAVING_ACCOUNT_PAYLOAD_TYPE;
  saving_account_id: number;
}

/**
 * A row the runner loaded.
 *
 * `payloadText` is kept alongside because `create_repeat_instance` writes
 * `payload = task.payload` **verbatim** — v1 hands Django the dict it read back (all values
 * already strings) and `HStoreField.get_prep_value` `str()`s them a second time, which is a
 * no-op. Cloning the stored text avoids a re-encode that could differ from what v1 stored.
 */
export interface DueSchedulerTask {
  readonly id: number;
  readonly type: number;
  readonly run_date: Date;
  readonly repeat: number;
  readonly payload: SchedulerPayload;
}

/**
 * The **second and last** place in the codebase allowed to write raw SQL against an `hstore`
 * column (plan §2; the other is `NotificationSubscriptionRepository`).
 *
 * ## Why this lands in Phase 3 — review finding **S9**, condition **C24**
 *
 * The plan sequenced `SchedulerTask` entirely into Phase 7, but Phase 3 and Phase 4 both
 * **write** rows:
 *
 * ```
 * fondo_api/services/user.py:281-282   remove_sch_notitfications("birthdate", user.id)
 *                                      schedule_notification(birthdate_time, payload, 4)
 * fondo_api/services/loan.py:107       remove_sch_notitfications("payment_reminder", id)
 * fondo_api/services/loan.py:314-315   schedule_notification(five_days_date, payload)
 * ```
 *
 * The first pair is `PATCH /api/user/<id>` — this phase. So Phase 7 is split: **7a**, the
 * write half (this class, plus `NotificationService.scheduleNotification` /
 * `removeSchNotifications` and the same-day dedupe rule) lands here; **7b**, the cron runner,
 * the executer factory and the `repeat` cloning, stays in Phase 7.
 *
 * ⚠️ **How the rows written here are validated before Phase 7 exists** (C24's actual
 * question): not by running them, but by comparing them. `fondodev` holds **626** real rows
 * written by v1 — 86 of them `payload->'type' = 'birthdate'`, 540 `payment_reminder` — so the
 * parity criterion for this phase is that a
 * `SchedulerTask` row v2 writes for a given user is byte-identical to the one v1 writes for
 * the same user, `payload::text` included, and that the same-day dedupe suppresses the second
 * write in both. That is a *data* comparison, available now; Phase 7 later adds the
 * behavioural half (does the runner pick it up, does the clone advance correctly), by which
 * time `nextRepeatRunDate` (Phase 0, condition C3) is already unit-pinned against
 * `python-dateutil==2.7.5`.
 *
 * ## The three encoding facts, taken from live rows
 *
 * A live birthdate row reads, verbatim:
 *
 * ```
 * type      | 0
 * run_date  | 2027-08-25 05:00:00+00          -- i.e. 2027-08-25 00:00 America/Bogota
 * payload   | "type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años …",
 *           | "owner_id"=>"5", "user_ids"=>"[2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8]"
 * processed | f
 * repeat    | 4
 * ```
 *
 *  1. **`owner_id` is stored as text.** Django's `KeyTransform` on an `HStoreField` has
 *     `output_field = TextField()`, so `payload__owner_id=5` compares against `'5'`. Both the
 *     dedupe query and the delete therefore bind strings, never integers.
 *  2. **`user_ids` is a Python list repr, not JSON.** They coincide for a list of ints, which
 *     is why v1's `json.loads` works — but the encoder must stay {@link toHstoreLiteral}, not
 *     `JSON.stringify`, or a future non-int value would diverge silently.
 *  3. **`run_date` is `make_aware(naive)` in `America/Bogota`**, so a birthday task fires at
 *     local midnight and lands in the column as `05:00Z`.
 *
 * ## ⚠️ `processed` and `repeat` have no database default
 *
 * Django declares `default=False` / `default=0` in Python. Both columns are `NOT NULL` with
 * no DB default, so v2 must supply them explicitly (plan §4 rule 5).
 */
@Injectable()
export class SchedulerTaskRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The same-day dedupe query of `schedule_notification`:
   *
   * ```python
   * SchedulerTask.objects.filter(payload__owner_id = payload["owner_id"],
   *                              payload__type    = payload["type"],
   *                              run_date__year   = run_date.year,
   *                              run_date__month  = run_date.month,
   *                              run_date__day    = run_date.day,
   *                              processed        = False)
   * ```
   *
   * ⚠️ `run_date__year` on a `timestamptz` under `USE_TZ = True` extracts in the **current
   * time zone**, not UTC — Django emits
   * `EXTRACT('year' FROM run_date AT TIME ZONE 'America/Bogota')`. A UTC extract would put a
   * midnight-Bogota task on the *next* day and silently defeat the dedupe, so the zone is
   * passed explicitly rather than left to the server's.
   *
   * The comparison is against the **local** calendar parts of `runDate`, which is how v1
   * compares them: `run_date` there is the naive datetime *before* `make_aware`.
   */
  async existsUnprocessedOnDay(
    ownerId: number,
    taskType: string,
    localYear: number,
    localMonth: number,
    localDay: number,
    client: SchedulerSqlClient = this.prisma,
  ): Promise<boolean> {
    const zone = this.config.timeZone;
    const rows = await client.$queryRaw<{ id: number }[]>`
      SELECT id
      FROM fondo_api_schedulertask
      WHERE payload ->> 'owner_id' = ${String(ownerId)}
        AND payload ->> 'type' = ${taskType}
        AND EXTRACT(YEAR FROM run_date AT TIME ZONE ${zone}) = ${localYear}
        AND EXTRACT(MONTH FROM run_date AT TIME ZONE ${zone}) = ${localMonth}
        AND EXTRACT(DAY FROM run_date AT TIME ZONE ${zone}) = ${localDay}
        AND processed = false
      LIMIT 1
    `;
    return rows.length > 0;
  }

  /**
   * `SchedulerTask.objects.create(type=0, run_date=<aware>, payload=payload, repeat=repeat)`.
   *
   * `id` is left to the sequence: v1 and v2 share it during parity testing and plan §4
   * forbids v2 setting a primary key on a table v1 also writes.
   */
  async create(
    runDate: Date,
    payload: SchedulerTaskPayload,
    repeat: number,
    client: SchedulerSqlClient = this.prisma,
  ): Promise<void> {
    await client.schedulerTask.create({
      data: {
        type: SCHEDULER_TASK_NOTIFICATIONS,
        run_date: runDate,
        payload: encodeJsonbColumn(payload, SCHEDULER_PAYLOAD_NATIVE_KEYS) as Prisma.InputJsonValue,
        processed: false,
        repeat,
      },
    });
  }

  /**
   * **Phase 6 / D12.** Writes the one-shot task that closes a CAP on its `end_date`.
   *
   * ## ⚠️ There is no `repeat` parameter, and that is condition **C77**
   *
   * `repeat` is the literal `0` in the SQL below and cannot be supplied by a caller. The
   * condition asks for the literal at the task-creation site; making the parameter *absent*
   * is the same guarantee enforced by the type system instead of by a reviewer, and it is
   * the guarantee that matters, because a non-zero `repeat` here would silently invalidate
   * the rule the executer is written under.
   *
   * The chain of reasoning, which is easy to lose and expensive to rediscover:
   *
   *  1. {@link SavingAccountCloseExecuter} must **`throw`** on a failed close rather than
   *     return `ok: false`, because `ok: false` marks the row `processed` and never retries —
   *     "task processed, CAP still open, one WARN" is a financial-state divergence no later
   *     pass repairs (**C74**).
   *  2. A `throw` is only cheap because {@link SchedulerRunner} releases the claim and
   *     rethrows **before** `createRepeatInstance`, so a throwing task clones no successor.
   *  3. For a task with `repeat = 0` there is no successor to lose, so the worst case is a
   *     row that keeps being retried and keeps being visible. For a *repeating* task the
   *     same `throw` trades one occurrence for the **whole chain** — which is exactly what
   *     **Q6** chose `ok: false` to avoid.
   *
   * So: *money is why D12's one occurrence must not be dropped; `repeat = 0` is why throwing
   * costs nothing else* (**C77**, `docs/phase-7b-deviations.md` §7.4 item 3).
   *
   * `processed` is supplied explicitly for the reason the class comment gives: Django
   * declares `default=False` in Python and the column has no database default.
   *
   * @returns the new row's id, so a caller and a test can assert on the row it wrote.
   */
  async createCloseSavingAccountTask(
    runDate: Date,
    payload: CloseSavingAccountTaskPayload,
    client: SchedulerSqlClient = this.prisma,
  ): Promise<number> {
    const row = await client.schedulerTask.create({
      data: {
        type: SCHEDULER_TASK_CLOSE_SAVING_ACCOUNT,
        run_date: runDate,
        payload: encodeJsonbColumn(payload, SCHEDULER_PAYLOAD_NATIVE_KEYS) as Prisma.InputJsonValue,
        processed: false,
        repeat: 0,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * ```python
   * SchedulerTask.objects.filter(payload__owner_id = owner_id,
   *                              payload__type     = notification_type).delete()
   * ```
   *
   * ⚠️ Unfiltered by `processed`: a member who edits their birthdate loses the *history* of
   * already-processed birthday tasks as well as the pending one. That is v1's behaviour and
   * nothing reads processed tasks, so it is ported rather than narrowed.
   *
   * @returns the number of rows removed, for the caller's logs and for tests.
   */
  async deleteByOwnerAndType(
    ownerId: number,
    taskType: string,
    client: SchedulerSqlClient = this.prisma,
  ): Promise<number> {
    const { count } = await client.schedulerTask.deleteMany({
      where: {
        AND: [
          { payload: { path: ['owner_id'], equals: String(ownerId) } },
          { payload: { path: ['type'], equals: taskType } },
        ],
      },
    });
    return count;
  }

  /**
   * **Phase 7b.** The runner's read: today's unprocessed tasks.
   *
   * ```python
   * date = datetime.now()                                  # process zone = America/Bogota
   * tasks = SchedulerTask.objects.filter(run_date__year = date.year,
   *                                      run_date__month = date.month,
   *                                      run_date__day = date.day, processed = False)
   * ```
   *
   * Two things are deliberately **not** a transcription:
   *
   * ⚠️ **`<=`, not `=` — this is deviation D7** (operator answer Q8). v1 matches the calendar
   * day exactly, so a reminder whose `run_date` has already passed is never sent: the 5-day
   * loan reminder is skipped outright whenever the monthly payment file lands within five
   * days of the deadline, which is the case D7 exists to fix. v2 sends it on the next pass
   * instead. ⚠️ **The backlog consequence is real and is registered as P7-D1** — this `<=`
   * returns **110** unprocessed rows on `fondodev` (measured 2026-09-07: 109 already past,
   * plus one dated today), the oldest from 2020-09-27, and a first run would publish 108 of
   * them. Draining that backlog is a cutover step, not a code change; `MIGRATION_PLAN.md` §3
   * Phase 9 step 3a is the statement, and it spares 2 of the 110 by design. ⚠️ The figure is a
   * snapshot of a live table — re-measure it, do not copy it out of another document
   * (it read 109 here until the parity round measured it: the count of rows *strictly* past
   * due is not the count this predicate returns).
   *
   * ⚠️ **"Today" is `America/Bogota`, passed in, never read from the host.** v1 gets it for
   * free (`Settings.__init__` sets `os.environ['TZ']` from `TIME_ZONE`), v2 does not; the
   * comparison also extracts the *stored* date in Bogota, matching the `AT TIME ZONE` that
   * Django's `__year`/`__month`/`__day` lookups emit under `USE_TZ`. A UTC extract would move
   * every 19:00–23:59 local task onto the next day and make the runner skip or double-run
   * around midnight. Same trap, same helper, as `existsUnprocessedOnDay` above.
   *
   * **No `ORDER BY`**, matching v1's unordered queryset — heap order is what both sides
   * iterate, and Phase 2 measured that adding one to the sibling subscription read *breaks*
   * wire parity. The only thing order affects here is the sequence of SQS messages.
   */
  async findDueUnprocessed(today: PlainDate): Promise<DueSchedulerTask[]> {
    const zone = this.config.timeZone;
    const rows = await this.prisma.$queryRaw<
      { id: number; type: number; run_date: Date; repeat: number; payload: SchedulerPayload }[]
    >`
      SELECT id, type, run_date, repeat, payload
      FROM fondo_api_schedulertask
      WHERE processed = false
        AND (run_date AT TIME ZONE ${zone})::date
            <= make_date(${today.year}, ${today.month}, ${today.day})
    `;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      run_date: row.run_date,
      repeat: row.repeat,
      payload: row.payload,
    }));
  }

  /**
   * **Phase 7b.** `task.processed = True; task.save()`, made an **atomic claim**.
   *
   * v1 writes an unconditional `UPDATE … SET processed = true WHERE id = ?` after
   * `executer.run()` has returned. v2 adds `AND processed = false` and reads the row count,
   * which turns the same statement into the compare-and-set the plan asks for
   * (§3 Phase 7 Risks: *"Multi-instance v2 needs a lock or an atomic claim
   * (`UPDATE … WHERE processed = false RETURNING`), or tasks run N times"*).
   *
   * The runner claims **before** running, so a second runner that loaded the same row loses
   * the race and skips it rather than publishing a duplicate push and writing a duplicate
   * repeat clone. The ordering change is registered as **P7-D2**, together with the one
   * behaviour it costs: the claim is *released* again when the executer throws, so v1's
   * "a failed task stays unprocessed and is retried next pass" survives everything except a
   * hard process crash inside `run()`.
   *
   * @returns `true` if this call won the row.
   */
  async claim(id: number, client: SchedulerSqlClient = this.prisma): Promise<boolean> {
    const { count } = await client.schedulerTask.updateMany({
      where: { id, processed: false },
      data: { processed: true },
    });
    return count === 1;
  }

  /**
   * **Phase 7b.** Undoes {@link claim} when the executer threw.
   *
   * v1 never sets `processed` in that case at all — the exception skips `task.save()` — so
   * releasing restores v1's observable end state: the row is still unprocessed and the next
   * 10:00/14:00 pass tries it again. Only called on the error path.
   */
  async release(id: number, client: SchedulerSqlClient = this.prisma): Promise<void> {
    await client.schedulerTask.updateMany({
      where: { id },
      data: { processed: false },
    });
  }

  /**
   * **Phase 7b.** `create_repeat_instance`'s insert (`scheduler/tasks.py:43-48`):
   *
   * ```python
   * SchedulerTask.objects.create(type = task.type, run_date = run_date,
   *                              payload = task.payload, repeat = task.repeat)
   * ```
   *
   * `processed` is not passed and takes Django's `default=False`; the column has no database
   * default, so v2 supplies it (plan §4 rule 5).
   *
   * ⚠️ **`payload` is the source row's payload, passed through unchanged** — no re-encoding.
   * Before Phase 9 step 6 that meant re-inserting the row's stored hstore *text*, because
   * re-encoding a decoded map would have had to rebuild a Python repr. Now it is the jsonb
   * object Prisma read, written straight back: the clone is byte-identical to its parent by
   * construction, which is what the plan predicted — *"in the 7b runner the whole change is
   * one cast"*.
   *
   * ⚠️ **The clone does not go through `schedule_notification`**, so the same-day dedupe does
   * **not** apply to it. Two rows for the same owner/type on the same day are reachable this
   * way in v1 too, and are ported rather than narrowed.
   *
   * @returns the new row's id.
   */
  async createRepeatInstance(
    task: DueSchedulerTask,
    runDate: Date,
    client: SchedulerSqlClient = this.prisma,
  ): Promise<number> {
    const row = await client.schedulerTask.create({
      data: {
        type: task.type,
        run_date: runDate,
        payload: task.payload as Prisma.InputJsonValue,
        processed: false,
        repeat: task.repeat,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Reads one row's stored payload, for the parity comparisons described in the class
   * comment. Not used in production.
   *
   * Before Phase 9 step 6 this returned the raw hstore *text*, because the whole point was to
   * compare v2's Python-repr encoding byte for byte with v1's. The column is jsonb now, so it
   * returns the parsed object: there is no encoding left to compare, and the member order a
   * caller sees is jsonb's canonical (length, bytes) — the same order hstore emitted.
   */
  async findPayloadById(id: number): Promise<SchedulerPayload | null> {
    const row = await this.prisma.schedulerTask.findUnique({
      where: { id },
      select: { payload: true },
    });
    return row === null ? null : (row.payload as SchedulerPayload);
  }
}
