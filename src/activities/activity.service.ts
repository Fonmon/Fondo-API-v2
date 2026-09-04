import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { plainDateToUtcDate, todayInBogota } from '../common/utils/timezone.util';
import { isUniqueViolation } from '../common/utils/prisma-error';
import {
  asPythonDict,
  pyGet,
  toDjangoDate,
  toDjangoInt,
  toDjangoSmallInt,
  toDjangoTextOrNull,
} from '../common/utils/python-obj';
import {
  serializeActivityDetail,
  serializeActivityGeneral,
  serializeActivityYear,
  type ActivityDetailDto,
  type ActivityGeneralDto,
  type ActivityYearDto,
} from './dto/activity.serializers';

/** Either the pooled client or an interactive-transaction client — see `LoanService`. */
type ActivitySqlClient = PrismaService | Prisma.TransactionClient;

/**
 * The `include` `ActivityDetailSerializer` needs: the `ActivityUser` rows in
 * `order_by('user_id')` order, each with both physical halves of `UserProfile(User)` so the
 * nested `UserProfileSerializer` can render `full_name` and `email`.
 */
const WITH_ACTIVITY_USERS = {
  users: {
    orderBy: { user_id: 'asc' },
    include: { user: { include: { auth_user: true } } },
  },
} as const satisfies Prisma.ActivityInclude;

/**
 * Raised where v1 would let Django's `NOT NULL` constraint raise `IntegrityError`.
 *
 * Deliberately a plain `Error`: `ApiExceptionFilter` renders it as a bare **500**,
 * which is what `create_activity` produces, and `patch_activity`'s bare `except:` swallows it
 * into a **404**, which is what the update path produces. Both are v1's answers.
 */
class DjangoNotNullViolation extends Error {
  constructor(column: string) {
    super(
      `IntegrityError: null value in column "${column}" of relation ` +
        '"fondo_api_activity" violates not-null constraint',
    );
  }
}

/**
 * `fondo_api/services/activity.py:ActivityService`.
 *
 * ## Nothing here deviates from v1
 *
 * Phase 5 owns **no** rows in `MIGRATION_PLAN.md` §5 — the register's `Phase` column has no
 * `P5` entry. Everything below is a straight port, including three shapes that look like
 * bugs and are not being fixed:
 *
 * | # | v1 shape | why it is carried |
 * |---|---|---|
 * | 1 | {@link createYear} has **no** `transaction.atomic` while {@link createActivity} does | verified: no decorator, and no `ATOMIC_REQUESTS` in any settings module, so Django is in autocommit. The disable and the insert are two independent commits and a same-year retry re-disables the highest other year *and then* answers 304. `docs/phase-5-prework.md` §2. |
 * | 2 | {@link patchActivity}'s bare `except:` turns **every** failure into a 404 | a missing body key, a non-numeric `state`, a `DoesNotExist` and a `NOT NULL` violation are one status in v1. Same hazard family as plan §4 rule 12 and deviation D24. |
 * | 3 | {@link removeActivity} does not check that the activity exists | `filter(id=id).delete()` on a miss deletes nothing and the view answers **200**. |
 *
 * ## The cascade is ours to write — plan §4 rule 10
 *
 * `ActivityUser.activity` is `on_delete=models.CASCADE` in `models.py:87`, and that is a
 * **Django-level** cascade executed by `Collector.delete()` in Python. Measured on both
 * `fondodev` and the test database, all three activity FKs are
 * `confdeltype = 'a'` (NO ACTION), `DEFERRABLE INITIALLY DEFERRED`. Prisma will not cascade
 * for us, so {@link removeActivity} deletes the children explicitly — in the same transaction
 * `Collector.delete()` opens.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger('fondo_api.services.activity');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `create_year()`.
   *
   * ```python
   * def create_year(self):
   *     year = date.today().year
   *     try:
   *         years = ActivityYear.objects.filter(~Q(year = year)).order_by('-year')
   *         if len(years) > 0:
   *             last_year = years[0]
   *             last_year.enable = False
   *             last_year.save()
   *         ActivityYear.objects.create(year = year)
   *     except IntegrityError:
   *         return False
   *     return True
   * ```
   *
   * ⚠️ **`date.today().year` is Bogotá, not the host zone** (condition **C28**, plan rule 5).
   * `django.conf.Settings.__init__` ends with `os.environ['TZ'] = self.TIME_ZONE;
   * time.tzset()`, so the *process* zone is `America/Bogota` and `date.today()` follows it.
   * Between 19:00 and 23:59 Bogotá the UTC year and the Bogotá year differ on 31 December —
   * `new Date().getFullYear()` on a UTC host would then create **next** year's row and
   * disable the current one. {@link todayInBogota} is the only correct reading.
   *
   * ⚠️ **It is not "disable the previous year".** `filter(~Q(year = year))` is *every* row
   * except the one being created, `order_by('-year')[0]` takes the highest of those, and
   * exactly **one** row is written. Across a gap — say the table holds 2019 and 2024 and it
   * is 2026 — the row disabled is 2024, not 2025 and not "all the others".
   *
   * ⚠️ **There is no transaction**, and the `try` spans the disable as well as the insert. On
   * a same-year retry the disable commits, the insert raises `23505`, and the caller answers
   * **304 Not Modified** on a request that did in fact write. Both halves are ported as
   * written; see the class docblock.
   *
   * @returns `true` → the view answers 201; `false` → 304, both with a zero-byte body.
   */
  async createYear(): Promise<boolean> {
    const year = BigInt(todayInBogota().year);
    try {
      // `filter(~Q(year = year)).order_by('-year')`, then `[0]` — `findFirst` is the same
      // query with `LIMIT 1`; v1 materialises the whole queryset only to call `len()` on it.
      const lastYear = await this.prisma.activityYear.findFirst({
        where: { year: { not: year } },
        orderBy: { year: 'desc' },
        select: { id: true },
      });
      if (lastYear !== null) {
        await this.prisma.activityYear.update({
          where: { id: lastYear.id },
          data: { enable: false },
        });
      }
      // `BooleanField(default=True)` is a Python-side default with no DB default, so v2 sets
      // it (plan §4 rule 5).
      await this.prisma.activityYear.create({ data: { year, enable: true } });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * `get_years()` — `ActivityYear.objects.all().order_by('-year')`.
   *
   * ⚠️ The **empty** case is a `204 No Content` in `ActivityYearView.get`, not a `200 []`.
   * That is the view's decision, not this method's; it returns the list either way.
   */
  async getYears(): Promise<ActivityYearDto[]> {
    const years = await this.prisma.activityYear.findMany({ orderBy: { year: 'desc' } });
    return years.map(serializeActivityYear);
  }

  /**
   * `get_activities(id_year)` — `filter(year_id = id_year).order_by('-date')`, rendered by
   * `ActivityGeneralSerializer` (`id` and `name` only).
   *
   * ⚠️ **Always 200**, even for a year id that does not exist: nothing looks the year up, so
   * an unknown id is an empty list rather than a 404.
   *
   * ⚠️ `order_by('-date')` alone — `date` is not unique (this fixture has ties), so the order
   * within a day is PostgreSQL's and neither stack promises one. No tie-breaker is added.
   */
  async getActivities(idYear: number): Promise<ActivityGeneralDto[]> {
    const activities = await this.prisma.activity.findMany({
      where: { year_id: idYear },
      orderBy: { date: 'desc' },
      select: { id: true, name: true },
    });
    return activities.map(serializeActivityGeneral);
  }

  /**
   * `create_activity(data, id_year)`.
   *
   * ```python
   * @transaction.atomic
   * def create_activity(self, data, id_year):
   *     activity = Activity()
   *     activity.name = data['name']
   *     activity.value = int(data['value'])
   *     activity.year_id = id_year
   *     activity.date = data['date']
   *     activity.save()
   *     self.__add_users(activity)
   * ```
   *
   * ⚠️ **A missing `name`, `value` or `date` key is an uncaught `KeyError` → 500**, not a 400.
   * Nothing validates the body: there is no serializer on this path.
   *
   * ⚠️ **`int(data['value'])` here, raw assignment in `__update_activity`.** Both end at
   * `BigIntegerField.get_prep_value`, which is also `int()`, so the two agree on every value
   * that converts — measured on the pinned stack: `'30000'`→30000, `30000.7`→30000,
   * `True`→1, `'  30  '`→30, `'30.5'`/`'abc'`→`ValueError`. They part on exactly one input,
   * **`null`**: `int(None)` is a `TypeError` *here* (→ 500), while `get_prep_value(None)`
   * returns `None` and the column's `NOT NULL` raises `IntegrityError` *there*, inside
   * `patch_activity`'s bare `except:` (→ 404). The asymmetry is in the error path, never in
   * the stored number.
   *
   * ⚠️ **An `id_year` that does not exist is a 500, not a 404 or a 400.** The FK is
   * `DEFERRABLE INITIALLY DEFERRED`, so the violation surfaces at `COMMIT` — i.e. when the
   * `atomic` block exits — and nothing catches it.
   */
  async createActivity(data: unknown, idYear: number): Promise<void> {
    const body = asPythonDict(data);
    // Evaluated in v1's order so the first missing key is the one that raises.
    const name = toDjangoTextOrNull(pyGet(body, 'name'));
    const value = toDjangoInt(pyGet(body, 'value'), 'value');
    const date = toDjangoDate(pyGet(body, 'date'), 'date');
    if (name === null) {
      throw new DjangoNotNullViolation('name');
    }

    await this.prisma.$transaction(async (tx) => {
      const activity = await tx.activity.create({
        data: { name, value, year_id: idYear, date: plainDateToUtcDate(date) },
        select: { id: true },
      });
      await this.addUsers(tx, activity.id);
    });
  }

  /**
   * `__add_users(activity)`.
   *
   * ```python
   * users = UserProfile.objects.filter(is_active = True).order_by('id')
   * for user in users:
   *     activity_user = ActivityUser()
   *     activity_user.user = user
   *     activity_user.activity = activity
   *     activity_user.save()
   * ```
   *
   * ⚠️ `is_active` lives on **`auth_user`**, the parent half of the multi-table inheritance,
   * and `order_by('id')` is the inherited pk — `auth_user.id`, which is `user_ptr_id` here.
   *
   * ⚠️ `state` takes `IntegerField(choices=..., default=0)` — **`0 NOT_PAID`**. It is a
   * Python-side default with no DB default, so v2 sets it (plan §4 rule 5).
   *
   * One row per active member: **15** on the current `fondodev` fixture. `createMany` is used
   * rather than v1's loop because the rows are independent and the ids are assigned by the
   * same sequence in the same order; nothing observable distinguishes them.
   */
  private async addUsers(tx: ActivitySqlClient, activityId: number): Promise<void> {
    const users = await tx.userProfile.findMany({
      where: { auth_user: { is_active: true } },
      orderBy: { user_ptr_id: 'asc' },
      select: { user_ptr_id: true },
    });
    if (users.length === 0) {
      return;
    }
    await tx.activityUser.createMany({
      data: users.map((user) => ({ state: 0, activity_id: activityId, user_id: user.user_ptr_id })),
    });
  }

  /**
   * `get_activity(id)` — `ActivityDetailSerializer`, or `None` for a miss (the view 404s).
   */
  async getActivity(id: number): Promise<ActivityDetailDto | null> {
    const activity = await this.prisma.activity.findUnique({
      where: { id },
      include: WITH_ACTIVITY_USERS,
    });
    if (activity === null) {
      return null;
    }
    return serializeActivityDetail(activity);
  }

  /**
   * `remove_activity(id)` — `Activity.objects.filter(id = id).delete()`.
   *
   * ⚠️ **No existence check anywhere on this path.** `QuerySet.delete()` on an empty selection
   * is a no-op and `ActivityDetailView.delete` answers a flat **200**, so `DELETE` on an id
   * that never existed and `DELETE` on one that did are indistinguishable to the caller.
   *
   * ⚠️ **The child rows are deleted here because nothing else will.** Django's
   * `on_delete=CASCADE` is `Collector.delete()` running in Python; the database constraint is
   * `NO ACTION` (measured, plan §4 rule 10). Dropping this line would raise a deferred FK
   * violation at `COMMIT` on any activity that has members attached — which, after
   * `__add_users`, is all of them. `Collector.delete()` wraps itself in
   * `transaction.atomic(savepoint=False)`, so both statements go in one transaction.
   */
  async removeActivity(id: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.activityUser.deleteMany({ where: { activity_id: id } }),
      this.prisma.activity.deleteMany({ where: { id } }),
    ]);
  }

  /**
   * `patch_activity(patch, id, data)`.
   *
   * ```python
   * try:
   *     if patch == 'activity':  self.__update_activity(id, data)
   *     else:                    self.__update_activity_user(id, data)
   * except:
   *     return None
   * return self.get_activity(id)
   * ```
   *
   * ⚠️ **The bare `except:` is the whole error contract on this route.** It catches
   * `Activity.DoesNotExist`, `ActivityUser.DoesNotExist`, the `KeyError` from a missing body
   * key, the `ValueError` from a non-numeric `state`, a `NOT NULL` violation and a column
   * overflow — every one of them answers **404** with a zero-byte body. There is no 400 and
   * no 500 reachable through this method. Same family as plan §4 rule 12 and deviation
   * **D24**; do not narrow it.
   *
   * ⚠️ The re-read is v1's: the response is `get_activity(id)`, a **fresh query**, not the
   * object that was just mutated. So the value the caller sees is the *stored* one after
   * Django's field coercion, which is why the `int()` asymmetry above is invisible in the
   * body.
   *
   * `patch` is already known to be `'activity'` or `'user'` — the view rejects anything else
   * with a 400 before calling in (`views/activity.py:23-25`).
   */
  async patchActivity(
    patch: 'activity' | 'user',
    id: number,
    data: unknown,
  ): Promise<ActivityDetailDto | null> {
    try {
      if (patch === 'activity') {
        await this.updateActivity(id, data);
      } else {
        await this.updateActivityUser(id, data);
      }
    } catch (error) {
      // v1's bare `except:` — deliberately catches everything, and logs so a genuine v2 fault
      // is not indistinguishable from a member typo in the operator's logs.
      this.logger.error(
        `patch_activity(${patch}, ${String(id)}) failed; answering 404 as v1 does: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
    return this.getActivity(id);
  }

  /**
   * `__update_activity(id, data)`.
   *
   * ```python
   * activity = Activity.objects.get(id = id)
   * activity.name = data['name']
   * activity.date = data['date']
   * activity.value = data['value']
   * activity.save()
   * ```
   *
   * ⚠️ **`value` is assigned raw** and coerced by `BigIntegerField.get_prep_value` on save,
   * where `create_activity` calls `int()` itself. See {@link createActivity} for the measured
   * table; the only input on which they differ is `null`, and only in *which* error results.
   *
   * ⚠️ All three keys are read, so a `PATCH` that means to change only the name must still
   * send `date` and `value` — a partial body is a `KeyError`, which the caller turns into a
   * **404**. This is a `PATCH` with `PUT` semantics and it is v1's.
   */
  private async updateActivity(id: number, data: unknown): Promise<void> {
    const body = asPythonDict(data);
    const name = toDjangoTextOrNull(pyGet(body, 'name'));
    const date = toDjangoDate(pyGet(body, 'date'), 'date');
    const value = toDjangoInt(pyGet(body, 'value'), 'value');
    if (name === null) {
      throw new DjangoNotNullViolation('name');
    }
    // `objects.get(...)` then `save()`: Prisma's `update` raises P2025 for a missing row,
    // which is `Activity.DoesNotExist` and lands in the caller's bare `except:`.
    await this.prisma.activity.update({
      where: { id },
      data: { name, date: plainDateToUtcDate(date), value },
    });
  }

  /**
   * `__update_activity_user(id, data)`.
   *
   * ```python
   * activity_user_id = data['id']
   * activity_user = ActivityUser.objects.get(activity_id = id, id = activity_user_id)
   * activity_user.state = data['state']
   * activity_user.save()
   * ```
   *
   * ⚠️ `data['id']` is the **`ActivityUser`** row id, not the member's, and it is matched
   * *together with* `activity_id` — so a valid id belonging to a different activity is a
   * `DoesNotExist`, i.e. a 404, not a cross-activity write.
   *
   * ⚠️ **`state` is not validated against `STATE_TYPES`.** Django checks `choices` in
   * `full_clean()`, which `save()` does not call, so v1 writes `7` or `-1` into the column
   * happily. Only a value PostgreSQL's `integer` cannot hold fails — and that failure is a
   * 404, like every other.
   */
  private async updateActivityUser(id: number, data: unknown): Promise<void> {
    const body = asPythonDict(data);
    const activityUserId = toDjangoSmallInt(pyGet(body, 'id'), 'id');
    const state = toDjangoSmallInt(pyGet(body, 'state'), 'state');
    // `get(activity_id=..., id=...)` — the pair is the lookup, so `updateMany` with both in
    // the `where` is the faithful shape. Zero rows updated is `DoesNotExist`.
    const updated = await this.prisma.activityUser.updateMany({
      where: { id: activityUserId, activity_id: id },
      data: { state },
    });
    if (updated.count === 0) {
      throw new Error('ActivityUser matching query does not exist.');
    }
  }
}
