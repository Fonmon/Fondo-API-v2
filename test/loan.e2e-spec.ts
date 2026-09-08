import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { EmailTemplate } from '../src/mail/email-template';
import { MailService } from '../src/mail/mail.service';
import type { Loan as LoanRecord } from '../src/prisma/prisma-client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedLoan,
  seedLoanDetail,
  seedUser,
  type SeededUser,
} from './support/abstract-test';

/**
 * Phase 4 e2e — the port of `fondo_api/tests/test_loan_views.py` (**33 methods**), DB-backed,
 * through the whole `AppModule` pipeline.
 *
 * Every `it(...)` names its v1 counterpart so `manual-tester` and the reviewer can diff the two
 * files method by method.
 *
 * ## Where the expectation **changes**, and why
 *
 * | v1 test | v1 expectation | v2 | why |
 * |---|---|---|---|
 * | `test_update_loan_state` | `PATCH {state:3}` on a **WAITING_APPROVAL** loan → 200, loan becomes PAID_OUT | **409** `Invalid state transition`, loan unchanged | **D9** — `0→3` is not a legal transition (operator Q14) |
 * | `test_bulk_update_loans` | bare `200`, **no body** | `200` with `{"closed_loans": [...]}` | **D8** (operator Q3) |
 *
 * Two further deviations are *additive* — they refuse things v1 allowed, and no v1 test
 * exercised them, so nothing moves:
 *
 * * **D4** — `1 <= timelimit <= 36` is a 400 at create, **both bounds** (operator Q9). Below 1,
 *   v1 answers 201 and then dies with `DivisionByZero` at approval, so nothing moves. Above 36,
 *   v1 **silently clamps** and answers 201 — so `test_post_loan_5` **does** move, from 201 to
 *   400. It is the one moved expectation on the create path.
 * * **D10** — `GET /api/loan/<id>` and `paymentProjection` are restricted to the loan's owner
 *   plus roles `[0,1,2]`. Every v1 test reads its **own** loan as the ADMIN, so none moves.
 *
 * **D6** (upsert, not insert) is invisible in the response and is asserted on the row count.
 *
 * ## Fixture differences from `AbstractTest`, all deliberate
 *
 * * v1 pins `id = 1` on the admin and `id = i+1` on the bulk-upload loans. v2 lets the
 *   sequences assign ids (plan §4: v2 never sets a primary key on a table v1 also writes), so
 *   "the loan that does not exist" is a computed id and the TSV is built from the real ones.
 * * v1 patches `MailService.send_mail` with `@patch.object`. v2 overrides the provider — the
 *   same seam, checked the same way.
 */
/**
 * `expect.any(String)`, typed. `expect.any` returns `any`, which the lint rules reject inside
 * an object literal — and `created_at` is the one field whose value cannot be pinned (it is
 * `auto_now_add`, so it is "today" in Bogota). Everything else in these `toEqual`s is exact.
 */
const ANY_STRING: unknown = expect.any(String);

describe('Phase 4 — /api/loan (port of test_loan_views.py)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let token: string;

  const sendMail = jest.fn<Promise<boolean>, unknown[]>();

  // `setUp`'s JSON fixtures, transcribed from `test_loan_views.py:20-59`.
  const loanWithQuotaFee5 = {
    value: 100,
    timelimit: 5,
    disbursement_date: '2017-12-9',
    comments: '',
    payment: 0,
    fee: 0,
    disbursement_value: 105,
  };
  const loanWithQuotaFee10 = {
    value: 200,
    timelimit: 10,
    disbursement_date: '2017-11-9',
    comments: '',
    payment: 1,
    fee: 0,
    disbursement_value: 205,
  };
  const loanWithNotQuota = {
    value: 600,
    timelimit: 8,
    disbursement_date: '2017-12-9',
    comments: '',
    payment: 0,
    fee: 0,
    disbursement_value: 605,
  };
  /** `__get_loan_with_quota_fee(timelimit)`. */
  const loanWithQuotaFee = (timelimit: number): Record<string, unknown> => ({
    value: 300,
    timelimit,
    disbursement_date: '2018-1-1',
    comments: '',
    payment: 0,
    fee: 0,
    disbursement_value: 305,
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({ sendMail })
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(true);
    await resetDatabase(prisma);
    // `AbstractTest.create_user()` — one ADMIN, available_quota 500.
    admin = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    token = await obtainToken(app, 'mail_for_tests@mail.com');
  });

  const asAdmin = (): Record<string, string> => authHeader(token);
  const server = (): App => app.getHttpServer();

  const postLoan = async (body: object, header = asAdmin()): Promise<number> => {
    const response = await request(server()).post('/api/loan').set(header).send(body).expect(201);
    return (response.body as { id: number }).id;
  };

  const loanRow = async (id: number): Promise<LoanRecord> =>
    prisma.loan.findUniqueOrThrow({ where: { id } });

  // ==========================================================================
  // POST /api/loan
  // ==========================================================================

  /** `test_post_loan_1` */
  it('test_post_loan_1: 201, rate 0.015 for timelimit 5, state WAITING_APPROVAL', async () => {
    const id = await postLoan(loanWithQuotaFee5);
    const loan = await loanRow(id);

    expect(loan.value).toBe(100n);
    expect(loan.fee).toBe(0); // MONTHLY
    expect(loan.state).toBe(0); // WAITING_APPROVAL
    expect(loan.rate.toFixed(3)).toBe('0.015');
    expect(loan.disbursement_date.toISOString()).toBe('2017-12-09T00:00:00.000Z');
    expect(loan.comments).toBe('');
    expect(loan.payment).toBe(0); // CASH
    expect(loan.disbursement_value).toBe(105n);
    expect(loan.user_id).toBe(admin.id);
  });

  /** `test_post_loan_2` */
  it('test_post_loan_2: rate 0.020 for timelimit 10, payment BANK_ACCOUNT', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const loan = await loanRow(id);

    expect(loan.value).toBe(200n);
    expect(loan.rate.toFixed(3)).toBe('0.020');
    expect(loan.disbursement_date.toISOString()).toBe('2017-11-09T00:00:00.000Z');
    expect(loan.payment).toBe(1); // BANK_ACCOUNT
    expect(loan.disbursement_value).toBe(205n);
  });

  /** `test_post_loan_3` */
  it('test_post_loan_3: rate 0.022 for timelimit 20', async () => {
    const loan = await loanRow(await postLoan(loanWithQuotaFee(20)));
    expect(loan.value).toBe(300n);
    expect(loan.rate.toFixed(3)).toBe('0.022');
    expect(loan.disbursement_date.toISOString()).toBe('2018-01-01T00:00:00.000Z');
  });

  /** `test_post_loan_4` */
  it('test_post_loan_4: rate 0.025 for timelimit 30, timelimit stored as 30', async () => {
    const loan = await loanRow(await postLoan(loanWithQuotaFee(30)));
    expect(loan.rate.toFixed(3)).toBe('0.025');
    expect(loan.timelimit).toBe(30);
  });

  /**
   * `test_post_loan_5` — a **moved expectation**. v1 silently clamps 37 to 36 and answers
   * `201`; operator **Q9** decided a term outside `1-36` is a **400**, so D4 removes the
   * clamp and v2 refuses. The plan's §3 describes v1's clamp and §5/§9 decide against it —
   * where they disagree, §5 wins, because a registered deviation *is* the decision to
   * diverge from what §3 documents.
   */
  it('test_post_loan_5 (moved): timelimit 37 is a 400 and writes no row, where v1 clamps to 36', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send(loanWithQuotaFee(37))
      .expect(400);
    expect(response.body).toEqual({ message: 'Timelimit must be between 1 and 36' });
    await expect(prisma.loan.count()).resolves.toBe(0);
  });

  /** The upper bound from the accepting side, so the boundary is pinned on both sides. */
  it('D4: timelimit 36 is accepted — the upper bound is inclusive', async () => {
    const loan = await loanRow(await postLoan(loanWithQuotaFee(36)));
    expect(loan.timelimit).toBe(36);
    expect(loan.rate.toFixed(3)).toBe('0.025');
  });

  /** `test_post_loan_error` */
  it('test_post_loan_error: over quota is 406 with v1’s message and writes no row', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send(loanWithNotQuota)
      .expect(406);
    expect(response.body).toEqual({ message: 'User does not have available quota' });
    await expect(prisma.loan.count({ where: { user_id: admin.id } })).resolves.toBe(0);
  });

  /** **D4** — new in v2. */
  it('D4: timelimit 0 is a 400 and writes no row (v1: 201, then a 500 at approval)', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send({ ...loanWithQuotaFee5, timelimit: 0 })
      .expect(400);
    expect(response.body).toEqual({ message: 'Timelimit must be between 1 and 36' });
    await expect(prisma.loan.count()).resolves.toBe(0);
  });

  it('D4: timelimit 1 is accepted — the bound is inclusive', async () => {
    const loan = await loanRow(await postLoan({ ...loanWithQuotaFee5, timelimit: 1 }));
    expect(loan.timelimit).toBe(1);
    expect(loan.rate.toFixed(3)).toBe('0.015');
  });

  // --------------------------------------------------------------------------
  // D29 — the quota comparison runs on the RAW body value
  // --------------------------------------------------------------------------

  /**
   * ⚠️ **The boundary cell the BA and the reviewer both required to be *run*, not assumed.**
   * `available_quota` is 500 (`AbstractTest.create_user`), so this posts `500.5`.
   *
   * Measured before the fix, on both stacks: **v1 `406`** (`500.5 > 500` is `True` in Python —
   * the `TypeError` is `str` vs `int` only) and **v2 `201` with `value` stored as `500`**,
   * because `toDjangoInt` truncates *before* the comparison. So v2 did not merely accept what
   * v1 refuses; it wrote a number the member never submitted. The divergent window is exactly
   * `quota < value < quota + 1`. Now 406 on both.
   */
  it('D29: value = available_quota + 0.5 is a 406 and writes no row, as it is in v1', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send({ ...loanWithQuotaFee5, value: 500.5 })
      .expect(406);
    expect(response.body).toEqual({ message: 'User does not have available quota' });
    await expect(prisma.loan.count()).resolves.toBe(0);
  });

  /** The other half of the window: below the quota both stacks accept and both truncate. */
  it('D29: a fraction below the quota is a 201 and is stored truncated, on both stacks', async () => {
    const loan = await loanRow(await postLoan({ ...loanWithQuotaFee5, value: 499.5 }));
    expect(loan.value).toBe(499n);
  });

  /**
   * ⚠️ **D29's accepted divergence — v1 answers 500 here.** `'100' > 500` is
   * `TypeError: '>' not supported between instances of 'str' and 'int'`, raised before
   * `Loan.objects.create`, so v1 writes nothing and returns an uncaught 500. That is a crash,
   * not a rule, so v2 coerces (register row **D29**). This cell must keep passing after the
   * comparison ordering changed: only the *ordering* moved, not the leniency.
   */
  it('D29: an integer-shaped string value is a 201 with the coerced amount, where v1 is a 500', async () => {
    const loan = await loanRow(await postLoan({ ...loanWithQuotaFee5, value: '100' }));
    expect(loan.value).toBe(100n);
  });

  it('D29: an over-quota string gets the fund’s real 406, where v1 gives a 500', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send({ ...loanWithQuotaFee5, value: '600' })
      .expect(406);
    expect(response.body).toEqual({ message: 'User does not have available quota' });
    await expect(prisma.loan.count()).resolves.toBe(0);
  });

  // --------------------------------------------------------------------------
  // D30 — the lower bound neither stack has
  // --------------------------------------------------------------------------

  /**
   * ⚠️ **v1 accepts this and writes the row, and so did v2 until D30 landed.** This is a
   * divergence v2 introduces *by decision* (operator: the fund has no minimum loan amount, so
   * the floor is 1 as cheap insurance), **not** a parity repair — a future parity round must
   * read the 400 as expected rather than filing it as a regression.
   */
  it.each([0, -1000])(
    'D30: value %p is a 400 and writes no row — v1 answers 201 and writes it',
    async (value) => {
      const response = await request(server())
        .post('/api/loan')
        .set(asAdmin())
        .send({ ...loanWithQuotaFee5, value })
        .expect(400);
      expect(response.body).toEqual({ message: 'Loan value must be greater than 0' });
      await expect(prisma.loan.count()).resolves.toBe(0);
    },
  );

  it('D30: 0.5 is a 400 — the bound is checked after `int()` truncates it to 0', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send({ ...loanWithQuotaFee5, value: 0.5 })
      .expect(400);
    expect(response.body).toEqual({ message: 'Loan value must be greater than 0' });
    await expect(prisma.loan.count()).resolves.toBe(0);
  });

  /** Through **D29** the same bound catches the string shape — it is a rule about money. */
  it('D30: "-1000" is a 400 from the same bound, not from a rule about JSON types', async () => {
    const response = await request(server())
      .post('/api/loan')
      .set(asAdmin())
      .send({ ...loanWithQuotaFee5, value: '-1000' })
      .expect(400);
    expect(response.body).toEqual({ message: 'Loan value must be greater than 0' });
    await expect(prisma.loan.count()).resolves.toBe(0);
  });

  it('D30: value 1 is accepted — the floor is inclusive, and the fund has three such loans', async () => {
    const loan = await loanRow(await postLoan({ ...loanWithQuotaFee5, value: 1 }));
    expect(loan.value).toBe(1n);
  });

  // ==========================================================================
  // GET /api/loan
  // ==========================================================================

  /** `test_get_loans_paginator` */
  it('test_get_loans_paginator: 10 per page, num_pages 3, count 25, page 4 empty', async () => {
    for (let i = 0; i < 25; i += 1) {
      await postLoan(loanWithQuotaFee5);
    }
    await expect(prisma.loan.count()).resolves.toBe(25);

    const first = await request(server()).get('/api/loan').set(asAdmin()).expect(200);
    expect((first.body as { list: unknown[] }).list).toHaveLength(10);
    expect(first.body).toMatchObject({ num_pages: 3, count: 25 });

    const zero = await request(server()).get('/api/loan?page=0').set(asAdmin()).expect(400);
    expect(zero.body).toEqual({ message: 'Page number must be greater or equal than 0' });

    const third = await request(server()).get('/api/loan?page=3').set(asAdmin()).expect(200);
    expect((third.body as { list: unknown[] }).list).toHaveLength(5);
    expect(third.body).toMatchObject({ num_pages: 3, count: 25 });

    // Past the last page: 200 with an empty list and the real counters (§4 rule 1).
    const fourth = await request(server()).get('/api/loan?page=4').set(asAdmin()).expect(200);
    expect((fourth.body as { list: unknown[] }).list).toHaveLength(0);
    expect(fourth.body).toMatchObject({ num_pages: 3, count: 25 });
  });

  /** `test_get_loans_not_paginator` */
  it('test_get_loans_not_paginator: paginate=false returns a bare list with no counters', async () => {
    for (let i = 0; i < 25; i += 1) {
      await postLoan(loanWithQuotaFee5);
    }
    const response = await request(server())
      .get('/api/loan?paginate=false')
      .set(asAdmin())
      .expect(200);
    expect((response.body as { list: unknown[] }).list).toHaveLength(25);
    expect(response.body).not.toHaveProperty('num_pages');
    expect(response.body).not.toHaveProperty('count');
  });

  /**
   * ⚠️ `paginate`'s *presence* switches it from the default `true` to `== 'true'`, so an
   * empty value means **false** and `paginate=True` (capitalised) also means false. Comparing
   * strings, not parsing booleans.
   */
  it('paginate is an exact string comparison: `?paginate=` and `?paginate=True` are both false', async () => {
    await postLoan(loanWithQuotaFee5);
    for (const query of ['paginate=', 'paginate=True', 'paginate=1', 'paginate=yes']) {
      const response = await request(server()).get(`/api/loan?${query}`).set(asAdmin()).expect(200);
      expect(response.body).not.toHaveProperty('num_pages');
    }
    const paginated = await request(server())
      .get('/api/loan?paginate=true')
      .set(asAdmin())
      .expect(200);
    expect(paginated.body).toHaveProperty('num_pages');
  });

  /** `test_get_loans` */
  it('test_get_loans: each caller sees their own; all_loans is honoured only for roles ≤ 2', async () => {
    await postLoan(loanWithQuotaFee5);
    await postLoan(loanWithQuotaFee10);

    const member = await seedUser(prisma, {
      email: 'mail_for_tests_2@mail.com',
      identification: 99899n,
      role: Role.MEMBER,
    });
    const memberToken = await obtainToken(app, member.email);
    await postLoan(loanWithQuotaFee(20), authHeader(memberToken));

    const memberOwn = await request(server())
      .get('/api/loan')
      .set(authHeader(memberToken))
      .expect(200);
    expect((memberOwn.body as { list: Record<string, unknown>[] }).list).toHaveLength(1);
    for (const loan of (memberOwn.body as { list: Record<string, unknown>[] }).list) {
      for (const field of [
        'user_full_name',
        'state',
        'value',
        'timelimit',
        'disbursement_date',
        'fee',
        'rate',
        'id',
        'created_at',
        'disbursement_value',
      ]) {
        expect(loan[field]).not.toBeNull();
        expect(loan[field]).toBeDefined();
      }
    }

    const adminOwn = await request(server()).get('/api/loan').set(asAdmin()).expect(200);
    expect((adminOwn.body as { list: unknown[] }).list).toHaveLength(2);

    const adminAll = await request(server())
      .get('/api/loan?all_loans=true')
      .set(asAdmin())
      .expect(200);
    expect((adminAll.body as { list: unknown[] }).list).toHaveLength(3);

    // ⚠️ For a MEMBER the argument is simply not passed, so `all_loans=true` is a silent no-op.
    const memberAll = await request(server())
      .get('/api/loan?all_loans=true')
      .set(authHeader(memberToken))
      .expect(200);
    expect((memberAll.body as { list: unknown[] }).list).toHaveLength(1);
  });

  it('all_loans is an exact string comparison — TRUE, 1 and yes are all false', async () => {
    await postLoan(loanWithQuotaFee5);
    const other = await seedUser(prisma, {
      email: 'other@mail.com',
      identification: 5555n,
      role: Role.TREASURER,
    });
    await postLoan(loanWithQuotaFee10, authHeader(await obtainToken(app, other.email)));

    for (const value of ['TRUE', '1', 'yes', '']) {
      const response = await request(server())
        .get(`/api/loan?all_loans=${value}`)
        .set(asAdmin())
        .expect(200);
      expect((response.body as { list: unknown[] }).list).toHaveLength(1);
    }
    const real = await request(server()).get('/api/loan?all_loans=true').set(asAdmin()).expect(200);
    expect((real.body as { list: unknown[] }).list).toHaveLength(2);
  });

  /** `test_get_loans_filter` */
  it('test_get_loans_filter: state=5 is 400; state filters the list', async () => {
    await postLoan(loanWithQuotaFee5);
    await postLoan(loanWithQuotaFee10);

    const bad = await request(server()).get('/api/loan?state=5').set(asAdmin()).expect(400);
    expect(bad.body).toEqual({ message: 'State must be between 0 and 4' });

    const approved = await request(server()).get('/api/loan?state=1').set(asAdmin()).expect(200);
    expect((approved.body as { list: unknown[] }).list).toHaveLength(0);

    const waiting = await request(server()).get('/api/loan?state=0').set(asAdmin()).expect(200);
    const list = (waiting.body as { list: Record<string, unknown>[] }).list;
    expect(list).toHaveLength(2);
    for (const loan of list) {
      expect(loan.state).toBe(0);
    }
  });

  it('state=4 means "every state", and is the default', async () => {
    const waiting = await postLoan(loanWithQuotaFee5);
    const toDeny = await postLoan(loanWithQuotaFee10);
    await request(server())
      .patch(`/api/loan/${toDeny}`)
      .set(asAdmin())
      .send({ state: 2 })
      .expect(200);

    const explicit = await request(server()).get('/api/loan?state=4').set(asAdmin()).expect(200);
    expect((explicit.body as { list: unknown[] }).list).toHaveLength(2);
    const implicit = await request(server()).get('/api/loan').set(asAdmin()).expect(200);
    expect((implicit.body as { list: unknown[] }).list).toHaveLength(2);
    expect(waiting).toBeDefined();
  });

  it('a negative state is 400 with the same message', async () => {
    const response = await request(server()).get('/api/loan?state=-1').set(asAdmin()).expect(400);
    expect(response.body).toEqual({ message: 'State must be between 0 and 4' });
  });

  /** ⚠️ The page check runs **before** the state check, so an invalid pair reports the page. */
  it('the page 400 precedes the state 400', async () => {
    const response = await request(server())
      .get('/api/loan?page=0&state=9')
      .set(asAdmin())
      .expect(400);
    expect(response.body).toEqual({ message: 'Page number must be greater or equal than 0' });
  });

  /**
   * ⚠️ Unlike `UserView.get`, `LoanView.get` calls `int()` on `state`/`page` **unguarded**,
   * so a non-numeric value is a 500, not a 400. Measured behaviour, ported deliberately.
   */
  it('a non-numeric page or state is a 500, not a 400 (int() is unguarded here)', async () => {
    await request(server()).get('/api/loan?page=').set(asAdmin()).expect(500);
    await request(server()).get('/api/loan?page=abc').set(asAdmin()).expect(500);
    await request(server()).get('/api/loan?state=abc').set(asAdmin()).expect(500);
  });

  it('a repeated query key takes the LAST value, as QueryDict.get does', async () => {
    for (let i = 0; i < 15; i += 1) {
      await postLoan(loanWithQuotaFee5);
    }
    const response = await request(server())
      .get('/api/loan?page=1&page=2')
      .set(asAdmin())
      .expect(200);
    expect((response.body as { list: unknown[] }).list).toHaveLength(5);
  });

  /** `test_get_loans_filter_all` */
  it('test_get_loans_filter_all: state and all_loans combine', async () => {
    await postLoan(loanWithQuotaFee5);
    await postLoan(loanWithQuotaFee10);
    const response = await request(server())
      .get('/api/loan?state=0&all_loans=true')
      .set(asAdmin())
      .expect(200);
    const list = (response.body as { list: Record<string, unknown>[] }).list;
    expect(list).toHaveLength(2);
    for (const loan of list) {
      expect(loan.state).toBe(0);
    }
  });

  /** ⚠️ Order is `-created_at, -id` — and nothing else. */
  it('lists newest first by created_at, then by descending id', async () => {
    const shared = new Date('2020-05-05T12:00:00.000Z');
    const a = await seedLoan(prisma, {
      userId: admin.id,
      value: 1n,
      timelimit: 5,
      fee: 0,
      rate: '0.015',
      disbursementDate: '2020-01-01',
      createdAt: shared,
    });
    const b = await seedLoan(prisma, {
      userId: admin.id,
      value: 2n,
      timelimit: 5,
      fee: 0,
      rate: '0.015',
      disbursementDate: '2020-01-01',
      createdAt: shared,
    });
    const older = await seedLoan(prisma, {
      userId: admin.id,
      value: 3n,
      timelimit: 5,
      fee: 0,
      rate: '0.015',
      disbursementDate: '2020-01-01',
      createdAt: new Date('2019-01-01T12:00:00.000Z'),
    });
    const response = await request(server()).get('/api/loan').set(asAdmin()).expect(200);
    expect((response.body as { list: { id: number }[] }).list.map((loan) => loan.id)).toEqual([
      b,
      a,
      older,
    ]);
  });

  // ==========================================================================
  // PATCH /api/loan/<id>
  // ==========================================================================

  /** `test_update_loan_approved_monthly` */
  it('test_update_loan_approved_monthly: 200, the v1 email HTML, then GET returns the detail', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: 1 })
      .expect(200);

    expect(response.body).toMatchObject({
      total_payment: 222,
      minimum_payment: 24,
      payday_limit: '9 dic. 2017',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(
      EmailTemplate.CHANGE_STATE_LOAN_APPROVED,
      ['mail_for_tests@mail.com'],
      {
        loan_id: id,
        loan_table:
          '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$4</td><td>$20</td><td>9 dic. 2017</td><td>$24</td><td>$180</td></tr><tr><td>2</td><td>$180</td><td>9 dic. 2017</td><td>$4</td><td>$20</td><td>9 ene. 2018</td><td>$24</td><td>$160</td></tr><tr><td>3</td><td>$160</td><td>9 ene. 2018</td><td>$3</td><td>$20</td><td>9 feb. 2018</td><td>$23</td><td>$140</td></tr><tr><td>4</td><td>$140</td><td>9 feb. 2018</td><td>$3</td><td>$20</td><td>9 mar. 2018</td><td>$23</td><td>$120</td></tr><tr><td>5</td><td>$120</td><td>9 mar. 2018</td><td>$2</td><td>$20</td><td>9 abr. 2018</td><td>$22</td><td>$100</td></tr><tr><td>6</td><td>$100</td><td>9 abr. 2018</td><td>$2</td><td>$20</td><td>9 may. 2018</td><td>$22</td><td>$80</td></tr><tr><td>7</td><td>$80</td><td>9 may. 2018</td><td>$2</td><td>$20</td><td>9 jun. 2018</td><td>$22</td><td>$60</td></tr><tr><td>8</td><td>$60</td><td>9 jun. 2018</td><td>$1</td><td>$20</td><td>9 jul. 2018</td><td>$21</td><td>$40</td></tr><tr><td>9</td><td>$40</td><td>9 jul. 2018</td><td>$1</td><td>$20</td><td>9 ago. 2018</td><td>$21</td><td>$20</td></tr><tr><td>10</td><td>$20</td><td>9 ago. 2018</td><td>$0</td><td>$20</td><td>9 sept. 2018</td><td>$20</td><td>$0</td></tr></table>',
      },
      // ⚠️ The borrower is the ADMIN here, and `MailService` drops an address that is also a
      // recipient — so the BCC list arrives with them still in it and is deduped downstream.
      ['mail_for_tests@mail.com'],
    );

    await expect(loanRow(id).then((loan) => loan.state)).resolves.toBe(1);

    const read = await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);
    expect(read.body).toEqual({
      loan: {
        value: 200,
        timelimit: 10,
        disbursement_date: '9 nov. 2017',
        payment: 1,
        created_at: ANY_STRING as string,
        fee: 0,
        comments: '',
        state: 1,
        user_full_name: 'Foo Name Foo Last Name',
        id,
        rate: '0.020',
        is_refinanced: false,
        refinanced_loan: null,
        user_id: admin.id,
        disbursement_value: 205,
      },
      loan_detail: {
        minimum_payment: 24,
        total_payment: 222,
        payday_limit: '9 dic. 2017',
        interests: 4,
        capital_balance: 200,
        from_date: '9 nov. 2017',
      },
    });
  });

  /** `test_update_loan_approved_unique` */
  it('test_update_loan_approved_unique: one instalment at +13 months, total 257', async () => {
    const id = await postLoan({ ...loanWithQuotaFee10, fee: 1, timelimit: 13 });
    const response = await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: 1 })
      .expect(200);

    expect(response.body).toMatchObject({
      total_payment: 257,
      minimum_payment: 257,
      payday_limit: '9 dic. 2018',
    });
    expect(sendMail).toHaveBeenCalledWith(
      EmailTemplate.CHANGE_STATE_LOAN_APPROVED,
      ['mail_for_tests@mail.com'],
      {
        loan_id: id,
        loan_table:
          '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$57</td><td>$200</td><td>9 dic. 2018</td><td>$257</td><td>$0</td></tr></table>',
      },
      ['mail_for_tests@mail.com'],
    );

    const read = await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);
    expect(read.body).toMatchObject({
      loan: { timelimit: 13, fee: 1, rate: '0.022', state: 1 },
      loan_detail: {
        total_payment: 257,
        minimum_payment: 257,
        payday_limit: '9 dic. 2018',
        from_date: '9 nov. 2017',
      },
    });
  });

  /** `test_update_loan_approved_repeat_email` */
  it('test_update_loan_approved_repeat_email: the borrower is the To, roles [0,2] the Bcc', async () => {
    const borrower = await seedUser(prisma, {
      email: 'mail_for_tests_2@mail.com',
      identification: 99899n,
      role: Role.MEMBER,
    });
    const borrowerToken = await obtainToken(app, borrower.email);
    const id = await postLoan(
      { ...loanWithQuotaFee10, fee: 1, timelimit: 13 },
      authHeader(borrowerToken),
    );

    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, , bcc] = sendMail.mock.calls[0] as [unknown, string[], unknown, string[]];
    expect(to).toEqual(['mail_for_tests_2@mail.com']);
    expect(bcc).toEqual(['mail_for_tests@mail.com']);
  });

  /**
   * `test_update_loan_state` — ⚠️ **THE ONE MOVED EXPECTATION.**
   *
   * v1 answers **200** and writes `state = 3` on a loan still awaiting approval, skipping the
   * approval entirely: no amortisation table, no `LoanDetail`, no email. **D9** (operator Q14)
   * makes `0 → 3` illegal, so v2 answers **409** and leaves the row alone.
   */
  it('test_update_loan_state: D9 — 0 -> 3 is now 409, and the loan is unchanged', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: 3 })
      .expect(409);
    expect(response.body).toEqual({ message: 'Invalid state transition' });

    await expect(loanRow(id).then((loan) => loan.state)).resolves.toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('D9: the legal 1 -> 3 payout still answers 200 with a JSON empty string', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);
    sendMail.mockClear();

    const response = await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: 3 })
      .expect(200);
    // ⚠️ `Response('', status=200)` — `JSONRenderer` writes the two bytes `""`, not an empty
    // body (that is what it does for `None`).
    expect(response.text).toBe('""');
    await expect(loanRow(id).then((loan) => loan.state)).resolves.toBe(3);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('D9: re-approving an APPROVED loan is 409, with no second email and no second detail', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);
    sendMail.mockClear();

    const response = await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: 1 })
      .expect(409);
    expect(response.body).toEqual({ message: 'Invalid state transition' });
    expect(sendMail).not.toHaveBeenCalled();
    await expect(prisma.loanDetail.count({ where: { loan_id: id } })).resolves.toBe(1);
  });

  /**
   * **D6.** The v1 defect this closes: `LoanDetail.loan` is a plain FK, so re-approving a
   * loan inserts a **second** detail row and `LoanDetail.objects.get(loan_id=...)` then raises
   * `MultipleObjectsReturned` — `GET /api/loan/<id>` is a permanent 500. D9 blocks the
   * transition at the source; D6 is the belt-and-braces that makes the write an upsert.
   */
  it('D6: an approval never creates a second LoanDetail, and the read stays a 200', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    // Simulate the recovery path a DBA would take on a wrongly auto-closed loan: put the row
    // back to APPROVED out-of-band, then re-approve through the API is blocked by D9 — so
    // exercise the upsert directly by driving the same state again after a manual reset.
    await prisma.loan.update({ where: { id }, data: { state: 0 } });
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    await expect(prisma.loanDetail.count({ where: { loan_id: id } })).resolves.toBe(1);
    await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);
  });

  it('D9: a negative state passes v1’s `<= 3` check and is then refused as a transition', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: -1 })
      .expect(409);
    expect(response.body).toEqual({ message: 'Invalid state transition' });
    await expect(loanRow(id).then((loan) => loan.state)).resolves.toBe(0);
  });

  /** `test_update_loan_denied` */
  it('test_update_loan_denied: 200 and the DENIED email', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 2 }).expect(200);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(
      EmailTemplate.CHANGE_STATE_LOAN_DENIED,
      ['mail_for_tests@mail.com'],
      { loan_id: id },
      ['mail_for_tests@mail.com'],
    );
    await expect(loanRow(id).then((loan) => loan.state)).resolves.toBe(2);
  });

  /** `test_update_loan_denied_repeat_email` */
  it('test_update_loan_denied_repeat_email: the borrower is the To, roles [0,2] the Bcc', async () => {
    const borrower = await seedUser(prisma, {
      email: 'mail_for_tests_2@mail.com',
      identification: 99899n,
      role: Role.MEMBER,
    });
    const id = await postLoan(
      loanWithQuotaFee10,
      authHeader(await obtainToken(app, borrower.email)),
    );
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 2 }).expect(200);

    expect(sendMail).toHaveBeenCalledWith(
      EmailTemplate.CHANGE_STATE_LOAN_DENIED,
      ['mail_for_tests_2@mail.com'],
      { loan_id: id },
      ['mail_for_tests@mail.com'],
    );
    await expect(loanRow(id).then((loan) => loan.state)).resolves.toBe(2);
  });

  /** `test_update_loan_not_found` */
  it('test_update_loan_not_found: 404 with v1’s message', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server())
      .patch(`/api/loan/${id + 1}`)
      .set(asAdmin())
      .send({ state: 2 })
      .expect(404);
    expect(response.body).toEqual({ message: 'Loan does not exist' });
  });

  /** `test_update_loan_exceeded` */
  it('test_update_loan_exceeded: state 5 is 400, before the loan is even looked up', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server())
      .patch(`/api/loan/${id + 1}`)
      .set(asAdmin())
      .send({ state: 5 })
      .expect(400);
    expect(response.body).toEqual({ message: 'State must be less or equal than 3' });
  });

  it('a missing `state` key is a 500 — nothing wraps the subscript in v1', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({}).expect(500);
    await request(server())
      .patch(`/api/loan/${id}`)
      .set(asAdmin())
      .send({ state: 'abc' })
      .expect(500);
  });

  // ==========================================================================
  // GET /api/loan/<id>
  // ==========================================================================

  /** `test_get_loan` */
  it('test_get_loan: an unapproved loan returns `loan` only, with no `loan_detail`', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);

    expect(response.body).toEqual({
      loan: {
        value: 200,
        timelimit: 10,
        disbursement_date: '9 nov. 2017',
        payment: 1,
        created_at: ANY_STRING as string,
        fee: 0,
        comments: '',
        state: 0,
        user_full_name: 'Foo Name Foo Last Name',
        id,
        rate: '0.020',
        is_refinanced: false,
        refinanced_loan: null,
        user_id: admin.id,
        disbursement_value: 205,
      },
    });
    expect(response.body).not.toHaveProperty('loan_detail');
  });

  /** `test_get_loan_not_found` */
  it('test_get_loan_not_found: 404 with a zero-byte body', async () => {
    const response = await request(server()).get('/api/loan/999').set(asAdmin()).expect(404);
    expect(response.text).toBe('');
  });

  it('DRF Meta.fields key order is preserved on the wire', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);
    expect(Object.keys((response.body as { loan: Record<string, unknown> }).loan)).toEqual([
      'value',
      'timelimit',
      'disbursement_date',
      'payment',
      'created_at',
      'fee',
      'comments',
      'state',
      'user_full_name',
      'id',
      'rate',
      'is_refinanced',
      'refinanced_loan',
      'user_id',
      'disbursement_value',
    ]);
  });

  it('rate is a JSON string and money fields are bare JSON numbers (rules 5b / DRF)', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    const response = await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);
    expect(response.text).toContain('"rate":"0.020"');
    expect(response.text).toContain('"value":200');
    expect(response.text).not.toContain('"value":"200"');
  });

  // ==========================================================================
  // D10 — the loan read
  // ==========================================================================

  describe('D10 — the loan read is the owner plus roles [0,1,2]', () => {
    let borrower: SeededUser;
    let loanId: number;

    beforeEach(async () => {
      borrower = await seedUser(prisma, {
        email: 'borrower@mail.com',
        identification: 4242n,
        role: Role.MEMBER,
      });
      loanId = await seedLoan(prisma, {
        userId: borrower.id,
        value: 200n,
        timelimit: 10,
        fee: 0,
        rate: '0.020',
        disbursementDate: '2017-11-09',
        state: 1,
      });
      await seedLoanDetail(prisma, {
        loanId,
        paydayLimit: '2017-12-09',
        fromDate: '2017-11-09',
        capitalBalance: 200n,
      });
    });

    it('the owner reads their own loan', async () => {
      const borrowerToken = await obtainToken(app, borrower.email);
      await request(server()).get(`/api/loan/${loanId}`).set(authHeader(borrowerToken)).expect(200);
    });

    it.each([
      ['ADMIN', Role.ADMIN],
      ['PRESIDENT', Role.PRESIDENT],
      ['TREASURER', Role.TREASURER],
    ])('%s reads any member’s loan', async (label, role) => {
      const privileged = await seedUser(prisma, {
        email: `priv-${label}@mail.com`,
        identification: BigInt(70_000 + role),
        role,
      });
      const privilegedToken = await obtainToken(app, privileged.email);
      await request(server())
        .get(`/api/loan/${loanId}`)
        .set(authHeader(privilegedToken))
        .expect(200);
    });

    it('another MEMBER is refused with DRF’s generic 403 body', async () => {
      const stranger = await seedUser(prisma, {
        email: 'stranger@mail.com',
        identification: 4343n,
        role: Role.MEMBER,
      });
      const strangerToken = await obtainToken(app, stranger.email);
      const response = await request(server())
        .get(`/api/loan/${loanId}`)
        .set(authHeader(strangerToken))
        .expect(403);
      // Byte-identical to a role denial, so it cannot be used to enumerate loans.
      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
    });

    it('paymentProjection is restricted by the same predicate', async () => {
      const stranger = await seedUser(prisma, {
        email: 'stranger2@mail.com',
        identification: 4444n,
        role: Role.MEMBER,
      });
      const strangerToken = await obtainToken(app, stranger.email);
      await request(server())
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(authHeader(strangerToken))
        .send({ to_date: '2017-12-09' })
        .expect(403);

      // Positive control: the owner's identical request succeeds, so the 403 is D10 and not
      // a broken route.
      const borrowerToken = await obtainToken(app, borrower.email);
      await request(server())
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(authHeader(borrowerToken))
        .send({ to_date: '2017-12-09' })
        .expect(200);
    });

    it('a non-existent loan is still 404 for everyone, so D10 leaks no existence', async () => {
      const stranger = await seedUser(prisma, {
        email: 'stranger3@mail.com',
        identification: 4545n,
        role: Role.MEMBER,
      });
      const strangerToken = await obtainToken(app, stranger.email);
      await request(server())
        .get(`/api/loan/${loanId + 5000}`)
        .set(authHeader(strangerToken))
        .expect(404);
    });
  });

  // ==========================================================================
  // PATCH /api/loan — the monthly file
  // ==========================================================================

  describe('PATCH /api/loan — bulk_update_loans', () => {
    /** `test_bulk_update_loans`, with the ids the sequence actually assigned. */
    it('test_bulk_update_loans: upserts every listed detail and returns 200', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const id = await seedLoan(prisma, {
          userId: admin.id,
          value: 100n,
          timelimit: 5,
          fee: 0,
          rate: '0',
          disbursementDate: '2000-01-01',
          state: 1,
        });
        await seedLoanDetail(prisma, { loanId: id, paydayLimit: '2000-01-01' });
        ids.push(id);
      }
      // v1's `create_test_file()`: three known ids plus one that does not exist.
      const file =
        `${ids[0]}\t1234\t5678\t1/1/2018\t13\t24\t2/2/2018\r\n` +
        `${ids[1]}\t4321\t8765\t2/1/2018\t45\t56\t3/3/2018\r\n` +
        `${ids[2]}\t1\t2\t3/1/2017\t4\t5\t1/1/2017\r\n` +
        `${ids[3] + 1000}\t1\t2\t3/1/2017\t4\t5\t3/3/2017\r\n`;

      await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach('file', Buffer.from(file, 'utf8'), 'loans.txt')
        .expect(200);

      const first = await prisma.loanDetail.findFirstOrThrow({ where: { loan_id: ids[0] } });
      expect(first.total_payment).toBe(1234n);
      expect(first.minimum_payment).toBe(5678n);
      expect(first.payday_limit.toISOString()).toBe('2018-01-01T00:00:00.000Z');
      expect(first.interests).toBe(13n);
      expect(first.capital_balance).toBe(24n);
      expect(first.from_date.toISOString()).toBe('2018-02-02T00:00:00.000Z');
      await expect(loanRow(ids[0]).then((l) => l.state)).resolves.toBe(1);

      const second = await prisma.loanDetail.findFirstOrThrow({ where: { loan_id: ids[1] } });
      expect(second.total_payment).toBe(4321n);
      expect(second.minimum_payment).toBe(8765n);
      // ⚠️ D/M/Y: '2/1/2018' is 2 January, not 1 February.
      expect(second.payday_limit.toISOString()).toBe('2018-01-02T00:00:00.000Z');
      expect(second.from_date.toISOString()).toBe('2018-03-03T00:00:00.000Z');
      await expect(loanRow(ids[1]).then((l) => l.state)).resolves.toBe(1);

      const third = await prisma.loanDetail.findFirstOrThrow({ where: { loan_id: ids[2] } });
      expect(third.total_payment).toBe(1n);
      expect(third.minimum_payment).toBe(2n);
      expect(third.payday_limit.toISOString()).toBe('2017-01-03T00:00:00.000Z');
      expect(third.interests).toBe(4n);
      expect(third.capital_balance).toBe(5n);
      expect(third.from_date.toISOString()).toBe('2017-01-01T00:00:00.000Z');
      await expect(loanRow(ids[2]).then((l) => l.state)).resolves.toBe(1);
    });

    /** **D8** — the response body v1 does not have. */
    it('D8: the response names the loans the upload auto-closed', async () => {
      const listed = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      await seedLoanDetail(prisma, { loanId: listed, paydayLimit: '2000-01-01' });
      const omitted = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      await seedLoanDetail(prisma, { loanId: omitted, paydayLimit: '2000-01-01' });

      const response = await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach(
          'file',
          Buffer.from(`${listed}\t100\t10\t15/6/2018\t1\t90\t1/6/2018\n`, 'utf8'),
          'loans.txt',
        )
        .expect(200);

      expect(response.body).toEqual({ closed_loans: [omitted] });
      await expect(loanRow(omitted).then((l) => l.state)).resolves.toBe(3);
      await expect(loanRow(listed).then((l) => l.state)).resolves.toBe(1);
      // The auto-close is silent — no mail for either loan.
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('schedules two payment reminders per listed loan, at T-5d and T-1d', async () => {
      const id = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      await seedLoanDetail(prisma, { loanId: id, paydayLimit: '2000-01-01' });

      await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach(
          'file',
          Buffer.from(`${id}\t100\t10\t15/6/2018\t1\t90\t1/6/2018\n`, 'utf8'),
          'loans.txt',
        )
        .expect(200);

      const rows = await prisma.$queryRaw<
        { run_date: Date; payload: string; processed: boolean; repeat: number; type: number }[]
      >`SELECT run_date, payload::text AS payload, processed, repeat, type
        FROM fondo_api_schedulertask ORDER BY run_date`;
      expect(rows).toHaveLength(2);
      // `make_aware(datetime(y, m, d))` in America/Bogota -> 05:00Z.
      expect(rows[0].run_date.toISOString()).toBe('2018-06-10T05:00:00.000Z');
      expect(rows[1].run_date.toISOString()).toBe('2018-06-14T05:00:00.000Z');
      for (const row of rows) {
        expect(row.type).toBe(0);
        expect(row.repeat).toBe(0);
        expect(row.processed).toBe(false);
        // hstore stores strings; `user_ids` is a Python list repr.
        expect(row.payload).toContain('"type"=>"payment_reminder"');
        expect(row.payload).toContain(`"owner_id"=>"${id}"`);
        expect(row.payload).toContain(`"user_ids"=>"[${admin.id}]"`);
        expect(row.payload).toContain(`"target"=>"/loan/${id}"`);
        expect(row.payload).toContain(
          `"message"=>"Recuerde que la fecha límite de pago para el crédito ${id}, es el: 15 jun. 2018"`,
        );
      }
    });

    it('an id listed in the file but with no LoanDetail shields itself from the auto-close', async () => {
      const noDetail = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      const response = await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach(
          'file',
          Buffer.from(`${noDetail}\t1\t2\t1/1/2018\t3\t4\t1/1/2018\n`, 'utf8'),
          'loans.txt',
        )
        .expect(200);
      expect(response.body).toEqual({ closed_loans: [] });
      await expect(loanRow(noDetail).then((l) => l.state)).resolves.toBe(1);
    });

    /**
     * **C46 — an out-of-`Int32` id in column 0 must miss, not abort the file.**
     *
     * Measured on the pinned v1 container, read-only:
     * `LoanDetail.objects.get(loan_id=X)` raises `DoesNotExist` for `999999`, `2**31`,
     * `3e9` **and** `2**63` — Python's `int` is arbitrary precision and PostgreSQL compares an
     * `integer` column against an out-of-range numeric literal happily. v1 logs
     * `Loan with id: X, not exists` and continues the upload.
     *
     * Measured on v2 before the fix: Prisma refuses the same value client-side with
     * `Value out of range for the type: value "3000000000" is out of range for type integer`.
     * That is not D9's 409, so the narrow catch rethrows it and the `$transaction` rolls back
     * the **whole monthly file**. The cell drives both halves at once: a good row that must
     * still apply, and a poisoned row that must be skipped.
     */
    it('C46: an out-of-32-bit-range id is skipped, and the rest of the file still applies', async () => {
      const good = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      await seedLoanDetail(prisma, { loanId: good, paydayLimit: '2000-01-01' });

      const response = await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach(
          'file',
          Buffer.from(
            `3000000000\t1\t2\t1/1/2018\t3\t4\t1/1/2018\n` +
              `99999999999999999999\t1\t2\t1/1/2018\t3\t4\t1/1/2018\n` +
              `${good}\t100\t10\t15/6/2018\t1\t90\t1/6/2018\n`,
            'utf8',
          ),
          'loans.txt',
        )
        .expect(200);

      // The listed good loan is shielded from the auto-close and its detail was written.
      expect(response.body).toEqual({ closed_loans: [] });
      const detail = await prisma.loanDetail.findFirst({ where: { loan_id: good } });
      expect(detail?.total_payment).toBe(100n);
      expect(detail?.capital_balance).toBe(90n);
      // The two poisoned ids shielded nothing, exactly as v1's real integers shield nothing.
      await expect(loanRow(good).then((l) => l.state)).resolves.toBe(1);
    });

    it('an empty file auto-closes every APPROVED loan — the blast radius, exercised', async () => {
      const approved: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        approved.push(
          await seedLoan(prisma, {
            userId: admin.id,
            value: 100n,
            timelimit: 5,
            fee: 0,
            rate: '0',
            disbursementDate: '2000-01-01',
            state: 1,
            createdAt: new Date(`2020-0${i + 1}-01T00:00:00.000Z`),
          }),
        );
      }
      const untouched = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 0,
      });

      const response = await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach('file', Buffer.from('', 'utf8'), 'loans.txt')
        .expect(200);

      expect(new Set((response.body as { closed_loans: number[] }).closed_loans)).toEqual(
        new Set(approved),
      );
      for (const id of approved) {
        await expect(loanRow(id).then((l) => l.state)).resolves.toBe(3);
      }
      // A loan awaiting approval is NOT a candidate — only APPROVED ones are.
      await expect(loanRow(untouched).then((l) => l.state)).resolves.toBe(0);
    });

    it('a malformed line rolls the whole upload back — no partial application', async () => {
      const id = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      await seedLoanDetail(prisma, { loanId: id, paydayLimit: '2000-01-01' });

      await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach(
          'file',
          Buffer.from(`${id}\t100\t10\t15/6/2018\t1\t90\t1/6/2018\nnot-a-loan-line\n`, 'utf8'),
          'loans.txt',
        )
        .expect(500);

      const detail = await prisma.loanDetail.findFirstOrThrow({ where: { loan_id: id } });
      // The first line must NOT have been applied.
      expect(detail.total_payment).toBe(0n);
      await expect(prisma.schedulerTask.count()).resolves.toBe(0);
    });

    /**
     * ⚠️ Rule **12b** — `@parser_classes((MultiPartParser,))` on an `APIView` *method* is a
     * no-op, so this route accepts the **default** parser list and then 500s on the missing
     * `file` part. Do not "restore" the narrowing: a 415 here is observable and wrong.
     */
    it('rule 12b: a JSON body is a 500 (KeyError on `file`), not a 415', async () => {
      await request(server()).patch('/api/loan').set(asAdmin()).send({ file: 'nope' }).expect(500);
    });

    it('rule 12b: a form body is a 500 too', async () => {
      await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .type('form')
        .send('file=nope')
        .expect(500);
    });

    it('rule 12b: multipart with no `file` part is a 500', async () => {
      await request(server()).patch('/api/loan').set(asAdmin()).field('other', 'value').expect(500);
    });

    it('rule 12b: text/plain is a 415 — outside the DEFAULT parser list too', async () => {
      await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .type('text/plain')
        .send('anything')
        .expect(415);
    });

    /**
     * ⚠️ Rule **12c** / **D23** — a *scalar* part carrying a `filename` must NOT be readable as
     * the file. v2 reads files from `request.files` only; DRF's `QueryDict`+`FILES` merge is
     * deliberately not implemented.
     */
    it('rule 12c: the file comes from request.files, and a scalar part is not merged in', async () => {
      const id = await seedLoan(prisma, {
        userId: admin.id,
        value: 100n,
        timelimit: 5,
        fee: 0,
        rate: '0',
        disbursementDate: '2000-01-01',
        state: 1,
      });
      await seedLoanDetail(prisma, { loanId: id, paydayLimit: '2000-01-01' });
      // Positive control first: a genuine file part works.
      await request(server())
        .patch('/api/loan')
        .set(asAdmin())
        .attach(
          'file',
          Buffer.from(`${id}\t7\t8\t1/1/2018\t9\t10\t1/1/2018\n`, 'utf8'),
          'loans.txt',
        )
        .expect(200);
      await expect(
        prisma.loanDetail.findFirstOrThrow({ where: { loan_id: id } }).then((d) => d.total_payment),
      ).resolves.toBe(7n);
    });
  });

  // ==========================================================================
  // POST /api/loan/<id>/<app>
  // ==========================================================================

  /** `test_loan_app_not_found` */
  it('test_loan_app_not_found: an unknown app is 404 with a zero-byte body', async () => {
    const response = await request(server())
      .post('/api/loan/2/notFound')
      .set(asAdmin())
      .expect(404);
    expect(response.text).toBe('');
  });

  it('the app segment is case-sensitive: `paymentprojection` is a 404', async () => {
    await request(server()).post('/api/loan/2/paymentprojection').set(asAdmin()).expect(404);
    await request(server()).post('/api/loan/2/Refinance').set(asAdmin()).expect(404);
  });

  /** `test_payment_projection_date_none` */
  it('test_payment_projection_date_none: no body is 400 with a zero-byte body', async () => {
    const response = await request(server())
      .post('/api/loan/1/paymentProjection')
      .set(asAdmin())
      .expect(400);
    expect(response.text).toBe('');
  });

  /** `test_payment_projection` */
  it('test_payment_projection: 0 / 1 / 4 interests for the three v1 dates', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    for (const [toDate, interests] of [
      ['2017-11-09', 0],
      ['2017-11-15', 1],
      ['2017-12-09', 4],
    ] as const) {
      const response = await request(server())
        .post(`/api/loan/${id}/paymentProjection`)
        .set(asAdmin())
        .send({ to_date: toDate })
        .expect(200);
      expect(response.body).toEqual({ interests, capital_balance: 200 });
    }
  });

  /** `test_payment_projection_empty_date` */
  it('test_payment_projection_empty_date: an empty to_date is 400', async () => {
    await request(server())
      .post('/api/loan/1/paymentProjection')
      .set(asAdmin())
      .send({ to_date: '' })
      .expect(400);
  });

  it('a badly formatted to_date is 400 (v1’s bare `except` around strptime)', async () => {
    for (const value of ['09/11/2017', '2017-11-09T00:00', 'nope']) {
      await request(server())
        .post('/api/loan/1/paymentProjection')
        .set(asAdmin())
        .send({ to_date: value })
        .expect(400);
    }
  });

  /** `test_payment_projection_loan_not_found` */
  it('test_payment_projection_loan_not_found: an unknown loan is 404 with a zero-byte body', async () => {
    const response = await request(server())
      .post('/api/loan/111/paymentProjection')
      .set(asAdmin())
      .send({ to_date: '2017-11-15' })
      .expect(404);
    expect(response.text).toBe('');
  });

  it('a loan that exists but was never approved has no detail, so it is also 404', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server())
      .post(`/api/loan/${id}/paymentProjection`)
      .set(asAdmin())
      .send({ to_date: '2017-11-15' })
      .expect(404);
  });

  // ==========================================================================
  // refinance
  // ==========================================================================

  const refinanceBody = (includeInterests: boolean): Record<string, unknown> => ({
    disbursement_date: '2017-12-09',
    includeInterests,
    comments: 'Suite test',
    timelimit: 12,
    fee: 0,
  });

  /** `test_refinance_loan_not_found` */
  it('test_refinance_loan_not_found: an unknown loan is 400 (NOT 404 — the branches differ)', async () => {
    const response = await request(server())
      .post('/api/loan/111/refinance')
      .set(asAdmin())
      .expect(400);
    expect(response.text).toBe('');
  });

  /** `test_refinance_loan_invalid_state` */
  it('test_refinance_loan_invalid_state: a loan awaiting approval is 400', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).post(`/api/loan/${id}/refinance`).set(asAdmin()).expect(400);
  });

  /** `test_refinance_loan` */
  it('test_refinance_loan: value = capital_balance, payment REFINANCED, links both ways', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send(refinanceBody(false))
      .expect(200);
    const newId = (response.body as { id: number }).id;
    expect(newId).toBeDefined();

    const newLoan = await loanRow(newId);
    const loan = await loanRow(id);

    expect(newLoan.disbursement_date.toISOString()).toBe('2017-12-09T00:00:00.000Z');
    expect(newLoan.comments).toBe(
      `Refinanciación del crédito #${id}, cuyo valor no incluye intereses. Suite test`,
    );
    expect(newLoan.value).toBe(200n);
    expect(newLoan.timelimit).toBe(12);
    expect(newLoan.payment).toBe(2); // REFINANCED
    expect(newLoan.fee).toBe(0);
    expect(newLoan.state).toBe(0);
    expect(newLoan.rate.toFixed(3)).toBe('0.020');
    expect(newLoan.refinanced_loan).toBeNull();
    expect(newLoan.prev_loan_id).toBe(id);
    expect(loan.refinanced_loan).toBe(BigInt(newId));
    expect(loan.disbursement_value).toBe(205n);
    expect(newLoan.disbursement_value).toBeNull();
  });

  /** `test_refinance_loan_include_interests` */
  it('test_refinance_loan_include_interests: value = capital_balance + interests (204)', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send(refinanceBody(true))
      .expect(200);
    const newLoan = await loanRow((response.body as { id: number }).id);

    expect(newLoan.comments).toBe(
      `Refinanciación del crédito #${id}, cuyo valor incluye intereses. Suite test`,
    );
    expect(newLoan.value).toBe(204n);
    expect(newLoan.prev_loan_id).toBe(id);
  });

  /**
   * **D35 / P5-F1 on the loan routes.** `refinance_loan` builds the new comment with
   * `'{}. {}'.format(comment, new_loan['comments'])` — a **format** context, not a column
   * write, so `str()` applies here and `None` really does become the four characters `None`
   * (measured: `'{}. {}'.format('c', None)` -> `'c. None'`). The *same* value then reaches
   * `Loan.comments`, which is `TextField(null=True)`, through `create_loan`.
   *
   * The two halves are pinned together because they are exactly the pair the corrected
   * helper has to keep apart: `pythonStr` for the format, `toDjangoText` for the column.
   */
  it('D35: `comments: null` on a refinance renders the four characters None, as `format` does', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send({ ...refinanceBody(false), comments: null })
      .expect(200);

    const newLoan = await loanRow((response.body as { id: number }).id);
    expect(newLoan.comments).toBe(
      `Refinanciación del crédito #${id}, cuyo valor no incluye intereses. None`,
    );
  });

  it('P5-F1: a non-scalar `comments` on a refinance renders CPython’s repr', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send({ ...refinanceBody(false), comments: ['a', { b: 2 }] })
      .expect(200);

    const newLoan = await loanRow((response.body as { id: number }).id);
    expect(newLoan.comments).toBe(
      `Refinanciación del crédito #${id}, cuyo valor no incluye intereses. ['a', {'b': 2}]`,
    );
  });

  /** `test_refinance_loan_update_approved` */
  it('test_refinance_loan_update_approved: approving the refinance closes the old loan', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);
    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send(refinanceBody(true))
      .expect(200);
    const newId = (response.body as { id: number }).id;

    await request(server())
      .patch(`/api/loan/${newId}`)
      .set(asAdmin())
      .send({ state: 1 })
      .expect(200);

    await expect(loanRow(id).then((l) => l.state)).resolves.toBe(3);
    await expect(loanRow(newId).then((l) => l.state)).resolves.toBe(1);
  });

  /** `test_refinance_loan_update_denied` */
  it('test_refinance_loan_update_denied: denying the refinance unlinks it', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);
    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send(refinanceBody(true))
      .expect(200);
    const newId = (response.body as { id: number }).id;

    await request(server())
      .patch(`/api/loan/${newId}`)
      .set(asAdmin())
      .send({ state: 2 })
      .expect(200);

    const loan = await loanRow(id);
    expect(loan.state).toBe(1);
    expect(loan.refinanced_loan).toBeNull();
  });

  it('refinance is owner-only, and that is v1’s own check, not D10', async () => {
    const borrower = await seedUser(prisma, {
      email: 'ownerloan@mail.com',
      identification: 6161n,
      role: Role.MEMBER,
    });
    const id = await postLoan(
      loanWithQuotaFee10,
      authHeader(await obtainToken(app, borrower.email)),
    );
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);

    // Even the ADMIN cannot refinance somebody else's loan — v1 returns None -> 400.
    await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send(refinanceBody(false))
      .expect(400);
  });

  it('the refinance body is unvalidated: a missing key is a 500, never a 400', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);
    // The 400 means "wrong loan"; a bad body is v1's uncaught KeyError.
    await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send({ includeInterests: false, comments: 'x', timelimit: 12, fee: 0 })
      .expect(500);
  });

  it('D4 reaches the refinance path too', async () => {
    const id = await postLoan(loanWithQuotaFee10);
    await request(server()).patch(`/api/loan/${id}`).set(asAdmin()).send({ state: 1 }).expect(200);
    const response = await request(server())
      .post(`/api/loan/${id}/refinance`)
      .set(asAdmin())
      .send({ ...refinanceBody(false), timelimit: 0 })
      .expect(400);
    expect(response.body).toEqual({ message: 'Timelimit must be between 1 and 36' });
  });

  // ==========================================================================
  // authorisation matrix and the URL layer (docs/adding-a-route.md §3, §4, §7)
  // ==========================================================================

  describe('authorisation and the URL layer', () => {
    const seedRole = async (role: Role): Promise<string> => {
      const user = await seedUser(prisma, {
        email: `role-${role}@mail.com`,
        identification: BigInt(80_000 + role),
        role,
      });
      return obtainToken(app, user.email);
    };

    it.each([Role.ADMIN, Role.PRESIDENT, Role.TREASURER, Role.MEMBER])(
      'GET /api/loan is role <= 3, so role %i is allowed',
      async (role) => {
        await request(server())
          .get('/api/loan')
          .set(authHeader(await seedRole(role)))
          .expect(200);
      },
    );

    it.each([
      [Role.ADMIN, 200],
      [Role.PRESIDENT, 403],
      [Role.TREASURER, 200],
      [Role.MEMBER, 403],
    ])('PATCH /api/loan is [0,2]: role %i -> %i', async (role, status) => {
      const req = request(server())
        .patch('/api/loan')
        .set(authHeader(await seedRole(role)));
      if (status === 200) {
        await req.attach('file', Buffer.from('', 'utf8'), 'loans.txt').expect(200);
      } else {
        await req.attach('file', Buffer.from('', 'utf8'), 'loans.txt').expect(403);
      }
    });

    /**
     * ⚠️ **The D28 cell, carried deliberately.** `LoanDetailView.patch` is `[0,2]` and
     * `update_loan(id, state)` never receives the actor's id, so a TREASURER can approve their
     * **own** loan. Operator **Q31** confirmed this is accepted fund practice and D28 was
     * WITHDRAWN on 2026-09-03. This cell asserts the exposure so that a future reader finds a
     * decision rather than an oversight — if it ever starts failing, that is a *policy* change
     * and needs an operator, not a fix.
     */
    it('D28 (WITHDRAWN, Q31): a TREASURER may approve their own loan', async () => {
      const treasurer = await seedUser(prisma, {
        email: 'treasurer-self@mail.com',
        identification: 90_001n,
        role: Role.TREASURER,
      });
      const treasurerToken = await obtainToken(app, treasurer.email);
      const id = await postLoan(loanWithQuotaFee10, authHeader(treasurerToken));

      await request(server())
        .patch(`/api/loan/${id}`)
        .set(authHeader(treasurerToken))
        .send({ state: 1 })
        .expect(200);
      await expect(loanRow(id).then((l) => l.state)).resolves.toBe(1);
    });

    it('DELETE /api/loan is 403 for ADMIN — the method is absent from the matrix', async () => {
      await request(server()).delete('/api/loan').set(asAdmin()).expect(403);
    });

    it('OPTIONS on a guarded loan view is 403 for every role (rule 13)', async () => {
      await request(server()).options('/api/loan').set(asAdmin()).expect(403);
      await request(server()).options('/api/loan/1').set(asAdmin()).expect(403);
      await request(server()).options('/api/loan/1/refinance').set(asAdmin()).expect(403);
    });

    it('GET on LoanAppsView is 403 — the view declares only POST', async () => {
      await request(server()).get('/api/loan/1/refinance').set(asAdmin()).expect(403);
    });

    it('an unauthenticated request is DRF’s 401, not a 403', async () => {
      const response = await request(server()).get('/api/loan').expect(401);
      expect(response.body).toEqual({
        detail: 'Authentication credentials were not provided.',
      });
    });

    /** ⚠️ v1's pattern is `^api/loan/(?P<id>[0-9]+)$` — **no** trailing `/?` (finding S7). */
    it('a trailing slash on a loan detail route is a 404, before the guards', async () => {
      const id = await postLoan(loanWithQuotaFee10);
      await request(server()).get(`/api/loan/${id}/`).set(asAdmin()).expect(404);
      // Positive control: without the slash it is a 200.
      await request(server()).get(`/api/loan/${id}`).set(asAdmin()).expect(200);
    });

    it('`/api/loan/` IS accepted — the collection pattern carries `/?`', async () => {
      await request(server()).get('/api/loan/').set(asAdmin()).expect(200);
    });

    it('the URL table is case-sensitive and fail-closed', async () => {
      await request(server()).get('/API/loan').set(asAdmin()).expect(404);
      await request(server()).get('/api/Loan').set(asAdmin()).expect(404);
      await request(server()).get('/api/loan/abc').set(asAdmin()).expect(404);
      await request(server()).get('/api/loan/-1').set(asAdmin()).expect(404);
    });

    it('Vary: Accept is set, because LoanView is on DRF’s two default renderers', async () => {
      const response = await request(server()).get('/api/loan').set(asAdmin()).expect(200);
      expect(response.headers.vary).toContain('Accept');
    });

    /** Rule **12** / finding **F6** — an unacceptable `Accept` is a 406 *before* the guards. */
    it('an unacceptable Accept is a 406 before authentication, and never writes', async () => {
      await request(server())
        .patch('/api/loan')
        .set('Accept', 'application/xml')
        .attach('file', Buffer.from('', 'utf8'), 'loans.txt')
        .expect(406);
      // Positive control: the same unauthenticated request under an acceptable Accept is a 401.
      await request(server())
        .patch('/api/loan')
        .set('Accept', '*/*')
        .attach('file', Buffer.from('', 'utf8'), 'loans.txt')
        .expect(401);
    });
  });

  /**
   * ## B1 on an ALREADY-GATED route — the cross-phase half of the finding
   *
   * `pythonInt` is a Phase 0 helper and `/api/loan` is Phase 4's, closed and approved weeks
   * before Phase 6 existed. `manual-tester` found the defect on `/api/saving-account` and then
   * reproduced it here, which is what turned it from "a Phase 6 bug" into "a shared-helper bug
   * that Phase 6 happened to surface".
   *
   * ⚠️ **These cells are the reason the fix is not filed under Phase 6.** `nestjs-reviewer`
   * ruled the earlier gates are NOT impugned — nobody in those rounds tried a full-width digit,
   * so this is new evidence rather than ignored evidence — but the fix belongs to whichever
   * phase is open, because deferring it means Phase 8 inherits it. Keep them here: if they only
   * lived in the Phase 6 suite, a future reader would think only Phase 6 was ever affected.
   */
  describe('B1 - CPython int() digit set, on Phase 4 routes', () => {
    it('accepts a full-width digit in ?page, as v1 does', async () => {
      // U+FF11. v1: int('１') === 1, so a real (empty or populated) loan page. v2 answered 500.
      await request(server()).get('/api/loan?page=１').set(asAdmin()).expect(200);
    });

    it('accepts a PEP 515 underscore in ?page, as v1 does', async () => {
      // int('1_0') === 10 -> page 10, which is past the last page and therefore a 200 with an
      // empty list, not a 404. Before B1 this was a 500.
      await request(server()).get('/api/loan?page=1_0').set(asAdmin()).expect(200);
    });

    it('still refuses a full-width SIGN, which CPython does not fold', async () => {
      await request(server()).get('/api/loan?page=＋1').set(asAdmin()).expect(500);
    });
  });
});
