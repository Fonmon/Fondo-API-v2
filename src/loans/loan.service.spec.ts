import { HttpStatus } from '@nestjs/common';
import { Role } from '../auth/permissions/roles';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { DrfException } from '../common/http/drf.exception';
import { EmailTemplate } from '../mail/email-template';
import type { MailService } from '../mail/mail.service';
import type { NotificationService } from '../notifications/notification.service';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { UserService } from '../users/user.service';
import { USER_READ_PRIVILEGED_ROLES } from '../users/user.service';
import {
  assertLegalLoanTransition,
  LoanService,
  LOAN_READ_PRIVILEGED_ROLES,
  strptimeIsoDate,
} from './loan.service';
import { FEE_MONTHLY } from './dto/loan.serializers';

/**
 * `fondo_api/services/loan.py:LoanService`, unit level — Prisma and both external boundaries
 * (SES via {@link MailService}, SQS via {@link NotificationService}) are mocked, which is the
 * shape v1's own suite uses (`@patch.object(MailService, 'send_mail')`).
 *
 * The DB-backed behaviour is `test/loan.e2e-spec.ts`; the money maths is
 * `amortization.spec.ts`. What lives here is the logic that can be wrong with no database
 * involved: the quota gate, the D4 bound, the D9 transition table, the D10 predicate, the SES
 * envelope, the auto-close selection and the TSV column map.
 */
describe('LoanService (unit)', () => {
  const ADMIN: AuthenticatedUser = actor(1, Role.ADMIN);
  const MEMBER: AuthenticatedUser = actor(2, Role.MEMBER);

  // ==========================================================================
  // D9 / D27 — the transition table
  // ==========================================================================
  describe('assertLegalLoanTransition — deviation D9 (operator Q14)', () => {
    it.each([
      [0, 1],
      [0, 2],
      [1, 3],
      [1, 2],
    ])('allows %i -> %i', (from, to) => {
      expect(() => assertLegalLoanTransition(from, to)).not.toThrow();
    });

    it.each([
      [0, 0],
      [0, 3],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
    ])('refuses %i -> %i with 409', (from, to) => {
      expectRefusal(() => assertLegalLoanTransition(from, to), HttpStatus.CONFLICT, {
        message: 'Invalid state transition',
      });
    });

    /**
     * ⚠️ `LoanDetailView.patch` only checks `new_state <= 3`, so v1 happily writes a negative
     * state into the column and every screen then renders an unknown state.
     */
    it('refuses the negative states LoanDetailView.patch lets through', () => {
      expectRefusal(() => assertLegalLoanTransition(0, -1), HttpStatus.CONFLICT);
      expectRefusal(() => assertLegalLoanTransition(1, -5), HttpStatus.CONFLICT);
    });

    it('1 -> 3 is legal, because that is exactly what the auto-close does', () => {
      expect(() => assertLegalLoanTransition(1, 3)).not.toThrow();
    });
  });

  // ==========================================================================
  // D10 / D25 — the shared predicate
  // ==========================================================================
  describe('D10 and D25 share one predicate — they must not drift', () => {
    /**
     * ⚠️ **The only mechanical guard.** D25 restricts `GET /api/user/<id>` and D10 restricts
     * `GET /api/loan/<id>` with "the record's owner plus roles `[0,1,2]`". The plan requires
     * them to land in the same phase precisely so a later change cannot tighten one alone;
     * this asserts the two arrays are still equal.
     */
    it('LOAN_READ_PRIVILEGED_ROLES equals USER_READ_PRIVILEGED_ROLES', () => {
      expect([...LOAN_READ_PRIVILEGED_ROLES]).toEqual([...USER_READ_PRIVILEGED_ROLES]);
      expect([...LOAN_READ_PRIVILEGED_ROLES]).toEqual([Role.ADMIN, Role.PRESIDENT, Role.TREASURER]);
    });

    it('MEMBER is deliberately absent from the privileged set', () => {
      expect(LOAN_READ_PRIVILEGED_ROLES).not.toContain(Role.MEMBER);
    });
  });

  // ==========================================================================
  // strptime
  // ==========================================================================
  describe('strptimeIsoDate — datetime.strptime(value, "%Y-%m-%d")', () => {
    it('accepts an unpadded month and day, as %m/%d do', () => {
      expect(strptimeIsoDate('2017-12-9')).toEqual({ year: 2017, month: 12, day: 9 });
      expect(strptimeIsoDate('2018-1-1')).toEqual({ year: 2018, month: 1, day: 1 });
    });

    it('accepts a zero-padded date', () => {
      expect(strptimeIsoDate('2017-11-09')).toEqual({ year: 2017, month: 11, day: 9 });
    });

    it.each(['', '2017/11/09', '09-11-2017', '2017-11-09T00:00', '2017-11-09\n', 'abc'])(
      'rejects %p — the view turns this into a 400',
      (value) => {
        expect(() => strptimeIsoDate(value)).toThrow();
      },
    );

    it('rejects an out-of-range calendar date', () => {
      expect(() => strptimeIsoDate('2018-02-30')).toThrow();
      expect(() => strptimeIsoDate('2018-13-01')).toThrow();
      expect(() => strptimeIsoDate('2019-02-29')).toThrow();
    });

    it('accepts 29 February in a leap year', () => {
      expect(strptimeIsoDate('2020-02-29')).toEqual({ year: 2020, month: 2, day: 29 });
    });

    it('rejects a non-string, as strptime does', () => {
      expect(() => strptimeIsoDate(20171109)).toThrow(/strptime/);
      expect(() => strptimeIsoDate(null)).toThrow(/strptime/);
    });
  });

  // ==========================================================================
  // create_loan
  // ==========================================================================
  describe('createLoan', () => {
    const BODY = {
      value: 100,
      timelimit: 5,
      disbursement_date: '2017-12-9',
      comments: '',
      payment: 0,
      fee: 0,
      disbursement_value: 105,
    };

    it('test_post_loan_1: writes the row with the ≤6 rate and WAITING_APPROVAL', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await expect(service.createLoan(1, BODY)).resolves.toBe(77);

      const data = firstArg(prisma.loan.create).data as Record<string, unknown>;
      expect(data.value).toBe(100n);
      expect(data.timelimit).toBe(5);
      expect(data.fee).toBe(0);
      expect(data.payment).toBe(0);
      expect(data.state).toBe(0);
      expect(data.comments).toBe('');
      expect(data.disbursement_value).toBe(105n);
      expect(data.prev_loan_id).toBeNull();
      expect((data.rate as Prisma.Decimal).toFixed(3)).toBe('0.015');
      expect((data.disbursement_date as Date).toISOString()).toBe('2017-12-09T00:00:00.000Z');
      // `auto_now_add` is application-set — the column has no DB default (rule 5).
      expect(data.created_at).toBeInstanceOf(Date);
    });

    it.each([
      [5, '0.015'],
      [10, '0.020'],
      [20, '0.022'],
      [30, '0.025'],
    ])('test_post_loan_1..4: timelimit %i freezes rate %s', async (timelimit, rate) => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, value: 300, timelimit });
      const data = firstArg(prisma.loan.create).data as Record<string, unknown>;
      expect((data.rate as Prisma.Decimal).toFixed(3)).toBe(rate);
      expect(data.timelimit).toBe(timelimit);
    });

    /** `test_post_loan_5` — the clamp is **silent** and is deliberately kept (brief scope). */
    it('test_post_loan_5: timelimit 37 is silently clamped to 36 and priced at 0.025', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, value: 300, timelimit: 37 });
      const data = firstArg(prisma.loan.create).data as Record<string, unknown>;
      expect(data.timelimit).toBe(36);
      expect((data.rate as Prisma.Decimal).toFixed(3)).toBe('0.025');
    });

    it('the clamp happens BEFORE the rate lookup, so 1000 is 0.025 and not the 0.015 fallthrough', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, value: 300, timelimit: 1000 });
      const data = firstArg(prisma.loan.create).data as Record<string, unknown>;
      expect((data.rate as Prisma.Decimal).toFixed(3)).toBe('0.025');
    });

    /** `test_post_loan_error`. */
    it('test_post_loan_error: value above available_quota is 406 and writes nothing', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await expect(service.createLoan(1, { ...BODY, value: 600 })).rejects.toMatchObject({
        body: { message: 'User does not have available quota' },
      });
      try {
        await service.createLoan(1, { ...BODY, value: 600 });
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_ACCEPTABLE);
      }
      expect(prisma.loan.create).not.toHaveBeenCalled();
    });

    it('exactly equal to available_quota is accepted — the check is `>`, not `>=`', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, value: 500 });
      expect(prisma.loan.create).toHaveBeenCalled();
    });

    it('the quota check is skipped for a refinance', async () => {
      const { service, prisma } = build({ available_quota: 1n });
      await service.createLoan(1, { ...BODY, value: 999_999 }, true, { id: 4 });
      expect(prisma.loan.create).toHaveBeenCalled();
      expect((firstArg(prisma.loan.create).data as Record<string, unknown>).prev_loan_id).toBe(4);
    });

    /** **D4** — the bound v1 does not have. */
    it('D4: timelimit 0 is a 400 and writes nothing (v1 writes the row, then 500s at approval)', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await expect(service.createLoan(1, { ...BODY, timelimit: 0 })).rejects.toMatchObject({
        body: { message: 'Timelimit must be greater or equal than 1' },
      });
      try {
        await service.createLoan(1, { ...BODY, timelimit: 0 });
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
      expect(prisma.loan.create).not.toHaveBeenCalled();
    });

    it('D4: a negative timelimit is refused too', async () => {
      const { service } = build({ available_quota: 500n });
      await expectAsyncRefusal(
        () => service.createLoan(1, { ...BODY, timelimit: -3 }),
        HttpStatus.BAD_REQUEST,
        { message: 'Timelimit must be greater or equal than 1' },
      );
    });

    it('D4: timelimit 1 is the lowest accepted value', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, timelimit: 1 });
      expect((firstArg(prisma.loan.create).data as Record<string, unknown>).timelimit).toBe(1);
    });

    /**
     * ⚠️ Ordering: v1 evaluates the quota comparison first, so a member who is *both* over
     * quota and sending `timelimit: 0` still gets v1's 406, not D4's 400. Keeping D4 behind
     * the quota gate keeps that request byte-identical to v1's.
     */
    it('D4 sits BEHIND the quota check, so an over-quota request is still a 406', async () => {
      const { service } = build({ available_quota: 10n });
      try {
        await service.createLoan(1, { ...BODY, value: 999, timelimit: 0 });
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_ACCEPTABLE);
      }
    });

    it('always pushes to roles [0,2] with the loan target, after the row is written', async () => {
      const { service, notifications, users } = build({ available_quota: 500n });
      await service.createLoan(1, BODY);
      expect(users.getUserIds).toHaveBeenCalledWith([0, 2]);
      expect(notifications.sendNotification).toHaveBeenCalledWith(
        [1, 3],
        'Ha sido creada una nueva solicitud de crédito',
        '/loan/77',
      );
    });

    it('null comments and null disbursement_value stay SQL NULL', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, comments: null, disbursement_value: null });
      const data = firstArg(prisma.loan.create).data as Record<string, unknown>;
      expect(data.comments).toBeNull();
      expect(data.disbursement_value).toBeNull();
    });

    it('accepts an unpadded disbursement_date, as Django’s parse_date does', async () => {
      const { service, prisma } = build({ available_quota: 500n });
      await service.createLoan(1, { ...BODY, disbursement_date: '2018-1-1' });
      const data = firstArg(prisma.loan.create).data as Record<string, unknown>;
      expect((data.disbursement_date as Date).toISOString()).toBe('2018-01-01T00:00:00.000Z');
    });

    it('a missing UserFinance row is a 500, as `UserFinance.objects.get` is', async () => {
      const { service } = build(null);
      await expect(service.createLoan(1, BODY)).rejects.toThrow(/UserFinance matching query/);
    });
  });

  // ==========================================================================
  // update_loan
  // ==========================================================================
  describe('updateLoan', () => {
    it('test_update_loan_not_found: a missing loan is 404 with v1’s message', async () => {
      const { service } = buildUpdate(null);
      try {
        await service.updateLoan(99, 1);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect((error as ApiException).body).toEqual({ message: 'Loan does not exist' });
      }
    });

    it('test_update_loan_approved_monthly: SES envelope and LoanDetail match v1', async () => {
      const { service, prisma, mail } = buildUpdate(loanRow({ state: 0 }));
      const detail = await service.updateLoan(5, 1);

      expect(detail).toEqual({
        minimum_payment: 24n,
        total_payment: 222n,
        payday_limit: '9 dic. 2017',
        interests: 4n,
        capital_balance: 200n,
        from_date: '9 nov. 2017',
      });
      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      const [template, to, params, bcc] = mail.sendMail.mock.calls[0] as [
        EmailTemplate,
        string[],
        Record<string, unknown>,
        string[],
      ];
      expect(template).toBe(EmailTemplate.CHANGE_STATE_LOAN_APPROVED);
      expect(to).toEqual(['borrower@mail.com']);
      expect(bcc).toEqual(['admin@mail.com', 'treasurer@mail.com']);
      expect(params.loan_id).toBe(5);
      expect(params.loan_table).toContain('<td>9 sept. 2018</td>');

      // The LoanDetail is written with the *loan's* value and disbursement date.
      const created = firstArg(prisma.loanDetail.create).data as Record<string, unknown>;
      expect(created.capital_balance).toBe(200n);
      expect(created.from_date).toEqual(new Date('2017-11-09T00:00:00.000Z'));
      expect(created.loan_id).toBe(5);
    });

    it('D6: an existing LoanDetail is UPDATED, never a second row inserted', async () => {
      const { service, prisma } = buildUpdate(loanRow({ state: 0 }), { existingDetailId: 42 });
      await service.updateLoan(5, 1);
      expect(prisma.loanDetail.create).not.toHaveBeenCalled();
      expect(prisma.loanDetail.update).toHaveBeenCalledTimes(1);
      expect(firstArg(prisma.loanDetail.update).where).toEqual({ id: 42 });
    });

    it('D9: re-approving an APPROVED loan is 409, with no mail and no write', async () => {
      const { service, prisma, mail } = buildUpdate(loanRow({ state: 1 }));
      try {
        await service.updateLoan(5, 1);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.CONFLICT);
      }
      expect(mail.sendMail).not.toHaveBeenCalled();
      expect(prisma.loan.update).not.toHaveBeenCalled();
      expect(prisma.loanDetail.create).not.toHaveBeenCalled();
    });

    it('D9: re-opening a PAID_OUT loan is 409 — the case D6 exists to survive', async () => {
      const { service, prisma } = buildUpdate(loanRow({ state: 3 }));
      await expectAsyncRefusal(() => service.updateLoan(5, 1), HttpStatus.CONFLICT, {
        message: 'Invalid state transition',
      });
      expect(prisma.loan.update).not.toHaveBeenCalled();
    });

    it('the 404 precedes the 409, so a missing id never leaks as a conflict', async () => {
      const { service } = buildUpdate(null);
      try {
        await service.updateLoan(5, 1);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('test_update_loan_denied: state 2 mails DENIED and returns the empty string', async () => {
      const { service, mail } = buildUpdate(loanRow({ state: 0 }));
      await expect(service.updateLoan(5, 2)).resolves.toBe('');
      expect(mail.sendMail).toHaveBeenCalledWith(
        EmailTemplate.CHANGE_STATE_LOAN_DENIED,
        ['borrower@mail.com'],
        { loan_id: 5 },
        ['admin@mail.com', 'treasurer@mail.com'],
      );
    });

    it('test_refinance_loan_update_approved: approving a refinance closes the previous loan', async () => {
      const { service, prisma } = buildUpdate(loanRow({ state: 0, prev_loan_id: 4 }));
      await service.updateLoan(5, 1);
      const updates = callArgs(prisma.loan.update);
      expect(updates).toContainEqual({ where: { id: 4 }, data: { state: 3 } });
    });

    it('test_refinance_loan_update_denied: denying a refinance unlinks the previous loan', async () => {
      const { service, prisma } = buildUpdate(loanRow({ state: 0, prev_loan_id: 4 }));
      await service.updateLoan(5, 2);
      const updates = callArgs(prisma.loan.update);
      expect(updates).toContainEqual({ where: { id: 4 }, data: { refinanced_loan: null } });
    });

    it('state 3 removes the payment reminders and sends no mail', async () => {
      const { service, mail, notifications } = buildUpdate(loanRow({ state: 1 }));
      await expect(service.updateLoan(5, 3)).resolves.toBe('');
      expect(mail.sendMail).not.toHaveBeenCalled();
      expect(notifications.removeSchNotifications).toHaveBeenCalledWith(
        'payment_reminder',
        5,
        expect.anything(),
      );
    });

    it('⚠️ a 1 -> 2 denial does NOT clear the reminders — only state 3 does (v1)', async () => {
      const { service, notifications } = buildUpdate(loanRow({ state: 1 }));
      await service.updateLoan(5, 2);
      expect(notifications.removeSchNotifications).not.toHaveBeenCalled();
    });

    it('D28 (withdrawn): update_loan never receives an actor — self-approval is not blocked', () => {
      // Operator Q31: a TREASURER approving their own loan is accepted fund practice. The
      // signature is the evidence — there is no actor to check against, deliberately.
      expect(LoanService.prototype.updateLoan.length).toBe(2);
    });
  });

  // ==========================================================================
  // D10 on the reads
  // ==========================================================================
  describe('getLoan — deviation D10', () => {
    it('lets the owner read their own loan', async () => {
      const { service } = buildRead(loanRow({ state: 0, user_id: 2 }));
      await expect(service.getLoan(MEMBER, 5)).resolves.toMatchObject({
        loan: { id: 5 },
      });
    });

    it.each([Role.ADMIN, Role.PRESIDENT, Role.TREASURER])(
      'lets role %i read any member’s loan',
      async (role) => {
        const { service } = buildRead(loanRow({ state: 0, user_id: 99 }));
        await expect(service.getLoan(actor(7, role), 5)).resolves.toBeDefined();
      },
    );

    it('refuses a MEMBER reading another member’s loan with DRF’s generic 403', async () => {
      const { service } = buildRead(loanRow({ state: 0, user_id: 99 }));
      await expect(service.getLoan(MEMBER, 5)).rejects.toThrow(DrfException);
      try {
        await service.getLoan(MEMBER, 5);
      } catch (error) {
        expect((error as DrfException).getStatus()).toBe(HttpStatus.FORBIDDEN);
      }
    });

    it('a missing loan is 404 for everyone, before D10 can produce a 403', async () => {
      const { service } = buildRead(null);
      try {
        await service.getLoan(MEMBER, 5);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('loan_detail is present only for an APPROVED loan', async () => {
      const approved = buildRead(loanRow({ state: 1, user_id: 2 }), { detail: true });
      await expect(approved.service.getLoan(ADMIN, 5)).resolves.toHaveProperty('loan_detail');

      const paidOut = buildRead(loanRow({ state: 3, user_id: 2 }), { detail: true });
      const result = await paidOut.service.getLoan(ADMIN, 5);
      expect(result.loan_detail).toBeUndefined();
    });
  });

  describe('paymentProjection — deviation D10', () => {
    it('test_payment_projection: 0 / 1 / 4 for the three v1 cells', async () => {
      for (const [to, expected] of [
        ['2017-11-09', 0n],
        ['2017-11-15', 1n],
        ['2017-12-09', 4n],
      ] as const) {
        const { service } = buildProjection();
        await expect(service.paymentProjection(ADMIN, 5, strptimeIsoDate(to))).resolves.toEqual({
          interests: expected,
          capital_balance: 200n,
        });
      }
    });

    it('a loan with no LoanDetail is a 404, even if the loan exists', async () => {
      const { service } = buildProjection({ detail: null });
      try {
        await service.paymentProjection(ADMIN, 5, strptimeIsoDate('2017-12-09'));
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('refuses a MEMBER projecting another member’s loan', async () => {
      const { service } = buildProjection({ ownerId: 99 });
      await expect(
        service.paymentProjection(MEMBER, 5, strptimeIsoDate('2017-12-09')),
      ).rejects.toThrow(DrfException);
    });

    it('a null actor skips D10 — the internal call from refinanceLoan', async () => {
      const { service } = buildProjection({ ownerId: 99 });
      await expect(
        service.paymentProjection(null, 5, strptimeIsoDate('2017-12-09')),
      ).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // bulk_update_loans
  // ==========================================================================
  describe('bulkUpdateLoans', () => {
    /** `create_test_file()` from `test_loan_views.py:713-722`, byte for byte. */
    const V1_FILE = Buffer.from(
      '1\t1234\t5678\t1/1/2018\t13\t24\t2/2/2018\r\n' +
        '2\t4321\t8765\t2/1/2018\t45\t56\t3/3/2018\r\n' +
        '3\t1\t2\t3/1/2017\t4\t5\t1/1/2017\r\n' +
        '5\t1\t2\t3/1/2017\t4\t5\t3/3/2017\r\n',
      'utf8',
    );

    it('test_bulk_update_loans: the column map is 0=id 1=total 2=min 3=payday 4=int 5=cap 6=from', async () => {
      const { service, prisma } = buildBulk({ existingDetailFor: [1, 2, 3], approved: [] });
      await service.bulkUpdateLoans(V1_FILE);

      const updates = callArgs(prisma.loanDetail.update).map((call) => call.data);
      expect(updates[0]).toEqual({
        total_payment: 1234n,
        minimum_payment: 5678n,
        payday_limit: new Date('2018-01-01T00:00:00.000Z'),
        interests: 13n,
        capital_balance: 24n,
        from_date: new Date('2018-02-02T00:00:00.000Z'),
      });
      // Row 2 pins that D/M/Y is not Y/M/D: '2/1/2018' is 2 January, not 1 February.
      expect(updates[1]).toMatchObject({
        payday_limit: new Date('2018-01-02T00:00:00.000Z'),
        from_date: new Date('2018-03-03T00:00:00.000Z'),
      });
      expect(updates[2]).toMatchObject({
        payday_limit: new Date('2017-01-03T00:00:00.000Z'),
        from_date: new Date('2017-01-01T00:00:00.000Z'),
      });
    });

    it('test_bulk_update_loans: an id with no LoanDetail is logged and skipped, not created', async () => {
      const { service, prisma } = buildBulk({ existingDetailFor: [1, 2, 3], approved: [] });
      await service.bulkUpdateLoans(V1_FILE);
      // Loan 5 is in the file and has no detail row.
      expect(prisma.loanDetail.update).toHaveBeenCalledTimes(3);
      expect(prisma.loanDetail.create).not.toHaveBeenCalled();
    });

    it('schedules TWO payment reminders per updated loan, at T-5d and T-1d', async () => {
      const { service, notifications } = buildBulk({ existingDetailFor: [1], approved: [] });
      await service.bulkUpdateLoans(
        Buffer.from('1\t100\t10\t15/6/2018\t1\t90\t1/6/2018\n', 'utf8'),
      );
      expect(notifications.scheduleNotification).toHaveBeenCalledTimes(2);
      const [firstDate, firstPayload, firstRepeat] = notifications.scheduleNotification.mock
        .calls[0] as [unknown, Record<string, unknown>, number];
      const [secondDate] = notifications.scheduleNotification.mock.calls[1] as [unknown];
      expect(firstDate).toEqual({ year: 2018, month: 6, day: 10 });
      expect(secondDate).toEqual({ year: 2018, month: 6, day: 14 });
      // repeat is NONE, unlike the birthday task's YEARLY.
      expect(firstRepeat).toBe(0);
      expect(firstPayload).toEqual({
        type: 'payment_reminder',
        owner_id: 1,
        user_ids: [2],
        target: '/loan/1',
        message: 'Recuerde que la fecha límite de pago para el crédito 1, es el: 15 jun. 2018',
      });
      // Key insertion order is v1's.
      expect(Object.keys(firstPayload)).toEqual([
        'type',
        'owner_id',
        'user_ids',
        'target',
        'message',
      ]);
    });

    it('the reminder dates cross a month boundary by day arithmetic, not by clamping', async () => {
      const { service, notifications } = buildBulk({ existingDetailFor: [1], approved: [] });
      await service.bulkUpdateLoans(Buffer.from('1\t100\t10\t3/3/2018\t1\t90\t1/1/2018\n', 'utf8'));
      const dates = callArgs(notifications.scheduleNotification);
      expect(dates).toEqual([
        { year: 2018, month: 2, day: 26 },
        { year: 2018, month: 3, day: 2 },
      ]);
    });

    /** **The auto-close.** */
    it('auto-closes every APPROVED loan absent from the file, and only those', async () => {
      const { service, prisma } = buildBulk({
        existingDetailFor: [1, 2, 3],
        approved: [1, 2, 3, 4, 9],
      });
      const result = await service.bulkUpdateLoans(V1_FILE);
      // 4 and 9 are approved and absent; 1/2/3 are present; 5 is in the file but not approved.
      expect(result.closed_loans).toEqual([4, 9]);
      const closes = callArgs(prisma.loan.update);
      expect(closes).toEqual([
        { where: { id: 4 }, data: { state: 3 } },
        { where: { id: 9 }, data: { state: 3 } },
      ]);
    });

    /**
     * ⚠️ An id present in the file but with **no `LoanDetail`** is still appended to
     * `loan_ids` *before* the update is attempted (`services/loan.py`), so it shields itself
     * from the auto-close. Getting that ordering wrong closes a loan the treasurer listed.
     */
    it('an id in the file with no LoanDetail still shields itself from the auto-close', async () => {
      const { service } = buildBulk({ existingDetailFor: [1], approved: [1, 5] });
      const result = await service.bulkUpdateLoans(V1_FILE);
      // 5 is in the file (and approved) but has no detail row — it must NOT be closed.
      expect(result.closed_loans).toEqual([]);
    });

    it('the auto-close is silent: no mail, no push', async () => {
      const { service, mail, notifications } = buildBulk({
        existingDetailFor: [],
        approved: [7],
      });
      await service.bulkUpdateLoans(Buffer.from('', 'utf8'));
      expect(mail.sendMail).not.toHaveBeenCalled();
      expect(notifications.sendNotification).not.toHaveBeenCalled();
      expect(notifications.removeSchNotifications).toHaveBeenCalledWith(
        'payment_reminder',
        7,
        expect.anything(),
      );
    });

    it('D8: returns the ids it closed, where v1 returns a bodyless 200', async () => {
      const { service } = buildBulk({ existingDetailFor: [], approved: [11, 12] });
      await expect(service.bulkUpdateLoans(Buffer.from('', 'utf8'))).resolves.toEqual({
        closed_loans: [11, 12],
      });
    });

    it('an empty file closes EVERY approved loan — the blast radius, stated', async () => {
      const { service } = buildBulk({ existingDetailFor: [], approved: [1, 2, 3, 4, 5] });
      const result = await service.bulkUpdateLoans(Buffer.from('', 'utf8'));
      expect(result.closed_loans).toEqual([1, 2, 3, 4, 5]);
    });

    it('a malformed line throws, so the whole upload rolls back', async () => {
      const { service } = buildBulk({ existingDetailFor: [1], approved: [] });
      await expect(
        service.bulkUpdateLoans(Buffer.from('1\t100\t10\t1/1/2018\t1\t2\t1/1/2018\nnope\n')),
      ).rejects.toThrow();
    });

    it('a short row is an IndexError, as Python list indexing is', async () => {
      const { service } = buildBulk({ existingDetailFor: [1], approved: [] });
      await expect(service.bulkUpdateLoans(Buffer.from('1\t100\t10\t1/1/2018\n'))).rejects.toThrow(
        /IndexError/,
      );
    });

    it('everything runs on the transaction client, never on the pooled one', async () => {
      const { service, prisma, tx } = buildBulk({ existingDetailFor: [1], approved: [2] });
      await service.bulkUpdateLoans(V1_FILE);
      // The pooled client's model accessors must not have been touched inside the unit.
      expect(prisma.loanDetail.update).toBe(tx.loanDetail.update);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/**
 * Asserts a refusal by its **status and body**, not merely by its class.
 *
 * ⚠️ `toThrow(ApiException)` does not type-check — the constructor is private, deliberately,
 * so that every instance comes from one of the three named factories. That is a happy
 * accident: asserting the class alone would pass for *any* refusal, which is the shape of
 * false-green #4 (a matrix satisfied by a uniform failure). Status plus body discriminates.
 */
function expectRefusal(run: () => void, status: number, body?: Record<string, unknown>): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiException);
  expect((thrown as ApiException).getStatus()).toBe(status);
  if (body !== undefined) {
    expect((thrown as ApiException).body).toEqual(body);
  }
}

/** {@link expectRefusal} for a promise. */
async function expectAsyncRefusal(
  run: () => Promise<unknown>,
  status: number,
  body?: Record<string, unknown>,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiException);
  expect((thrown as ApiException).getStatus()).toBe(status);
  if (body !== undefined) {
    expect((thrown as ApiException).body).toEqual(body);
  }
}

function actor(id: number, role: Role): AuthenticatedUser {
  return {
    id,
    username: `user${id}`,
    email: `user${id}@mail.com`,
    isActive: true,
    profile: { role },
  } as unknown as AuthenticatedUser;
}

function firstArg(mock: jest.Mock): Record<string, unknown> {
  return callArgs(mock)[0];
}

/** Every call's **first** argument, typed — `mock.calls` is `any[][]`. */
function callArgs(mock: jest.Mock): Record<string, unknown>[] {
  return (mock.mock.calls as unknown[][]).map((call) => call[0] as Record<string, unknown>);
}

/** A `Loan` row as `findUnique({ include: WITH_OWNER })` returns it. */
function loanRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 5,
    value: 200n,
    timelimit: 10,
    disbursement_date: new Date('2017-11-09T00:00:00.000Z'),
    payment: 1,
    created_at: new Date('2017-11-01T12:00:00.000Z'),
    fee: FEE_MONTHLY,
    comments: '',
    state: 0,
    rate: new Prisma.Decimal('0.020'),
    user_id: 2,
    prev_loan_id: null,
    refinanced_loan: null,
    disbursement_value: 205n,
    user: {
      auth_user: { first_name: 'Foo', last_name: 'Bar', email: 'borrower@mail.com' },
    },
    ...overrides,
  };
}

function build(finance: { available_quota: bigint } | null): {
  service: LoanService;
  prisma: { loan: { create: jest.Mock }; userFinance: { findFirst: jest.Mock } };
  users: { getUserIds: jest.Mock; getUserEmails: jest.Mock };
  notifications: { sendNotification: jest.Mock };
  mail: { sendMail: jest.Mock };
} {
  const prisma = {
    userFinance: {
      findFirst: jest.fn().mockResolvedValue(finance === null ? null : { ...finance, user_id: 1 }),
    },
    loan: { create: jest.fn().mockResolvedValue({ id: 77 }) },
  };
  const users = {
    getUserIds: jest.fn().mockResolvedValue([1, 3]),
    getUserEmails: jest.fn().mockResolvedValue([]),
  };
  const notifications = { sendNotification: jest.fn().mockResolvedValue(undefined) };
  const mail = { sendMail: jest.fn().mockResolvedValue(true) };
  return {
    service: new LoanService(
      prisma as unknown as PrismaService,
      users as unknown as UserService,
      notifications as unknown as NotificationService,
      mail as unknown as MailService,
    ),
    prisma,
    users,
    notifications,
    mail,
  };
}

function buildUpdate(
  loan: Record<string, unknown> | null,
  options: { existingDetailId?: number } = {},
): {
  service: LoanService;
  prisma: {
    loan: { findUnique: jest.Mock; update: jest.Mock };
    loanDetail: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  mail: { sendMail: jest.Mock };
  notifications: { removeSchNotifications: jest.Mock };
} {
  const writtenDetail = {
    minimum_payment: 24n,
    total_payment: 222n,
    payday_limit: new Date('2017-12-09T00:00:00.000Z'),
    interests: 4n,
    capital_balance: 200n,
    from_date: new Date('2017-11-09T00:00:00.000Z'),
  };
  const prisma = {
    loan: {
      findUnique: jest.fn().mockResolvedValue(loan),
      update: jest.fn().mockResolvedValue(undefined),
    },
    loanDetail: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.existingDetailId === undefined ? null : { id: options.existingDetailId },
        ),
      create: jest.fn().mockResolvedValue(writtenDetail),
      update: jest.fn().mockResolvedValue(writtenDetail),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback(prisma),
  );
  const users = {
    getUserIds: jest.fn().mockResolvedValue([]),
    getUserEmails: jest.fn().mockResolvedValue(['admin@mail.com', 'treasurer@mail.com']),
  };
  const notifications = {
    sendNotification: jest.fn(),
    removeSchNotifications: jest.fn().mockResolvedValue(0),
    scheduleNotification: jest.fn(),
  };
  const mail = { sendMail: jest.fn().mockResolvedValue(true) };
  return {
    service: new LoanService(
      prisma as unknown as PrismaService,
      users as unknown as UserService,
      notifications as unknown as NotificationService,
      mail as unknown as MailService,
    ),
    prisma,
    mail,
    notifications,
  };
}

function buildRead(
  loan: Record<string, unknown> | null,
  options: { detail?: boolean } = {},
): { service: LoanService } {
  const prisma = {
    loan: { findUnique: jest.fn().mockResolvedValue(loan) },
    loanDetail: {
      findFirst: jest.fn().mockResolvedValue(
        options.detail === true
          ? {
              minimum_payment: 1n,
              total_payment: 2n,
              payday_limit: new Date('2018-01-01T00:00:00.000Z'),
              interests: 3n,
              capital_balance: 4n,
              from_date: new Date('2018-01-01T00:00:00.000Z'),
            }
          : null,
      ),
    },
  };
  return {
    service: new LoanService(
      prisma as unknown as PrismaService,
      {} as unknown as UserService,
      {} as unknown as NotificationService,
      {} as unknown as MailService,
    ),
  };
}

function buildProjection(options: { detail?: null; ownerId?: number } = {}): {
  service: LoanService;
} {
  const prisma = {
    loanDetail: {
      findFirst: jest.fn().mockResolvedValue(
        options.detail === null
          ? null
          : {
              capital_balance: 200n,
              from_date: new Date('2017-11-09T00:00:00.000Z'),
              loan: { user_id: options.ownerId ?? 2, rate: new Prisma.Decimal('0.020') },
            },
      ),
    },
  };
  return {
    service: new LoanService(
      prisma as unknown as PrismaService,
      {} as unknown as UserService,
      {} as unknown as NotificationService,
      {} as unknown as MailService,
    ),
  };
}

function buildBulk(options: { existingDetailFor: number[]; approved: number[] }): {
  service: LoanService;
  prisma: {
    loanDetail: { findFirst: jest.Mock; update: jest.Mock; create: jest.Mock };
    loan: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  tx: { loanDetail: { update: jest.Mock } };
  mail: { sendMail: jest.Mock };
  notifications: {
    scheduleNotification: jest.Mock;
    removeSchNotifications: jest.Mock;
    sendNotification: jest.Mock;
  };
} {
  const approvedRows = options.approved.map((id) =>
    loanRow({ id, state: 1, user_id: 2, created_at: new Date('2018-01-01T00:00:00.000Z') }),
  );
  const prisma = {
    loanDetail: {
      findFirst: jest.fn(({ where }: { where: { loan_id: number } }) =>
        Promise.resolve(
          options.existingDetailFor.includes(where.loan_id)
            ? { id: where.loan_id * 10, loan: { id: where.loan_id, user_id: 2 } }
            : null,
        ),
      ),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    },
    loan: {
      findMany: jest.fn().mockResolvedValue(approvedRows),
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(approvedRows.find((row) => row.id === where.id) ?? null),
      ),
      update: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(approvedRows.length),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback(prisma),
  );
  const users = {
    getUserIds: jest.fn().mockResolvedValue([]),
    getUserEmails: jest.fn().mockResolvedValue([]),
  };
  const notifications = {
    scheduleNotification: jest.fn().mockResolvedValue(undefined),
    removeSchNotifications: jest.fn().mockResolvedValue(0),
    sendNotification: jest.fn(),
  };
  const mail = { sendMail: jest.fn().mockResolvedValue(true) };
  return {
    service: new LoanService(
      prisma as unknown as PrismaService,
      users as unknown as UserService,
      notifications as unknown as NotificationService,
      mail as unknown as MailService,
    ),
    prisma,
    tx: prisma,
    mail,
    notifications,
  };
}
