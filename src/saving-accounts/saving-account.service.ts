import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';
import { UserService } from '../users/user.service';
import { Role } from '../auth/permissions/roles';
import {
  buildPageEnvelope,
  isPageBeyondLast,
  pageOffset,
  unpaginatedEnvelope,
  type PageEnvelope,
  type UnpaginatedEnvelope,
} from '../common/http/pagination';
import type { PlainDate } from '../common/utils/date.util';
import {
  asPythonDict,
  pyGet,
  toDjangoDate,
  toDjangoInt,
  toDjangoSmallInt,
} from '../common/utils/python-obj';
import {
  bogotaWallClockToInstant,
  nowInstant,
  plainDateToUtcDate,
  todayInBogota,
} from '../common/utils/timezone.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CLOSE_SAVING_ACCOUNT_PAYLOAD_TYPE,
  SchedulerTaskRepository,
} from '../scheduler/scheduler-task.repository';
import {
  SAVING_ACCOUNT_ACTIVE,
  SAVING_ACCOUNT_CLOSED,
  serializeSavingAccount,
  WITH_OWNER,
  type SavingAccountDto,
} from './dto/saving-account.serializers';
import type { Prisma } from '../prisma';

/**
 * `fondo_api/services/saving_account.py:SavingAccountService`.
 *
 * ## What a CAP is — operator answers **Q19**–**Q24**, not inference
 *
 * A CAP (*Certificado de Ahorro a Plazo*) is a **fixed-term deposit that earns no interest
 * and no return** (**Q19**). The fund records that a member has money on deposit until a
 * date, and nothing accrues. **There is no rate anywhere in this module** — deliberately, and
 * unlike `LoanService`, whose whole shape is rate arithmetic.
 *
 * ## ⚠️ CAP balances are **purely informational** — they feed no quota (**Q24**)
 *
 * `UserFinanceSerializer.get_total_savingaccounts` (`serializers.py:32-35`) sums the
 * **active** rows this service writes and puts the total in the user response, and that is
 * *all* it does. It affects **neither `total_quota` nor `contributions`**, neither
 * `available_quota` nor a loan's eligibility. A member with 900,000 in a CAP can borrow
 * exactly what a member with none can.
 *
 * That is stated here in prose because it contradicts the natural reading — "savings that do
 * not count towards what you may borrow" is a surprising rule — and a future maintainer will
 * otherwise "fix" it by folding `total_savingaccounts` into a quota. It is not a defect. The
 * one live consequence to keep in mind is the reverse direction: **a write here changes a
 * Phase 3 response**, because `UserService.getUserFullInfo` aggregates `savingAccount` at
 * `state: 0`. Anything that changes which rows are `state = 0` — including **D12**'s
 * auto-close — changes `total_savingaccounts`.
 *
 * ## Who may act on a CAP
 *
 * `list_permissions['SavingAccountView']` is `GET 3`, `POST 3`, `PUT [0, 2]`. Only **ADMIN
 * and TREASURER** may revalue or close one (**Q22**), and PRESIDENT's exclusion is
 * **deliberate** (**Q23**) — the register row that proposed adding them (**D3**) is
 * *withdrawn*. There is no ownership check on `PUT` and none is wanted: those two roles
 * legitimately manage any member's CAP.
 *
 * **No member notification on close or revalue** (**Q22**). ⚠️ That answer is about *close
 * and revalue*; `create_account` **does** notify, and that notification is v1 behaviour that
 * stays — see {@link createAccount}.
 *
 * ## Dependencies mirror v1's own wiring
 *
 * `views/saving_account.py:11` constructs `SavingAccountService(user_service,
 * notification_service)`. {@link SchedulerTaskRepository} is the one addition, and it is
 * D12's: v1 has the `# TODO` and no scheduler write.
 */
@Injectable()
export class SavingAccountService {
  /** `self.ACCOUNTS_PER_PAGE = 10`. */
  readonly ACCOUNTS_PER_PAGE = 10;

  private readonly logger = new Logger('fondo_api.services.saving_account');

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly notifications: NotificationService,
    private readonly tasks: SchedulerTaskRepository,
  ) {}

  /**
   * `create_account(user_id, obj)`.
   *
   * ```python
   * user = self.__user_service.get_profile(user_id)
   * saving_account = SavingAccount.objects.create(end_date = obj['end_date'], user = user)
   * self.__notification_service.send_notification(
   *     self.__user_service.get_users_attr('id', [0,2]),
   *     "Ha sido creada una nueva CAP",
   *     "/manage/caps",
   * )
   * # TODO: schedule task for closing CAP
   * return saving_account.id
   * ```
   *
   * ⚠️ **The account is always created for the caller.** Nothing here reads a target user
   * from the body, so a treasurer cannot open a CAP *for* a member through this endpoint —
   * the same shape as `LoanView.post`.
   *
   * ⚠️ **`obj['end_date']` is a bare subscript.** A body without the key raises `KeyError`
   * with nothing around it to catch it, so v1 answers **500** and writes no row; an
   * unparseable date raises `ValidationError` out of `DateField.to_python`, also a 500. Both
   * are reproduced by {@link pyGet} / {@link toDjangoDate} (`docs/phase-7b-deviations.md`
   * §4 **P7-D6** covers why the log *text* of such an error differs from v1's).
   *
   * ⚠️ **`state` and `value` have Python-side defaults only** (`models.py:144-145`), and
   * `created_at` is `auto_now_add`. None of the three has a database default, so all three
   * are supplied explicitly (plan §4 rule 5).
   *
   * ## The notification stays — **Q22** is about *close and revalue*
   *
   * `"Ha sido creada una nueva CAP"` goes to every **active** ADMIN and TREASURER
   * (`get_users_attr('id', [0,2])` filters `is_active=True`), targeted at `/manage/caps`. It
   * is not sent to the member. Q22's "no member notification" answer is about the close and
   * the revalue; deleting this one would be an unregistered behaviour change on the create.
   *
   * It is published **after** the row is written and **outside** any transaction, which is
   * where v1 has it and where the publisher requires it (never inside a Prisma interactive
   * transaction). A publish failure does not roll the CAP back — `sendNotification` returns a
   * delivery tag and never throws.
   *
   * ## D12 — the close task, which v1's `# TODO` never became
   *
   * One `SchedulerTask` per CAP, `type = 1`, `run_date` = local midnight on `end_date`,
   * **`repeat = 0`** — see {@link SchedulerTaskRepository.createCloseSavingAccountTask} for
   * why that is load-bearing rather than incidental. `run_date` is built with
   * {@link bogotaWallClockToInstant} so the row lands at `05:00Z` exactly like the birthday
   * rows Django wrote, and the runner's Bogota-anchored date predicate selects it on the
   * intended day.
   *
   * The task is written **unconditionally**, including for an `end_date` already in the past:
   * the runner's predicate is `<=` (**D7**), so such a CAP closes on the very next pass
   * rather than never. Writing it is also *not* transactional with the CAP insert — v1 wraps
   * nothing here — so the failure mode is a CAP with no close task, which is exactly what the
   * reconciliation query in {@link findUnclosedPastDue} exists to surface.
   */
  async createAccount(userId: number, body: unknown): Promise<number> {
    const obj = asPythonDict(body);
    // `obj['end_date']` — KeyError, then DateField.to_python's ValidationError. Both 500.
    const endDate = toDjangoDate(pyGet(obj, 'end_date'), 'end_date');

    // `user = self.__user_service.get_profile(user_id)` — the FK target. The guard has
    // already proved the profile exists (it read `role` off it to authorise), so the
    // `DoesNotExist` → 500 branch is unreachable through the view, as it is in v1.
    const account = await this.prisma.savingAccount.create({
      data: {
        // `auto_now_add` on a `timestamptz` — an instant, not a calendar date (rule 5c).
        created_at: nowInstant(),
        end_date: plainDateToUtcDate(endDate),
        state: SAVING_ACCOUNT_ACTIVE,
        value: 0n,
        user_id: userId,
      },
      select: { id: true },
    });

    // D12. Before the notification, because v1's `# TODO` sits after it and the ordering of
    // two independent side effects is not observable — but a failure to schedule the close
    // must not be masked by having already published.
    await this.tasks.createCloseSavingAccountTask(bogotaWallClockToInstant(endDate), {
      type: CLOSE_SAVING_ACCOUNT_PAYLOAD_TYPE,
      saving_account_id: account.id,
    });

    // `get_users_attr('id', [0,2])` — active ADMINs and TREASURERs, not the member.
    const recipients = await this.users.getUserIds([Role.ADMIN, Role.TREASURER]);
    await this.notifications.sendNotification(
      recipients,
      'Ha sido creada una nueva CAP',
      '/manage/caps',
    );

    return account.id;
  }

  /**
   * `get_accounts(user_id, page, all_accounts = False, state = 0, paginate = True)`.
   *
   * ```python
   * if not all_accounts:
   *     accounts = SavingAccount.objects.filter(user_id=user_id, state=state).order_by('-created_at', '-id')
   * else:
   *     accounts = SavingAccount.objects.filter(state=state).order_by('-created_at', '-id')
   * if paginate:
   *     paginator = Paginator(accounts, self.ACCOUNTS_PER_PAGE)
   *     if page > paginator.num_pages:
   *         return {'list': [], 'num_pages': paginator.num_pages, 'count': paginator.count}
   *     page_return = paginator.page(page)
   *     return {'list': serializer.data, 'num_pages': paginator.num_pages, 'count': paginator.count}
   * return {'list': serializer.data}
   * ```
   *
   * ⚠️ **`state` is always applied**, unlike `get_loans`, which treats `state = 4` as "every
   * state". There is no "all states" value here: a CAP is `0 ACTIVE` or `1 CLOSED`, the view
   * refuses anything outside 0–1, and the default is `0`. So the **default list is the open
   * CAPs only** — a closed CAP is invisible until `?state=1` is asked for.
   *
   * ⚠️ **A row whose `state` is neither 0 nor 1 is unreachable through this method** and
   * therefore invisible in every list. `PUT` writes `state` with no choices validation (see
   * {@link updateAccount}), so such a row is producible. Registered in
   * `docs/phase-6-deviations.md`.
   *
   * ⚠️ **Ordering is `-created_at, -id`.** The `id` tiebreak is not decoration: `created_at`
   * is `auto_now_add` and two CAPs created in the same millisecond would otherwise come back
   * in heap order, which differs between v1 and v2.
   *
   * The envelope is the shared {@link buildPageEnvelope} — including the two v1 properties a
   * greenfield API would get wrong: a page past the last one is a **200** with an empty
   * `list`, and `num_pages` is **never 0**.
   */
  async getAccounts(
    userId: number,
    page: number,
    allAccounts = false,
    state: number = SAVING_ACCOUNT_ACTIVE,
    paginate = true,
  ): Promise<PageEnvelope<SavingAccountDto> | UnpaginatedEnvelope<SavingAccountDto>> {
    const where: Prisma.SavingAccountWhereInput = {
      ...(allAccounts ? {} : { user_id: userId }),
      state,
    };
    const orderBy: Prisma.SavingAccountOrderByWithRelationInput[] = [
      { created_at: 'desc' },
      { id: 'desc' },
    ];

    if (!paginate) {
      const accounts = await this.prisma.savingAccount.findMany({
        where,
        orderBy,
        include: WITH_OWNER,
      });
      return unpaginatedEnvelope(accounts.map(serializeSavingAccount));
    }

    const count = await this.prisma.savingAccount.count({ where });
    if (isPageBeyondLast(page, count, this.ACCOUNTS_PER_PAGE)) {
      return buildPageEnvelope<SavingAccountDto>([], count, this.ACCOUNTS_PER_PAGE);
    }
    const accounts = await this.prisma.savingAccount.findMany({
      where,
      orderBy,
      include: WITH_OWNER,
      skip: pageOffset(page, this.ACCOUNTS_PER_PAGE),
      take: this.ACCOUNTS_PER_PAGE,
    });
    return buildPageEnvelope(accounts.map(serializeSavingAccount), count, this.ACCOUNTS_PER_PAGE);
  }

  /**
   * `update_account(obj)`.
   *
   * ```python
   * try:
   *     account = SavingAccount.objects.get(id=obj['id'])
   * except SavingAccount.DoesNotExist:
   *     return False
   * account.state = obj['state']
   * account.value = obj['value']
   * account.save()
   * return True
   * ```
   *
   * ⚠️ **`value` is the new total balance, a plain replacement — not a deposit to add**
   * (**Q21**). `PUT {value: 500000}` on a CAP holding 900,000 leaves 500,000, not 1,400,000.
   * This matches v1 and is confirmed rather than changed.
   *
   * ⚠️ **The three subscripts are bare.** `obj['id']` is *inside* the `try`, but
   * `except SavingAccount.DoesNotExist` does not catch `KeyError`, so a missing `id` escapes
   * as a **500**; `obj['state']` and `obj['value']` are outside it entirely and are also
   * 500s. Only a well-formed body naming a row that does not exist is the **404**.
   *
   * ⚠️ **`state` is written without choices validation.** Django validates `choices` in
   * `full_clean()`, which `Model.save()` does not call, so `PUT {state: 7}` writes a 7. Such
   * a row then matches no list filter (0/1 only), is not counted by `total_savingaccounts`
   * (`state = 0`), and is skipped by D12's compare-and-set close (`AND state = 0`) — it is
   * invisible everywhere at once. Ported rather than narrowed, and registered.
   *
   * ⚠️ **v1's `account.save()` writes every column**, this writes two. Not observable: the
   * other four are re-sent with the values just read, `created_at` is `auto_now_add` and so
   * untouched on an update, and no column has a database-side trigger. Narrowing it also
   * removes a lost-update window v1 has.
   *
   * @returns `true` when a row was updated, `false` when no CAP has that id (the view's 404).
   */
  async updateAccount(body: unknown): Promise<boolean> {
    const obj = asPythonDict(body);
    // `SavingAccount.objects.get(id=obj['id'])` — Django coerces through
    // `AutoField.get_prep_value` → `int()`, so a non-numeric id is a ValueError → 500, not a
    // 404. Reading all three keys up front matches v1's evaluation order closely enough that
    // the observable result (which key 500s first) is the same.
    const id = toDjangoSmallInt(pyGet(obj, 'id'), 'id');

    const existing = await this.prisma.savingAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (existing === null) {
      return false;
    }

    const state = toDjangoSmallInt(pyGet(obj, 'state'), 'state');
    const value = toDjangoInt(pyGet(obj, 'value'), 'value');

    await this.prisma.savingAccount.update({ where: { id }, data: { state, value } });
    return true;
  }

  /**
   * **D12.** Closes one CAP. `UPDATE … SET state = 1 WHERE id = ? AND state = 0`.
   *
   * The shape is fixed by condition **C78** and every clause in it is doing work:
   *
   *  * **compare-and-set, not read-modify-write** — two runners that both loaded the task
   *    cannot both "close" it into an inconsistent read, and there is no window between the
   *    read and the write;
   *  * **`AND state = 0`** — a rerun is a no-op rather than an error, which is what makes the
   *    close *idempotent* and therefore safe under the claim-then-crash window that
   *    `docs/phase-7b-deviations.md` §4 **P7-D2** describes;
   *  * **`state` is written**, never derived from `end_date` at read time. Deriving would
   *    edit a Phase 3 path that has already passed its gate
   *    (`UserService.getUserFullInfo`'s `state: 0` aggregate), would put two sources of truth
   *    in a one-column model that `PUT { id, state, value }` writes directly, and — the point
   *    — would make the runner's failure *invisible* rather than *detectable*.
   *
   * @returns `'closed'` when this call did the closing, `'already-closed'` when the row was
   *   already `state != 0`. Both are successes.
   * @throws when no `fondo_api_savingaccount` row has that id at all — see
   *   {@link SavingAccountCloseExecuter}, which turns that into the loud, retried failure.
   */
  async closeAccount(id: number): Promise<'closed' | 'already-closed'> {
    const updated = await this.prisma.savingAccount.updateMany({
      where: { id, state: SAVING_ACCOUNT_ACTIVE },
      data: { state: SAVING_ACCOUNT_CLOSED },
    });
    if (updated.count > 0) {
      this.logger.log(`Saving account ${id} closed on its end_date`);
      return 'closed';
    }

    // 0 rows can mean two very different things and they must not be collapsed: the row is
    // already closed (the idempotent rerun this statement is designed for), or the row does
    // not exist (a CAP that vanished under a task that still names it).
    const existing = await this.prisma.savingAccount.findUnique({
      where: { id },
      select: { state: true },
    });
    if (existing === null) {
      throw new Error(
        `Saving account ${id} does not exist; its close task cannot be completed. ` +
          'The task row is left unprocessed on purpose so this stays visible.',
      );
    }
    return 'already-closed';
  }

  /**
   * **D12's independent check, and its ship-day backfill** — condition **C78**, operator
   * answer **Q38**.
   *
   * ```sql
   * SELECT id FROM fondo_api_savingaccount
   * WHERE state = 0 AND end_date < <today, America/Bogota>
   * ```
   *
   * ## Why this is not the thing that *drives* the close
   *
   * It would be cheaper to close CAPs by running this query on a schedule and updating
   * everything it returns, and that would be wrong: it would make the check and the mechanism
   * the same code, so a broken close would return an empty result and read as "nothing to
   * do". **C74** asked for a check that does *not* depend on the runner having succeeded, and
   * a check can only have that property by being a different path from the work. So the close
   * is driven by a per-CAP task and verified by this query, and the two share no code.
   *
   * ## Strictly `<`, not `<=`
   *
   * A CAP whose `end_date` is **today** is not overdue — its task is due today and the 10:00
   * pass closes it. Using `<=` would report every one of them as an anomaly every morning
   * until the pass ran, which is how a real check becomes one nobody reads.
   *
   * ## The backfill
   *
   * CAPs created before D12 shipped have no task. This same query is the one-time cutover
   * sweep (**Q38**): it returns them, and each is closed with {@link closeAccount}. Measured
   * on `fondodev` **2026-09-08**: 2 CAPs in total, one already `state = 1`, exactly **one**
   * open with `end_date 2024-02-28` (900,000), and **zero** open CAPs with a future
   * `end_date`. Re-measure before running it; do not trust that figure.
   *
   * "Today" is anchored in `America/Bogota` and never read from the host (**C28**).
   */
  async findUnclosedPastDue(today: PlainDate = todayInBogota()): Promise<number[]> {
    const rows = await this.prisma.savingAccount.findMany({
      where: { state: SAVING_ACCOUNT_ACTIVE, end_date: { lt: plainDateToUtcDate(today) } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }
}
