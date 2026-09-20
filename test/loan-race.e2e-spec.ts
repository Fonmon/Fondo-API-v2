import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TEST_DATABASE_URL } from './test-database';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedLoan,
  seedUser,
} from './support/abstract-test';

/**
 * **Condition C56 — `d3-race.py`'s construction, landed in the repo.**
 *
 * The harness probe (`scripts/d3-race.py`, also in this repo now) is the only artifact that
 * has ever *demonstrated* the defect M3's compare-and-set designs out: two concurrent
 * `PATCH /api/loan/<id> {"state": 1}` on one WAITING loan, where v1 lets both through and
 * writes **two** `LoanDetail` rows and **two** borrower emails. It lived in a home directory,
 * outside version control, which is exactly where Phase 9's `UNIQUE (loan_id)` work will not
 * find it.
 *
 * ## Why this is opt-in, and why that is not a cop-out
 *
 * `docs/phase-4-deviations.md` §5.1 says, correctly, that *"a concurrency cell that depends on
 * interleaving passes or fails on timing, which is worse than no cell"*. This one does **not**
 * depend on timing:
 *
 *  1. a third connection takes an explicit `SELECT … FOR UPDATE` row lock on the loan and holds
 *     it — a plain `SELECT` is not blocked by it, so both requests read state `0` and both pass
 *     the in-process guard, and both then block on the **write**;
 *  2. the cell **refuses to assert anything** until `pg_stat_activity` shows two sessions
 *     waiting on a lock. The interleaving is established by the database, not by a `sleep`;
 *  3. only then is the lock released.
 *
 * It is opt-in because it holds a table-level row lock and polls `pg_stat_activity`, which is
 * antisocial in a suite that runs `--runInBand` against a shared server, and because a CI box
 * with a single-connection pool would deadlock rather than fail. Enable with:
 *
 * ```
 * FONDO_RACE_CELL=1 npm run test:e2e -- loan-race
 * ```
 *
 * ⚠️ **Phase 9 must run it again** — once against the pre-`UNIQUE` schema and once after,
 * to show the physical constraint is belt-and-braces behind the CAS rather than a replacement
 * for it. The v1 half of the comparison (both requests 200, two detail rows, two mails) can
 * only be produced by `scripts/d3-race.py` against a live v1 container; that positive control
 * is what makes this cell's single 409 meaningful, and it is recorded in
 * `~/.fondo-parity-harness/p4/out-d3.json` and quoted in §5.1.
 */
const ENABLED = process.env.FONDO_RACE_CELL === '1';
const testIf = ENABLED ? it : it.skip;

describe('D6/M3 — two concurrent approvals of one loan (C56, opt-in)', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService;
  let locker: Client | undefined;
  let observer: Client | undefined;
  let token: string;
  let loanId: number;
  const sendMail = jest.fn().mockResolvedValue(true);

  beforeAll(async () => {
    if (!ENABLED) {
      return;
    }
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendMail })
      .compile();
    app = moduleRef.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);

    const admin = await seedUser(prisma, {
      email: 'race-admin@mail.com',
      identification: 77_001n,
      role: Role.ADMIN,
    });
    token = await obtainToken(app, admin.email);
    loanId = await seedLoan(prisma, {
      userId: admin.id,
      value: 1_000_000n,
      timelimit: 12,
      fee: 0,
      rate: '0.020',
      disbursementDate: '2018-01-01',
      state: 0,
    });

    locker = new Client({ connectionString: TEST_DATABASE_URL });
    observer = new Client({ connectionString: TEST_DATABASE_URL });
    await locker.connect();
    await observer.connect();
  }, 60_000);

  afterAll(async () => {
    await locker?.end();
    await observer?.end();
    await app?.close();
  });

  const blockedSessions = async (): Promise<number> => {
    const result = await observer!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND state = 'active'`,
    );
    return Number(result.rows[0].count);
  };

  testIf(
    'exactly one approval wins; the loser gets D9’s 409 and no second LoanDetail is written',
    async () => {
      const server = app!.getHttpServer();

      await locker!.query('BEGIN');
      await locker!.query('SELECT id, state FROM fondo_api_loan WHERE id = $1 FOR UPDATE', [
        loanId,
      ]);

      const first = request(server)
        .patch(`/api/loan/${loanId}`)
        .set(authHeader(token))
        .send({ state: 1 });
      const second = request(server)
        .patch(`/api/loan/${loanId}`)
        .set(authHeader(token))
        .send({ state: 1 });
      const responses = Promise.all([first, second]);

      // The precondition, established by the database. No assertion below is reached unless
      // both writers are genuinely queued behind the lock.
      let waiting = 0;
      for (let attempt = 0; attempt < 40 && waiting < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        waiting = await blockedSessions();
      }
      expect(waiting).toBeGreaterThanOrEqual(2);

      await locker!.query('ROLLBACK');
      const [a, b] = await responses;

      // v1's answer here is 200/200, two LoanDetail rows and two mails — the corruption D6
      // exists to survive. See `scripts/d3-race.py`.
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body).toEqual({ message: 'Invalid state transition' });

      const details = await prisma.loanDetail.findMany({ where: { loan_id: loanId } });
      expect(details).toHaveLength(1);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const loan = await prisma.loan.findUnique({ where: { id: loanId } });
      expect(loan?.state).toBe(1);
    },
    120_000,
  );
});
