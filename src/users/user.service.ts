import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DjangoPasswordService } from '../auth/password/django-password.service';
import {
  assertSectionWritable,
  changedSectionFields,
  resolveSection,
  userPatchAllowlist,
  type UserSection,
} from '../auth/policies/user-patch.policy';
import { SELF_USER_ID } from '../auth/policies/ownership';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import {
  buildPageEnvelope,
  isPageBeyondLast,
  pageOffset,
  unpaginatedEnvelope,
  type PageEnvelope,
  type UnpaginatedEnvelope,
} from '../common/http/pagination';
import type { PlainDate } from '../common/utils/date.util';
import { roundHalfEvenToBigInt } from '../common/utils/rounding.util';
import {
  nowInstant,
  plainDateToUtcDate,
  todayForAutoNowDateColumn,
} from '../common/utils/timezone.util';
import { AppConfigService } from '../config/app-config.service';
import { EmailTemplate } from '../mail/email-template';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { Prisma } from '../prisma';
import { PrismaService } from '../prisma/prisma.service';
import {
  serializeUserBirthdate,
  serializeUserFullInfo,
  serializeUserProfile,
  type UserBirthdateDto,
  type UserFullInfoDto,
  type UserProfileDto,
  type UserProfileRow,
} from './dto/user.serializers';
import {
  asPythonDict,
  pyGet,
  pyGetDict,
  pyHas,
  pythonNotEqual,
  toDjangoBool,
  toDjangoInt,
  toDjangoSmallInt,
  toDjangoText,
  PythonTypeError,
} from './python-obj';

/** The two halves of `UserProfile(User)`, as every read here loads them. */
const WITH_AUTH_USER = { auth_user: true } as const;

/** Thrown to abort `create_user`'s transaction after a failed activation email. */
class MailRollback extends Error {}

/**
 * `fondo_api/services/user.py:UserService` — everything except `handle_power_request`, which
 * is {@link PowerService} (same class in v1; split here only for file size, with no change
 * to who calls what).
 *
 * ## The error contract is v1's exception surface, not a design
 *
 * v1 has no validation layer. Which status a bad request gets is decided by which `except`
 * clause happens to sit around the line that raised — see `python-obj.ts` for the table. The
 * three shapes that recur below:
 *
 *  * `ApiException.empty(404 | 409)` — `Response(status=…)`, a **zero-byte** body.
 *  * `ApiException.withMessage(409, msg)` — `Response({'message': msg}, 409)`.
 *  * an ordinary `Error` — v1's uncaught exception, rendered as a bare 500.
 *
 * ## Deviations implemented here (plan §5)
 *
 * | # | v1 | v2 |
 * |---|---|---|
 * | **D1** | any member may set their own `role` / anyone's `total_quota` | {@link updateUser} authorises per section and per field |
 * | **D11** | `UserFinance.user` / `UserPreference.user` are plain FKs; a duplicate row 500s the endpoint forever | deterministic single-row reads, see {@link readFinance} |
 * | **D14** | only `GET` substitutes `-1` for the caller | `GET` **and** `PATCH` do; `DELETE` never does |
 * | **D15** | `__update_user_personal` rewrites `auth_user.username` from `email` | `username` is never written after creation |
 * | **D16** | `identification` is writable by any caller | ADMIN-only, gated on an actual change |
 * | **D19** | a 29 Feb birthdate 500s every personal save in a non-leap year | clamped to 28 Feb |
 * | **D20** | editing a **soft-deleted** user 500s and rolls the edit back | guarded |
 */
@Injectable()
export class UserService {
  /** v1: `self.ITEMS_PER_PAGE = 10`. */
  readonly ITEMS_PER_PAGE = 10;

  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
    private readonly passwords: DjangoPasswordService,
    private readonly config: AppConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // create_user
  // -------------------------------------------------------------------------

  /**
   * `create_user(obj)` — atomic across **four** tables, `auth_user` and
   * `fondo_api_userprofile` being the two physical halves of one Django model.
   *
   * ```python
   * with transaction.atomic():
   *     user = UserProfile.objects.create_user(...)
   *     UserFinance.objects.create(contributions=0, ..., user=user)
   *     UserPreference.objects.create(user=user)
   *     if not self.__mail_service.send_mail(USER_ACTIVATION, [user.email], mail_params):
   *         transaction.set_rollback(True)
   *         return (False, 'Invalid email')
   * except IntegrityError:
   *     return (False, 'Identification/email already exists')
   * ```
   *
   * Three things that are easy to lose:
   *
   *  1. **The mail send is inside the transaction and its failure rolls all four rows back.**
   *     An account nobody can activate is worse than no account: `key_activation` is the only
   *     way in, and it is only ever delivered by that email. (Condition **C22** is what keeps
   *     this bounded — the SES client does one attempt with a 5 s socket timeout, so a dead
   *     SES cannot hold a database transaction open indefinitely.)
   *  2. **`email` and `username` are normalised differently.** `UserManager._create_user`
   *     runs `normalize_email` on the email (which lowercases *only the domain*) and
   *     `normalize_username` — Unicode NFKC — on the username. `'A@EXAMPLE.COM'` is therefore
   *     stored as `email='A@example.com'`, `username='A@EXAMPLE.COM'`.
   *  3. **The password is *unusable*, not empty.** `create_user` passes no password, so
   *     `set_password(None)` stores `'!' + 40 random chars`.
   *
   * ⚠️ `auth_user.email` carries **no** unique constraint — only `username` and
   * `identification` do — so "email already exists" is really "username already exists". Two
   * live members share an email address with a child account for exactly this reason.
   */
  async createUser(body: unknown): Promise<void> {
    const obj = asPythonDict(body);
    const rawEmail = toDjangoText(pyGet(obj, 'email'));
    const identification = toDjangoInt(pyGet(obj, 'identification'), 'identification');
    const role = toDjangoSmallInt(pyGet(obj, 'role'), 'role');
    const firstName = toDjangoText(pyGet(obj, 'first_name'));
    const lastName = toDjangoText(pyGet(obj, 'last_name'));
    const keyActivation = generateActivationKey();

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.authUser.create({
            data: {
              password: this.passwords.unusablePassword(),
              username: normalizeUsername(rawEmail),
              email: normalizeEmail(rawEmail),
              first_name: firstName,
              last_name: lastName,
              is_superuser: false,
              is_staff: false,
              // v1: `is_active = False` — the member activates through the emailed link.
              is_active: false,
              // `User.date_joined` defaults to `timezone.now()`, application-side.
              date_joined: nowInstant(),
              profile: {
                create: {
                  identification,
                  role,
                  key_activation: keyActivation,
                  birthdate: null,
                },
              },
            },
            select: { id: true, email: true, first_name: true, last_name: true },
          });

          await tx.userFinance.create({
            data: {
              contributions: 0n,
              balance_contributions: 0n,
              total_quota: 0n,
              available_quota: 0n,
              utilized_quota: 0n,
              last_modified: todayForAutoNowDateColumn(),
              user_id: created.id,
            },
          });
          // `UserPreference.objects.create(user=user)` — every column is a model default.
          await tx.userPreference.create({
            data: {
              notifications: false,
              primary_color: '#800000',
              secondary_color: '#c83737',
              user_id: created.id,
            },
          });

          const sent = await this.mail.sendMail(EmailTemplate.USER_ACTIVATION, [created.email], {
            user_full_name: `${created.first_name} ${created.last_name}`,
            user_id: created.id,
            user_key: keyActivation,
            host_url: this.config.hostUrlApp,
          });
          if (!sent) {
            throw new MailRollback();
          }
        },
        // The default 5 s interactive-transaction budget is shorter than the mail leg's own
        // worst case (C22: one attempt, 1 s connect + 5 s socket).
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (error) {
      if (error instanceof MailRollback) {
        // v1: `transaction.set_rollback(True); return (False, 'Invalid email')`.
        throw ApiException.withMessage(HttpStatus.CONFLICT, 'Invalid email');
      }
      if (isUniqueViolation(error)) {
        throw ApiException.withMessage(HttpStatus.CONFLICT, 'Identification/email already exists');
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /**
   * `get_users(page)` — `UserProfile.objects.filter(is_active=True).order_by('id')`.
   *
   * `page === null` is v1's "no `page` query parameter": a bare `{'list': [...]}` with **no**
   * `num_pages` and **no** `count`. A page past the last one is a 200 with an empty list and
   * the real counters (plan §4 rule 1).
   */
  async getUsers(
    page: number | null,
  ): Promise<PageEnvelope<UserProfileDto> | UnpaginatedEnvelope<UserProfileDto>> {
    const where = { auth_user: { is_active: true } };

    if (page === null) {
      const users = await this.prisma.userProfile.findMany({
        where,
        orderBy: { user_ptr_id: 'asc' },
        include: WITH_AUTH_USER,
      });
      return unpaginatedEnvelope(users.map(serializeUserProfile));
    }

    const count = await this.prisma.userProfile.count({ where });
    if (isPageBeyondLast(page, count, this.ITEMS_PER_PAGE)) {
      return buildPageEnvelope<UserProfileDto>([], count, this.ITEMS_PER_PAGE);
    }
    const users = await this.prisma.userProfile.findMany({
      where,
      orderBy: { user_ptr_id: 'asc' },
      include: WITH_AUTH_USER,
      skip: pageOffset(page, this.ITEMS_PER_PAGE),
      take: this.ITEMS_PER_PAGE,
    });
    return buildPageEnvelope(users.map(serializeUserProfile), count, this.ITEMS_PER_PAGE);
  }

  /**
   * `get_user(id)`.
   *
   * ```python
   * try:
   *     user_finance = UserFinance.objects.get(user_id=id)
   *     user_preference = UserPreference.objects.get(user_id=id)
   * except:
   *     return (False, {})
   * ```
   *
   * ⚠️ **No `is_active` filter** — a soft-deleted member's profile is still readable by id.
   * That is deliberate in v1 (the admin screen needs it) and is ported unchanged.
   *
   * @throws ApiException 404 with a zero-byte body when either row is missing.
   */
  async getUser(id: number): Promise<UserFullInfoDto> {
    const finance = await this.readFinance({ user_id: id });
    const preference = await this.readPreference(id);
    if (finance === null || preference === null) {
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    const user = await this.prisma.userProfile.findUnique({
      where: { user_ptr_id: id },
      include: WITH_AUTH_USER,
    });
    if (user === null) {
      // Unreachable behind the FK, but v1's bare `except` would answer 404 here too.
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    const savings = await this.prisma.savingAccount.aggregate({
      where: { user_id: id, state: 0 },
      _sum: { value: true },
    });
    // `sum([])` is `0` in Python; Prisma's `_sum` is `null` for an empty set.
    return serializeUserFullInfo(user, finance, savings._sum.value ?? 0n, preference);
  }

  /**
   * `get_users_birthdate()` — every **active** member, unordered.
   *
   * ⚠️ No `ORDER BY`: `UserProfile.objects.filter(is_active=True)` has no `Meta.ordering`, so
   * v1 serialises PostgreSQL's heap order. Prisma emits no `ORDER BY` either when none is
   * asked for, so the two agree. Do not "tidy" an `orderBy` in — the same rule that governs
   * `NotificationSubscriptionRepository`'s row order applies, and here it also decides the
   * `user_ids` string stored in every birthday `SchedulerTask`.
   */
  async getUsersBirthdate(): Promise<UserBirthdateDto[]> {
    const users = await this.prisma.userProfile.findMany({
      where: { auth_user: { is_active: true } },
      include: WITH_AUTH_USER,
    });
    return users.map(serializeUserBirthdate);
  }

  /**
   * `get_users_attr(attr, roles=None)` — the ids or emails of the active members, in the same
   * unordered form as {@link getUsersBirthdate}.
   */
  async getUserIds(roles?: readonly number[]): Promise<number[]> {
    const users = await this.prisma.userProfile.findMany({
      where: {
        auth_user: { is_active: true },
        ...(roles === undefined ? {} : { role: { in: [...roles] } }),
      },
      select: { user_ptr_id: true },
    });
    return users.map((user) => user.user_ptr_id);
  }

  /** `get_users_attr('email', roles)`. */
  async getUserEmails(roles?: readonly number[]): Promise<string[]> {
    const users = await this.prisma.userProfile.findMany({
      where: {
        auth_user: { is_active: true },
        ...(roles === undefined ? {} : { role: { in: [...roles] } }),
      },
      select: { auth_user: { select: { email: true } } },
    });
    return users.map((user) => user.auth_user.email);
  }

  /** `get_profile(user_id)` — `UserProfile.objects.get(id=user_id)`, `null` on a miss. */
  async getProfile(userId: number): Promise<UserProfileRow | null> {
    return this.prisma.userProfile.findUnique({
      where: { user_ptr_id: userId },
      include: WITH_AUTH_USER,
    });
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * `inactive_user(id)` — a **soft** delete (`is_active = False`) on `auth_user`.
   *
   * ⚠️ Nothing in the API sets `is_active` back: `activate_user` is the only writer and it
   * requires a `key_activation`, which is `NULL` for all 15 live members. A soft delete is
   * therefore irreversible without direct database access — which is why **D14** refuses the
   * `-1` sentinel on this verb, and why {@link resolveDetailUserId} takes the substitution as
   * an explicit argument rather than a default.
   *
   * @throws ApiException 404 (zero-byte) when no `auth_user` row has that id.
   */
  async inactiveUser(id: number): Promise<void> {
    const result = await this.prisma.authUser.updateMany({
      where: { id },
      data: { is_active: false },
    });
    if (result.count === 0) {
      // v1: `except User.DoesNotExist: return False` -> 404.
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
  }

  // -------------------------------------------------------------------------
  // update_user
  // -------------------------------------------------------------------------

  /**
   * `update_user(id, obj)` plus **D1**'s authorisation, which v1 has none of.
   *
   * ```python
   * if obj['type'] == 'personal':  return self.__update_user_personal(id, obj['personal'])
   * if obj['type'] == 'finance':   return self.__update_user_finance(id, None, obj['finance'])
   * return self.__update_user_preferences(id, obj['preferences'])
   * ```
   *
   * ## Order of operations (§7 "C8 resolved")
   *
   * 1. `obj['type']` — a **missing** key is `KeyError` → 500, as in v1.
   * 2. {@link resolveSection} classifies it; an unrecognised value falls through to
   *    `preferences`, as in v1.
   * 3. **The section gate**, on `body.type` and the caller's role/ownership — never on which
   *    sections the body happens to contain. It runs **before** the target row is loaded, so
   *    a MEMBER declaring a `finance` write gets 403 whether or not the user exists, and the
   *    endpoint cannot be used to enumerate ids.
   * 4. The section handler, which loads the row (404 on a miss) and then applies the **field**
   *    gate to the fields actually being changed.
   */
  async updateUser(actor: AuthenticatedUser, id: number, body: unknown): Promise<void> {
    const obj = asPythonDict(body);
    // v1 evaluates `obj['type']` unguarded: a body without it is a 500, not a 400.
    const section: UserSection = resolveSection(pyGet(obj, 'type'));

    // D1, level 1. Independent of the payload's contents and of the target's existence.
    assertSectionWritable(actor, id, section);

    if (section === 'personal') {
      await this.updateUserPersonal(actor, id, pyGetDict(obj, 'personal'));
      return;
    }
    if (section === 'finance') {
      await this.updateUserFinance(id, null, pyGetDict(obj, 'finance'));
      return;
    }
    // ⚠️ `obj['preferences']` is subscripted in `update_user`, *outside*
    // `__update_user_preferences`'s bare `except`, so a body with no `preferences` key is a
    // **500** — not the 404 every other malformed preferences body produces.
    await this.updateUserPreferences(actor, id, pyGetDict(obj, 'preferences'));
  }

  /**
   * `__update_user_personal(id, obj)`.
   *
   * ```python
   * with transaction.atomic():
   *     user = self.get_profile(id)
   *     user.first_name = obj['first_name']
   *     user.last_name  = obj['last_name']
   *     user.email      = obj['email']
   *     user.username   = obj['email']          # <- D15: removed
   *     user.identification = obj['identification']
   *     user.role       = obj['role']
   *     if 'birthdate' in obj:
   *         user.birthdate = obj['birthdate']
   *         self.__create_birthdate_notification(user)
   *     user.save()
   * except UserProfile.DoesNotExist: return (False, 404)
   * except IntegrityError:           return (False, 409)
   * ```
   *
   * **D15 — `username` is no longer rewritten.** `auth_user.username` is UNIQUE and two live
   * members' emails are already another member's username, so v1's assignment raises
   * `IntegrityError` and **any** personal edit to user 13 or 14 is a bare 409 today. On the
   * other branch — a fresh, unique email — it silently rotates the name the member logs in
   * with, with no notification of any kind. `username` is not returned by any serializer, so
   * no client can even observe it. It is now set once, at creation, and never again.
   */
  private async updateUserPersonal(
    actor: AuthenticatedUser,
    id: number,
    obj: Record<string, unknown>,
  ): Promise<void> {
    const stored = await this.getProfile(id);
    if (stored === null) {
      // v1: `except UserProfile.DoesNotExist: return (False, 404)`.
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    // D1, level 2 — `role` and `identification` are ADMIN-only, and only when actually
    // changed (§5 D1 clarification 1, D16). Fields outside the section's writable set are
    // ignored exactly as v1 ignores them; see `changedSectionFields`.
    const changed = changedSectionFields('personal', obj, {
      first_name: stored.auth_user.first_name,
      last_name: stored.auth_user.last_name,
      email: stored.auth_user.email,
      identification: stored.identification,
      role: stored.role,
      birthdate: stored.birthdate,
    });
    userPatchAllowlist({ actor, targetUserId: id, section: 'personal', fields: changed }).assert(
      changed,
    );

    const firstName = toDjangoText(pyGet(obj, 'first_name'));
    const lastName = toDjangoText(pyGet(obj, 'last_name'));
    const email = toDjangoText(pyGet(obj, 'email'));
    const identification = toDjangoInt(pyGet(obj, 'identification'), 'identification');
    const role = toDjangoSmallInt(pyGet(obj, 'role'), 'role');
    const hasBirthdate = pyHas(obj, 'birthdate');
    const birthdate = hasBirthdate ? parseBirthdate(obj.birthdate) : null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.authUser.update({
          where: { id },
          data: {
            first_name: firstName,
            last_name: lastName,
            email,
            // D15: `username` is deliberately absent.
          },
        });
        await tx.userProfile.update({
          where: { user_ptr_id: id },
          data: {
            identification,
            role,
            ...(hasBirthdate ? { birthdate: plainDateToUtcDate(birthdate as PlainDate) } : {}),
          },
        });

        if (hasBirthdate) {
          // v1 runs this *inside* the atomic block, before `user.save()`, so a failed write
          // takes the scheduler rows with it. `tx` is threaded through for that reason.
          await this.createBirthdateNotification(
            {
              id,
              firstName,
              lastName,
              birthdate: birthdate as PlainDate,
            },
            tx,
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // v1: `except IntegrityError: return (False, 409)`. Still reachable through
        // `identification`, which is UNIQUE; no longer reachable through `username` (D15).
        throw ApiException.empty(HttpStatus.CONFLICT);
      }
      throw error;
    }
  }

  /**
   * `__create_birthdate_notification(user)` (`services/user.py:267-282`).
   *
   * ```python
   * today_year = datetime.now().year
   * birthdate  = datetime.strptime(user.birthdate, '%Y-%m-%d').date().replace(year=today_year)
   * user_ids   = self.get_users_attr("id")
   * user_ids.remove(user.id)
   * payload = {type, owner_id, user_ids, target: '/', message: 'Hoy está cumpliendo años …'}
   * self.__notification_service.remove_sch_notitfications("birthdate", user.id)
   * self.__notification_service.schedule_notification(birthdate_time, payload, 4)
   * ```
   *
   * Two registered defects are fixed here, both of which produce a **500 that rolls the whole
   * profile edit back** in v1:
   *
   * **D19 — 29 February.** `date(2000, 2, 29).replace(year=2026)` raises `ValueError`, and
   * `UserDetailView.patch` has no handler, so a member born on a leap day cannot save their
   * profile at all in a non-leap year. 0 of the 15 live members are affected, so it is latent
   * — it fires the day one is enrolled. **v2 clamps to 28 February**, and the reason is
   * consistency rather than taste: `repeat = 4` means the scheduler clones this task forward
   * with `relativedelta(years=+1)`, which maps 29 Feb to **28 Feb** (pinned in
   * `relativedelta.util.spec.ts` against `python-dateutil==2.7.5`). Clamping to 1 March would
   * make the first notification land a day later than every repeat of it — a permanent
   * one-day disagreement between the row this phase writes and the row Phase 7 writes from it.
   *
   * **D20 — a soft-deleted user.** `get_users_attr("id")` filters `is_active=True`, so
   * `user_ids.remove(user.id)` raises `ValueError` when the member being edited is inactive.
   * `fondodev` has **2 inactive users**, so this is triggerable today: an admin correcting a
   * deactivated member's name gets a 500 and the edit is discarded. The removal is guarded.
   *
   * ⚠️ `user_ids` order is PostgreSQL's heap order and is part of the stored payload
   * (`"user_ids"=>"[2, 4, 3, 13, …]"` on live rows). Do not sort it.
   */
  private async createBirthdateNotification(
    user: { id: number; firstName: string; lastName: string; birthdate: PlainDate },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const thisYear = new Date().getFullYear();
    const runDate = birthdayInYear(user.birthdate, thisYear);

    const userIds = await this.getUserIds();
    // D20: `list.remove` raises ValueError when the value is absent, which it is for every
    // inactive member. `indexOf` + `splice` reproduces "remove the first occurrence" without
    // the exception.
    const index = userIds.indexOf(user.id);
    if (index !== -1) {
      userIds.splice(index, 1);
    }

    const payload = {
      type: 'birthdate',
      owner_id: user.id,
      user_ids: userIds,
      target: '/',
      message: `Hoy está cumpliendo años ${user.firstName} ${user.lastName}`,
    };

    await this.notifications.removeSchNotifications('birthdate', user.id, tx);
    await this.notifications.scheduleNotification(runDate, payload, YEARLY_REPEAT, tx);
  }

  /**
   * `__update_user_finance(id, identification, obj)`.
   *
   * ```python
   * try:
   *     user_finance = (UserFinance.objects.get(user_id=id) if id is not None
   *                     else UserFinance.objects.get(user__identification=identification))
   * except UserFinance.DoesNotExist:
   *     return (False, 404)
   * if (contributions/balance_contributions/total_quota/utilized_quota differ):
   *     ... ; user_finance.available_quota = int(total_quota) - int(utilized_quota)
   *     user_finance.save()
   * return (True, 200)
   * ```
   *
   * Three properties worth stating because they look like bugs:
   *
   *  * **`available_quota` is derived, never taken from the body.** v1's own test posts an
   *    `available_quota` and asserts the *computed* value wins
   *    (`test_patch_user_not_finance`).
   *  * **Nothing is written when all four values match**, so `last_modified` does **not**
   *    advance on a no-op save. The monthly TSV relies on that.
   *  * **The comparison is Python's `!=`**, so a stringified number counts as a change. See
   *    `pythonNotEqual`.
   *
   * @param id the user id, or `null` when looking the row up by `identification` (bulk TSV).
   * @param quiet `true` for the bulk path, which logs and continues instead of 404ing.
   * @returns `true` when a row was found.
   */
  private async updateUserFinance(
    id: number | null,
    identification: bigint | null,
    obj: Record<string, unknown>,
    quiet = false,
  ): Promise<boolean> {
    const finance =
      id !== null
        ? await this.readFinance({ user_id: id })
        : await this.readFinance({ user: { identification: identification as bigint } });

    if (finance === null) {
      if (quiet) {
        return false;
      }
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    const contributions = pyGet(obj, 'contributions');
    const balanceContributions = pyGet(obj, 'balance_contributions');
    const totalQuota = pyGet(obj, 'total_quota');
    const utilizedQuota = pyGet(obj, 'utilized_quota');

    const changed =
      pythonNotEqual(finance.contributions, contributions) ||
      pythonNotEqual(finance.balance_contributions, balanceContributions) ||
      pythonNotEqual(finance.total_quota, totalQuota) ||
      pythonNotEqual(finance.utilized_quota, utilizedQuota);

    if (!changed) {
      return true;
    }

    const total = toDjangoInt(totalQuota, 'total_quota');
    const utilized = toDjangoInt(utilizedQuota, 'utilized_quota');
    await this.prisma.userFinance.update({
      where: { id: finance.id },
      data: {
        contributions: toDjangoInt(contributions, 'contributions'),
        balance_contributions: toDjangoInt(balanceContributions, 'balance_contributions'),
        total_quota: total,
        utilized_quota: utilized,
        available_quota: total - utilized,
        // `last_modified` is `auto_now` on a DateField: `date.today()` under the process
        // zone, which Django pins to `settings.TIME_ZONE` (plan §4 rule 5).
        last_modified: todayForAutoNowDateColumn(),
      },
    });
    return true;
  }

  /**
   * `__update_user_preferences(id, obj)`.
   *
   * ⚠️ **The whole body is inside a bare `except: return (False, 404)`.** A missing
   * `primary_color`, a colour longer than the column, a boolean the field cannot parse, even
   * a database error — all of them are a 404 in v1, not a 400 and not a 500. That is ported
   * literally, with a log line so the cause is not lost.
   *
   * ## `remove_all_subscriptions` is wired here — it is not dead code
   *
   * ```python
   * remove_notifications = user_preference.notifications != obj['notifications']
   * ...
   * if remove_notifications and not user_preference.notifications:
   *     self.__notification_service.remove_all_subscriptions(id)
   * ```
   *
   * It fires **only on the `true → false` transition**, not on every preferences save, and it
   * deletes every push subscription that member owns on every device. Irreversible from the
   * server's side — the browser only re-subscribes on service-worker activation. Phase 2
   * ported the method and could not wire it because this route did not exist; parity finding
   * **F5** corrected P2-D4's claim that it was dead.
   */
  private async updateUserPreferences(
    actor: AuthenticatedUser,
    id: number,
    obj: Record<string, unknown>,
  ): Promise<void> {
    let removeNotifications: boolean;
    let notifications: boolean;

    try {
      const stored = await this.readPreference(id);
      if (stored === null) {
        // v1: `UserPreference.objects.get(user_id=id)` -> DoesNotExist -> bare except -> 404.
        throw new PreferencesNotFound();
      }

      const submitted = pyGet(obj, 'notifications');
      // Python's `!=`: a stored `False` differs from the string `'false'`.
      removeNotifications = pythonNotEqual(stored.notifications, submitted);
      notifications = toDjangoBool(submitted, 'notifications');

      await this.prisma.userPreference.update({
        where: { id: stored.id },
        data: {
          notifications,
          primary_color: toDjangoText(pyGet(obj, 'primary_color')),
          secondary_color: toDjangoText(pyGet(obj, 'secondary_color')),
        },
      });
    } catch (error) {
      if (!(error instanceof PreferencesNotFound)) {
        this.logger.warn(
          `update_user_preferences(${id}) failed and is reported as 404, as in v1: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    // Outside the try in v2 as well as in v1: the subscription wipe is *after* the save, and
    // a failure in it is not a 404 (`remove_all_subscriptions` is inside v1's try, but it
    // cannot raise anything the bare except would have hidden usefully — a delete that fails
    // is a 500 the operator needs to see).
    if (removeNotifications && !notifications) {
      void actor;
      await this.notifications.removeAllSubscriptions(id);
    }
  }

  // -------------------------------------------------------------------------
  // activate_user
  // -------------------------------------------------------------------------

  /**
   * `activate_user(id, obj)`.
   *
   * ```python
   * if 'key' not in obj or obj['key'] == '':
   *     return False
   * try:
   *     user = UserProfile.objects.get(id=id, key_activation=obj['key'],
   *                                    identification=obj['identification'])
   * except:
   *     return False
   * user.set_password(obj['password'])
   * user.is_active = True
   * user.key_activation = None
   * user.save()
   * ```
   *
   * ⚠️ `obj['password']` is read **outside** the `try`, so a body with no `password` is a
   * **500** while a body with no `identification` is a 404. And `set_password(None)` stores an
   * *unusable* password, so `{"password": null, ...}` activates an account nobody can ever log
   * into — reproduced, because a client doing that in v1 gets the same silent outcome.
   *
   * This route is `permission_classes = []`: **public**, by design. The `key_activation` is
   * the credential.
   *
   * @throws ApiException 404 (zero-byte) on any mismatch.
   */
  async activateUser(id: number, body: unknown): Promise<void> {
    const obj = asPythonDict(body);
    if (!pyHas(obj, 'key') || obj.key === '') {
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    let match: { user_ptr_id: number } | null;
    try {
      match = await this.prisma.userProfile.findFirst({
        where: {
          user_ptr_id: id,
          key_activation: toDjangoText(obj.key),
          identification: toDjangoInt(pyGet(obj, 'identification'), 'identification'),
        },
        select: { user_ptr_id: true },
      });
    } catch {
      // v1's bare `except` also swallows the `KeyError` for `identification` and the
      // `ValueError` from a non-numeric one.
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    if (match === null) {
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    // Outside the try, as in v1: a missing `password` key is an uncaught KeyError -> 500.
    const rawPassword = pyGet(obj, 'password');
    const password =
      rawPassword === null || rawPassword === undefined
        ? this.passwords.unusablePassword()
        : await this.passwords.hash(toDjangoText(rawPassword));

    await this.prisma.$transaction([
      this.prisma.authUser.update({
        where: { id },
        data: { password, is_active: true },
      }),
      this.prisma.userProfile.update({
        where: { user_ptr_id: id },
        data: { key_activation: null },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // bulk_update_users
  // -------------------------------------------------------------------------

  /**
   * `bulk_update_users(obj)` — the treasurer's monthly TSV, `@transaction.atomic`.
   *
   * ```python
   * for line in obj['file']:
   *     data = line.decode('utf-8').strip().split("\t")
   *     identification = int(data[0])
   *     info['balance_contributions'] = int(round(float(data[1]), 0))
   *     info['total_quota']           = int(round(float(data[2]), 0))
   *     info['contributions']         = int(round(float(data[3]), 0))
   *     info['utilized_quota']        = int(round(float(data[4]), 0))
   *     success, state = self.__update_user_finance(None, identification, info)
   *     if not success:
   *         self.__logger.error('User with identification: {}, not exists'.format(identification))
   *         continue
   * ```
   *
   * ⚠️ **Column order is not the model's.** The file is
   * `identification, balance_contributions, total_quota, contributions, utilized_quota` —
   * `contributions` is the **fourth** column, not the second. Getting that wrong swaps two
   * money figures for every member and the response is still a 200.
   *
   * ⚠️ `round()` is CPython's, i.e. **half-even** (`round(0.5) == 0`), not `Math.round`.
   *
   * ⚠️ An unknown identification is **logged and skipped** — the response is still 200 with an
   * empty body. That silence is what makes D16 matter: a member who changes their own cédula
   * disappears from the file with no signal to the treasurer.
   *
   * ⚠️ A malformed line raises (`ValueError` / `IndexError`) and, being inside
   * `@transaction.atomic`, **discards the whole upload** — every earlier line included.
   * Ported: partial application of a monthly file would be worse than none.
   */
  async bulkUpdateUsers(fileContents: Buffer): Promise<void> {
    const lines = djangoFileLines(fileContents);
    await this.prisma.$transaction(async () => {
      for (const line of lines) {
        const data = line.trim().split('\t');
        const identification = toDjangoInt(requireColumn(data, 0), 'identification');
        const info = {
          balance_contributions: parseMoneyColumn(data, 1),
          total_quota: parseMoneyColumn(data, 2),
          contributions: parseMoneyColumn(data, 3),
          utilized_quota: parseMoneyColumn(data, 4),
        };
        const found = await this.updateUserFinance(null, identification, info, true);
        if (!found) {
          this.logger.error(`User with identification: ${identification}, not exists`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // D11 — one finance / preference row per user, deterministically
  // -------------------------------------------------------------------------

  /**
   * `UserFinance.objects.get(...)`, made total — **deviation D11**.
   *
   * `UserFinance.user` and `UserPreference.user` are declared `ForeignKey`, not `OneToOne`, so
   * the database permits a second row per user. `.get()` then raises `MultipleObjectsReturned`,
   * which `__update_user_finance` does **not** catch (it catches only `DoesNotExist`), so that
   * member's finance endpoints 500 permanently. `get_user` catches it in a bare `except` and
   * answers 404 instead — a different wrong answer for the same corruption.
   *
   * v2 reads the **lowest-id** row deterministically, so a duplicate degrades to "the second
   * row is ignored" rather than to a permanent outage, and both endpoints keep working.
   *
   * ⚠️ The physical `UNIQUE (user_id)` constraint D11 also asks for is **not** applied here:
   * Django owns the schema until Phase 9 and plan §4 rule 6 forbids v2 running migrations
   * against a database v1 shares. It is recorded as a Phase 9 schema change in
   * `docs/phase-3-deviations.md`. Nothing in v2 can create a second row — `create_user` is the
   * only writer and it runs inside a transaction — so the application-level rule is the whole
   * of the fix until then.
   */
  private async readFinance(where: Prisma.UserFinanceWhereInput): Promise<{
    id: number;
    contributions: bigint;
    balance_contributions: bigint;
    total_quota: bigint;
    available_quota: bigint;
    utilized_quota: bigint;
    last_modified: Date;
  } | null> {
    return this.prisma.userFinance.findFirst({ where, orderBy: { id: 'asc' } });
  }

  /** {@link readFinance}'s counterpart for `UserPreference` — same D11 reasoning. */
  private async readPreference(userId: number): Promise<{
    id: number;
    notifications: boolean;
    primary_color: string;
    secondary_color: string;
  } | null> {
    return this.prisma.userPreference.findFirst({
      where: { user_id: userId },
      orderBy: { id: 'asc' },
    });
  }
}

/** Internal marker so the bare-except port does not log a legitimate 404 as a failure. */
class PreferencesNotFound extends Error {}

/** `SchedulerTask.REPEAT_TYPES` — `4` is `YEARLY`, which is what the birthday task uses. */
const YEARLY_REPEAT = 4;

/**
 * `binascii.hexlify(os.urandom(25)).decode()` — 25 random bytes as 50 lowercase hex chars.
 * The column is `varchar(100)`.
 */
function generateActivationKey(): string {
  return randomBytes(25).toString('hex');
}

/**
 * `BaseUserManager.normalize_email` — lowercases **only the domain part**, and leaves an
 * address with no `@` (or more than one) alone.
 */
export function normalizeEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) {
    return email;
  }
  return `${email.slice(0, at)}@${email.slice(at + 1).toLowerCase()}`;
}

/** `AbstractBaseUser.normalize_username` — `unicodedata.normalize('NFKC', username)`. */
export function normalizeUsername(username: string): string {
  return username.normalize('NFKC');
}

/**
 * `datetime.strptime(user.birthdate, '%Y-%m-%d').date()`.
 *
 * v1 assigns the raw body value to `user.birthdate` and then parses that **string**, so a
 * non-string or a differently formatted value is a `TypeError`/`ValueError` → 500 → the whole
 * edit rolls back. Reproduced, including the rejection of `null`.
 */
function parseBirthdate(value: unknown): PlainDate {
  if (typeof value !== 'string') {
    throw new PythonTypeError(
      `TypeError: strptime() argument 1 must be str, not ${value === null ? 'NoneType' : typeof value}`,
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new PythonTypeError(`ValueError: time data '${value}' does not match format '%Y-%m-%d'`);
  }
  const [, year, month, day] = match;
  const parsed = { year: Number(year), month: Number(month), day: Number(day) };
  const asDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (
    asDate.getUTCFullYear() !== parsed.year ||
    asDate.getUTCMonth() + 1 !== parsed.month ||
    asDate.getUTCDate() !== parsed.day
  ) {
    throw new PythonTypeError(`ValueError: day is out of range for month: '${value}'`);
  }
  return parsed;
}

/**
 * `birthdate.replace(year=today_year)` with **D19**'s clamp.
 *
 * 29 February exists only in a leap year; `.replace` raises `ValueError` in every other one.
 * v2 moves the notification to **28 February**, which is where `relativedelta(years=+1)` —
 * and therefore Phase 7's own yearly clone of this very task — puts it.
 */
export function birthdayInYear(birthdate: PlainDate, year: number): PlainDate {
  if (birthdate.month === 2 && birthdate.day === 29 && !isLeapYear(year)) {
    return { year, month: 2, day: 28 };
  }
  return { year, month: birthdate.month, day: birthdate.day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * `django.core.files.base.File.__iter__` — iterating an uploaded file yields **lines**.
 *
 * For `bytes`, CPython's `splitlines` breaks on `\n`, `\r` and `\r\n` only (the extra Unicode
 * line breaks are a `str` feature). A terminator at the end of the file does **not** produce a
 * trailing empty line.
 *
 * ⚠️ A genuinely blank line in the middle of the file yields `['']`, and `int('')` raises
 * `ValueError` → 500 → the whole upload rolls back. v1's behaviour, kept: a monthly file with
 * a stray blank line is rejected in full rather than applied in part.
 */
export function djangoFileLines(contents: Buffer): string[] {
  const text = contents.toString('utf8');
  if (text === '') {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function requireColumn(data: readonly string[], index: number): string {
  const value = data[index];
  if (value === undefined) {
    throw new PythonTypeError(`IndexError: list index out of range (column ${index})`);
  }
  return value;
}

/** `int(round(float(data[i]), 0))` — CPython's half-even `round`, not `Math.round`. */
function parseMoneyColumn(data: readonly string[], index: number): bigint {
  const raw = requireColumn(data, index).trim();
  const asFloat = Number(raw);
  if (raw === '' || !Number.isFinite(asFloat)) {
    throw new PythonTypeError(`ValueError: could not convert string to float: '${raw}'`);
  }
  return roundHalfEvenToBigInt(asFloat);
}

/** A PostgreSQL `23505` surfaced by Prisma. v1 sees `django.db.IntegrityError`. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * v1's `-1 == me`, applied **per verb** — deviation **D14**.
 *
 * ```python
 * # UserDetailView.get   -> substitutes
 * # UserDetailView.patch -> does not; looks up user -1 and 404s, for every caller, always
 * # UserDetailView.delete-> does not
 * ```
 *
 *  * **GET** keeps it. Unchanged.
 *  * **PATCH adopts it.** v1 404s unconditionally, so no working client can depend on the old
 *    answer; the change is inert against today's front end and stops the API telling a
 *    logged-in member that they do not exist.
 *  * **DELETE refuses it.** `fondodev` has exactly one ADMIN, `DELETE` is ADMIN-only, and the
 *    soft delete has no recovery path through the API (`key_activation` is NULL for all 15
 *    members, so `activate_user` can never restore them). "Me" semantics there is one
 *    mis-click from locking the fund out of its own administration. Passing `-1` through
 *    simply 404s, which is what v1 does, so this is a *refusal to add* rather than a change.
 */
export function resolveDetailUserId(
  requestedId: number,
  actor: AuthenticatedUser,
  verb: 'GET' | 'PATCH' | 'DELETE',
): number {
  if (requestedId === SELF_USER_ID && verb !== 'DELETE') {
    return actor.id;
  }
  return requestedId;
}
