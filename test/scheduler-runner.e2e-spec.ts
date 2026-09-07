import { Test, type TestingModule } from '@nestjs/testing';
import { AppConfigService } from '../src/config/app-config.service';
import { AppConfigModule } from '../src/config/config.module';
import { NotificationModule } from '../src/notifications/notification.module';
import { NOTIFICATION_PUBLISH_RETRY } from '../src/notifications/notification-publisher';
import { NotificationPublisher } from '../src/notifications/notification-publisher';
import { SQS_CLIENT } from '../src/notifications/sqs.client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SchedulerRunnerModule } from '../src/scheduler/scheduler-runner.module';
import { SchedulerTaskRepository } from '../src/scheduler/scheduler-task.repository';
import { SchedulerRunner } from '../src/scheduler/scheduler.runner';
import { Role } from '../src/auth/permissions/roles';
import { resetDatabase, seedUser, type SeededUser } from './support/abstract-test';
import { REAL_APPLE_ROW, REAL_FCM_ROW } from './support/push-subscription.fixture';

/**
 * Phase **7b** e2e — the scheduler runner against a real database.
 *
 * ## Why this file exists at all
 *
 * ⚠️ **v1 has no scheduler test.** Not one: `fondo_api/tests/` contains no
 * `test_scheduler*.py` and `fondo_api/scheduler/` has no tests of its own. This is the
 * subsystem the plan calls *"the highest ratio of consequence to coverage in the migration"*
 * — the sole delivery path for loan payment reminders, raw-SQL `hstore` territory, and one
 * that **fails silently**. Every cell below is new, and the unit spec
 * (`src/scheduler/scheduler.runner.spec.ts`) covers the branching; this file covers the parts
 * a mock cannot: the SQL, the `hstore` round trip, the atomic claim under a real concurrent
 * update, and the exact bytes that reach SQS.
 *
 * ## The clock is fixed in every cell
 *
 * `run(now)` takes an injectable instant and every cell passes one, so "today" is never the
 * day CI happens to run on. The host zone is UTC (`test/global-setup.ts`), so a host-zone
 * read produces the wrong day here rather than the right one by coincidence (condition
 * **C28**).
 */
describe('Phase 7b — scheduler runner', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let runner: SchedulerRunner;
  let repository: SchedulerTaskRepository;
  let member: SeededUser;
  let other: SeededUser;
  const sqs = { send: jest.fn() };

  /** 2026-09-07 12:00 Bogota — the 10:00 pass of an ordinary Monday, near enough. */
  const TODAY = new Date('2026-09-07T17:00:00.000Z');

  /**
   * Inserts a task the way v1's `SchedulerTask.objects.create` does, through raw hstore.
   * `runDateIso` is a UTC instant; local midnight in Bogota is `T05:00:00Z`.
   */
  async function insertTask(options: {
    runDateIso: string;
    payload: string;
    type?: number;
    repeat?: number;
    processed?: boolean;
  }): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
      'INSERT INTO fondo_api_schedulertask (type, run_date, payload, processed, repeat) ' +
        'VALUES ($1, $2, $3::hstore, $4, $5) RETURNING id',
      options.type ?? 0,
      new Date(options.runDateIso),
      options.payload,
      options.processed ?? false,
      options.repeat ?? 0,
    );
    return rows[0].id;
  }

  function reminderPayload(ownerId: number, userId: number, dateText: string): string {
    return (
      `"type"=>"payment_reminder", "target"=>"/loan/${ownerId}", ` +
      `"message"=>"Recuerde que la fecha límite de pago para el crédito ${ownerId}, ` +
      `es el: ${dateText}", "owner_id"=>"${ownerId}", "user_ids"=>"[${userId}]"`
    );
  }

  async function allTasks(): Promise<
    {
      id: number;
      type: number;
      run_date: Date;
      repeat: number;
      processed: boolean;
      payload: string;
    }[]
  > {
    return prisma.$queryRawUnsafe(
      'SELECT id, type, run_date, repeat, processed, payload::text AS payload ' +
        'FROM fondo_api_schedulertask ORDER BY id',
    );
  }

  function sentBodies(): string[] {
    const calls = sqs.send.mock.calls as [{ input: { MessageBody: string } }][];
    return calls.map((call) => call[0].input.MessageBody);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, NotificationModule, SchedulerRunnerModule],
    })
      // v1's tests patch `boto3.client`; this is the same seam. ⚠️ Nothing in this suite may
      // reach a real SQS queue — the runner *executes* tasks, so an unstubbed client would
      // publish for real.
      .overrideProvider(SQS_CLIENT)
      .useValue(sqs)
      .overrideProvider(NOTIFICATION_PUBLISH_RETRY)
      .useValue({ attempts: 3, baseDelayMs: 0 })
      .compile();

    prisma = moduleRef.get(PrismaService);
    runner = moduleRef.get(SchedulerRunner);
    repository = moduleRef.get(SchedulerTaskRepository);

    // Silence the two loggers whose messages these cells assert on individually.
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(runner['logger'], method).mockImplementation(() => undefined);
    }
    jest
      .spyOn(moduleRef.get(NotificationPublisher)['logger'], 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn(moduleRef.get(NotificationPublisher)['logger'], 'log')
      .mockImplementation(() => undefined);

    await resetDatabase(prisma);
    member = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    other = await seedUser(prisma, {
      email: 'other@mail.com',
      identification: 1001n,
      role: Role.MEMBER,
    });
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await moduleRef.close();
  });

  beforeEach(async () => {
    sqs.send.mockReset();
    sqs.send.mockResolvedValue({ MessageId: 'msg-1' });
    await prisma.$executeRawUnsafe('TRUNCATE TABLE fondo_api_schedulertask RESTART IDENTITY');
    await prisma.$executeRawUnsafe('DELETE FROM fondo_api_notificationsubscriptions');
  });

  // -------------------------------------------------------------------------
  // The query: which rows a pass picks up
  // -------------------------------------------------------------------------

  describe('findDueUnprocessed', () => {
    it('picks up today’s unprocessed tasks and leaves tomorrow’s alone', async () => {
      const today = await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });
      await insertTask({
        runDateIso: '2026-09-08T05:00:00.000Z',
        payload: reminderPayload(2, member.id, '13 sep. 2026'),
      });

      const due = await repository.findDueUnprocessed({ year: 2026, month: 9, day: 7 });

      expect(due.map((task) => task.id)).toEqual([today]);
    });

    it('ignores a task that is already processed', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        processed: true,
      });

      await expect(
        repository.findDueUnprocessed({ year: 2026, month: 9, day: 7 }),
      ).resolves.toEqual([]);
    });

    /**
     * ⚠️ **D7** (operator answer Q8). v1 matches the calendar day *exactly*, so a reminder
     * whose `run_date` has passed is never sent — the T−5d loan reminder is skipped outright
     * whenever the monthly payment file lands within five days of the deadline. v2 sends it
     * on the next pass. **This cell is the whole of D7.**
     */
    it('D7 — includes a past-due task, which v1 would have skipped forever', async () => {
      const stale = await insertTask({
        runDateIso: '2026-09-02T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '07 sep. 2026'),
      });

      const due = await repository.findDueUnprocessed({ year: 2026, month: 9, day: 7 });

      expect(due.map((task) => task.id)).toEqual([stale]);
    });

    /**
     * ⚠️ **The timezone trap the plan flags twice.** `run_date` for a task scheduled at local
     * midnight is stored as `05:00Z`; for one scheduled at 20:00 local it is `01:00Z` the
     * *next* UTC day. Extracting in UTC would put that second row on the 8th and the pass on
     * the 7th would miss it — a task silently skipped, then double-run when the clone lands.
     */
    it('extracts run_date’s calendar day in America/Bogota, not UTC', async () => {
      // 2026-09-07 20:00 Bogota == 2026-09-08 01:00 UTC.
      const evening = await insertTask({
        runDateIso: '2026-09-08T01:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });

      const due = await repository.findDueUnprocessed({ year: 2026, month: 9, day: 7 });

      expect(due.map((task) => task.id)).toEqual([evening]);
    });

    it('parses the hstore payload into a map of strings', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload:
          '"type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años X", ' +
          '"owner_id"=>"5", "user_ids"=>"[2, 3]"',
        repeat: 4,
      });

      const [task] = await repository.findDueUnprocessed({ year: 2026, month: 9, day: 7 });

      expect(task.payload).toEqual({
        type: 'birthdate',
        target: '/',
        message: 'Hoy está cumpliendo años X',
        owner_id: '5',
        user_ids: '[2, 3]',
      });
      expect(task.repeat).toBe(4);
      expect(task.run_date.toISOString()).toBe('2026-09-07T05:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // A full pass
  // -------------------------------------------------------------------------

  describe('a full pass', () => {
    it('publishes the notification, marks the row processed and writes no clone', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      const id = await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(412, member.id, '12 sep. 2026'),
      });

      const summary = await runner.run(TODAY);

      expect(summary).toEqual({
        loaded: 1,
        processed: 1,
        failedDelivery: 0,
        skippedClaimed: 0,
        errored: 0,
        cloned: 0,
      });
      expect(sqs.send).toHaveBeenCalledTimes(1);
      const rows = await allTasks();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, processed: true });
    });

    /**
     * The SQS body must be **byte-identical** to v1's (plan §4 rule 5d): CPython's
     * `json.dumps` uses `', '`/`': '` separators and escapes non-ASCII, and every message
     * this fund sends is accented Spanish.
     */
    it('publishes the exact bytes v1 publishes', async () => {
      await insertRawSubscription(prisma, member.id, REAL_APPLE_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload:
          '"type"=>"payment_reminder", "target"=>"/loan/412", ' +
          '"message"=>"Recuerde que la fecha límite de pago para el crédito 412, ' +
          'es el: 12 sep. 2026", "owner_id"=>"412", ' +
          `"user_ids"=>"[${member.id}]"`,
      });

      await runner.run(TODAY);

      const [body] = sentBodies();
      // `é` and `í` escaped, spaces after every separator — CPython, not JSON.stringify.
      expect(body).toContain(
        '"message": {"body": "Recuerde que la fecha l\\u00edmite de pago para el ' +
          'cr\\u00e9dito 412, es el: 12 sep. 2026", "target": "/loan/412"}',
      );
      expect(body.startsWith('{"subscriptions": [{"keys": {"p256dh": ')).toBe(true);
    });

    it('resolves user_ids to every subscribed device of every listed member', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertRawSubscription(prisma, other.id, REAL_APPLE_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload:
          '"type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años X", ' +
          `"owner_id"=>"5", "user_ids"=>"[${member.id}, ${other.id}]"`,
      });

      await runner.run(TODAY);

      const [body] = sentBodies();
      const parsed = JSON.parse(body) as { subscriptions: unknown[] };
      expect(parsed.subscriptions).toHaveLength(2);
    });

    /**
     * ⚠️ Plan Phase 2, condition 4 / operator answer Q7: push only, no email fallback. A
     * member who never granted browser notifications receives **nothing**, and v1 still marks
     * the task processed. Ported knowingly.
     */
    it('marks a task processed even when the member has no devices', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(412, member.id, '12 sep. 2026'),
      });

      const summary = await runner.run(TODAY);

      expect(sqs.send).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ processed: 1, failedDelivery: 0 });
      expect((await allTasks())[0].processed).toBe(true);
    });

    it('processes several tasks in one pass', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });
      await insertTask({
        runDateIso: '2026-09-06T05:00:00.000Z',
        payload: reminderPayload(2, member.id, '11 sep. 2026'),
      });

      const summary = await runner.run(TODAY);

      expect(summary.loaded).toBe(2);
      expect(summary.processed).toBe(2);
      expect(sqs.send).toHaveBeenCalledTimes(2);
      expect((await allTasks()).every((row) => row.processed)).toBe(true);
    });

    it('a second pass on the same day finds nothing left to do', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });

      await runner.run(TODAY);
      // The 14:00 pass, four hours after the 10:00 one.
      const second = await runner.run(new Date('2026-09-07T19:00:00.000Z'));

      expect(second).toMatchObject({ loaded: 0, processed: 0 });
      expect(sqs.send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // create_repeat_instance, against the real column
  // -------------------------------------------------------------------------

  describe('create_repeat_instance', () => {
    it('clones a YEARLY birthday task forward one year, payload byte-identical', async () => {
      const payload =
        '"type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años N@CHO ' +
        'Montañez Herrera", "owner_id"=>"5", "user_ids"=>"[2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8]"';
      const id = await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload,
        repeat: 4,
      });

      const summary = await runner.run(TODAY);

      expect(summary.cloned).toBe(1);
      const rows = await allTasks();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id, processed: true, repeat: 4 });
      expect(rows[1]).toMatchObject({ type: 0, processed: false, repeat: 4 });
      expect(rows[1].run_date.toISOString()).toBe('2027-09-07T05:00:00.000Z');
      // Cloned verbatim — hstore's stored rendering, not a re-encode.
      expect(rows[1].payload).toBe(rows[0].payload);
      expect(rows[1].payload).toBe(payload);
    });

    it.each([
      [1, '2026-09-08T05:00:00.000Z'],
      [2, '2026-09-14T05:00:00.000Z'],
      [3, '2026-10-07T05:00:00.000Z'],
      [4, '2027-09-07T05:00:00.000Z'],
    ])('repeat = %i clones to %s', async (repeat, expected) => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        repeat,
      });

      await runner.run(TODAY);

      const rows = await allTasks();
      expect(rows).toHaveLength(2);
      expect(rows[1].run_date.toISOString()).toBe(expected);
    });

    /**
     * The `relativedelta` month-end rule, through the real column: a MONTHLY chain starting
     * on the 31st clamps to the shortest month and **never recovers**. Pinned against
     * `python-dateutil==2.7.5` in Phase 0 (condition C3); this is the same value surviving a
     * `timestamptz` round trip.
     */
    it('clamps a MONTHLY 31st to the 28th, permanently', async () => {
      await insertTask({
        runDateIso: '2026-01-31T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '31 ene. 2026'),
        repeat: 3,
      });

      // First pass on a day well past 31 Jan — D7 makes the overdue row eligible.
      await runner.run(new Date('2026-02-07T17:00:00.000Z'));
      const afterFirst = await allTasks();
      expect(afterFirst[1].run_date.toISOString()).toBe('2026-02-28T05:00:00.000Z');

      // Second pass: the clamped date is the new input, so the chain stays on the 28th.
      await runner.run(new Date('2026-03-07T17:00:00.000Z'));
      const afterSecond = await allTasks();
      expect(afterSecond[2].run_date.toISOString()).toBe('2026-03-28T05:00:00.000Z');
    });

    it('does not clone a repeat = NONE task', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        repeat: 0,
      });

      await runner.run(TODAY);

      expect(await allTasks()).toHaveLength(1);
    });

    /**
     * ⚠️ **P7-D3.** v1's four `if`s are not `elif`s and there is no `else`, so an
     * out-of-range `repeat` clones the task **onto its own `run_date`**. v1 does that twice —
     * the day's second pass processes the twin and clones again — and then its exact
     * calendar-day filter stops selecting it; it is **D7's `<=` here** that would make such a
     * twin due on every pass, forever. No such row exists in `fondodev`, but the
     * column has no check constraint, so the state is reachable. v2 refuses and logs.
     */
    it('P7-D3 — refuses an out-of-range repeat instead of cloning onto the same date', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        repeat: 7,
      });

      const summary = await runner.run(TODAY);

      expect(await allTasks()).toHaveLength(1);
      expect(summary).toMatchObject({ processed: 1, errored: 1, cloned: 0 });
      // The row stays processed: v1's `task.save()` autocommits before the clone is attempted.
      expect((await allTasks())[0].processed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The atomic claim — the multi-instance answer, against a real UPDATE
  // -------------------------------------------------------------------------

  describe('the atomic claim', () => {
    it('claim() wins once and loses every time after', async () => {
      const id = await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });

      await expect(repository.claim(id)).resolves.toBe(true);
      await expect(repository.claim(id)).resolves.toBe(false);
    });

    it('claim() loses to a row another process already marked processed', async () => {
      const id = await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });
      // Stand-in for the second runner: the row changes under us between read and claim.
      await prisma.$executeRawUnsafe(
        'UPDATE fondo_api_schedulertask SET processed = true WHERE id = $1',
        id,
      );

      await expect(repository.claim(id)).resolves.toBe(false);
    });

    /**
     * ⚠️ The failure mode the whole design is against: **two runners, one task, one push and
     * one clone** — not two of each.
     *
     * The window is the gap between a runner's read and its claim, and it is *forced* here
     * rather than raced for: both passes are handed the same snapshot, which is exactly the
     * state two processes are in when their 10:00 ticks land within a few milliseconds of
     * each other. Left to `Promise.all` alone the two reads serialise on the connection pool
     * and the second one loads nothing — a green cell that proves the pool's timing, not the
     * claim (rule C67: what would this print if the claim were missing?).
     */
    it('two runners that both loaded the same row produce one publish and one clone', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        repeat: 4,
      });
      const snapshot = await repository.findDueUnprocessed({ year: 2026, month: 9, day: 7 });
      expect(snapshot).toHaveLength(1);
      const read = jest
        .spyOn(repository, 'findDueUnprocessed')
        .mockResolvedValue(snapshot.map((task) => ({ ...task })));

      let first, second;
      try {
        [first, second] = await Promise.all([runner.run(TODAY), runner.run(TODAY)]);
      } finally {
        read.mockRestore();
      }

      expect([first.loaded, second.loaded]).toEqual([1, 1]);
      expect(first.processed + second.processed).toBe(1);
      expect(first.skippedClaimed + second.skippedClaimed).toBe(1);
      expect(first.cloned + second.cloned).toBe(1);
      expect(sqs.send).toHaveBeenCalledTimes(1);
      // The original, now processed, plus exactly one clone.
      expect(await allTasks()).toHaveLength(2);
    });

    /** Positive control: one runner on the same fixture is a plain success, not a skip. */
    it('a single runner on the same fixture skips nothing', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        repeat: 4,
      });

      const summary = await runner.run(TODAY);

      expect(summary).toMatchObject({ processed: 1, skippedClaimed: 0, cloned: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------

  describe('when a task cannot be executed', () => {
    it('leaves a malformed payload unprocessed, so the next pass retries it', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        // No `user_ids` — v1's `payload["user_ids"]` raises KeyError inside `run`.
        payload:
          '"type"=>"payment_reminder", "target"=>"/loan/1", "message"=>"x", ' + '"owner_id"=>"1"',
      });

      const summary = await runner.run(TODAY);

      expect(summary).toMatchObject({ processed: 0, errored: 1 });
      // ⚠️ The claim was released. v1 never reaches `task.save()` on this path.
      expect((await allTasks())[0].processed).toBe(false);
    });

    it('leaves an unknown task type unprocessed and never claims it', async () => {
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        type: 3,
      });

      const summary = await runner.run(TODAY);

      expect(summary).toMatchObject({ processed: 0, errored: 1 });
      expect((await allTasks())[0].processed).toBe(false);
    });

    /**
     * ⚠️ **The phase's headline decision.** v1 swallows the SQS error, marks the row
     * processed, and the reminder is lost while the database records it as sent. v2 keeps
     * the row state — operator answer Q6, and the alternative retries a configuration error
     * twice a day forever without ever cloning the `repeat` successor — and drops only the
     * silence, by counting it. See `docs/phase-7b-deviations.md` §3.
     */
    it('still marks a task processed when SQS rejected every attempt, but counts it', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
        repeat: 4,
      });
      sqs.send.mockRejectedValue(new Error('SQS is down'));

      const summary = await runner.run(TODAY);

      expect(sqs.send).toHaveBeenCalledTimes(3); // bounded retry, Phase 2 condition 1
      expect(summary).toMatchObject({ processed: 1, failedDelivery: 1, errored: 0, cloned: 1 });
      expect((await allTasks())[0].processed).toBe(true);
    });

    it('one broken task does not stop the rest of the pass', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: '"type"=>"payment_reminder", "owner_id"=>"1"',
      });
      const good = await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(2, member.id, '12 sep. 2026'),
      });

      const summary = await runner.run(TODAY);

      expect(summary).toMatchObject({ loaded: 2, processed: 1, errored: 1 });
      const rows = await allTasks();
      expect(rows.find((row) => row.id === good)?.processed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The cron and its guard, on the real container
  // -------------------------------------------------------------------------

  describe('the cron guard', () => {
    it('handleCron does nothing when SCHEDULER_ENABLED is not set on this process', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });

      // The test environment never sets it, which is exactly the point: no suite in this
      // repository can publish a payment reminder by ticking the clock.
      expect(moduleRef.get(AppConfigService).schedulerEnabled).toBe(false);
      await runner.handleCron();

      expect(sqs.send).not.toHaveBeenCalled();
      expect((await allTasks())[0].processed).toBe(false);
    });

    /** Positive control: the same tick does the work when the flag is on. */
    it('handleCron runs the pass when SCHEDULER_ENABLED is set', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertTask({
        runDateIso: '2026-09-07T05:00:00.000Z',
        payload: reminderPayload(1, member.id, '12 sep. 2026'),
      });
      const config = moduleRef.get(AppConfigService);
      const enabled = jest.spyOn(config, 'schedulerEnabled', 'get').mockReturnValue(true);

      try {
        await runner.handleCron();
      } finally {
        enabled.mockRestore();
      }

      expect(sqs.send).toHaveBeenCalledTimes(1);
      expect((await allTasks())[0].processed).toBe(true);
    });
  });
});

/** Same helper as `test/notification.e2e-spec.ts`: a v1-shaped hstore subscription row. */
async function insertRawSubscription(
  prisma: PrismaService,
  userId: number,
  hstoreText: string,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    'INSERT INTO fondo_api_notificationsubscriptions (user_id, subscription) ' +
      'VALUES ($1, $2::hstore) RETURNING id',
    userId,
    hstoreText,
  );
  return rows[0].id;
}
