import type { AppConfigService } from '../config/app-config.service';
import { BOGOTA_TIME_ZONE } from '../common/utils/timezone.util';
import type { ExecuterFactory } from './executers/executer.factory';
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
     * `repeat` leaves `run_date` untouched and clones the task **onto its own date** — an
     * unprocessed twin that does it again on the next pass, forever. v2 refuses.
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
