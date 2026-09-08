import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationPublisher } from '../src/notifications/notification-publisher';
import { SavingAccountService } from '../src/saving-accounts/saving-account.service';
import { SchedulerRunner } from '../src/scheduler/scheduler.runner';
import { ExecuterFactory } from '../src/scheduler/executers/executer.factory';
import { SavingAccountCloseExecuter } from '../src/scheduler/executers/saving-account-close.executer';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedSavingAccount,
  seedUser,
  type SeededUser,
} from './support/abstract-test';
import { rawRequestFor } from './support/raw-request';

/**
 * Phase 6 e2e — `GET|POST|PUT /api/saving-account`, plus **D12**'s auto-close, DB-backed and
 * through the whole `AppModule` pipeline.
 *
 * ## ⚠️ There is no v1 suite to port
 *
 * `fondo_api/tests/` contains **no `test_saving_account_views.py`** — this is the only module
 * in the migration with zero inherited coverage on both the service and the view. Every cell
 * below is written from three sources, named per cell:
 *
 *  1. the v1 source (`views/saving_account.py`, `services/saving_account.py`,
 *     `serializers.py:161-179`), for the port;
 *  2. the operator answers **Q19**–**Q24**, which *are* the specification here;
 *  3. **D12**'s own answers — **Q20**, **Q38**, **Q39** — for the auto-close, which v1 never
 *     built (`# TODO: schedule task for closing CAP`) and which therefore has no v1 behaviour
 *     to be parity-checked against.
 *
 * ## The cross-phase check
 *
 * `total_savingaccounts` is a **Phase 3** response field this phase's writes feed
 * (`UserFinanceSerializer.get_total_savingaccounts` sums `state = 0` rows). The block at the
 * end asserts it before and after each kind of CAP write, including D12's close — a CAP write
 * changing a Phase 3 response is this phase's cross-phase failure mode.
 */
describe('Phase 6 — /api/saving-account (no v1 suite exists; see the file header)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let president: SeededUser;
  let member: SeededUser;
  let adminToken: string;
  let treasurerToken: string;
  let presidentToken: string;
  let memberToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    // The create notification publishes to SQS. No queue is configured in the harness beyond
    // a fake URL, so the publisher fails and logs; silence it rather than assert on it here.
    jest
      .spyOn(app.get(NotificationPublisher)['logger'], 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(app.get(NotificationPublisher)['logger'], 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
      firstName: 'Admin',
      lastName: 'User',
    });
    president = await seedUser(prisma, {
      email: 'president@mail.com',
      identification: 1001n,
      role: Role.PRESIDENT,
      firstName: 'Presi',
      lastName: 'Dent',
    });
    await seedUser(prisma, {
      email: 'treasurer@mail.com',
      identification: 2002n,
      role: Role.TREASURER,
      firstName: 'Trea',
      lastName: 'Surer',
    });
    member = await seedUser(prisma, {
      email: 'member@mail.com',
      identification: 3003n,
      role: Role.MEMBER,
      firstName: 'Mem',
      lastName: 'Ber',
    });
    adminToken = await obtainToken(app, 'mail_for_tests@mail.com');
    presidentToken = await obtainToken(app, 'president@mail.com');
    treasurerToken = await obtainToken(app, 'treasurer@mail.com');
    memberToken = await obtainToken(app, 'member@mail.com');
  });

  const server = (): App => app.getHttpServer();
  const asAdmin = (): Record<string, string> => authHeader(adminToken);
  const asTreasurer = (): Record<string, string> => authHeader(treasurerToken);
  const asPresident = (): Record<string, string> => authHeader(presidentToken);
  const asMember = (): Record<string, string> => authHeader(memberToken);
  const raw = rawRequestFor(() => app.getHttpServer() as unknown as Server);

  /**
   * `SELECT count(*) FROM fondo_api_schedulertask`, raw.
   *
   * `SchedulerTask` is one of the two hstore tables and has no Prisma model (plan §2), so the
   * count has to be raw SQL rather than `prisma.schedulerTask.count()`.
   */
  const schedulerTaskCount = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*)::bigint AS count FROM fondo_api_schedulertask`;
    return Number(rows[0].count);
  };

  // ==========================================================================
  // POST — create_account
  // ==========================================================================
  describe('POST /api/saving-account', () => {
    /** ⚠️ **200, not 201**, on a call that creates a row. `LoanView.post` answers 201. */
    it('answers 200 with the new id — not 201', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);

      expect(response.body).toEqual({ id: expect.any(Number) as number });
      const row = await prisma.savingAccount.findUnique({
        where: { id: (response.body as { id: number }).id },
      });
      expect(row).toMatchObject({ state: 0, value: 0n, user_id: admin.id });
      expect(row?.end_date.toISOString()).toBe('2027-02-28T00:00:00.000Z');
    });

    /** `GET`/`POST` are `role <= 3`, so every role may open a CAP for themselves. */
    it.each([
      ['ADMIN', (): Record<string, string> => asAdmin()],
      ['PRESIDENT', (): Record<string, string> => asPresident()],
      ['TREASURER', (): Record<string, string> => asTreasurer()],
      ['MEMBER', (): Record<string, string> => asMember()],
    ])('lets a %s create one', async (_role, header) => {
      await request(server())
        .post('/api/saving-account')
        .set(header())
        .send({ end_date: '2027-02-28' })
        .expect(200);
    });

    it('always creates it for the caller, whatever user_id the body carries', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asMember())
        .send({ end_date: '2027-02-28', user_id: admin.id, value: 999999 })
        .expect(200);

      const row = await prisma.savingAccount.findUnique({
        where: { id: (response.body as { id: number }).id },
      });
      expect(row?.user_id).toBe(member.id);
      expect(row?.value).toBe(0n);
    });

    /** `obj['end_date']` is a bare subscript: `KeyError` → **500**, and nothing is written. */
    it('answers 500 for a body with no end_date, and writes no row', async () => {
      await request(server()).post('/api/saving-account').set(asAdmin()).send({}).expect(500);

      expect(await prisma.savingAccount.count()).toBe(0);
      expect(await schedulerTaskCount()).toBe(0);
    });

    it.each(['not-a-date', '2027-13-01', '28/02/2027'])(
      'answers 500 for an unparseable end_date %p',
      async (value) => {
        await request(server())
          .post('/api/saving-account')
          .set(asAdmin())
          .send({ end_date: value })
          .expect(500);
        expect(await prisma.savingAccount.count()).toBe(0);
      },
    );

    it('accepts a single-digit month and day, as Django’s DateField does', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-2-8' })
        .expect(200);

      const row = await prisma.savingAccount.findUnique({
        where: { id: (response.body as { id: number }).id },
      });
      expect(row?.end_date.toISOString()).toBe('2027-02-08T00:00:00.000Z');
    });

    it('answers 401 without a token', async () => {
      await request(server())
        .post('/api/saving-account')
        .send({ end_date: '2027-02-28' })
        .expect(401);
    });
  });

  // ==========================================================================
  // D12 — the close task, read back out of the database
  // ==========================================================================
  describe('D12 — the close task the create writes', () => {
    /**
     * ⚠️ **Condition C77, gate obligations (i) and (ii)** — the assertion that the *inserted
     * row* carries `repeat = 0`. The unit cell pins the call; this one pins the column, which
     * is the thing the runner actually reads.
     */
    it('writes exactly one task, type 1, repeat 0, unprocessed (C77 i/ii)', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const accountId = (response.body as { id: number }).id;

      const rows = await prisma.$queryRaw<
        { id: number; type: number; run_date: Date; repeat: number; processed: boolean }[]
      >`SELECT id, type, run_date, repeat, processed FROM fondo_api_schedulertask`;

      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe(1);
      // The literal that condition C77 is about.
      expect(rows[0].repeat).toBe(0);
      expect(rows[0].processed).toBe(false);
      // 00:00 America/Bogota, the same shape Django wrote for every birthday row.
      expect(rows[0].run_date.toISOString()).toBe('2027-02-28T05:00:00.000Z');

      const payload = await prisma.$queryRaw<
        { payload: string }[]
      >`SELECT payload::text AS payload FROM fondo_api_schedulertask WHERE id = ${rows[0].id}`;
      expect(payload[0].payload).toContain('"saving_account_id"=>"' + String(accountId) + '"');
      expect(payload[0].payload).toContain('"type"=>"saving_account_close"');
    });

    it('carries no recipient list, message or target — a close notifies nobody (Q22)', async () => {
      await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);

      const rows = await prisma.$queryRaw<
        { payload: string }[]
      >`SELECT payload::text AS payload FROM fondo_api_schedulertask`;
      expect(rows[0].payload).not.toContain('user_ids');
      expect(rows[0].payload).not.toContain('message');
      expect(rows[0].payload).not.toContain('target');
      expect(rows[0].payload).not.toContain('owner_id');
    });

    it('writes a task even for an end_date already in the past', async () => {
      await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2024-02-28' })
        .expect(200);

      const rows = await prisma.$queryRaw<
        { run_date: Date }[]
      >`SELECT run_date FROM fondo_api_schedulertask`;
      expect(rows).toHaveLength(1);
      expect(rows[0].run_date.toISOString()).toBe('2024-02-28T05:00:00.000Z');
    });

    /** One CAP, one task — the close is not a sweep, so two CAPs are two rows. */
    it('writes one task per CAP', async () => {
      await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);

      expect(await schedulerTaskCount()).toBe(2);
    });
  });

  // ==========================================================================
  // D12 — the runner actually closes the CAP
  // ==========================================================================
  describe('D12 — the auto-close, driven through the real runner', () => {
    /** The whole path: create → the runner's pass on the due day → `state = 1`. */
    it('closes the CAP on its end_date and marks the task processed', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const accountId = (response.body as { id: number }).id;
      const runner = app.get(SchedulerRunner);
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

      // 2027-02-28 10:00 America/Bogota.
      const summary = await runner.run(new Date('2027-02-28T15:00:00.000Z'));

      expect(summary).toMatchObject({ loaded: 1, processed: 1, errored: 0, cloned: 0 });
      expect((await prisma.savingAccount.findUnique({ where: { id: accountId } }))?.state).toBe(1);
      const rows = await prisma.$queryRaw<
        { processed: boolean }[]
      >`SELECT processed FROM fondo_api_schedulertask`;
      expect(rows).toHaveLength(1);
      expect(rows[0].processed).toBe(true);
    });

    /** ⚠️ Not before. The runner's predicate is date-granularity `<=` today. */
    it('does not close it the day before its end_date', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const runner = app.get(SchedulerRunner);
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

      const summary = await runner.run(new Date('2027-02-27T15:00:00.000Z'));

      expect(summary.loaded).toBe(0);
      expect(
        (
          await prisma.savingAccount.findUnique({
            where: { id: (response.body as { id: number }).id },
          })
        )?.state,
      ).toBe(0);
    });

    /**
     * ⚠️ **Q39, and the reason it needs no code.** The 10:00 pass claims the row and marks it
     * `processed`, so the 14:00 pass's `processed = false` filter already excludes it. There
     * is no per-type pass scheduling anywhere, and none is needed.
     */
    it('is a no-op on the 14:00 pass, because the 10:00 pass claimed the row (Q39)', async () => {
      await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const runner = app.get(SchedulerRunner);
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

      await runner.run(new Date('2027-02-28T15:00:00.000Z')); // 10:00 Bogota
      const second = await runner.run(new Date('2027-02-28T19:00:00.000Z')); // 14:00 Bogota

      expect(second).toMatchObject({ loaded: 0, processed: 0 });
    });

    /**
     * ⚠️ **Condition C77, gate obligation (iii)**, end to end. A throwing close leaves the row
     * **unprocessed** and writes **no clone**, so the 14:00 pass retries it — which is the
     * retry path the "must throw" rule depends on.
     *
     * ⚠️ **What this cell can and cannot discriminate — measured, not assumed.** Both halves
     * were mutation-controlled:
     *
     *  * the **unprocessed / retried** half is real here — a runner that skipped `release()`
     *    fails this cell (and two others below it);
     *  * the **no clone** half is **vacuous at this level**, because D12's task carries
     *    `repeat = 0` and `createRepeatInstance` returns early on `NONE` under *either*
     *    ordering. A runner mutated to clone *before* running passes this whole file.
     *
     * The cell that actually catches that reordering is the `repeat = 4` variant in
     * `src/scheduler/scheduler.runner.spec.ts` → *"would end a chain if the close task ever
     * carried a non-zero repeat"*. Said here so a later reader does not take this assertion
     * for the control it is not.
     */
    it('leaves the row unprocessed and writes no clone when the close throws (C77 iii)', async () => {
      await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const runner = app.get(SchedulerRunner);
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);
      const errors = jest.spyOn(runner['logger'], 'error').mockImplementation(() => undefined);
      const closeExecuter = app.get(SavingAccountCloseExecuter);
      const run = jest
        .spyOn(closeExecuter, 'run')
        .mockRejectedValue(new Error('deadlock detected'));

      const failed = await runner.run(new Date('2027-02-28T15:00:00.000Z'));

      expect(failed).toMatchObject({ loaded: 1, processed: 0, errored: 1, cloned: 0 });
      const rows = await prisma.$queryRaw<
        { processed: boolean }[]
      >`SELECT processed FROM fondo_api_schedulertask`;
      // Still exactly one row: no clone was written.
      expect(rows).toHaveLength(1);
      expect(rows[0].processed).toBe(false);
      expect((errors.mock.calls as string[][])[0][0]).toContain('exception: deadlock detected');

      // …and the 14:00 pass retries it, which is the whole point of throwing.
      run.mockRestore();
      const retried = await runner.run(new Date('2027-02-28T19:00:00.000Z'));
      expect(retried).toMatchObject({ loaded: 1, processed: 1 });
      const after = await prisma.savingAccount.findMany({ select: { state: true } });
      expect(after[0].state).toBe(1);
    });

    /** Idempotent: re-running the same close against an already-closed CAP is a success. */
    it('is a no-op, not an error, when the CAP was closed by hand first', async () => {
      const response = await request(server())
        .post('/api/saving-account')
        .set(asAdmin())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const accountId = (response.body as { id: number }).id;
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId, state: 1, value: 0 })
        .expect(201);
      const runner = app.get(SchedulerRunner);
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

      const summary = await runner.run(new Date('2027-02-28T15:00:00.000Z'));

      expect(summary).toMatchObject({ loaded: 1, processed: 1, errored: 0, failedDelivery: 0 });
      expect((await prisma.savingAccount.findUnique({ where: { id: accountId } }))?.state).toBe(1);
    });

    /** A `type = 1` row resolves to the close executer, not the notification one. */
    it('resolves task type 1 to the CAP close executer', () => {
      expect(app.get(ExecuterFactory).get(1)).toBe(app.get(SavingAccountCloseExecuter));
    });
  });

  // ==========================================================================
  // D12 — the reconciliation query / ship-day backfill (C78, Q38)
  // ==========================================================================
  describe('D12 — the independent check (C78) and the ship-day backfill (Q38)', () => {
    /**
     * ⚠️ The check shares **no code** with the close. That is the point: a derivation, or a
     * check that reused the closing path, would make the runner's failure invisible rather
     * than detectable, which is what C74 asked this query to be immune to.
     */
    it('finds an open CAP whose end_date is past, and only that one', async () => {
      const past = await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2024-02-28',
        value: 900000,
      });
      // Already closed — reconciled, not overdue.
      await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2023-12-01',
        state: 1,
        value: 450000,
      });
      // Open but not yet due.
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01' });

      await expect(
        app.get(SavingAccountService).findUnclosedPastDue({ year: 2026, month: 9, day: 8 }),
      ).resolves.toEqual([past]);
    });

    /** ⚠️ Strictly `<`: a CAP whose `end_date` is **today** is not overdue, its task is due. */
    it('does not flag a CAP whose end_date is today', async () => {
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2026-09-08' });

      await expect(
        app.get(SavingAccountService).findUnclosedPastDue({ year: 2026, month: 9, day: 8 }),
      ).resolves.toEqual([]);
    });

    /**
     * **Q38** — the ship-day backfill. A CAP created before D12 existed has no close task, so
     * nothing will ever close it; the same query finds it and `closeAccount` closes it. This
     * reproduces `fondodev`'s exact shape as measured 2026-09-08: two CAPs, one already
     * `state = 1`, exactly one open at `end_date 2024-02-28` for 900,000, and none open with
     * a future `end_date`.
     */
    it('backfills a pre-D12 CAP that has no close task at all (Q38)', async () => {
      const orphan = await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2024-02-28',
        value: 900000,
      });
      await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2023-12-01',
        state: 1,
        value: 450000,
      });
      const accounts = app.get(SavingAccountService);
      jest.spyOn(accounts['logger'], 'log').mockImplementation(() => undefined);
      // No scheduler row exists for either — that is the situation the backfill is for.
      expect(await schedulerTaskCount()).toBe(0);

      const overdue = await accounts.findUnclosedPastDue({ year: 2026, month: 9, day: 8 });
      expect(overdue).toEqual([orphan]);
      for (const id of overdue) {
        await expect(accounts.closeAccount(id)).resolves.toBe('closed');
      }

      await expect(accounts.findUnclosedPastDue({ year: 2026, month: 9, day: 8 })).resolves.toEqual(
        [],
      );
      expect((await prisma.savingAccount.findUnique({ where: { id: orphan } }))?.state).toBe(1);
    });

    it('closes idempotently — a second sweep changes nothing', async () => {
      const orphan = await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2024-02-28',
        value: 900000,
      });
      const accounts = app.get(SavingAccountService);
      jest.spyOn(accounts['logger'], 'log').mockImplementation(() => undefined);

      await expect(accounts.closeAccount(orphan)).resolves.toBe('closed');
      await expect(accounts.closeAccount(orphan)).resolves.toBe('already-closed');
    });
  });

  // ==========================================================================
  // GET — get_accounts
  // ==========================================================================
  describe('GET /api/saving-account', () => {
    it('returns the caller’s open CAPs, serialised in Meta.fields order', async () => {
      await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2024-02-28',
        value: 900000,
        createdAt: new Date('2023-03-14T13:47:00.182Z'),
      });

      const response = await request(server())
        .get('/api/saving-account')
        .set(asAdmin())
        .expect(200);

      expect(response.body).toEqual({
        list: [
          {
            value: 900000,
            created_at: '14 mar. 2023',
            state: 0,
            user_full_name: 'Admin User',
            id: expect.any(Number) as number,
            end_date: '28 feb. 2024',
          },
        ],
        num_pages: 1,
        count: 1,
      });
      expect(Object.keys((response.body as { list: object[] }).list[0])).toEqual([
        'value',
        'created_at',
        'state',
        'user_full_name',
        'id',
        'end_date',
      ]);
    });

    /** `value` is a `BigIntegerField` and must render as a bare JSON number (rule 5b). */
    it('renders value as a bare JSON number, exactly, at the 2^53 - 1 boundary', async () => {
      await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2030-01-01',
        value: 9007199254740991n,
      });

      const response = await request(server())
        .get('/api/saving-account')
        .set(asAdmin())
        .expect(200);

      // The raw text, not the parsed body: `JSON.parse` would corrupt the value on the way
      // back in and the assertion would pass on a wrong wire format.
      expect(response.text).toContain('"value":9007199254740991');
      expect(response.text).not.toContain('"value":"9007199254740991"');
    });

    /**
     * ⚠️ **Pre-declared, not a Phase 6 finding.** `bigIntToJsonNumber` refuses a value outside
     * ±(2^53 − 1) with a 500 rather than silently losing a peso — plan §4 rule **5b**,
     * `docs/phase-0-deviations.md` §2.10, condition **C2**, which says explicitly *"do not
     * re-litigate per DTO"*. v1's Python `int` has no such bound and `json.dumps` would render
     * it exactly, so the divergence is real; it is unreachable with real CAP balances (2^53 is
     * ~9 × 10^15 pesos) and the refusal is the registered choice.
     *
     * Pinned here because a `BigIntegerField` reaches the wire on this route too, and a cell
     * that only covered the safe side would read as "money renders fine" without saying where
     * it stops.
     */
    it('answers 500 rather than losing precision above 2^53 (rule 5b, C2)', async () => {
      await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2030-01-01',
        value: 9007199254740993n,
      });

      await request(server()).get('/api/saving-account').set(asAdmin()).expect(500);
    });

    /** ⚠️ The default `state` is 0, so a closed CAP is invisible until `?state=1`. */
    it('hides closed CAPs by default and shows them for state=1', async () => {
      await seedSavingAccount(prisma, { userId: admin.id, endDate: '2024-01-01', state: 1 });

      const open = await request(server()).get('/api/saving-account').set(asAdmin()).expect(200);
      expect((open.body as { list: unknown[] }).list).toEqual([]);
      expect(open.body).toMatchObject({ count: 0, num_pages: 1 });

      const closed = await request(server())
        .get('/api/saving-account?state=1')
        .set(asAdmin())
        .expect(200);
      expect((closed.body as { list: unknown[] }).list).toHaveLength(1);
    });

    it('returns only the caller’s own CAPs without all_accounts', async () => {
      await seedSavingAccount(prisma, { userId: admin.id, endDate: '2030-01-01' });
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01' });

      const response = await request(server())
        .get('/api/saving-account')
        .set(asAdmin())
        .expect(200);

      expect(response.body).toMatchObject({ count: 1 });
    });

    it.each([
      ['ADMIN', (): Record<string, string> => asAdmin()],
      ['TREASURER', (): Record<string, string> => asTreasurer()],
    ])('honours all_accounts=true for a %s', async (_role, header) => {
      await seedSavingAccount(prisma, { userId: admin.id, endDate: '2030-01-01' });
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01' });

      const response = await request(server())
        .get('/api/saving-account?all_accounts=true')
        .set(header())
        .expect(200);

      expect(response.body).toMatchObject({ count: 2 });
    });

    /**
     * ⚠️ **A role-3 caller gets a silent no-op, not an error.** `user.role <= 2` gates the
     * argument, not the request, so `?all_accounts=true` returns only their own CAPs with a
     * 200. A PRESIDENT (1) *does* get the widened list — `<= 2` includes them, even though
     * the `PUT` rule `[0, 2]` excludes them (**Q23**).
     */
    it('silently ignores all_accounts=true for a MEMBER (role 3)', async () => {
      await seedSavingAccount(prisma, { userId: admin.id, endDate: '2030-01-01' });
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01' });

      const response = await request(server())
        .get('/api/saving-account?all_accounts=true')
        .set(asMember())
        .expect(200);

      expect(response.body).toMatchObject({ count: 1 });
    });

    it('honours all_accounts=true for a PRESIDENT, who may not PUT', async () => {
      await seedSavingAccount(prisma, { userId: admin.id, endDate: '2030-01-01' });
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01' });

      const response = await request(server())
        .get('/api/saving-account?all_accounts=true')
        .set(asPresident())
        .expect(200);

      expect(response.body).toMatchObject({ count: 2 });
    });

    /** ⚠️ The strings are compared, not parsed: only the exact lowercase `true` counts. */
    it.each(['TRUE', 'True', '1', 'yes', ''])('treats all_accounts=%p as false', async (value) => {
      await seedSavingAccount(prisma, { userId: admin.id, endDate: '2030-01-01' });
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01' });

      const response = await request(server())
        .get(`/api/saving-account?all_accounts=${value}`)
        .set(asAdmin())
        .expect(200);

      expect(response.body).toMatchObject({ count: 1 });
    });

    it('orders by -created_at then -id', async () => {
      const older = await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2030-01-01',
        createdAt: new Date('2023-01-01T12:00:00.000Z'),
      });
      const newer = await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2030-01-01',
        createdAt: new Date('2024-01-01T12:00:00.000Z'),
      });

      const response = await request(server())
        .get('/api/saving-account')
        .set(asAdmin())
        .expect(200);

      expect((response.body as { list: { id: number }[] }).list.map((row) => row.id)).toEqual([
        newer,
        older,
      ]);
    });

    it('breaks a created_at tie by descending id', async () => {
      const at = new Date('2024-01-01T12:00:00.000Z');
      const first = await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2030-01-01',
        createdAt: at,
      });
      const second = await seedSavingAccount(prisma, {
        userId: admin.id,
        endDate: '2030-01-01',
        createdAt: at,
      });

      const response = await request(server())
        .get('/api/saving-account')
        .set(asAdmin())
        .expect(200);

      expect((response.body as { list: { id: number }[] }).list.map((row) => row.id)).toEqual([
        second,
        first,
      ]);
    });

    describe('pagination', () => {
      const seedMany = async (count: number): Promise<void> => {
        for (let i = 0; i < count; i += 1) {
          await seedSavingAccount(prisma, {
            userId: admin.id,
            endDate: '2030-01-01',
            createdAt: new Date(2020, 0, 1 + i),
          });
        }
      };

      it('pages ten at a time and reports num_pages and count', async () => {
        await seedMany(23);

        const first = await request(server()).get('/api/saving-account').set(asAdmin()).expect(200);
        expect(first.body).toMatchObject({ num_pages: 3, count: 23 });
        expect((first.body as { list: unknown[] }).list).toHaveLength(10);

        const last = await request(server())
          .get('/api/saving-account?page=3')
          .set(asAdmin())
          .expect(200);
        expect((last.body as { list: unknown[] }).list).toHaveLength(3);
      });

      /** ⚠️ Past the last page is a **200 with an empty list**, not a 404. */
      it('answers 200 with an empty list past the last page', async () => {
        await seedMany(3);

        const response = await request(server())
          .get('/api/saving-account?page=99')
          .set(asAdmin())
          .expect(200);

        expect(response.body).toEqual({ list: [], num_pages: 1, count: 3 });
      });

      /** ⚠️ `num_pages` is never 0. */
      it('reports num_pages 1 and count 0 for a member with no CAPs', async () => {
        const response = await request(server())
          .get('/api/saving-account')
          .set(asMember())
          .expect(200);

        expect(response.body).toEqual({ list: [], num_pages: 1, count: 0 });
      });

      /** `paginate=false` drops `num_pages` and `count` entirely. */
      it('returns a bare list for paginate=false', async () => {
        await seedMany(12);

        const response = await request(server())
          .get('/api/saving-account?paginate=false')
          .set(asAdmin())
          .expect(200);

        expect(Object.keys(response.body as object)).toEqual(['list']);
        expect((response.body as { list: unknown[] }).list).toHaveLength(12);
      });

      /** ⚠️ `?paginate=` (present but empty) is **false** — presence switches the default. */
      it('treats an empty paginate as false', async () => {
        await seedMany(12);

        const response = await request(server())
          .get('/api/saving-account?paginate=')
          .set(asAdmin())
          .expect(200);

        expect(Object.keys(response.body as object)).toEqual(['list']);
      });

      it('treats an absent paginate as true', async () => {
        await seedMany(12);

        const response = await request(server())
          .get('/api/saving-account')
          .set(asAdmin())
          .expect(200);

        expect(response.body).toMatchObject({ num_pages: 2, count: 12 });
      });
    });

    describe('the two 400s', () => {
      /**
       * ⚠️ **The message contradicts the check.** v1 refuses `page <= 0` while telling the
       * caller the page must be *greater or equal than 0* — page 0 is rejected. Copied
       * verbatim, because a client may be matching on the text; registered in
       * `docs/phase-6-deviations.md`.
       */
      it.each(['0', '-1', '-99'])(
        'answers 400 for page=%p, with v1’s wrong message',
        async (page) => {
          const response = await request(server())
            .get(`/api/saving-account?page=${page}`)
            .set(asAdmin())
            .expect(400);

          expect(response.body).toEqual({
            message: 'Page number must be greater or equal than 0',
          });
        },
      );

      it.each(['2', '-1', '99'])('answers 400 for state=%p', async (state) => {
        const response = await request(server())
          .get(`/api/saving-account?state=${state}`)
          .set(asAdmin())
          .expect(400);

        expect(response.body).toEqual({ message: 'State must be between 0 and 1' });
      });

      /** ⚠️ Order matters: `?page=0&state=9` yields the **page** message. */
      it('reports the page message first when both are invalid', async () => {
        const response = await request(server())
          .get('/api/saving-account?page=0&state=9')
          .set(asAdmin())
          .expect(400);

        expect(response.body).toEqual({
          message: 'Page number must be greater or equal than 0',
        });
      });
    });

    describe('the unguarded int()', () => {
      /**
       * ⚠️ `int()` runs unguarded on both, so a non-numeric value is CPython's `ValueError`
       * and therefore a **500**, not a 400. This is v1's contract, not a v2 defect.
       */
      it.each(['abc', '', '1.5', '1e3', ' '])('answers 500 for page=%p', async (page) => {
        await request(server())
          .get(`/api/saving-account?page=${encodeURIComponent(page)}`)
          .set(asAdmin())
          .expect(500);
      });

      it.each(['abc', '', '0.5'])('answers 500 for state=%p', async (state) => {
        await request(server())
          .get(`/api/saving-account?state=${encodeURIComponent(state)}`)
          .set(asAdmin())
          .expect(500);
      });

      /** CPython's `int()` accepts surrounding whitespace and a leading sign. */
      it.each(['%20%201%20', '+1'])('accepts page=%p as 1, like int()', async (page) => {
        await request(server()).get(`/api/saving-account?page=${page}`).set(asAdmin()).expect(200);
      });
    });

    /** `QueryDict.get` returns the **last** value of a repeated key. */
    it('uses the last value of a repeated page parameter', async () => {
      const response = await request(server())
        .get('/api/saving-account?page=1&page=0')
        .set(asAdmin())
        .expect(400);

      expect(response.body).toEqual({
        message: 'Page number must be greater or equal than 0',
      });
    });

    it('answers 401 without a token', async () => {
      await request(server()).get('/api/saving-account').expect(401);
    });
  });

  // ==========================================================================
  // PUT — update_account
  // ==========================================================================
  describe('PUT /api/saving-account', () => {
    let accountId: number;

    beforeEach(async () => {
      accountId = await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2030-01-01',
        value: 900000,
      });
    });

    /** ⚠️ **201 Created for an update**, with a zero-byte body. */
    it('answers a bodiless 201 and replaces state and value', async () => {
      const response = await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId, state: 1, value: 500000 })
        .expect(201);

      expect(response.text).toBe('');
      expect(await prisma.savingAccount.findUnique({ where: { id: accountId } })).toMatchObject({
        state: 1,
        value: 500000n,
      });
    });

    /** ⚠️ **Q21** — a replacement, not a deposit. 900,000 then `value: 500000` is 500,000. */
    it('replaces the balance rather than adding to it (Q21)', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId, state: 0, value: 500000 })
        .expect(201);

      expect((await prisma.savingAccount.findUnique({ where: { id: accountId } }))?.value).toBe(
        500000n,
      );
    });

    /** ⚠️ **404 with a zero-byte body** for an id no CAP has. */
    it('answers a bodiless 404 for an id that does not exist', async () => {
      const response = await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId + 10000, state: 1, value: 0 })
        .expect(404);

      expect(response.text).toBe('');
    });

    it.each([
      ['id', { state: 1, value: 0 }],
      ['state', { state: undefined, value: 0 }],
      ['value', { state: 1, value: undefined }],
    ])('answers 500 when %s is missing', async (key, partial) => {
      const body: Record<string, unknown> = { id: accountId, ...partial };
      if (key !== 'id') {
        delete body[key];
      } else {
        delete body.id;
      }

      await request(server()).put('/api/saving-account').set(asAdmin()).send(body).expect(500);
    });

    /**
     * ⚠️ The ordering is observable: a row that does not exist is found *first*, so a body
     * missing `state` **and** naming a non-existent id is the 404, not the 500.
     */
    it('404s rather than 500ing when the row is missing and state is absent too', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId + 10000 })
        .expect(404);
    });

    it('answers 500 for a non-numeric id, not 404', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: 'abc', state: 1, value: 0 })
        .expect(500);
    });

    /**
     * ⚠️ **`state` is written with no `choices` validation** — `Model.save()` never calls
     * `full_clean()`. The resulting row is then invisible in every list (which filters 0/1),
     * uncounted by `total_savingaccounts` (`state = 0`) and skipped by D12's close
     * (`AND state = 0`). Ported, and registered.
     */
    it('accepts a state outside 0-1 and writes it', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId, state: 7, value: 0 })
        .expect(201);

      expect((await prisma.savingAccount.findUnique({ where: { id: accountId } }))?.state).toBe(7);
      const listed = await request(server())
        .get('/api/saving-account?all_accounts=true&state=1')
        .set(asAdmin())
        .expect(200);
      expect(listed.body).toMatchObject({ count: 0 });
    });

    it('accepts a negative value', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId, state: 0, value: -1 })
        .expect(201);

      expect((await prisma.savingAccount.findUnique({ where: { id: accountId } }))?.value).toBe(
        -1n,
      );
    });

    /** ⚠️ **Q22** — no notification, and in particular none to the member. */
    it('writes no scheduler row and sends no notification (Q22)', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id: accountId, state: 1, value: 0 })
        .expect(201);

      expect(await schedulerTaskCount()).toBe(0);
    });

    /** ⚠️ There is **no ownership check** — that is deliberate (**Q22**), not an omission. */
    it('lets a TREASURER revalue another member’s CAP', async () => {
      await request(server())
        .put('/api/saving-account')
        .set(asTreasurer())
        .send({ id: accountId, state: 0, value: 1 })
        .expect(201);
    });
  });

  // ==========================================================================
  // The authorisation matrix
  // ==========================================================================
  describe('the authorisation matrix', () => {
    /** `PUT: [0, 2]` is a **list**, i.e. exact membership — PRESIDENT is excluded (**Q23**). */
    it.each([
      ['ADMIN', 201, (): Record<string, string> => asAdmin()],
      ['TREASURER', 201, (): Record<string, string> => asTreasurer()],
      ['PRESIDENT', 403, (): Record<string, string> => asPresident()],
      ['MEMBER', 403, (): Record<string, string> => asMember()],
    ])('PUT as %s → %i', async (_role, status, header) => {
      const accountId = await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2030-01-01',
      });

      await request(server())
        .put('/api/saving-account')
        .set(header())
        .send({ id: accountId, state: 1, value: 0 })
        .expect(status);
    });

    /**
     * ⚠️ A PRESIDENT is excluded from `PUT` even on their **own** CAP. There is no ownership
     * escape hatch, in either direction.
     */
    it('refuses a PRESIDENT their own CAP', async () => {
      const own = await seedSavingAccount(prisma, {
        userId: president.id,
        endDate: '2030-01-01',
      });

      await request(server())
        .put('/api/saving-account')
        .set(asPresident())
        .send({ id: own, state: 1, value: 0 })
        .expect(403);
    });

    /**
     * ⚠️ `PATCH`, `DELETE` and `OPTIONS` are absent from `list_permissions`, and
     * `APIRolePermission`'s bare `except` denies anything absent — so they are **403 for every
     * role, ADMIN included**, and never a 405.
     */
    it.each(['patch', 'delete', 'options'] as const)(
      '%s is 403 even for an ADMIN',
      async (method) => {
        await request(server())[method]('/api/saving-account').set(asAdmin()).expect(403);
      },
    );

    it('answers 401 for an unknown token', async () => {
      await request(server())
        .get('/api/saving-account')
        .set({ Authorization: 'Token deadbeef' })
        .expect(401);
    });
  });

  // ==========================================================================
  // The URL layer
  // ==========================================================================
  describe('the URL layer', () => {
    /** `^api/saving-account/?$` — the trailing slash is **optional** on this pattern. */
    it('resolves both /api/saving-account and /api/saving-account/', async () => {
      await request(server()).get('/api/saving-account').set(asAdmin()).expect(200);
      await request(server()).get('/api/saving-account/').set(asAdmin()).expect(200);
    });

    /** Django's URL conf is **case-sensitive**; Express's router is not. Fail closed. */
    it('404s on a case-mismatched path', async () => {
      await request(server()).get('/api/SAVING-account').set(asAdmin()).expect(404);
    });

    it('404s on a path segment beyond the pattern', async () => {
      await request(server()).get('/api/saving-account/1').set(asAdmin()).expect(404);
    });

    /** `renderer_classes` has two entries, so DRF attaches `Vary: Accept` to every response. */
    it('sends Vary: Accept', async () => {
      const response = await request(server())
        .get('/api/saving-account')
        .set(asAdmin())
        .expect(200);

      expect(response.headers.vary).toContain('Accept');
    });

    /** ⚠️ Negotiation happens in `initial()`, **before** authentication: a 406 beats the 401. */
    it('answers 406 for an unacceptable Accept, before authenticating', async () => {
      await request(server())
        .get('/api/saving-account')
        .set({ Accept: 'application/xml' })
        .expect(406);
    });

    /**
     * The same pair sent **raw**, because supertest re-serialises the request target and
     * would normalise the trailing slash away before it reached the resolver (condition
     * **C27**). `^api/saving-account/?$` accepts both forms, so both must be 200 on the wire.
     */
    it('accepts the trailing slash on the wire, not only through supertest', async () => {
      const headers = `Host: localhost\r\nAuthorization: Token ${adminToken}\r\n`;

      const withSlash = await raw('/api/saving-account/', 'GET', headers);
      expect(withSlash.status).toBe(200);

      const without = await raw('/api/saving-account', 'GET', headers);
      expect(without.status).toBe(200);
      expect(without.body).toBe(withSlash.body);
    });
  });

  // ==========================================================================
  // ⚠️ The cross-phase check — total_savingaccounts is a PHASE 3 response field
  // ==========================================================================
  describe('total_savingaccounts (the Phase 3 field this phase’s writes feed)', () => {
    /**
     * ⚠️ **Q24 — CAP balances are purely informational.** `total_savingaccounts` is
     * display-only: it affects **neither `total_quota` nor `contributions`**, and neither
     * `available_quota` nor a loan's eligibility. This cell pins that, because the natural
     * reading is the opposite one and "fixing" it is the accident this phase is most likely
     * to cause.
     */
    it('appears in the user response and changes no other finance field (Q24)', async () => {
      const before = await request(server())
        .get(`/api/user/${String(member.id)}`)
        .set(asAdmin())
        .expect(200);
      const financeBefore = (before.body as { finance: Record<string, unknown> }).finance;

      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01', value: 900000 });

      const after = await request(server())
        .get(`/api/user/${String(member.id)}`)
        .set(asAdmin())
        .expect(200);
      const financeAfter = (after.body as { finance: Record<string, unknown> }).finance;

      expect(financeBefore.total_savingaccounts).toBe(0);
      expect(financeAfter.total_savingaccounts).toBe(900000);
      // Everything else is byte-identical.
      expect({ ...financeAfter, total_savingaccounts: 0 }).toEqual(financeBefore);
    });

    it('sums only the ACTIVE CAPs — a closed one drops out', async () => {
      await seedSavingAccount(prisma, { userId: member.id, endDate: '2030-01-01', value: 900000 });
      await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2023-12-01',
        value: 450000,
        state: 1,
      });

      const response = await request(server())
        .get(`/api/user/${String(member.id)}`)
        .set(asAdmin())
        .expect(200);

      expect(
        (response.body as { finance: { total_savingaccounts: number } }).finance
          .total_savingaccounts,
      ).toBe(900000);
    });

    /** A `PUT` revalue moves the Phase 3 number immediately. */
    it('follows a PUT revalue', async () => {
      const id = await seedSavingAccount(prisma, {
        userId: member.id,
        endDate: '2030-01-01',
        value: 900000,
      });

      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id, state: 0, value: 100 })
        .expect(201);

      const response = await request(server())
        .get(`/api/user/${String(member.id)}`)
        .set(asAdmin())
        .expect(200);
      expect(
        (response.body as { finance: { total_savingaccounts: number } }).finance
          .total_savingaccounts,
      ).toBe(100);
    });

    /**
     * ⚠️ **The one that matters most.** D12's close writes `state = 1`, which drops the CAP
     * out of the Phase 3 aggregate — so the auto-close is a *silent* change to a ported
     * response. Pinned here rather than discovered in production.
     */
    it('drops to 0 when D12 closes the CAP', async () => {
      const created = await request(server())
        .post('/api/saving-account')
        .set(asMember())
        .send({ end_date: '2027-02-28' })
        .expect(200);
      const id = (created.body as { id: number }).id;
      await request(server())
        .put('/api/saving-account')
        .set(asAdmin())
        .send({ id, state: 0, value: 900000 })
        .expect(201);
      const runner = app.get(SchedulerRunner);
      jest.spyOn(runner['logger'], 'log').mockImplementation(() => undefined);

      const before = await request(server())
        .get(`/api/user/${String(member.id)}`)
        .set(asAdmin())
        .expect(200);
      expect(
        (before.body as { finance: { total_savingaccounts: number } }).finance.total_savingaccounts,
      ).toBe(900000);

      await runner.run(new Date('2027-02-28T15:00:00.000Z'));

      const after = await request(server())
        .get(`/api/user/${String(member.id)}`)
        .set(asAdmin())
        .expect(200);
      expect(
        (after.body as { finance: { total_savingaccounts: number } }).finance.total_savingaccounts,
      ).toBe(0);
    });
  });
});
