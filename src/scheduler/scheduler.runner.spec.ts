import type { AppConfigService } from '../config/app-config.service';
import { BOGOTA_TIME_ZONE } from '../common/utils/timezone.util';
import type { ExecuterFactory } from './executers/executer.factory';
import { LAST_SCHEDULER_PASS_HOUR, SCHEDULER_PASS_HOURS } from './scheduler-passes';
import type { DueSchedulerTask, SchedulerTaskRepository } from './scheduler-task.repository';
import { SCHEDULER_CRON_EXPRESSION, SCHEDULER_CRON_JOB, SchedulerRunner } from './scheduler.runner';

/**
 * `fondo_api/scheduler/tasks.py`, unit level.
 *
 * ⚠️ **v1 ships no test for this file.** There is no `tests/test_scheduler*.py`, no
 * `tests/scheduler/`, nothing — the subsystem that is the sole delivery path for loan payment
 * reminders has zero inherited coverage. Everything below is new.
 *
 * The clock is **fixed in every cell that depends on a date**, and the host zone is UTC
 * (`jest.config.ts`), so a `new Date().getDate()` anywhere in the runner produces a wrong day
 * here rather than a coincidentally right one (review condition **C28**).
 */

/** `2026-09-07T02:30:00Z` = **2026-09-06** 21:30 in Bogota — the two dates disagree. */
const LATE_EVENING_UTC = new Date('2026-09-07T02:30:00.000Z');

function task(overrides: Partial<DueSchedulerTask> = {}): DueSchedulerTask {
  const payloadText =
    '"type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años X", ' +
    '"owner_id"=>"5", "user_ids"=>"[2, 3]"';
  return {
    id: 101,
    type: 0,
    run_date: new Date('2026-09-07T05:00:00.000Z'),
    repeat: 0,
    payload: {
      type: 'birthdate',
      target: '/',
      message: 'Hoy está cumpliendo años X',
      owner_id: '5',
      user_ids: '[2, 3]',
    },
    payloadText,
    ...overrides,
  };
}

describe('SchedulerRunner', () => {
  let tasks: {
    findDueUnprocessed: jest.Mock;
    claim: jest.Mock;
    release: jest.Mock;
    createRepeatInstance: jest.Mock;
  };
  let executer: { run: jest.Mock };
  let executers: { get: jest.Mock };
  let config: { timeZone: string; schedulerEnabled: boolean };
  let runner: SchedulerRunner;
  /** The runner's own `Logger`, silenced and observable. Its three messages are v1's. */
  let logged: { log: jest.SpyInstance; warn: jest.SpyInstance; error: jest.SpyInstance };

  beforeEach(() => {
    tasks = {
      findDueUnprocessed: jest.fn().mockResolvedValue([]),
      claim: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
      createRepeatInstance: jest.fn().mockResolvedValue(9001),
    };
    executer = { run: jest.fn().mockResolvedValue({ ok: true, detail: 'published' }) };
    executers = { get: jest.fn().mockReturnValue(executer) };
    config = { timeZone: BOGOTA_TIME_ZONE, schedulerEnabled: true };
    runner = new SchedulerRunner(
      tasks as unknown as SchedulerTaskRepository,
      executers as unknown as ExecuterFactory,
      config as unknown as AppConfigService,
    );
    const logger = runnerLogger(runner);
    logged = {
      log: jest.spyOn(logger, 'log').mockImplementation(() => undefined),
      warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
      error: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The cron declaration — `crontab(minute=0, hour='10,14')`, America/Bogota
  // -------------------------------------------------------------------------

  describe('the cron declaration', () => {
    /**
     * Read off the decorator metadata rather than off a copy of the constant, so this cell
     * fails if the schedule is edited. `@nestjs/schedule` stores it under `SCHEDULE_CRON_OPTIONS`.
     */
    it('is 0 10,14 * * * in America/Bogota, matching celery beat', () => {
      const handler = Object.getOwnPropertyDescriptor(SchedulerRunner.prototype, 'handleCron')
        ?.value as object;
      const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler) as {
        cronTime: string;
        timeZone: string;
        name: string;
        waitForCompletion: boolean;
      };

      expect(options.cronTime).toBe('0 10,14 * * *');
      expect(options.timeZone).toBe('America/Bogota');
      expect(options.name).toBe(SCHEDULER_CRON_JOB);
      // A slow 10:00 pass must not overlap the 14:00 one inside this process.
      expect(options.waitForCompletion).toBe(true);
    });

    it('exports the expression it registers', () => {
      expect(SCHEDULER_CRON_EXPRESSION).toBe('0 10,14 * * *');
    });

    /**
     * **Phase 8b / D48.** `nextBirthdayRunDate` decides "a pass is still to run today" from
     * `SCHEDULER_PASS_HOURS`, not from the cron text. This cell is the check that the two agree.
     */
    it('agrees with SCHEDULER_PASS_HOURS, which D48 reads', () => {
      const [minute, hour, ...rest] = SCHEDULER_CRON_EXPRESSION.split(' ');

      expect(minute).toBe('0');
      expect(hour.split(',').map(Number)).toEqual(SCHEDULER_PASS_HOURS);
      expect(rest).toEqual(['*', '*', '*']);
      expect(LAST_SCHEDULER_PASS_HOUR).toBe(14);
    });
  });

  // -------------------------------------------------------------------------
  // SCHEDULER_ENABLED — the multi-instance answer
  // -------------------------------------------------------------------------

  describe('SCHEDULER_ENABLED', () => {
    it('does nothing at all when this process is not the scheduler', async () => {
      config.schedulerEnabled = false;

      await runner.handleCron();

      expect(tasks.findDueUnprocessed).not.toHaveBeenCalled();
      expect(executers.get).not.toHaveBeenCalled();
    });

    /** Positive control: the same tick *does* work when the flag is on. */
    it('runs the pass when this process is the scheduler', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task()]);

      await runner.handleCron();

      expect(tasks.findDueUnprocessed).toHaveBeenCalledTimes(1);
      expect(executer.run).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // "Today" is Bogota, never the host zone
  // -------------------------------------------------------------------------

  describe('the date it asks for', () => {
    it('anchors today in America/Bogota, not the host zone', async () => {
      await runner.run(LATE_EVENING_UTC);

      // 2026-09-07T02:30Z is already the 7th in UTC and still the 6th in Bogota. v1 gets the
      // 6th because Django's `Settings.__init__` sets the process TZ; a host-zone read here
      // would ask for the 7th, skipping every task due today and running tomorrow's early.
      expect(tasks.findDueUnprocessed).toHaveBeenCalledWith({ year: 2026, month: 9, day: 6 });
    });

    it('honours a configured time zone other than the default', async () => {
      config.timeZone = 'UTC';

      await runner.run(LATE_EVENING_UTC);

      expect(tasks.findDueUnprocessed).toHaveBeenCalledWith({ year: 2026, month: 9, day: 7 });
    });
  });

  // -------------------------------------------------------------------------
  // The loop — v1's five statements, in v1's order bar the claim
  // -------------------------------------------------------------------------

  describe('the loop', () => {
    it('resolves the executer, claims, runs, and reports one processed task', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task()]);

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(executers.get).toHaveBeenCalledWith(0);
      expect(tasks.claim).toHaveBeenCalledWith(101);
      expect(executer.run).toHaveBeenCalledWith(task().payload);
      expect(tasks.release).not.toHaveBeenCalled();
      expect(summary).toEqual({
        loaded: 1,
        processed: 1,
        failedDelivery: 0,
        skippedClaimed: 0,
        errored: 0,
        cloned: 0,
      });
    });

    it('processes every task and does not let one failure stop the rest', async () => {
      const good = task({ id: 1 });
      const bad = task({ id: 2 });
      const alsoGood = task({ id: 3 });
      tasks.findDueUnprocessed.mockResolvedValue([good, bad, alsoGood]);
      executer.run.mockImplementation((payload: unknown) =>
        payload === bad.payload
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ ok: true, detail: 'published' }),
      );

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(executer.run).toHaveBeenCalledTimes(3);
      expect(summary.processed).toBe(2);
      expect(summary.errored).toBe(1);
    });

    it('resolves the executer BEFORE claiming, so an unknown type is never consumed', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ type: 7 })]);
      executers.get.mockImplementation(() => {
        throw new Error('Executer type 7 does not exist.');
      });

      const summary = await runner.run(LATE_EVENING_UTC);

      // ⚠️ The rolling-deploy case: Phase 6's D12 adds a second task type, and an old replica
      // must leave those rows for the new one rather than marking them processed.
      expect(tasks.claim).not.toHaveBeenCalled();
      expect(tasks.release).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ loaded: 1, processed: 0, errored: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // The atomic claim
  // -------------------------------------------------------------------------

  describe('the atomic claim (multi-instance safety)', () => {
    it('skips a task another runner claimed between the read and the claim', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task()]);
      tasks.claim.mockResolvedValue(false);

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(executer.run).not.toHaveBeenCalled();
      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ loaded: 1, processed: 0, skippedClaimed: 1, cloned: 0 });
    });

    it('claims each task exactly once per pass', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ id: 1 }), task({ id: 2 })]);

      await runner.run(LATE_EVENING_UTC);

      expect(tasks.claim.mock.calls).toEqual([[1], [2]]);
    });
  });

  // -------------------------------------------------------------------------
  // Failure semantics: what v1 leaves behind after an exception
  // -------------------------------------------------------------------------

  describe('when the executer throws', () => {
    beforeEach(() => {
      tasks.findDueUnprocessed.mockResolvedValue([task()]);
      executer.run.mockRejectedValue(new Error("KeyError: 'user_ids'"));
    });

    it('releases the claim, so the row is unprocessed again for the next pass', async () => {
      // v1 never reaches `task.save()` on this path; the reordered claim has to be undone or
      // a malformed task would disappear instead of being retried and logged twice a day.
      const summary = await runner.run(LATE_EVENING_UTC);

      expect(tasks.release).toHaveBeenCalledWith(101);
      expect(summary).toMatchObject({ processed: 0, errored: 1 });
    });

    it('writes no repeat clone', async () => {
      await runner.run(LATE_EVENING_UTC);

      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
    });

    it('logs v1’s exact message shape', async () => {
      await runner.run(LATE_EVENING_UTC);

      expect(calls(logged.error)[0][0]).toBe(
        "Error processing task with id: 101, exception: KeyError: 'user_ids'",
      );
    });
  });

  // -------------------------------------------------------------------------
  // The silent-failure decision
  // -------------------------------------------------------------------------

  describe('a swallowed publish failure', () => {
    beforeEach(() => {
      tasks.findDueUnprocessed.mockResolvedValue([task()]);
      executer.run.mockResolvedValue({ ok: false, detail: 'failed' });
    });

    /**
     * ⚠️ **The deliberate parity choice.** v1 marks the row processed after a swallowed SQS
     * error, so the reminder is lost and recorded as sent. v2 keeps the row state — a
     * configuration error would otherwise retry forever and never clone the `repeat`
     * successor — and drops only the silence.
     */
    it('still counts as processed and still clones, exactly as v1 does', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ repeat: 4 })]);

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(tasks.release).not.toHaveBeenCalled();
      expect(tasks.createRepeatInstance).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ processed: 1, failedDelivery: 1, cloned: 1 });
    });

    it('is no longer silent — a warning names the task', async () => {
      await runner.run(LATE_EVENING_UTC);

      expect(logged.warn).toHaveBeenCalledWith(
        'Task 101 (type 0) was marked processed but its executer reported "failed" — ' +
          'nothing was delivered.',
      );
    });

    /** Positive control: a successful pass logs no warning, so the cell above can see one. */
    it('logs no warning on a successful publish', async () => {
      executer.run.mockResolvedValue({ ok: true, detail: 'published' });

      await runner.run(LATE_EVENING_UTC);

      expect(logged.warn).not.toHaveBeenCalled();
    });

    it('treats "no member has a device" as an ordinary success, not a failure', async () => {
      executer.run.mockResolvedValue({ ok: true, detail: 'no-subscriptions' });

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(summary).toMatchObject({ processed: 1, failedDelivery: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // create_repeat_instance
  // -------------------------------------------------------------------------

  describe('create_repeat_instance', () => {
    it('writes nothing for repeat = NONE', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ repeat: 0 })]);

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
      expect(summary.cloned).toBe(0);
    });

    it.each([
      [1, 'DAILY', '2026-09-08T05:00:00.000Z'],
      [2, 'WEEKLY', '2026-09-14T05:00:00.000Z'],
      [3, 'MONTHLY', '2026-10-07T05:00:00.000Z'],
      [4, 'YEARLY', '2027-09-07T05:00:00.000Z'],
    ])('advances a repeat = %i (%s) task to %s', async (repeat, _name, expected) => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ repeat })]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      expect(runDate.toISOString()).toBe(expected);
    });

    /**
     * ⚠️ `relativedelta` month-end arithmetic, which the plan asked to pin here. Every value
     * comes from `python-dateutil==2.7.5` on CPython 3.9 (Phase 0, condition **C3**); a date
     * library's `plus({months: 1})` agrees for 27 days a month and not for these.
     */
    it.each([
      // 31 Jan + 1 month clamps to 28 Feb, and the clamp is permanent — the next hop is
      // 28 Mar, never 31 Mar.
      [3, '2026-01-31T05:00:00.000Z', '2026-02-28T05:00:00.000Z'],
      [3, '2026-02-28T05:00:00.000Z', '2026-03-28T05:00:00.000Z'],
      // 31 May + 1 month = 30 Jun.
      [3, '2026-05-31T05:00:00.000Z', '2026-06-30T05:00:00.000Z'],
      // 29 Feb + 1 year = 28 Feb; the leap day is lost for good.
      [4, '2024-02-29T05:00:00.000Z', '2025-02-28T05:00:00.000Z'],
      // 31 Jan 2024 + 1 month = 29 Feb 2024 (leap year).
      [3, '2024-01-31T05:00:00.000Z', '2024-02-29T05:00:00.000Z'],
    ])('repeat %i: %s -> %s (python-dateutil semantics)', async (repeat, from, expected) => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ repeat, run_date: new Date(from) })]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      expect(runDate.toISOString()).toBe(expected);
    });

    /**
     * ⚠️ **Condition C76 — the cells that tell UTC-space arithmetic from Bogota-local.**
     *
     * Every other clone cell in this file, in `test/scheduler-runner.e2e-spec.ts` and in
     * every parity ME cell uses `05:00Z`, which is midnight in Bogota: the UTC calendar date
     * and the Bogota calendar date **agree**, so none of them can distinguish the two
     * implementations. v1 adds `relativedelta` to the `datetime` Django hands it, which under
     * `USE_TZ = True` is in **UTC**, and `relativedelta.__radd__` calls `other.replace(...)`
     * on those UTC fields — so v2 must read *and* rewrite the UTC fields, never Bogota's.
     *
     * ## ⚠️ There are **two** wrong implementations, and one cell catches only one of them
     *
     * This was measured, not reasoned: the cell C76 suggested was written first, on its own,
     * and a `fromDateColumn` → `toBogotaDate` mutant **passed it**. The two failure modes
     * are separable, and each needs its own cell.
     *
     * | mutant | what changes | differs from v1 when |
     * |---|---|---|
     * | **read-local** — `toBogotaDate(instant)` for the date, UTC time reattached | the day the delta starts from | the source UTC day ≠ the source Bogota day *and* no clamp collapses the two — i.e. DAILY / WEEKLY / YEARLY, and MONTHLY into a 31-day month |
     * | **round-trip-local** — convert to Bogota, add, convert back | the wall time the result is pinned to | a clamp binds, so the local day and the UTC day land in different months |
     *
     * A month-end MONTHLY hop into February — C76's suggestion — is exactly the case where
     * `min(28, 31)` and `min(28, 30)` are **both 28**, so read-local survives it. The DAILY
     * and YEARLY cells below are the ones that do not.
     */
    it('adds a DAILY delta from the UTC day, not the Bogota day (C76: read-local)', async () => {
      // 2026-01-31 in UTC, 2026-01-30 in Bogota. +1 day is 1 Feb in UTC space and would be
      // 31 Jan if the day were read locally — a whole month apart in the rendered date.
      tasks.findDueUnprocessed.mockResolvedValue([
        task({ repeat: 1, run_date: new Date('2026-01-31T01:00:00.000Z') }),
      ]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      expect(runDate.toISOString()).toBe('2026-02-01T01:00:00.000Z');
      expect(runDate.toISOString()).not.toBe('2026-01-31T01:00:00.000Z');
    });

    it('advances a YEARLY task from the UTC day (C76: read-local)', async () => {
      // The real birthday chains are `repeat = 4`, so this is the shape that matters. UTC
      // 31 Jan + 1 year is 31 Jan; read locally it would be 30 Jan, and a member would be
      // greeted a day early every year, for ever.
      tasks.findDueUnprocessed.mockResolvedValue([
        task({ repeat: 4, run_date: new Date('2026-01-31T01:00:00.000Z') }),
      ]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      expect(runDate.toISOString()).toBe('2027-01-31T01:00:00.000Z');
      expect(runDate.toISOString()).not.toBe('2027-01-30T01:00:00.000Z');
    });

    /**
     * C76's own suggested cell — the **round-trip-local** discriminator.
     *
     * | space | day | clamp | result |
     * |---|---|---|---|
     * | UTC (v1, and what this asserts) | 31 Jan | Feb has 28 days → 28 | `2026-02-28T01:00:00.000Z` |
     * | round-trip-local | 30 Jan 20:00 | → 28 Feb 20:00 local | `2026-03-01T01:00:00.000Z` |
     *
     * **One day apart**, and in different months.
     */
    it('clamps into UTC space, not Bogota-local (C76: round-trip-local)', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([
        task({ repeat: 3, run_date: new Date('2026-01-31T01:00:00.000Z') }),
      ]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      expect(runDate.toISOString()).toBe('2026-02-28T01:00:00.000Z');
      expect(runDate.toISOString()).not.toBe('2026-03-01T01:00:00.000Z');
    });

    /** The leap-day chain, on the same trap and the same axis. */
    it('loses the leap day in UTC space (C76: round-trip-local)', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([
        task({ repeat: 4, run_date: new Date('2024-02-29T01:00:00.000Z') }),
      ]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      expect(runDate.toISOString()).toBe('2025-02-28T01:00:00.000Z');
      expect(runDate.toISOString()).not.toBe('2025-03-01T01:00:00.000Z');
    });

    it('preserves the time of day, so a local-midnight task stays at local midnight', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([
        task({ repeat: 4, run_date: new Date('2026-08-25T05:00:00.000Z') }),
      ]);

      await runner.run(LATE_EVENING_UTC);

      const [, runDate] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask, Date];
      // 05:00Z is 00:00 America/Bogota, and it must still be after the year hop.
      expect(runDate.toISOString()).toBe('2027-08-25T05:00:00.000Z');
    });

    it('hands the clone the source row’s stored payload text, not a re-encode', async () => {
      const source = task({ repeat: 4 });
      tasks.findDueUnprocessed.mockResolvedValue([source]);

      await runner.run(LATE_EVENING_UTC);

      const [cloned] = tasks.createRepeatInstance.mock.calls[0] as [DueSchedulerTask];
      expect(cloned.payloadText).toBe(source.payloadText);
      expect(cloned.type).toBe(source.type);
      expect(cloned.repeat).toBe(source.repeat);
    });

    /**
     * ⚠️ **P7-D3.** v1's four `if`s are not `elif`s and have no `else`, so an out-of-range
     * `repeat` leaves `run_date` untouched and clones the task **onto its own date**. In v1
     * that twin runs once more (the same day's second pass) and is then past its exact
     * calendar-day filter for good; under **D7**'s `<=` it would be due on every pass from
     * then on. v2 refuses to write it.
     */
    it('refuses to clone a repeat value outside 0–4 (P7-D3)', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ repeat: 7 })]);

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ processed: 1, errored: 1, cloned: 0 });
    });

    it('does not release the claim when only the clone failed', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ repeat: 7 })]);

      await runner.run(LATE_EVENING_UTC);

      // v1 reaches `task.save()` before `create_repeat_instance`, and each statement
      // autocommits, so a clone failure leaves the source row processed.
      expect(tasks.release).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The two info lines v1 emits
  // -------------------------------------------------------------------------

  describe('logging', () => {
    it('logs "Running scheduler" and the task count, as v1 does', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ id: 1 }), task({ id: 2 })]);

      await runner.run(LATE_EVENING_UTC);

      expect(calls(logged.log).map((call) => call[0])).toEqual([
        'Running scheduler',
        '2 tasks to process',
      ]);
    });

    it('logs a zero count rather than skipping the line', async () => {
      const summary = await runner.run(LATE_EVENING_UTC);

      expect(calls(logged.log).map((call) => call[0])).toEqual([
        'Running scheduler',
        '0 tasks to process',
      ]);
      expect(summary.loaded).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // C68 — the pass summary reaches a log, and a dead pass is distinguishable
  // -------------------------------------------------------------------------

  /**
   * ⚠️ **Condition C68.** `handleCron` used to discard `run()`'s return value, so the
   * `failedDelivery` count was computed and thrown away and a whole-pass failure went to
   * `@nestjs/schedule`'s default `console.error` with no `Logger` line at all. The operator
   * check the phase wrote for itself — `grep -c 'Running scheduler'` — returned **2**
   * whether the pass processed 110 rows or died on the next statement.
   *
   * This is the detection story **Phase 6's D12 inherits**: a CAP that silently stops
   * closing is caught the same way a reminder that silently stops sending is.
   */
  describe('the pass summary (C68)', () => {
    it('logs one summary line naming every counter, after a completed pass', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([
        task({ id: 1, repeat: 4 }),
        task({ id: 2, repeat: 0 }),
      ]);

      await runner.handleCron();

      const lines = calls(logged.log).map((call) => call[0]);
      expect(lines).toEqual([
        'Running scheduler',
        '2 tasks to process',
        'Scheduler pass finished: loaded=2 processed=2 failedDelivery=0 skippedClaimed=0 ' +
          'errored=0 cloned=1',
      ]);
    });

    it('carries the failedDelivery count that used to be thrown away', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ id: 1 })]);
      executer.run.mockResolvedValue({ ok: false, detail: 'failed' });

      await runner.handleCron();

      expect(calls(logged.log).map((call) => call[0])).toContain(
        'Scheduler pass finished: loaded=1 processed=1 failedDelivery=1 skippedClaimed=0 ' +
          'errored=0 cloned=0',
      );
    });

    /**
     * The half that matters most: a pass that dies **outside** the per-task `try` used to
     * leave no `Logger` line whatsoever, so the two states — 110 rows processed and nothing
     * at all — printed the same two lines.
     */
    it('logs a distinct line when the pass itself dies, instead of nothing', async () => {
      tasks.findDueUnprocessed.mockRejectedValue(new Error('connection terminated'));

      await expect(runner.handleCron()).resolves.toBeUndefined();

      expect(calls(logged.error).map((call) => call[0])).toEqual([
        'Scheduler pass failed: connection terminated',
      ]);
      // ⚠️ The discriminator: `Running scheduler` alone is present in BOTH cases, which is
      // exactly why the runbook's old grep could not tell them apart.
      const lines = calls(logged.log).map((call) => call[0]);
      expect(lines).toEqual(['Running scheduler']);
      expect(lines.some((line) => line.startsWith('Scheduler pass finished'))).toBe(false);
    });

    it('does not log a summary when this process is not the scheduler', async () => {
      config.schedulerEnabled = false;

      await runner.handleCron();

      expect(calls(logged.log)).toHaveLength(0);
      expect(calls(logged.error)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // C77 (iii) — a throwing close executer leaves the row unprocessed and clones nothing
  // -------------------------------------------------------------------------

  /**
   * ⚠️ **Condition C77, gate obligation (iii)** — for Phase 6's **D12**.
   *
   * The whole "must `throw`, never `ok: false`" rule rests on one mechanical fact about this
   * runner: the `catch` releases the claim and **rethrows before `createRepeatInstance`**. So
   * a throwing executer leaves its row unprocessed *and* writes no successor.
   *
   * ⚠️ **This cell does NOT catch someone later "fixing" the runner to clone before it runs,
   * and an earlier version of this docblock claimed it did.** On a `repeat = 0` task the claim
   * is vacuous: `createRepeatInstance` returns early on `SchedulerRepeat.NONE`, so "writes no
   * successor" is true under *either* ordering. Measured — a runner mutated to clone before
   * running **passes the entire 98-cell e2e suite** and fails only two unit cells, neither of
   * them this one. The cell that catches it is
   * *"would end a chain if the close task ever carried a non-zero repeat"* below; the false
   * claim is recorded in `MIGRATION_PLAN.md`'s **C77** row and it was my wording, relayed from
   * the review into the developer's brief and into this file.
   *
   * It is written against a **`type = 1`** task on purpose: that is D12's shape, and the
   * `repeat: 0` on it is the second half of the reason a throw is cheap here.
   */
  describe('a throwing D12 close executer (C77 iii)', () => {
    const closeTask = (): DueSchedulerTask =>
      task({
        id: 501,
        type: 1,
        repeat: 0,
        payload: { type: 'saving_account_close', saving_account_id: '3' },
        payloadText: '"type"=>"saving_account_close", "saving_account_id"=>"3"',
      });

    beforeEach(() => {
      tasks.findDueUnprocessed.mockResolvedValue([closeTask()]);
      executer.run.mockRejectedValue(new Error('deadlock detected'));
    });

    it('releases the claim, so the row is unprocessed again for the next pass', async () => {
      await runner.run(LATE_EVENING_UTC);

      expect(tasks.claim).toHaveBeenCalledWith(501);
      expect(tasks.release).toHaveBeenCalledWith(501);
    });

    it('writes NO clone — the release-and-rethrow sits before createRepeatInstance', async () => {
      const summary = await runner.run(LATE_EVENING_UTC);

      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ processed: 0, errored: 1, cloned: 0 });
    });

    /**
     * The same task with a **non-zero** `repeat` would be the failure C77 is about: it throws
     * on every pass and therefore never clones its successor, ending the chain. Asserted here
     * so the consequence is visible next to the rule rather than only in prose.
     *
     * ⚠️ **DO NOT DELETE — this is the only cell in the repository that catches a runner
     * "fixed" to clone before it runs.** Measured against exactly that mutant (`dist`-level, by
     * `manual-tester`, and again at the unit level): with the clone moved ahead of the executer,
     * the `repeat = 0` sibling above still passes and `createRepeatInstance` **is** called here,
     * so this assertion fails and nothing else does. It looks redundant beside the `repeat = 0`
     * cell precisely because the `repeat = 0` cell cannot fail — that is the trap, not a reason
     * to tidy. `test/saving-account.e2e-spec.ts` points here for the same reason.
     */
    it('would end a chain if the close task ever carried a non-zero repeat', async () => {
      tasks.findDueUnprocessed.mockResolvedValue([{ ...closeTask(), repeat: 4 }]);

      await runner.run(LATE_EVENING_UTC);

      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
    });

    /** Positive control: the same task succeeding is processed, and still clones nothing. */
    it('is processed and still clones nothing when the close succeeds', async () => {
      executer.run.mockResolvedValue({ ok: true, detail: 'closed' });

      const summary = await runner.run(LATE_EVENING_UTC);

      expect(tasks.release).not.toHaveBeenCalled();
      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ processed: 1, errored: 0, cloned: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // C69 — a failed release must not destroy the executer's error
  // -------------------------------------------------------------------------

  /**
   * ⚠️ **Condition C69.** The error path was `await this.tasks.release(id); throw error;` —
   * so if `release()` rejected, the `throw` was unreachable, the executer's error was
   * destroyed and replaced by a database error, and the row stayed `processed` with nothing
   * done. Both facts have to survive.
   */
  describe('when releasing the claim fails (C69)', () => {
    beforeEach(() => {
      tasks.findDueUnprocessed.mockResolvedValue([task({ id: 77 })]);
      executer.run.mockRejectedValue(new Error('SQS credentials rejected'));
      tasks.release.mockRejectedValue(new Error('connection terminated'));
    });

    it('still logs v1’s error line for the executer’s own failure', async () => {
      await runner.run(LATE_EVENING_UTC);

      expect(calls(logged.error).map((call) => call[0])).toContain(
        'Error processing task with id: 77, exception: SQS credentials rejected',
      );
    });

    it('logs the stuck claim separately, naming the row and the repair statement', async () => {
      await runner.run(LATE_EVENING_UTC);

      const stuck = calls(logged.error)
        .map((call) => call[0])
        .filter((line) => line.startsWith('Failed to release the claim'));
      expect(stuck).toHaveLength(1);
      expect(stuck[0]).toContain('task 77');
      expect(stuck[0]).toContain(
        'UPDATE fondo_api_schedulertask SET processed = false WHERE id = 77',
      );
      expect(stuck[0]).toContain('connection terminated');
    });

    it('counts the row as errored and writes no clone', async () => {
      const summary = await runner.run(LATE_EVENING_UTC);

      expect(summary).toMatchObject({ processed: 0, errored: 1, cloned: 0 });
      expect(tasks.createRepeatInstance).not.toHaveBeenCalled();
    });

    /** Positive control: with a working `release`, only v1's line is emitted. */
    it('emits only v1’s line when the release succeeds', async () => {
      tasks.release.mockResolvedValue(undefined);

      await runner.run(LATE_EVENING_UTC);

      expect(calls(logged.error).map((call) => call[0])).toEqual([
        'Error processing task with id: 77, exception: SQS credentials rejected',
      ]);
    });
  });
});

/** A spy's recorded arguments, typed — `mock.calls` is `any[][]` and the lint rule says so. */
function calls(spy: jest.SpyInstance): string[][] {
  return spy.mock.calls as string[][];
}

/** The runner's private `Logger`, reached the way a spy has to reach it. */
function runnerLogger(runner: SchedulerRunner): {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, stack?: string) => void;
} {
  return (runner as unknown as { logger: never }).logger;
}
