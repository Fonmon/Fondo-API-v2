import { parseStrptimeIsoDate, pythonStr } from '../common/utils/python-str';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { assertOwnership } from '../auth/policies/ownership';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { djangoFileLines, parseMoneyColumn, requireColumn } from '../common/http/django-tsv';
import {
  buildPageEnvelope,
  isPageBeyondLast,
  pageOffset,
  unpaginatedEnvelope,
  type PageEnvelope,
  type UnpaginatedEnvelope,
} from '../common/http/pagination';
import { formatDateEs } from '../common/i18n/spanish-format';
import { utcMillisFromParts, fromDateColumn, type PlainDate } from '../common/utils/date.util';
import {
  asPythonDict,
  pyGet,
  pythonGreaterThan,
  toDjangoDate,
  toDjangoInt,
  toDjangoSmallInt,
  toDjangoText,
  PythonTypeError,
} from '../common/utils/python-obj';
import { addRelativeDelta } from '../common/utils/relativedelta.util';
import { roundHalfEvenToBigInt } from '../common/utils/rounding.util';
import { plainDateToUtcDate, nowInstant } from '../common/utils/timezone.util';
import { EmailTemplate } from '../mail/email-template';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { Prisma } from '../prisma';
import { PrismaService } from '../prisma/prisma.service';
import { UserService } from '../users/user.service';
import {
  calculateInterests,
  generateAmortizationTable,
  getRate,
  MAX_TIMELIMIT,
  MIN_TIMELIMIT,
} from './amortization';
import {
  LOAN_APPROVED,
  LOAN_DENIED,
  LOAN_PAID_OUT,
  LOAN_WAITING_APPROVAL,
  PAYMENT_REFINANCED,
  serializeLoan,
  serializeLoanDetail,
  type LoanDetailDto,
  type LoanDto,
} from './dto/loan.serializers';

/**
 * Either the pooled client or an interactive-transaction client.
 *
 * ⚠️ Not cosmetic. `bulk_update_loans` is `@transaction.atomic` and calls `update_loan`,
 * which opens its own `transaction.atomic()` — in Django that **joins** the outer one. Prisma
 * has no ambient transaction: a `this.prisma` call inside `$transaction(async tx => ...)`
 * runs on a *different* connection, commits independently and survives the rollback. Every
 * query on a transactional path therefore takes the client as an argument.
 */
type LoanSqlClient = PrismaService | Prisma.TransactionClient;

/** The `include` every loan read needs to serialise `user_full_name`. */
const WITH_OWNER = { user: { include: { auth_user: true } } } as const;

/**
 * The roles that may read **any** loan, alongside the loan's own owner — deviation **D10**
 * (operator Q16). Identical to the set **D25** applies to `GET /api/user/<id>`; the two land
 * together, in this phase, so the loan read and the user read cannot drift apart.
 */
export const LOAN_READ_PRIVILEGED_ROLES: readonly number[] = Object.freeze([0, 1, 2]);

/**
 * The smallest `value` a loan may be created with — deviation **D30**.
 *
 * ⚠️ **Neither stack has this bound today.** `create_loan`'s only test on `value` is
 * `> available_quota`, so `0` and `-1000` as plain JSON numbers are a `201` with a row on
 * **v1 and v2 alike**; this is a divergence v2 introduces *by decision*, not a parity repair,
 * and `manual-tester` has it in `docs/phase-4-deviations.md` §4.1 as such.
 *
 * The operator confirmed the fund has **no minimum loan amount**, so the floor is the weakest
 * defensible one: money is whole units on a `BigIntegerField`, and a loan for zero or a
 * negative amount is not a loan. Live evidence that it catches nothing in use: **0 of 425**
 * rows have `value <= 0`, and the three smallest (ids 132 and 198 at `1`, id 109 at `500`)
 * were all denied by hand. If a stated minimum ever arrives, it replaces this constant.
 */
export const MIN_LOAN_VALUE = 1n;

/**
 * `fondo_api/services/loan.py:LoanService`.
 *
 * ## The deviations this class carries
 *
 * | # | what changes |
 * |---|---|
 * | **D4** | `1 <= timelimit <= 36` is enforced at create with a **400** (operator Q9). v1 has neither bound: below 1 it 500s at approval, above 36 it **silently clamps**. The clamp is **gone**. |
 * | **D6** | `LoanDetail` is **upserted** on approval, not inserted, and every read of it is deterministic. |
 * | **D8** | the bulk upload returns the ids it auto-closed instead of a bare, bodyless 200. |
 * | **D9** | only `0→1`, `0→2`, `1→3`, `1→2` are legal state transitions; anything else is a **409** with no mail and no write. |
 * | **D10** | `GET /api/loan/<id>` and `paymentProjection` are restricted to the loan's owner plus roles `[0,1,2]`. |
 * | **D29** | the quota gate compares the **raw** body value and coerces only for the write, as v1 does — with one registered exception, an integer-shaped **string**, which v2 coerces rather than porting v1's `TypeError` 500. |
 * | **D30** | `value < 1` is a **400** at create. ⚠️ v1 accepts `0` and `-1000` and **so did v2** until this row landed: a divergence by decision, not a parity repair. |
 *
 * ## What is deliberately **not** changed
 *
 * * **`LoanDetailView.patch` is `[0, 2]` with no ownership check, so a TREASURER can approve
 *   their own loan.** `update_loan(id, state)` never receives the actor's id
 *   (`services/loan.py:79`), so there is nothing to check against. This is **deviation D28,
 *   WITHDRAWN 2026-09-03 per operator Q31** — it is accepted fund practice, not an oversight.
 *   See `docs/operator-q29a-q30a-q31.md`. The permission-matrix cell carries it deliberately.
 * * **The auto-close rule** (absent from the monthly file ⇒ paid off) is a real business rule
 *   (operator Q1) and stays **silent**: no email, no push. There is no guard against closing a
 *   loan approved *after* the treasurer generated the file (Q2).
 * * **Quota comes only from the treasurer's monthly file** (Q12). Loans never increment
 *   `utilized_quota`, so a member can open several loans between uploads that together exceed
 *   their quota.
 * * **Concurrent refinance requests against one loan** stay allowed (Q5), broken linkage
 *   included: the second one overwrites `prev_loan.refinanced_loan`.
 * * **Listing order is `-created_at, -id`** and nothing else.
 */
@Injectable()
export class LoanService {
  /** v1: `self.LOANS_PER_PAGE = 10`. */
  private readonly LOANS_PER_PAGE = 10;

  private readonly logger = new Logger('fondo_api.services.loan');

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
  ) {}

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * `create_loan(user_id, obj, refinance=False, prev_loan=None)`.
   *
   * ```python
   * user_finance = UserFinance.objects.get(user_id = user_id)
   * if obj['value'] > user_finance.available_quota and not refinance:
   *     return (False, 'User does not have available quota')
   * user = user_finance.user
   * if int(obj['timelimit']) > 36:
   *     obj['timelimit'] = 36
   * rate = self.__get_rate(int(obj['timelimit']))
   * new_loan = Loan.objects.create(...)
   * self.__notification_service.send_notification(
   *     self.__user_service.get_users_attr('id', [0,2]),
   *     "Ha sido creada una nueva solicitud de crédito", "/loan/{}".format(new_loan.id))
   * return (True, new_loan.id)
   * ```
   *
   * ⚠️ **The quota comparison runs even for a refinance.** `and not refinance` short-circuits
   * *after* the comparison, so a non-numeric `value` is a `TypeError` (500) on both paths;
   * only the *refusal* is skipped. Reproduced.
   *
   * ⚠️ **The push notification always fires**, including for a refinance and including when
   * the loan was created on somebody's behalf. Targets roles `[0, 2]` — ADMIN and TREASURER.
   * It is sent **after** the row is written and **outside** any transaction (v1 has none here,
   * and Phase 2 condition 3 forbids publishing from inside one).
   *
   * ## D4 — `1 <= timelimit <= 36`, enforced at the boundary. **Both** bounds.
   *
   * v1 has neither. Below 1 it accepts `timelimit = 0`, writes the row, and then dies with
   * `DivisionByZero` inside `__generate_table` **at approval time** — by which point the
   * member holds a request that can never be approved and nothing connected the failure to
   * the create call. Above 36 it **silently clamps** (`services/loan.py:31-32`), so a member
   * asking for 48 months gets a 36-month loan and a `201`, with no indication the term was
   * changed.
   *
   * Operator **Q9** — "Term outside 1–36" → **"Reject 400"** (`MIGRATION_PLAN.md` §9, and the
   * v0.4 changelog records D4 changing from *validate* to *reject 400*). So **the clamp is
   * gone**, not just the lower bound.
   *
   * ⚠️ **`test_post_loan_5` asserts the clamp — and that is a *moved expectation*, not a
   * spec.** v1 answers `201` with `timelimit == 36` for a submitted `37`; v2 answers **400**.
   * §3 of the plan *describes* the clamp and §5/§9 *decide* against it; where the two
   * disagree, §5 wins by construction, because a registered deviation is precisely a decision
   * to diverge from what §3 documents. Two descriptions of v1 plus a v1 test will always
   * agree with each other, and that agreement carries no information about what v2 should do.
   *
   * The check sits exactly where v1 first reads the value — **after** the quota check, so a
   * member over quota still gets v1's 406 — and the message follows v1's own register
   * (`'State must be between 0 and 4'`, `'Page number must be greater or equal than 0'`).
   *
   * @returns the new loan's id.
   * @throws ApiException 406 `{'message': 'User does not have available quota'}` — on the
   *   **raw** submitted value (**D29**), so `quota + 0.5` refuses here exactly as v1 does
   *   rather than truncating into an accepted `quota`.
   * @throws ApiException 400 `{'message': 'Loan value must be greater than 0'}` (**D30**)
   * @throws ApiException 400 `{'message': 'Timelimit must be between 1 and 36'}` (D4)
   */
  async createLoan(
    userId: number,
    body: unknown,
    refinance = false,
    prevLoan: { id: number } | null = null,
  ): Promise<number> {
    const obj = asPythonDict(body);

    const finance = await this.prisma.userFinance.findFirst({
      where: { user_id: userId },
      orderBy: { id: 'asc' },
      select: { available_quota: true, user_id: true },
    });
    if (finance === null) {
      // `UserFinance.objects.get(user_id=...)` -> DoesNotExist -> uncaught 500.
      throw new PythonTypeError('UserFinance matching query does not exist.');
    }

    const rawValue = pyGet(obj, 'value');

    // ⚠️ **This is the fund's only quota gate, and D28's withdrawal is what it costs**
    // (**C49/n4**). `available_quota` is writable by ADMIN and TREASURER
    // (`PRIVILEGED_FINANCE_ROLES`), and D28 — restricting a TREASURER from approving their
    // own loan — was **withdrawn** by operator **Q31**, ported from v1 unchanged. So a
    // TREASURER can raise their own `available_quota`, pass the check below, and approve the
    // resulting loan themselves. That is an accepted exposure, not an oversight: the loop is
    // closed in `docs/phase-4-deviations.md` §1.2, `docs/operator-q29a-q30a-q31.md`,
    // `loan-detail.controller.ts`'s class docblock, `loan.service.ts:88-93` and a **passing**
    // e2e cell whose docblock says a failure there is a policy change needing an operator.
    // Changing it is the operator's call, not a tidy-up.

    // ## D29 — compare **raw**, coerce for the write
    //
    // v1's gate is `if obj['value'] > user_finance.available_quota and not refinance`
    // (`services/loan.py:27`): the comparison runs on the *body* value and `int()` happens
    // later, on the write. That is the ordering Phase 3 established for the same reason at
    // `user.service.ts::updateUserFinance` (`pythonNotEqual`, then `toDjangoInt`), and
    // `createLoan` was the one place in v2 that had it the other way round.
    //
    // It is not cosmetic: `toDjangoInt` **truncates**, so with a quota of `Q` a submitted
    // `Q + 0.5` is `> Q` raw (v1's 406) but `== Q` coerced — v2 answered 201 and stored `Q`,
    // a different number from the one the member submitted. The divergent window is exactly
    // `Q < value < Q + 1`; it is a measured cell in both suites.
    //
    // ⚠️ The one place v2 stays lenient is a JSON **string**, and it is deliberate: v1's
    // `'1000' > 1000` is a `TypeError` — an uncaught 500 before any write — which is a crash
    // and not a rule (D29, `docs/ba-phase-4-p4f1.md` §1). Coercing it here keeps `"1000"` a
    // 201 and `"30000001"` the fund's real 406. The deviation is taken *here*, at the call
    // site, so it stays visible; `pythonGreaterThan` itself is faithful to CPython.
    const compared = typeof rawValue === 'string' ? toDjangoInt(rawValue, 'value') : rawValue;
    // `and not refinance` is evaluated **after** the comparison in v1, so a body that cannot
    // be compared at all is a 500 even on the refinance path. Same order here.
    if (pythonGreaterThan(compared, finance.available_quota) && !refinance) {
      throw ApiException.withMessage(
        HttpStatus.NOT_ACCEPTABLE,
        'User does not have available quota',
      );
    }

    const value = toDjangoInt(rawValue, 'value');
    if (value < MIN_LOAN_VALUE) {
      // ## D30 — the lower bound neither stack has
      //
      // ⚠️ **v1 accepts this and so did v2 until now**: `create_loan`'s only test on `value`
      // is `> available_quota`, so `0` and `-1000` as plain JSON numbers are 201 on both
      // stacks. This is therefore a *divergence v2 introduces by decision*, not a parity fix
      // — `manual-tester` must read the new 400 as expected. The operator confirmed the fund
      // has **no minimum loan amount**, so the floor is 1 as cheap insurance.
      //
      // Placed after the coercion (so `0.5`, which truncates to 0, is caught too) and after
      // the quota gate (so an over-quota request is still v1's 406), in D4's style and with
      // D4's status.
      throw ApiException.withMessage(HttpStatus.BAD_REQUEST, 'Loan value must be greater than 0');
    }

    // `int(obj['timelimit'])`, then D4's bounds check — where v1 has its silent clamp, and
    // before the rate lookup either way.
    const timelimit = toDjangoSmallInt(pyGet(obj, 'timelimit'), 'timelimit');
    if (timelimit < MIN_TIMELIMIT || timelimit > MAX_TIMELIMIT) {
      // D4 / Q9. v1 writes the row for both: below 1 it 500s at approval, above 36 it
      // silently books a shorter loan than the member asked for.
      throw ApiException.withMessage(
        HttpStatus.BAD_REQUEST,
        `Timelimit must be between ${MIN_TIMELIMIT} and ${MAX_TIMELIMIT}`,
      );
    }

    const created = await this.prisma.loan.create({
      data: {
        value,
        timelimit,
        disbursement_date: plainDateToUtcDate(
          toDjangoDate(pyGet(obj, 'disbursement_date'), 'disbursement_date'),
        ),
        fee: toDjangoSmallInt(pyGet(obj, 'fee'), 'fee'),
        payment: toDjangoSmallInt(pyGet(obj, 'payment'), 'payment'),
        comments: toDjangoNullableText(pyGet(obj, 'comments')),
        rate: new Prisma.Decimal(getRate(timelimit)),
        user_id: finance.user_id,
        prev_loan_id: prevLoan === null ? null : prevLoan.id,
        disbursement_value: toDjangoNullableInt(pyGet(obj, 'disbursement_value')),
        // `auto_now_add` is application-set in Django; the column has no DB default.
        state: LOAN_WAITING_APPROVAL,
        created_at: nowInstant(),
      },
      select: { id: true },
    });

    await this.notifications.sendNotification(
      // ⚠️ **C45/m6 — the documented exception to the "every query on a transactional path
      // takes the client" rule** stated at the top of this class. `getUserIds` and
      // `getUserEmails` (in `updateLoan`) do **not** take `tx`. Safe, and only for these two:
      // both are read-only, both hit `auth_user`/`fondo_api_userprofile`, and neither
      // transaction writes those tables — so there is no uncommitted state they could miss.
      // Anything that reads a table the enclosing transaction writes must take the client.
      await this.users.getUserIds([0, 2]),
      'Ha sido creada una nueva solicitud de crédito',
      `/loan/${created.id}`,
    );
    return created.id;
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /**
   * `get_loans(user_id, page, all_loans=False, state=4, paginate=True)`.
   *
   * ```python
   * if state == 4:
   *     loans = (Loan.objects.all() if all_loans
   *              else Loan.objects.filter(user_id=user_id)).order_by('-created_at', '-id')
   * else:
   *     loans = (Loan.objects.filter(state=state) if all_loans
   *              else Loan.objects.filter(user_id=user_id, state=state)).order_by('-created_at','-id')
   * ```
   *
   * ⚠️ **`state = 4` means "all states"**, not a fourth state — `Loan.LOAN_STATES` stops at 3.
   * It is the default when the query parameter is absent.
   *
   * ⚠️ **`all_loans` is honoured only for roles ≤ 2**, and that filter lives in the *view*
   * (`views/loan.py:33-41`), which simply omits the argument for a MEMBER. See
   * {@link LoanController.list}.
   *
   * ⚠️ **Order is `-created_at, -id` and nothing else.** `created_at` is a `timestamptz` with
   * millisecond resolution, so the `-id` tiebreak decides the order of loans created in the
   * same millisecond — which is exactly what v1's 25-row pagination test produces.
   */
  async getLoans(
    userId: number | null,
    page: number | null,
    allLoans = false,
    state = 4,
    paginate = true,
    client: LoanSqlClient = this.prisma,
  ): Promise<PageEnvelope<LoanDto> | UnpaginatedEnvelope<LoanDto>> {
    if (!allLoans && userId === null) {
      // **C45/m7.** Unreachable from the controller — the only `null` caller passes
      // `allLoans = true` — and guarded for the same reason as `page === null` below, which
      // is the sibling case the pattern was established for. Without it Prisma **drops** an
      // `undefined` filter and lists the whole fund, where Django's `filter(user_id=None)`
      // compiles to `user_id IS NULL` and returns nothing: an impossible argument would have
      // become a data leak rather than an empty page.
      throw new TypeError('getLoans: userId must be a number unless allLoans is true');
    }
    const where: Prisma.LoanWhereInput = {
      ...(allLoans ? {} : { user_id: userId ?? undefined }),
      ...(state === 4 ? {} : { state }),
    };
    const orderBy: Prisma.LoanOrderByWithRelationInput[] = [{ created_at: 'desc' }, { id: 'desc' }];

    if (!paginate) {
      const loans = await client.loan.findMany({ where, orderBy, include: WITH_OWNER });
      return unpaginatedEnvelope(loans.map(serializeLoan));
    }

    const count = await client.loan.count({ where });
    if (page === null) {
      // Unreachable from the view (`page` defaults to '1'); guarded so a future caller
      // cannot silently page from `null`.
      throw new TypeError('getLoans: page must be a number when paginate is true');
    }
    if (isPageBeyondLast(page, count, this.LOANS_PER_PAGE)) {
      return buildPageEnvelope<LoanDto>([], count, this.LOANS_PER_PAGE);
    }
    const loans = await client.loan.findMany({
      where,
      orderBy,
      include: WITH_OWNER,
      skip: pageOffset(page, this.LOANS_PER_PAGE),
      take: this.LOANS_PER_PAGE,
    });
    return buildPageEnvelope(loans.map(serializeLoan), count, this.LOANS_PER_PAGE);
  }

  /**
   * `get_loan(id)`.
   *
   * ```python
   * try: loan = Loan.objects.get(id=id)
   * except Loan.DoesNotExist: return (False, '')
   * serializer = LoanSerializer(loan)
   * if loan.state == 1:
   *     loan_detail = LoanDetail.objects.get(loan_id=id)
   *     return (True, {'loan': serializer.data, 'loan_detail': LoanDetailSerializer(loan_detail).data})
   * return (True, {'loan': serializer.data})
   * ```
   *
   * ⚠️ **`loan_detail` appears only for an APPROVED loan.** A `PAID_OUT` loan has a detail row
   * and v1 does not return it. Ported.
   *
   * ⚠️ **`LoanDetail.objects.get(loan_id=id)` on an approved loan with no detail row is
   * `DoesNotExist` — a 500, not a 404.** Unreachable through v2 (approval always writes one),
   * but reachable on rows Django wrote, so it is left as a 500 rather than softened into the
   * 404 the missing-*loan* case gives.
   *
   * **D6** — the read is `findFirst(orderBy: id asc)`, not `findUnique`, so a duplicate
   * detail row (which v1's plain FK permits and which `MultipleObjectsReturned` turns into a
   * permanent 500) degrades to "the second row is ignored".
   *
   * **D10** — the caller must own the loan or hold a role in
   * {@link LOAN_READ_PRIVILEGED_ROLES}. The loan is looked up first, so a **non-existent** id
   * is v1's 404 for everyone and only an *existing* loan can produce the 403.
   *
   * @throws ApiException 404 (zero-byte) when no loan has that id.
   * @throws DrfException 403 when D10 refuses.
   */
  async getLoan(
    actor: AuthenticatedUser,
    id: number,
  ): Promise<{ loan: LoanDto; loan_detail?: LoanDetailDto }> {
    const loan = await this.prisma.loan.findUnique({ where: { id }, include: WITH_OWNER });
    if (loan === null) {
      // v1: `(False, '')` -> `Response(status=404)`, a zero-byte body.
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    assertOwnership(actor, loan.user_id, LOAN_READ_PRIVILEGED_ROLES);

    if (loan.state !== LOAN_APPROVED) {
      return { loan: serializeLoan(loan) };
    }
    const detail = await this.readLoanDetail(id);
    if (detail === null) {
      throw new PythonTypeError('LoanDetail matching query does not exist.');
    }
    return { loan: serializeLoan(loan), loan_detail: serializeLoanDetail(detail) };
  }

  /**
   * `payment_projection(loan_id, to_date)`.
   *
   * ```python
   * try:
   *     loan_detail = LoanDetail.objects.get(loan_id=loan_id)
   *     loan = loan_detail.loan
   *     interests = self.__calculate_interests(loan, loan_detail.capital_balance,
   *                                            to_date, loan_detail.from_date)
   *     return {'interests': int(round(interests, 0)), 'capital_balance': loan_detail.capital_balance}
   * except LoanDetail.DoesNotExist:
   *     return None
   * ```
   *
   * ⚠️ **Keyed on `LoanDetail`, not on `Loan`** — a loan that exists but was never approved
   * has no detail row and is therefore a 404 here, the same answer as a loan that does not
   * exist at all.
   *
   * ⚠️ `int(round(interests, 0))` is Python's **half-even** `round` on a `Decimal` under the
   * default context, not `Math.round`.
   *
   * **D10** applies, via the detail row's loan. `checkOwnership` is off for the internal call
   * from {@link refinanceLoan}, which has already established that the caller owns the loan.
   */
  async paymentProjection(
    actor: AuthenticatedUser | null,
    loanId: number,
    toDate: PlainDate,
  ): Promise<{ interests: bigint; capital_balance: bigint }> {
    const detail = await this.prisma.loanDetail.findFirst({
      where: { loan_id: loanId },
      orderBy: { id: 'asc' },
      include: { loan: true },
    });
    if (detail === null) {
      // v1 returns None -> `Response(None, status=404)`, a zero-byte body.
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    if (actor !== null) {
      assertOwnership(actor, detail.loan.user_id, LOAN_READ_PRIVILEGED_ROLES);
    }

    const interests = calculateInterests(
      detail.loan.rate,
      detail.capital_balance,
      fromDateColumn(detail.from_date),
      toDate,
    );
    return {
      interests: roundHalfEvenToBigInt(interests),
      capital_balance: detail.capital_balance,
    };
  }

  // -------------------------------------------------------------------------
  // state transitions
  // -------------------------------------------------------------------------

  /**
   * `update_loan(id, state)` — the whole approval / denial / payout machine, atomic.
   *
   * ```python
   * with transaction.atomic():
   *     try: loan = Loan.objects.get(id=id)
   *     except Loan.DoesNotExist: return (False, 'Loan does not exist')
   *     loan.state = state; loan.save()
   *     mail_params = {'loan_id': loan.id}
   *     if state == 1:
   *         table, detail = self.__generate_table(loan)
   *         if loan.prev_loan is not None: loan.prev_loan.state = 3; loan.prev_loan.save()
   *         loan_detail = self.__create_loan_detail(loan, detail)
   *         mail_params['loan_table'] = table
   *         send_mail(CHANGE_STATE_LOAN_APPROVED, [loan.user.email], mail_params,
   *                   get_users_attr('email', [0,2]))
   *         return (True, LoanDetailSerializer(loan_detail).data)
   *     if state == 2:
   *         send_mail(CHANGE_STATE_LOAN_DENIED, [loan.user.email], mail_params,
   *                   get_users_attr('email', [0,2]))
   *         if loan.prev_loan is not None: loan.prev_loan.refinanced_loan = None; ...save()
   *     if state == 3:
   *         self.__notification_service.remove_sch_notitfications("payment_reminder", id)
   * return (True, '')
   * ```
   *
   * ⚠️ **The approval email BCCs roles `[0, 2]`** and `MailService` drops any address that is
   * also a recipient, so a TREASURER approving their own loan is not blind-copied on it
   * (`test_update_loan_approved_monthly` pins exactly that).
   *
   * ⚠️ **Only `state == 3` clears the payment reminders.** A denial after approval (`1→2`)
   * leaves the scheduled `payment_reminder` tasks in place and the member keeps getting
   * push reminders for a cancelled loan. v1's behaviour; not changed here, because Q6 makes
   * reminders best-effort and the fix belongs with Phase 7's runner.
   *
   * ⚠️ **`prev_loan.state = 3` is a direct column write, not a recursive `update_loan` call**,
   * so it sends no mail and clears no reminders. Also v1's.
   *
   * ## D9 — the transition guard
   *
   * v1 writes `loan.state` unconditionally, so re-approving an already-approved loan
   * regenerates the amortisation table from `disbursement_date`, **inserts a second
   * `LoanDetail`** (D6) and re-sends the borrower's email. Legal transitions are `0→1`,
   * `0→2`, `1→3`, `1→2` (operator Q14); anything else is a **409** with no mail, no scheduler
   * write and no state change. The loan is looked up first, so a missing id is still v1's 404.
   *
   * ## D6 — upsert, not insert
   *
   * `__create_loan_detail` becomes an update-or-create keyed on `loan_id`. With D9 in place
   * the second-row case is unreachable through the API.
   *
   * ⚠️ **D6 makes the repair of a wrongly auto-closed loan *safe when it happens*; it does
   * not make it *reachable through this API*.** The repair is "set the state back and
   * re-approve", and D9 refuses every route to it: `3 → 1` is a **409**, `3 → 0` is a 409,
   * and there is no path from `1` back to `0` either
   * ({@link LEGAL_LOAN_TRANSITIONS} has entries for states `0` and `1` only). So after an
   * erroneous {@link bulkUpdateLoans} auto-close — which can close *every* APPROVED loan in
   * the fund in one upload — **v2 has no API-level recovery at all**: someone with database
   * access must `UPDATE fondo_api_loan SET state = 0`, and only *then* does D6's upsert earn
   * its keep, by making the subsequent approval an update instead of v1's second row and
   * permanent 500 on `GET /api/loan/<id>`.
   *
   * That is arguably the better trade — v1's "recovery" left the loan 500ing forever — but it
   * is a change in operational posture. **Whether a wrongly closed loan should be re-openable
   * through the API, and by whom, is a fund-policy question escalated to `business-analyst`
   * (review condition C42); it is deliberately not decided here, and the transition table is
   * deliberately unchanged.**
   *
   * @returns the serialised `LoanDetail` for an approval, `''` for every other transition —
   *   v1's `Response('', status=200)`, which `JSONRenderer` writes as the two bytes `""`.
   * @throws ApiException 404 `{'message': 'Loan does not exist'}`
   * @throws ApiException 409 `{'message': 'Invalid state transition'}` (D9) — also the answer
   *   to the loser of a concurrent transition, whose compare-and-set matches no row. ⚠️ For
   *   one race pair (approve wins, deny loses on a WAITING loan) sequential execution would
   *   have given a **200**; see the compare-and-set comment below and C51.
   */
  async updateLoan(id: number, state: number): Promise<LoanDetailDto | ''> {
    return this.prisma.$transaction(async (tx) => this.updateLoanIn(tx, id, state), {
      // The approval leg sends the borrower's email *inside* v1's `transaction.atomic()`.
      // The default 5 s interactive budget is shorter than SES's own worst case (C22).
      //
      // ⚠️ **The budget now has to cover a queued caller *plus* SES** (review nit **C57**).
      // Since M3 the state write is a compare-and-set, so a second concurrent transition on
      // the same loan blocks on the winner's row lock and waits out the winner's *entire*
      // remaining transaction — `getUserEmails`, `generateAmortizationTable`,
      // `upsertLoanDetail` and `sendMail` — before it can re-evaluate. Before M3 the loser
      // completed immediately, with a lost update. 20 s covers SES's own 5 s connect + 10 s
      // socket budget (`ses.client.ts`) with headroom for one queued caller; a third
      // simultaneous caller on the *same loan* could exceed it.
      //
      // If it is exceeded the caller gets Prisma's **P2028**, which is not an `ApiException`,
      // a `DrfException` or an `HttpException`, so `ApiExceptionFilter`'s catch-all renders it
      // — a **zero-byte 500 with no `Allow` and `Vary: Origin`**, which is exactly **P3-D6**'s
      // uncaught shape and therefore the same thing v1 answers when *its* untimed
      // `transaction.atomic` fails for any other reason. Pinned in
      // `api-exception.filter.spec.ts` ("a Prisma P2028 renders P3-D6's uncaught shape"), so
      // the claim is a cell rather than a reading of the filter.
      timeout: 20_000,
      maxWait: 10_000,
    });
  }

  /** {@link updateLoan}'s body, on an explicit client so `bulkUpdateLoans` can join it. */
  private async updateLoanIn(
    tx: LoanSqlClient,
    id: number,
    state: number,
  ): Promise<LoanDetailDto | ''> {
    const loan = await tx.loan.findUnique({ where: { id }, include: WITH_OWNER });
    if (loan === null) {
      throw ApiException.withMessage(HttpStatus.NOT_FOUND, 'Loan does not exist');
    }

    // D9 — before any write, and before any mail.
    assertLegalLoanTransition(loan.state, state);

    // ⚠️ **Compare-and-set, not a plain update.** `findUnique` → guard → `update` is a
    // lost-update race: Prisma's interactive transaction runs at the database default,
    // **READ COMMITTED**, so two concurrent `PATCH /api/loan/<id> {"state":1}` on the same
    // WAITING loan both read state `0`, both pass the guard above, both find no `LoanDetail`
    // and **both insert one** — the exact duplicate D6 exists to survive, and the physical
    // `UNIQUE (loan_id)` that would stop it is deferred to Phase 9 (§5.1 of
    // `docs/phase-4-deviations.md`). The window is a double-clicked approve button.
    //
    // Adding `state: loan.state` to the predicate makes the write itself the serialisation
    // point: the second transaction blocks on the first's row lock, re-evaluates the
    // predicate after it commits, matches nothing and gets `count === 0`. The loser is
    // answered with **D9's own 409**.
    //
    // ⚠️ **That is the answer sequential execution would have given for five of the six race
    // pairs D9 permits — and not for the sixth** (C51). Enumerated: `0→1` vs `0→1`, `0→2` vs
    // `0→2`, `0→2` vs `0→1`, `1→2` vs `1→3` and `1→3` vs `1→2` all leave the loser facing a
    // state the table has no legal move from, so it is a 409 either way and the CAS is
    // honest. The exception is **winner `0→1`, loser `0→2`** — an approve and a deny racing
    // on a WAITING loan, approve first. From state `1`, `1→2` is *legal*, so had the denial
    // arrived a millisecond later it would have got a **200**, the denial mail and the
    // `prev_loan.refinanced_loan = null` unlink. Under the CAS it gets "Invalid state
    // transition", which reads as "not allowed, do not retry" — and the deny is the
    // safety-side action, so the asymmetry runs the wrong way.
    //
    // **Registered, not fixed** (§4.1 and §5.1 of `docs/phase-4-deviations.md`, `§5 D9` of
    // `MIGRATION_PLAN.md`) and pinned by a unit cell so it stays measured. The alternative —
    // on `count === 0`, re-read the row and re-run the guard once — reproduces sequential
    // semantics exactly but changes behaviour on the money path and needs its own review
    // cycle; the window is milliseconds and no caller has hit it.
    //
    // No migration and no schema change: this is a `WHERE` clause on a column Django owns.
    const applied = await tx.loan.updateMany({ where: { id, state: loan.state }, data: { state } });
    if (applied.count === 0) {
      throw ApiException.withMessage(HttpStatus.CONFLICT, 'Invalid state transition');
    }

    // ⚠️ **C45/m5 — computed inside the branches that mail, not above them.** v1 calls
    // `get_users_attr('email', [0,2])` *inside* the `state == 1` and `state == 2` arms
    // (`services/loan.py:96,110`). Hoisting it was output-identical but issued one extra
    // query per **auto-closed** loan — 28 on a whole-fund close — inside the 120 s bulk
    // transaction, which v1 never does. `1 → 3` and every 409 now issue none.

    if (state === LOAN_APPROVED) {
      const mailBcc = await this.users.getUserEmails([0, 2]);
      const { table, summary } = generateAmortizationTable({
        value: loan.value,
        timelimit: loan.timelimit,
        fee: loan.fee,
        rate: loan.rate,
        disbursement_date: fromDateColumn(loan.disbursement_date),
      });
      if (loan.prev_loan_id !== null) {
        // A refinance was approved: the loan it replaces is now PAID_OUT.
        await tx.loan.update({
          where: { id: loan.prev_loan_id },
          data: { state: LOAN_PAID_OUT },
        });
      }
      const detail = await this.upsertLoanDetail(tx, loan, summary);
      await this.mail.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_APPROVED,
        [loan.user.auth_user.email],
        { loan_id: loan.id, loan_table: table },
        mailBcc,
      );
      return serializeLoanDetail(detail);
    }

    if (state === LOAN_DENIED) {
      const mailBcc = await this.users.getUserEmails([0, 2]);
      await this.mail.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_DENIED,
        [loan.user.auth_user.email],
        { loan_id: loan.id },
        mailBcc,
      );
      if (loan.prev_loan_id !== null) {
        // The refinance was refused: unlink it from the loan it would have replaced.
        await tx.loan.update({
          where: { id: loan.prev_loan_id },
          data: { refinanced_loan: null },
        });
      }
    }

    if (state === LOAN_PAID_OUT) {
      // v1's method name carries a typo (`remove_sch_notitfications`); the behaviour does not.
      await this.notifications.removeSchNotifications('payment_reminder', id, tx);
    }

    return '';
  }

  /**
   * `refinance_loan(loan_id, new_loan, user_id)`.
   *
   * ```python
   * try:
   *     loan = Loan.objects.get(id=loan_id)
   *     if loan.state != 1 or user_id != loan.user.id: return None
   *     to_date = datetime.strptime(new_loan['disbursement_date'], '%Y-%m-%d').date()
   *     payment = self.payment_projection(loan_id, to_date)
   *     new_loan['value'] = payment['capital_balance']
   *     comment = 'Refinanciación del crédito #{}, cuyo valor'.format(loan_id)
   *     if new_loan['includeInterests']:
   *         new_loan['value'] += payment['interests']
   *         comment = '{} incluye intereses'.format(comment)
   *     else:
   *         comment = '{} no incluye intereses'.format(comment)
   *     new_loan['comments'] = '{}. {}'.format(comment, new_loan['comments'])
   *     new_loan['payment'] = 2
   *     new_loan['disbursement_value'] = None
   *     state, new_loan_id = self.create_loan(user_id, new_loan, True, loan)
   *     loan.refinanced_loan = new_loan_id
   *     loan.save()
   *     return new_loan_id
   * except Loan.DoesNotExist:
   *     return None
   * ```
   *
   * ⚠️ **Own APPROVED loan only** — and that is the *whole* authorisation, built into v1. D10
   * adds nothing here, because a non-owner already gets `None` → 400.
   *
   * ⚠️ **`Loan.DoesNotExist` is the only caught exception.** A missing `disbursement_date`,
   * `includeInterests` or `comments` key is a `KeyError` → **500**, not a 400. A loan with no
   * `LoanDetail` makes `payment_projection` return `None` and `payment['capital_balance']`
   * raise `TypeError` → 500. All three are reproduced: the 400 means "wrong loan", never
   * "wrong body".
   *
   * ⚠️ **`includeInterests` is tested for Python truthiness**, not compared to `True`, so
   * `"false"` (a non-empty string) *includes* the interest. Reproduced.
   *
   * ⚠️ **No transaction.** v1 has none, so a `create_loan` failure between the two writes
   * leaves the old loan un-linked; and `create_loan`'s SQS publish must not run inside one
   * (Phase 2 condition 3).
   *
   * ⚠️ **D30 turned that hypothetical into a reachable path** (**C52**). Before D30 the only
   * way to fail between the two writes was a crash; now a projected `value` below 1 — a
   * fully-paid or negative `capital_balance` — is a deliberate 400 from `createLoan`, so the
   * `prisma.loan.update` below simply never runs and the refusal touches **no table at all**
   * (measured: `tables touched: []`). v1 in the same case writes the child *and* links the
   * parent. **That asymmetry is the intended shape, not a gap**: a refused refinance must
   * leave no parent pointing at a loan that does not exist. Do not "fix" it by moving the
   * link ahead of the create. Registered in `docs/phase-4-deviations.md` §4.1.
   *
   * ⚠️ `#{}` interpolates the raw URL segment in v1 (`id` is a `str` from the regex), which
   * renders identically to the integer.
   *
   * D4 applies through `create_loan`: a refinance body with `timelimit: 0` is a 400.
   *
   * @returns the new loan's id.
   * @throws ApiException 400 (zero-byte) when the loan is missing, not APPROVED, or not the
   *   caller's — v1's three `None` paths, which the view renders identically.
   */
  async refinanceLoan(actor: AuthenticatedUser, loanId: number, body: unknown): Promise<number> {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (loan === null || loan.state !== LOAN_APPROVED || loan.user_id !== actor.id) {
      throw ApiException.empty(HttpStatus.BAD_REQUEST);
    }
    const newLoan = asPythonDict(body);

    const toDate = strptimeIsoDate(pyGet(newLoan, 'disbursement_date'));
    // `actor` is null: ownership is already established above, and v1 calls the service
    // method directly with no permission layer between.
    const payment = await this.paymentProjection(null, loanId, toDate);

    let value = payment.capital_balance;
    let comment = `Refinanciación del crédito #${loanId}, cuyo valor`;
    if (isPythonTruthy(pyGet(newLoan, 'includeInterests'))) {
      value += payment.interests;
      comment = `${comment} incluye intereses`;
    } else {
      comment = `${comment} no incluye intereses`;
    }

    const newLoanId = await this.createLoan(
      actor.id,
      {
        ...newLoan,
        value,
        // ⚠️ D35: v1 builds this with `'{}. {}'.format(comment, obj['comments'])`, so a null
        // renders as the four characters `None` — `toDjangoText` returns SQL NULL here and
        // `${null}` would write `null`. Interpolation wants `str()`, not the column coercion.
        comments: `${comment}. ${pythonStr(pyGet(newLoan, 'comments'))}`,
        payment: PAYMENT_REFINANCED,
        disbursement_value: null,
      },
      true,
      loan,
    );

    await this.prisma.loan.update({
      where: { id: loanId },
      data: { refinanced_loan: BigInt(newLoanId) },
    });
    return newLoanId;
  }

  // -------------------------------------------------------------------------
  // the monthly file
  // -------------------------------------------------------------------------

  /**
   * `bulk_update_loans(obj)` — **the highest-consequence implicit rule in the codebase.**
   *
   * ```python
   * @transaction.atomic
   * def bulk_update_loans(self, obj):
   *     loan_ids = []
   *     for line in obj['file']:
   *         data = line.decode('utf-8').strip().split("\t")
   *         loan_id = int(data[0]); loan_ids.append(loan_id)
   *         info['total_payment']   = int(round(float(data[1]), 0))
   *         info['minimum_payment'] = int(round(float(data[2]), 0))
   *         date = data[3].strip().split("/")
   *         info['payday_limit']    = "{}-{}-{}".format(date[2], date[1], date[0])
   *         info['interests']       = int(round(float(data[4]), 0))
   *         info['capital_balance'] = int(round(float(data[5]), 0))
   *         date = data[6].strip().split("/")
   *         info['from_date']       = "{}-{}-{}".format(date[2], date[1], date[0])
   *         try: self.__update_loan_detail(info)
   *         except LoanDetail.DoesNotExist:
   *             self.__logger.error('Loan with id: {}, not exists'.format(loan_id)); continue
   *     loans = self.get_loans(None, None, True, 1, False)['list']
   *     for loan in loans:
   *         if loan['id'] not in loan_ids:
   *             self.__logger.info('Auto closing loan with id {}'.format(loan['id']))
   *             self.update_loan(loan['id'], 3)
   * ```
   *
   * ## The column map, which is not the model's field order
   *
   * | # | column | note |
   * |---|---|---|
   * | 0 | `loan_id` | `int()` — a non-numeric line is a `ValueError`, i.e. the whole upload rolls back |
   * | 1 | `total_payment` | money |
   * | 2 | `minimum_payment` | money |
   * | 3 | `payday_limit` | **`D/M/Y` with `/` separators**, re-assembled as `Y-M-D` |
   * | 4 | `interests` | money |
   * | 5 | `capital_balance` | money |
   * | 6 | `from_date` | **`D/M/Y`** |
   *
   * ⚠️ **An id in the file with no `LoanDetail` row is logged and skipped** — but it *is*
   * appended to `loan_ids` first, so listing a not-yet-approved loan in the file protects it
   * from the auto-close. That ordering is load-bearing and is reproduced.
   *
   * ⚠️ **The auto-close candidate set is every APPROVED loan in the fund** — 28 of them in
   * `fondodev` today. A well-formed but *incomplete* file commits and closes the omissions;
   * a loan approved after the treasurer generated the file is absent by construction and gets
   * closed. Operator Q1/Q2 accept both. The close is silent: `update_loan(id, 3)` sends no
   * mail and only removes the scheduled reminders.
   *
   * ⚠️ **A loan whose state changed between the read and the auto-close write is skipped,
   * not force-closed, and the upload still commits** (C50) — the one place v2's
   * compare-and-set is deliberately *not* allowed to refuse the caller. See the `catch` in
   * the auto-close loop below; the id is left out of `closed_loans`.
   *
   * ⚠️ **Everything is one transaction**, `schedule_notification` and the auto-closes
   * included, so a malformed line on row 400 discards rows 1-399 as well. Ported: a partly
   * applied monthly file is worse than none.
   *
   * ## D8 — the response
   *
   * v1 answers a bare `200` with **no body**, so nothing tells the treasurer which loans the
   * upload just closed. Operator Q3: return the list, with no cap on its length.
   *
   * @returns the ids auto-closed by this upload, in the order they were closed (**D8**).
   */
  async bulkUpdateLoans(fileContents: Buffer): Promise<{ closed_loans: number[] }> {
    const lines = djangoFileLines(fileContents);

    return this.prisma.$transaction(
      async (tx) => {
        const loanIds: number[] = [];

        for (const line of lines) {
          const data = line.trim().split('\t');
          // ⚠️ **C46 — an out-of-`Int32` id must MISS, not abort the file.** `int()` is
          // arbitrary precision and PostgreSQL compares an `integer` column against an
          // out-of-range numeric literal happily, so v1's
          // `LoanDetail.objects.get(loan_id=3000000000)` is a plain `DoesNotExist`: logged,
          // skipped, upload continues. Measured on the pinned stack for `2**31`, `3e9` and
          // `2**63` — all four `DoesNotExist`. Prisma refuses the same value client-side
          // (`Value out of range for the type … integer`, measured), and that error is **not**
          // D9's 409, so the narrow catch below rethrows it and the `$transaction` rolls back
          // the **whole monthly file** — every detail upsert, every scheduler row, every
          // auto-close — for one mistyped digit in column 0.
          //
          // Same hazard and same answer as `parseLoanPathId`: map it to **`-1`**, an id no row
          // can hold (the sequence starts at 1), so the lookup misses exactly where v1's does.
          // The `loanIds` shield is unaffected — v1 pushes the real out-of-range integer,
          // which matches no live loan either, so `-1` shields exactly as much: nothing.
          const rawLoanId = toDjangoInt(requireColumn(data, 0), 'loan id');
          const loanId =
            rawLoanId > 2147483647n || rawLoanId < -2147483648n ? -1 : Number(rawLoanId);
          // ⚠️ Appended *before* the update is attempted — an unknown id still shields
          // nothing, but a known-but-unapproved id shields itself from the auto-close.
          loanIds.push(loanId);

          const info = {
            total_payment: parseMoneyColumn(data, 1),
            minimum_payment: parseMoneyColumn(data, 2),
            payday_limit: parseSlashDate(requireColumn(data, 3)),
            interests: parseMoneyColumn(data, 4),
            capital_balance: parseMoneyColumn(data, 5),
            from_date: parseSlashDate(requireColumn(data, 6)),
          };

          const updated = await this.updateLoanDetail(tx, loanId, info);
          if (!updated) {
            // v1: `except LoanDetail.DoesNotExist: logger.error(...); continue`
            this.logger.error(`Loan with id: ${loanId}, not exists`);
          }
        }

        // `get_loans(None, None, True, 1, False)` — every APPROVED loan, unpaginated.
        const approved = await this.getLoans(null, null, true, LOAN_APPROVED, false, tx);
        const closed: number[] = [];
        for (const loan of approved.list) {
          if (!loanIds.includes(loan.id)) {
            try {
              await this.updateLoanIn(tx, loan.id, LOAN_PAID_OUT);
            } catch (error) {
              // ⚠️ **C50.** The auto-close goes through the same compare-and-set as
              // `PATCH /api/loan/<id>`, so a concurrent denial or payout committing between
              // the `getLoans(state=1)` read above and this write makes the CAS match no row
              // (or the re-read see the new state) and throw **D9's 409**. Uncaught, that
              // escapes the `$transaction` callback and rolls back the **entire file** — all
              // 374 `LoanDetail` upserts, every scheduler row and every other auto-close —
              // answered with a 409 that names neither the file nor the loan. v1 cannot fail
              // here at all (`update_loan(id, 3)` writes unconditionally and silently wins a
              // lost update), so this is a **v2-only failure mode the CAS created**, and the
              // narrowing is the right answer: a loan someone *just denied* must not be
              // force-closed by a file generated before the denial. Directly mirrors v1's
              // `except LoanDetail.DoesNotExist: logger.error(...); continue` in the loop
              // above — log, skip, keep the upload.
              //
              // ⚠️ **Narrow on purpose.** Only D9's 409 is swallowed; a 404, a Prisma error
              // or anything else still aborts the upload, because a partly applied monthly
              // file is worse than none.
              if (!isInvalidStateTransition(error)) {
                throw error;
              }
              this.logger.warn(
                `Loan with id: ${loan.id}, state changed concurrently, not auto closed`,
              );
              continue;
            }
            closed.push(loan.id);
          }
        }
        // ⚠️ **C47 — one `warn` line, not 28 at `log`.** v1 emits
        // `logger.info('Auto closing loan with id {}')` per loan, which is the whole alerting
        // story for a **whole-fund close**: 28 info lines nobody is paged on, and — per M2 —
        // a treasurer who does notice cannot undo it through the API. D8's response body is a
        // capability the client has to be changed to use (Phase 9 runbook), so it is not the
        // notice either. The per-loan lines are consolidated rather than dropped: every id is
        // in the list below, verbatim and in close order, and the level is the one an operator
        // actually alerts on. Whether a mass close should also *notify* is a business question
        // carried with C42.
        if (closed.length > 0) {
          this.logger.warn(`Auto closed ${closed.length} loan(s): [${closed.join(', ')}]`);
        }
        return { closed_loans: closed };
      },
      // 374 detail rows plus up to 28 auto-closes, each writing scheduler rows, in one unit.
      // **P4-D7** (C45/m3). v1's `@transaction.atomic` has **no** timeout; Prisma requires a
      // budget and its default (5 s) is far below a monthly run. A run slow enough to exceed
      // two minutes commits in v1 and rolls back with a 500 here. All-or-nothing is preserved
      // either way and the measured run is far inside the budget. Registered rather than left
      // implicit, because its sibling — the 20 s approval budget — is **P4-D6**.
      { timeout: 120_000, maxWait: 20_000 },
    );
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  /**
   * `__update_loan_detail(obj)` followed by `__create_scheduled_task(payday_limit, loan)`.
   *
   * ⚠️ **This one stays an update, not an upsert.** D6's "upsert not insert" targets
   * {@link upsertLoanDetail} (approval), which is where the duplicate row comes from. Here a
   * missing `LoanDetail` means the file names a loan that was never approved — v1 logs and
   * skips it, and creating a row would either violate the FK (no such loan) or fabricate a
   * schedule for a loan awaiting approval.
   *
   * @returns `false` when there is no `LoanDetail` for that loan (v1's `DoesNotExist`).
   */
  private async updateLoanDetail(
    tx: LoanSqlClient,
    loanId: number,
    info: {
      total_payment: bigint;
      minimum_payment: bigint;
      payday_limit: PlainDate;
      interests: bigint;
      capital_balance: bigint;
      from_date: PlainDate;
    },
  ): Promise<boolean> {
    // D6 — deterministic read, so a duplicate row cannot raise `MultipleObjectsReturned`.
    const existing = await tx.loanDetail.findFirst({
      where: { loan_id: loanId },
      orderBy: { id: 'asc' },
      select: { id: true, loan: { select: { id: true, user_id: true } } },
    });
    if (existing === null) {
      return false;
    }

    await tx.loanDetail.update({
      where: { id: existing.id },
      data: {
        total_payment: info.total_payment,
        minimum_payment: info.minimum_payment,
        payday_limit: plainDateToUtcDate(info.payday_limit),
        interests: info.interests,
        capital_balance: info.capital_balance,
        from_date: plainDateToUtcDate(info.from_date),
      },
    });
    await this.createScheduledTask(tx, info.payday_limit, existing.loan);
    return true;
  }

  /**
   * `__create_scheduled_task(payday_limit, loan)` — the **two** payment reminders.
   *
   * ```python
   * payday_limit    = datetime.strptime(payday_limit, '%Y-%m-%d').date()
   * five_days_date  = payday_limit - relativedelta(days=5)
   * before_date     = payday_limit - relativedelta(days=1)
   * payload = {"type": "payment_reminder", "owner_id": loan.id, "user_ids": [loan.user.id],
   *            "target": "/loan/{}".format(loan.id),
   *            "message": "Recuerde que la fecha límite de pago para el crédito {}, es el: {}"
   *                       .format(loan.id, format_date(payday_limit, locale=...))}
   * self.__notification_service.schedule_notification(five_days_date, payload)
   * self.__notification_service.schedule_notification(before_date, payload)
   * ```
   *
   * ⚠️ **Both dates derive from `payday_limit`, which comes out of the uploaded file** — they
   * are not "today ± n". There is no calendar-now read anywhere on the loan path (condition
   * **C28**); the only clock read in this service is `created_at`'s `nowInstant()`.
   *
   * ⚠️ **`repeat` is 0 (`NONE`)**, unlike the birthday task's `4`. And the payload is
   * identical for both rows — the same-day dedupe in `schedule_notification` is what keeps
   * them from collapsing, and they cannot fall on the same day because they are 4 days apart.
   *
   * ⚠️ Key insertion order (`type, owner_id, user_ids, target, message`) is v1's. PostgreSQL
   * re-orders hstore entries on storage, but the encoder writes what it is given.
   *
   * ⚠️ **D7 lives in Phase 7, not here.** A reminder whose `run_date` has already passed is
   * still written; v1's *runner* then never fires it, and the decision to send it immediately
   * instead (operator Q8) is the runner's.
   */
  private async createScheduledTask(
    tx: LoanSqlClient,
    paydayLimit: PlainDate,
    loan: { id: number; user_id: number },
  ): Promise<void> {
    const fiveDaysBefore = addRelativeDelta(paydayLimit, { days: -5 });
    const oneDayBefore = addRelativeDelta(paydayLimit, { days: -1 });

    const payload = {
      type: 'payment_reminder',
      owner_id: loan.id,
      user_ids: [loan.user_id],
      target: `/loan/${loan.id}`,
      message:
        `Recuerde que la fecha límite de pago para el crédito ${loan.id}, ` +
        `es el: ${formatDateEs(paydayLimit)}`,
    };

    await this.notifications.scheduleNotification(fiveDaysBefore, payload, 0, tx);
    await this.notifications.scheduleNotification(oneDayBefore, payload, 0, tx);
  }

  /**
   * `__create_loan_detail(loan, detail)` — **upserted**, not inserted (**D6**).
   *
   * ```python
   * LoanDetail.objects.create(
   *     total_payment=detail['total_payment'], minimum_payment=detail['minimum_payment'],
   *     payday_limit=detail['payday_limit'], from_date=loan.disbursement_date,
   *     interests=detail['interests'], capital_balance=loan.value, loan=loan)
   * ```
   *
   * ⚠️ **`from_date` is the loan's `disbursement_date` and `capital_balance` is `loan.value`**
   * — neither comes from the amortisation summary. The model's `default=date.today` on
   * `from_date` therefore never fires on this path.
   */
  private async upsertLoanDetail(
    tx: LoanSqlClient,
    loan: { id: number; value: bigint; disbursement_date: Date },
    summary: {
      total_payment: bigint;
      minimum_payment: bigint;
      payday_limit: PlainDate;
      interests: bigint;
    },
  ): Promise<{
    minimum_payment: bigint;
    total_payment: bigint;
    payday_limit: Date;
    interests: bigint;
    capital_balance: bigint;
    from_date: Date;
  }> {
    const data = {
      total_payment: summary.total_payment,
      minimum_payment: summary.minimum_payment,
      payday_limit: plainDateToUtcDate(summary.payday_limit),
      from_date: loan.disbursement_date,
      interests: summary.interests,
      capital_balance: loan.value,
    };

    const existing = await tx.loanDetail.findFirst({
      where: { loan_id: loan.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (existing !== null) {
      // D6: v1 would INSERT a second row here and make `GET /api/loan/<id>` a permanent 500.
      return tx.loanDetail.update({ where: { id: existing.id }, data });
    }
    return tx.loanDetail.create({ data: { ...data, loan_id: loan.id } });
  }

  /** `LoanDetail.objects.get(loan_id=...)`, made deterministic — see **D6**. */
  private async readLoanDetail(loanId: number): Promise<{
    minimum_payment: bigint;
    total_payment: bigint;
    payday_limit: Date;
    interests: bigint;
    capital_balance: bigint;
    from_date: Date;
  } | null> {
    return this.prisma.loanDetail.findFirst({
      where: { loan_id: loanId },
      orderBy: { id: 'asc' },
    });
  }
}

/**
 * The legal `Loan.state` transitions — **deviation D9** (operator Q14).
 *
 * ```
 *   0 WAITING_APPROVAL ──► 1 APPROVED ──► 3 PAID_OUT
 *          │                   │
 *          └──────────────────►2 DENIED
 * ```
 *
 * Everything else — `1→1` (re-approval), `3→1` (re-opening a closed loan), `2→anything`,
 * `x→x`, and the negative states `LoanDetailView.patch`'s `new_state <= 3` check lets through
 * — is refused. v1 permits them all and each one corrupts the record differently: `1→1`
 * re-sends the borrower's email and writes a second `LoanDetail`; `3→1` re-opens a loan the
 * fund has recorded as paid; a negative state is stored verbatim and renders as an unknown
 * state on every screen.
 *
 * ⚠️ **There is no entry for state `3`, so this table is also what makes a wrongly
 * auto-closed loan unrecoverable through the API** — `3→1` and `3→0` are both a 409. D6's
 * upsert makes such a repair *safe* once someone with database access has set the state back
 * by hand; it does not make it *reachable*. See {@link LoanService.updateLoan}'s D6 section.
 * Whether that repair should exist as a route is fund policy, escalated to `business-analyst`
 * as review condition **C42** — do not add a `3→…` entry here to “fix” it.
 *
 * ⚠️ **And if that answer ever comes back “yes”, an entry in this table is not enough.**
 * Verified in both stacks: the payment reminders are scheduled **only** on the monthly-TSV
 * path — v1 calls `__create_scheduled_task` from `__update_loan_detail` (`services/loan.py:296`)
 * and *never* from `__create_loan_detail`, and v2 mirrors it
 * ({@link LoanService} calls `scheduleNotification` from `updateLoanDetail` only, never from
 * `upsertLoanDetail`). Closing a loan **deletes** them (`removeSchNotifications` on state 3),
 * so a re-opened loan comes back with **no T−5d and no T−1d reminder** until the next
 * month's upload re-creates them. A re-open route must therefore *re-schedule* as well as
 * re-transition, or it silently costs the member the reminders their payment depends on.
 */
const LEGAL_LOAN_TRANSITIONS: ReadonlyMap<number, readonly number[]> = new Map([
  [LOAN_WAITING_APPROVAL, [LOAN_APPROVED, LOAN_DENIED]],
  [LOAN_APPROVED, [LOAN_PAID_OUT, LOAN_DENIED]],
]);

/** @throws ApiException 409 `{'message': 'Invalid state transition'}` */
export function assertLegalLoanTransition(current: number, next: number): void {
  const allowed = LEGAL_LOAN_TRANSITIONS.get(current) ?? [];
  if (!allowed.includes(next)) {
    throw ApiException.withMessage(HttpStatus.CONFLICT, 'Invalid state transition');
  }
}

/**
 * Is this **D9's own 409** — the single answer both {@link assertLegalLoanTransition} and the
 * compare-and-set in {@link LoanService.updateLoan} give when the row's state is not the one
 * the caller is transitioning from?
 *
 * Exists so {@link LoanService.bulkUpdateLoans}' auto-close can skip **exactly** the loan
 * whose state changed under it (C50) and keep aborting the upload on everything else. Match
 * on both the status and the body, not on `instanceof` alone: a 404 `'Loan does not exist'`
 * from the same call is not a race and must not be swallowed.
 */
function isInvalidStateTransition(error: unknown): boolean {
  return (
    error instanceof ApiException &&
    error.getStatus() === CONFLICT &&
    error.body?.message === 'Invalid state transition'
  );
}

/** `HttpStatus.CONFLICT` as a plain number, so the comparison is not an enum mismatch. */
const CONFLICT: number = HttpStatus.CONFLICT;

/**
 * `datetime.strptime(value, '%Y-%m-%d').date()`.
 *
 * ⚠️ **Stricter than `DateField.to_python`** and that difference is v1's, not v2's: the
 * *body* of a create goes through Django's field coercion (which accepts `2017-12-9`), while
 * `paymentProjection`'s `to_date` and `refinanceLoan`'s `disbursement_date` go through
 * `strptime`. `%m`/`%d` accept one *or* two digits, so `'2017-12-9'` parses here too — but a
 * trailing newline does not, and neither does anything after the day.
 *
 * `strptime` also validates the calendar date, so `'2018-02-30'` raises.
 */
export function strptimeIsoDate(value: unknown): PlainDate {
  if (typeof value !== 'string') {
    throw new PythonTypeError(
      `TypeError: strptime() argument 1 must be str, not ${value === null ? 'NoneType' : typeof value}`,
    );
  }
  // ⚠️ `parseStrptimeIsoDate`, not a hand-rolled `\d{1,2}` regex — **Major 5**. `_strptime`
  // generates `(?P<Y>\d\d\d\d)-(?P<m>1[0-2]|0[1-9]|[1-9])-(?P<d>3[0-1]|[1-2]\d|0[1-9]|[1-9]| [1-9])`
  // and the directives DISAGREE about Unicode: `%Y` is Unicode-aware and folded, `%m` is ASCII
  // in every branch, `%d` is ASCII in its first character but Unicode-aware in `[1-2]\d`'s
  // second — and it has a space-padded branch. Seven inputs v1 accepts were refused here.
  const parts = parseStrptimeIsoDate(value);
  if (parts === null) {
    throw new PythonTypeError(`ValueError: time data '${value}' does not match format '%Y-%m-%d'`);
  }
  const { year, month, day } = parts;
  // ⚠️ `utcMillisFromParts`, never raw `Date.UTC` — **B2, second round**. The round-trip
  // comparison below is what made this reachable: `Date.UTC` remaps a year in [0,99] to
  // 1900+year, so `probe.getUTCFullYear() !== year` fired for every such year and this threw.
  // Measured on the pinned CPython 3.9.25: `strptime('0050-06-15', '%Y-%m-%d')` is
  // `0050-06-15`, so v1 answered 200 where v2 answered 500.
  const probe = new Date(utcMillisFromParts(year, month - 1, day));
  if (
    // `strptime` raises `ValueError: year 0 is out of range` outside 1..9999 (measured).
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new PythonTypeError(
      `ValueError: unconverted data remains, or day is out of range: '${value}'`,
    );
  }
  return { year, month, day };
}

/**
 * `"{}-{}-{}".format(date[2], date[1], date[0])` over `data[n].strip().split("/")`, then
 * Django's `DateField.to_python` on the result.
 *
 * The file carries `D/M/Y`; the code re-assembles `Y-M-D` **without zero-padding**, which is
 * exactly why `toDjangoDate` has to accept `\d{1,2}`. A short row (`'1/1'`) produces
 * `IndexError` in v1 — reproduced by {@link requireColumn}'s sibling below.
 */
function parseSlashDate(raw: string): PlainDate {
  const parts = raw.trim().split('/');
  const day = parts[0];
  const month = parts[1];
  const year = parts[2];
  if (year === undefined || month === undefined || day === undefined) {
    throw new PythonTypeError('IndexError: list index out of range (date column)');
  }
  return toDjangoDate(`${year}-${month}-${day}`, 'payday_limit/from_date');
}

/**
 * Python truthiness, as `if new_loan['includeInterests']:` applies it.
 *
 * `False`, `None`, `0`, `''`, `[]` and `{}` are falsy; **every** other value — including the
 * string `'false'` — is truthy. `Boolean(value)` in JS agrees on all of those except the
 * empty array and the empty object, which JS calls truthy and Python calls falsy.
 */
function isPythonTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** `Loan.comments` is `TextField(null=True)`, so a JSON `null` stays SQL NULL. */
function toDjangoNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : toDjangoText(value);
}

/** `Loan.disbursement_value` is `BigIntegerField(null=True)`. */
function toDjangoNullableInt(value: unknown): bigint | null {
  return value === null || value === undefined ? null : toDjangoInt(value, 'disbursement_value');
}
