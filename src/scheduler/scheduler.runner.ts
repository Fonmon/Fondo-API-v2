import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import {
  isSchedulerRepeat,
  nextRepeatRunDate,
  SchedulerRepeat,
} from '../common/utils/relativedelta.util';
import { BOGOTA_TIME_ZONE, nowInstant, todayInBogota } from '../common/utils/timezone.util';
import { ExecuterFactory } from './executers/executer.factory';
import type { SchedulerExecuterOutcome } from './executers/scheduler-executer';
import { SchedulerTaskRepository, type DueSchedulerTask } from './scheduler-task.repository';

/**
 * `crontab(minute=0, hour='10,14')` — `api/celery.py:13`.
 *
 * Celery's crontab and Unix cron agree field-for-field on this expression, so it is
 * transcribed rather than translated. Exported so a test can assert the *registered* job's
 * `cronTime` against it instead of against a copy of itself.
 */
export const SCHEDULER_CRON_EXPRESSION = '0 10,14 * * *';
// export const SCHEDULER_CRON_EXPRESSION = '* * * * *';

/** The `SchedulerRegistry` key, so tests and ops can find the job. */
export const SCHEDULER_CRON_JOB = 'fondo:scheduler';

/** What one pass did. v1's task returns `None`; this exists for the log, tests and ops. */
export interface SchedulerRunSummary {
  /** Rows the query returned. v1 logs this as `{} tasks to process`. */
  readonly loaded: number;
  /** Rows this runner claimed and executed without an exception. */
  readonly processed: number;
  /** Of those, the ones whose executer reported it did not do what it set out to do. */
  readonly failedDelivery: number;
  /** Rows another runner had already claimed between the read and the claim. */
  readonly skippedClaimed: number;
  /** Rows whose executer threw. The claim was released; the row is unprocessed again. */
  readonly errored: number;
  /** `create_repeat_instance` inserts. */
  readonly cloned: number;
}

/**
 * `fondo_api/scheduler/tasks.py` — **Phase 7b**, the runner that replaces `celery -A api beat`
 * plus its worker.
 *
 * ```python
 * @app.task(name = 'scheduler')
 * def scheduler():
 *     logger.info("Running scheduler")
 *     date = datetime.now()
 *     tasks = SchedulerTask.objects.filter(run_date__year = date.year,
 *                                          run_date__month = date.month,
 *                                          run_date__day = date.day, processed = False)
 *     logger.info("{} tasks to process".format(len(tasks)))
 *     for task in tasks:
 *         try:
 *             executer = get_executer(task.type)
 *             executer.run(task.payload)
 *             task.processed = True
 *             task.save()
 *             create_repeat_instance(task)
 *         except Exception as ex:
 *             logger.error("Error processing task with id: {}, exception: {}".format(task.id, ex))
 * ```
 *
 * ## `@nestjs/schedule`, not BullMQ — and why that is not a shortcut
 *
 * The plan left the choice open and asked for the multi-instance question to be settled here
 * (§3, Phase 7 *Scope*). It is settled by **topology**, which is how v1 settles it:
 *
 * * v1's runner is a **separate container** (`celery -A api beat`); the gunicorn API image
 *   never runs it, at any replica count. v2 keeps that property with
 *   {@link AppConfigService.schedulerEnabled} — one deployed process sets
 *   `SCHEDULER_ENABLED=true`, every other replica registers a cron that returns immediately.
 * * BullMQ would buy a distributed lock at the price of **keeping Redis**, which this phase
 *   exists to retire along with the Celery containers, and of a *second* source of truth for
 *   "what runs when": `fondo_api_schedulertask` already is that source, rows and all, and a
 *   repeatable-job registry that disagreed with it would be the next silent-failure story.
 * * The residual risk — two processes both flagged on — is handled where it actually shows
 *   up, in the data: {@link SchedulerTaskRepository.claim} is an atomic
 *   `UPDATE … WHERE id = ? AND processed = false`, so the loser of the race skips the row
 *   instead of publishing a duplicate push and writing a duplicate `repeat` clone. That is
 *   the plan's own suggested remedy (§3 *Risks*), and unlike a Redis lock it also survives a
 *   Redis outage, because it *is* the row.
 *
 * ## The four ordering decisions, each registered
 *
 * | v1 | v2 | why |
 * |---|---|---|
 * | `run_date` day **=** today | **`<=`** today | **D7** (Q8): a past-due reminder is sent, not skipped |
 * | `datetime.now()` in the process zone | {@link todayInBogota} | v2 has no `tzset()`; the host zone would skip or double-run around midnight |
 * | resolve → run → mark → clone | resolve → **claim** → run → clone | the atomic claim above (**P7-D2**); resolve stays *first*, so an unknown type is never consumed |
 * | throw ⇒ row stays unprocessed | throw ⇒ **claim released** | restores v1's end state after the reordering |
 *
 * ⚠️ **The one thing that is deliberately *not* fixed**: a task whose publish failed is still
 * marked `processed`. It is v1's behaviour, the operator confirmed it (Q6), and the
 * alternative retries a configuration error twice a day forever while never cloning the
 * `repeat` successor. What changes is that it is no longer *silent* — see
 * {@link SchedulerExecuterOutcome} and `docs/phase-7b-deviations.md` §3.
 */
@Injectable()
export class SchedulerRunner {
  /**
   * v1's logger is `logging.getLogger('fondo_api.scheduler.tasks')`. The context string is
   * the closest v2 equivalent; the *messages* are transcribed verbatim, because they are the
   * only observable this subsystem has.
   */
  private readonly logger = new Logger('fondo_api.scheduler.tasks');

  constructor(
    private readonly tasks: SchedulerTaskRepository,
    private readonly executers: ExecuterFactory,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The cron entry point. `celery beat`'s `crontab(minute=0, hour='10,14')` with
   * `CELERY_TIMEZONE = TIME_ZONE = 'America/Bogota'` (`api/settings/base.py:166`).
   *
   * ⚠️ **`timeZone` is passed explicitly.** Without it `cron` fires on the *host* zone, which
   * the test harness deliberately pins to UTC and a container may set to anything — 10:00 UTC
   * is 05:00 in Bogota, five hours early, every day.
   *
   * `waitForCompletion` keeps a slow 10:00 pass from overlapping the 14:00 one inside this
   * process; the atomic claim covers the cross-process case.
   *
   * The `SCHEDULER_ENABLED` guard is *inside* the handler rather than expressed as the
   * decorator's `disabled` option because the decorator is evaluated at class-definition
   * time, before any configuration exists. The observable effect is the same — no work, no
   * query, no publish — and this way the guard is unit-testable.
   *
   * ## ⚠️ The pass summary reaches the log, and a dead pass is distinguishable — **C68**
   *
   * This method used to `await this.run()` and discard the result, which had two costs. The
   * `failedDelivery` count {@link SchedulerExecuterOutcome} promises was computed and thrown
   * away, so `ok: false` was *warned only*; and a throw anywhere outside the per-task
   * `try` — {@link SchedulerTaskRepository.findDueUnprocessed} failing, for instance —
   * escaped into `@nestjs/schedule`'s default `console.error`, with **no `Logger` line at
   * all**. The operator check the phase wrote for itself, `grep -c 'Running scheduler'`,
   * therefore returned **2** whether the pass processed 110 rows or died on the statement
   * after that line.
   *
   * So the pass now ends with exactly one line either way, and the two are distinguishable:
   *
   * ```
   * Scheduler pass finished: loaded=110 processed=108 failedDelivery=2 skippedClaimed=0 errored=2 cloned=86
   * Scheduler pass failed: <message>
   * ```
   *
   * `grep -c 'Scheduler pass finished'` is the check that answers the question the old one
   * only appeared to. **This is the detection story Phase 6's D12 inherits** rather than
   * building its own: a CAP that silently stops closing shows up exactly as a reminder that
   * silently stops sending — as a pass whose `loaded` is 0 when it should not be, or as a
   * `finished` line that never appears.
   *
   * The pass-level error is **logged and swallowed** rather than rethrown. `run()` already
   * contains every per-task failure, so reaching here means the pass itself is over; letting
   * it escape would only re-emit the same information through a channel with no `Logger`
   * context and no timestamp discipline. The next 10:00/14:00 pass retries every row, because
   * a row is only `processed` if it was claimed **and** its executer returned.
   */
  @Cron(SCHEDULER_CRON_EXPRESSION, {
    name: SCHEDULER_CRON_JOB,
    timeZone: BOGOTA_TIME_ZONE,
    waitForCompletion: true,
  })
  async handleCron(): Promise<void> {
    if (!this.config.schedulerEnabled) {
      return;
    }
    try {
      const summary = await this.run();
      this.logger.log(formatRunSummary(summary));
    } catch (error) {
      this.logger.error(
        `Scheduler pass failed: ${describe(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * One pass of v1's `scheduler()` task.
   *
   * @param now injectable clock — every cell that asserts a date fixes it, so "today" is
   *   never whatever day CI happens to run on (review condition **C28**'s discipline).
   */
  async run(now: Date = nowInstant()): Promise<SchedulerRunSummary> {
    // v1: logger.info("Running scheduler")
    this.logger.log('Running scheduler');

    const today = todayInBogota(now, this.config.timeZone);
    const due = await this.tasks.findDueUnprocessed(today);
    // v1: logger.info("{} tasks to process".format(len(tasks)))
    this.logger.log(`${due.length} tasks to process`);

    let processed = 0;
    let failedDelivery = 0;
    let skippedClaimed = 0;
    let errored = 0;
    let cloned = 0;

    for (const task of due) {
      try {
        // Resolve first, and *before* claiming: an unknown type must stay unprocessed.
        const executer = this.executers.get(task.type);

        if (!(await this.tasks.claim(task.id))) {
          skippedClaimed += 1;
          this.logger.warn(
            `Task ${task.id} was already claimed by another runner; skipping. ` +
              'Two processes have SCHEDULER_ENABLED=true.',
          );
          continue;
        }

        let outcome: SchedulerExecuterOutcome;
        try {
          outcome = await executer.run(task.payload);
        } catch (error) {
          // v1 never reaches `task.save()` on this path, so the row must go back to
          // unprocessed for the next pass to retry it.
          //
          // ⚠️ **The release is itself in a `try` — condition C69.** It used to be a bare
          // `await this.tasks.release(...)` followed by `throw error`, and if the release
          // rejected, that `throw` was never reached: the *executer's* error was destroyed
          // and replaced by a database error, while the row stayed `processed` with nothing
          // done. Both facts have to survive, and they are different facts — what the
          // executer failed at (v1's own log line, emitted by the outer `catch`) and that the
          // row is now stuck claimed (no v1 counterpart; it is a consequence of P7-D2's
          // reordering, so it gets its own line rather than shadowing v1's).
          try {
            await this.tasks.release(task.id);
          } catch (releaseError) {
            this.logger.error(
              `Failed to release the claim on task ${task.id} after its executer threw. ` +
                'The row is still marked processed and its work was never done; it will ' +
                'NOT be retried. Release it by hand: ' +
                `UPDATE fondo_api_schedulertask SET processed = false WHERE id = ${task.id}. ` +
                `Release error: ${describe(releaseError)}`,
              releaseError instanceof Error ? releaseError.stack : undefined,
            );
          }
          throw error;
        }

        processed += 1;
        if (!outcome.ok) {
          failedDelivery += 1;
          // The silence v1 keeps, broken. The row is still `processed` — see the class doc.
          this.logger.warn(
            `Task ${task.id} (type ${task.type}) was marked processed but its executer ` +
              `reported "${outcome.detail}" — nothing was delivered.`,
          );
        }

        if (await this.createRepeatInstance(task)) {
          cloned += 1;
        }
      } catch (error) {
        errored += 1;
        // v1: logger.error("Error processing task with id: {}, exception: {}".format(...))
        this.logger.error(
          `Error processing task with id: ${task.id}, exception: ${describe(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return { loaded: due.length, processed, failedDelivery, skippedClaimed, errored, cloned };
  }

  /**
   * `create_repeat_instance(task)` (`scheduler/tasks.py:30-48`).
   *
   * ```python
   * if task.repeat != 0:
   *     run_date = task.run_date
   *     if task.repeat == 1: run_date = run_date + relativedelta(days=1)
   *     ...
   *     SchedulerTask.objects.create(type=task.type, run_date=run_date,
   *                                  payload=task.payload, repeat=task.repeat)
   * ```
   *
   * ⚠️ **The arithmetic is `python-dateutil`'s `relativedelta`, not a date library's default**
   * — a MONTHLY chain starting on the 31st collapses to the 28th **forever** (each step
   * clamps and the clamped value becomes the next input), and a YEARLY task on 29 February
   * loses the leap day permanently. {@link nextRepeatRunDate} is the Phase 0 port, pinned
   * value-by-value against `python-dateutil==2.7.5` on CPython 3.9 (condition **C3**, 104
   * cells). Reaching for `date-fns`/`luxon`'s `plus({months: 1})` here would have produced
   * the same answer for 27 days a month and a different one for the rest.
   *
   * ⚠️ **`repeat` values outside 0–4 clone nothing.** v1's four `if`s are not `elif`s and
   * carry no `else`: `repeat = 7` falls past all of them, leaves `run_date` unchanged, and
   * `objects.create` writes a **duplicate row on the same date**, unprocessed. The column is
   * `choices`-constrained in Python only (no DB check constraint), and no such row exists in
   * `fondodev` (626 rows: 540 `repeat=0`, 86 `repeat=4`).
   *
   * ⚠️ **v1's version of this is bounded, and the unbounded version is ours** — measured, five
   * v1 passes on an isolated clone: the twin is picked up by the same day's *second* pass and
   * clones once more, and then v1's exact calendar-day filter never selects it again
   * (`0 tasks to process` on D+1 and D+2). Two extra rows, on the original date, and it stops.
   * But {@link SchedulerTaskRepository.findDueUnprocessed} selects with **`<=` (D7)**, and a
   * past-due twin is due on *every* later pass — a real v2 pass on D+1 loaded exactly that row.
   * So reproducing v1's clone here would be **strictly worse than v1**: every pass would mark
   * its row processed and leave a fresh permanently-due successor, so the chain never ends —
   * two rows and two pushes a day, for as long as the runner runs. The refusal is registered as
   * **P7-D3**, and it is not separable from D7 — relaxing one means revisiting the other.
   *
   * @returns whether a clone was written.
   */
  private async createRepeatInstance(task: DueSchedulerTask): Promise<boolean> {
    if (!isSchedulerRepeat(task.repeat)) {
      throw new Error(
        `Repeat type ${task.repeat} does not exist; refusing to clone task ${task.id} ` +
          'onto its own run_date (P7-D3).',
      );
    }
    // v1: `if task.repeat != 0:` — NONE clones nothing.
    if (task.repeat === SchedulerRepeat.NONE) {
      return false;
    }

    const runDate = nextRepeatRunDate(task.run_date, task.repeat);
    /* istanbul ignore next -- unreachable: repeat === NONE returned above */
    if (runDate === null) {
      return false;
    }
    await this.tasks.createRepeatInstance(task, runDate);
    return true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one line a completed pass leaves behind (**C68**).
 *
 * Written as a function, and exported through the runner's own log rather than assembled at
 * the call site, so the operator check and the unit cell can agree on a literal prefix
 * (`Scheduler pass finished:`) that a later edit to the field list cannot move.
 */
function formatRunSummary(summary: SchedulerRunSummary): string {
  return (
    `Scheduler pass finished: loaded=${summary.loaded} processed=${summary.processed} ` +
    `failedDelivery=${summary.failedDelivery} skippedClaimed=${summary.skippedClaimed} ` +
    `errored=${summary.errored} cloned=${summary.cloned}`
  );
}
