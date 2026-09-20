import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';

/**
 * `fondo_api/services/activity.py:ActivityService`, unit level — Prisma mocked.
 *
 * The DB-backed behaviour is `test/activity.e2e-spec.ts` (the port of
 * `fondo_api/tests/test_activity_views.py`). What lives here is what can be wrong with no
 * database involved:
 *
 *  * `create_year` reading **Bogotá's** calendar year, not the host's (condition **C28**);
 *  * its disable being "the highest year that is not this one", **one row**, not "the
 *    previous year" and not "all the others";
 *  * the absence of a transaction around it, and its presence around `create_activity`;
 *  * `patch_activity`'s bare `except:` collapsing every failure into `null` (→ 404);
 *  * `remove_activity` deleting the `ActivityUser` children **explicitly**, because the
 *    database will not (plan §4 rule 10).
 */
describe('ActivityService (unit)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // create_year
  // ==========================================================================
  describe('create_year', () => {
    /**
     * ⚠️ **C28's first real calendar read.** Phase 4 had none: its dates all came from the
     * request body or from `todayForAutoNowDateColumn`. `date.today().year` in v1 is Bogotá,
     * because `django.conf.Settings.__init__` does `os.environ['TZ'] = TIME_ZONE; tzset()`.
     *
     * At `2026-01-01T02:00Z` the host (pinned to UTC in `jest.config.ts`) says **2026** and
     * Bogotá — `2025-12-31 21:00 -05:00` — says **2025**. A `new Date().getFullYear()` would
     * create next year's row and disable the current one, on the one night of the year when
     * nobody is watching.
     */
    it('reads the year in America/Bogota, not the host zone (C28)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
      const { service, prisma } = build();

      await expect(service.createYear()).resolves.toBe(true);

      expect(new Date().getUTCFullYear()).toBe(2026); // the host really is on 2026 here
      expect(prisma.activityYear.create).toHaveBeenCalledWith({
        data: { year: 2025n, enable: true },
      });
      expect(prisma.activityYear.findFirst).toHaveBeenCalledWith({
        where: { year: { not: 2025n } },
        orderBy: { year: 'desc' },
        select: { id: true },
      });
    });

    it('reads the same instant as 2026 once Bogota has crossed midnight', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T05:00:00.000Z'));
      const { service, prisma } = build();

      await service.createYear();

      expect(prisma.activityYear.create).toHaveBeenCalledWith({
        data: { year: 2026n, enable: true },
      });
    });

    /**
     * `filter(~Q(year = year)).order_by('-year')[0]` — the highest year that is **not** the
     * one being created, and **exactly one row** is disabled.
     */
    it('disables the single highest other year, by id', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const { service, prisma } = build({ lastYear: { id: 4 } });

      await service.createYear();

      expect(prisma.activityYear.update).toHaveBeenCalledTimes(1);
      expect(prisma.activityYear.update).toHaveBeenCalledWith({
        where: { id: 4 },
        data: { enable: false },
      });
    });

    /**
     * ⚠️ It is **not** "disable the previous year". Across a gap the row disabled is whatever
     * the highest other year happens to be — the query is `ORDER BY year DESC LIMIT 1` over
     * everything except the current year, so the service cannot know or care that 2025 is
     * missing. Pinned because "previous year" is the reading a maintainer will reach for.
     */
    it('disables the highest other year across a gap, not year - 1', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const { service, prisma } = build({ lastYear: { id: 6 } });

      await service.createYear();

      const call = firstCallArg<{ where: unknown; orderBy: unknown }>(
        prisma.activityYear.findFirst,
      );
      expect(call.where).toEqual({ year: { not: 2026n } });
      expect(call.orderBy).toEqual({ year: 'desc' });
      expect(prisma.activityYear.update).toHaveBeenCalledWith({
        where: { id: 6 },
        data: { enable: false },
      });
    });

    it('writes no disable at all when the table holds no other year', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const { service, prisma } = build({ lastYear: null });

      await expect(service.createYear()).resolves.toBe(true);

      expect(prisma.activityYear.update).not.toHaveBeenCalled();
      expect(prisma.activityYear.create).toHaveBeenCalledTimes(1);
    });

    /** `except IntegrityError: return False` → the view answers a bodiless 304. */
    it('returns false when the year already exists (unique violation)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const { service, prisma } = build({ lastYear: { id: 4 } });
      prisma.activityYear.create.mockRejectedValue(uniqueViolation());

      await expect(service.createYear()).resolves.toBe(false);
    });

    /**
     * ⚠️ **The retry is not a no-op.** `create_year` has no `transaction.atomic` and there is
     * no `ATOMIC_REQUESTS` in any settings module, so Django is in autocommit and the disable
     * has already committed by the time the insert collides. A second POST in the same
     * calendar year therefore re-disables the highest other year *and* answers "not
     * modified". Verified against v1 source; `docs/phase-5-prework.md` §2. Port the absence —
     * wrapping this in `$transaction` would be a silent behaviour change.
     */
    it('still commits the disable when the insert then collides (no transaction)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const { service, prisma } = build({ lastYear: { id: 4 } });
      prisma.activityYear.create.mockRejectedValue(uniqueViolation());

      await expect(service.createYear()).resolves.toBe(false);

      expect(prisma.activityYear.update).toHaveBeenCalledWith({
        where: { id: 4 },
        data: { enable: false },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    /** Only `P2002` is `IntegrityError` here. Anything else is a 500, as in v1. */
    it('re-raises a non-unique failure instead of reporting 304', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      const { service, prisma } = build({ lastYear: { id: 4 } });
      prisma.activityYear.create.mockRejectedValue(new Error('connection reset'));

      await expect(service.createYear()).rejects.toThrow('connection reset');
    });
  });

  // ==========================================================================
  // get_years / get_activities
  // ==========================================================================
  describe('get_years', () => {
    it('orders by -year and serialises through ActivityYearSerializer', async () => {
      const { service, prisma } = build();
      prisma.activityYear.findMany.mockResolvedValue([
        { id: 2, year: 2021n, enable: true },
        { id: 1, year: 2020n, enable: true },
      ]);

      await expect(service.getYears()).resolves.toEqual([
        { id: 2, year: 2021n, enable: true },
        { id: 1, year: 2020n, enable: true },
      ]);
      expect(prisma.activityYear.findMany).toHaveBeenCalledWith({ orderBy: { year: 'desc' } });
    });

    it('returns [] for an empty table — the 204 is the view’s decision, not this one', async () => {
      const { service, prisma } = build();
      prisma.activityYear.findMany.mockResolvedValue([]);
      await expect(service.getYears()).resolves.toEqual([]);
    });
  });

  describe('get_activities', () => {
    it('filters by year_id and orders by -date', async () => {
      const { service, prisma } = build();
      prisma.activity.findMany.mockResolvedValue([{ id: 1, name: 'Test Activity 1' }]);

      await expect(service.getActivities(3)).resolves.toEqual([{ id: 1, name: 'Test Activity 1' }]);
      expect(prisma.activity.findMany).toHaveBeenCalledWith({
        where: { year_id: 3 },
        orderBy: { date: 'desc' },
        select: { id: true, name: true },
      });
    });
  });

  // ==========================================================================
  // create_activity
  // ==========================================================================
  describe('create_activity', () => {
    it('is wrapped in a transaction, unlike create_year', async () => {
      const { service, prisma } = build();

      await service.createActivity(
        { name: 'New Activity for tests', value: 30000, date: '2020-11-7' },
        1,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.activity.create).toHaveBeenCalledWith({
        data: {
          name: 'New Activity for tests',
          value: 30000n,
          year_id: 1,
          date: new Date(Date.UTC(2020, 10, 7)),
        },
        select: { id: true },
      });
    });

    /**
     * `__add_users`: `UserProfile.objects.filter(is_active = True).order_by('id')`, one row
     * each at `state` **0 NOT_PAID**. `is_active` lives on `auth_user` (the parent half of the
     * multi-table inheritance) and `id` is the inherited pk, i.e. `user_ptr_id`.
     */
    it('attaches every active user at state 0, ordered by the inherited pk', async () => {
      const { service, prisma } = build();
      prisma.userProfile.findMany.mockResolvedValue([{ user_ptr_id: 2 }, { user_ptr_id: 5 }]);

      await service.createActivity({ name: 'a', value: 1, date: '2020-01-01' }, 1);

      expect(prisma.userProfile.findMany).toHaveBeenCalledWith({
        where: { auth_user: { is_active: true } },
        orderBy: { user_ptr_id: 'asc' },
        select: { user_ptr_id: true },
      });
      expect(prisma.activityUser.createMany).toHaveBeenCalledWith({
        data: [
          { state: 0, activity_id: 77, user_id: 2 },
          { state: 0, activity_id: 77, user_id: 5 },
        ],
      });
    });

    it('writes no ActivityUser rows when no user is active', async () => {
      const { service, prisma } = build();
      prisma.userProfile.findMany.mockResolvedValue([]);

      await service.createActivity({ name: 'a', value: 1, date: '2020-01-01' }, 1);

      expect(prisma.activityUser.createMany).not.toHaveBeenCalled();
    });

    /** `data['name']` / `data['value']` / `data['date']` are bare subscripts — `KeyError` → 500. */
    it.each(['name', 'value', 'date'])(
      'raises on a missing %s key (KeyError -> 500), writing nothing',
      async (missing) => {
        const { service, prisma } = build();
        const body: Record<string, unknown> = {
          name: 'a',
          value: 1,
          date: '2020-01-01',
        };
        delete body[missing];

        await expect(service.createActivity(body, 1)).rejects.toThrow(/KeyError/);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    /**
     * `int(data['value'])` — CPython's, so a decimal string converts and a float truncates.
     * Measured against `Django==2.2.27` / CPython 3.9 in the v1 container.
     */
    it.each<[unknown, bigint]>([
      ['30000', 30000n],
      [30000.7, 30000n],
      [30000.0, 30000n],
      [true, 1n],
      ['  30  ', 30n],
    ])('coerces value %p to %p with int()', async (input, expected) => {
      const { service, prisma } = build();
      await service.createActivity({ name: 'a', value: input, date: '2020-01-01' }, 1);
      expect(prisma.activity.create).toHaveBeenCalledWith(
        containing({ data: containing({ value: expected }) }),
      );
    });

    it.each(['abc', '30.5'])('raises ValueError on value %p (-> 500)', async (input) => {
      const { service } = build();
      await expect(
        service.createActivity({ name: 'a', value: input, date: '2020-01-01' }, 1),
      ).rejects.toThrow(/invalid literal for int/);
    });

    /**
     * ⚠️ **The one input on which `create_activity` and `__update_activity` genuinely
     * differ.** Here `int(None)` is a `TypeError` → uncaught → **500**; there,
     * `BigIntegerField.get_prep_value(None)` returns `None` and the column's `NOT NULL`
     * raises inside `patch_activity`'s bare `except:` → **404**. Measured:
     * `get_prep_value(None) -> None` but `int(None) -> TypeError`.
     */
    it('raises TypeError on a null value — int(None), not a NOT NULL violation', async () => {
      const { service } = build();
      await expect(
        service.createActivity({ name: 'a', value: null, date: '2020-01-01' }, 1),
      ).rejects.toThrow(/TypeError/);
    });

    /**
     * `TextField.get_prep_value(None)` returns `None` — measured; it does **not** stringify to
     * `'None'`. So a null name is a `NOT NULL` violation, which is a 500 on this path.
     */
    it('raises on a null name rather than storing the four characters None', async () => {
      const { service, prisma } = build();
      await expect(
        service.createActivity({ name: null, value: 1, date: '2020-01-01' }, 1),
      ).rejects.toThrow(/not-null/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    /** `DateField.to_python` accepts `\d{1,2}` month and day — v1's own fixture is `2020-11-7`. */
    it('accepts a single-digit month and day', async () => {
      const { service, prisma } = build();
      await service.createActivity({ name: 'a', value: 1, date: '2020-1-3' }, 1);
      expect(prisma.activity.create).toHaveBeenCalledWith(
        containing({ data: containing({ date: new Date(Date.UTC(2020, 0, 3)) }) }),
      );
    });

    it('raises on an invalid date (-> 500)', async () => {
      const { service } = build();
      await expect(
        service.createActivity({ name: 'a', value: 1, date: '2020-13-01' }, 1),
      ).rejects.toThrow(/invalid date/);
    });
  });

  // ==========================================================================
  // get_activity / remove_activity
  // ==========================================================================
  describe('get_activity', () => {
    it('orders the nested users by user_id, as get_users does', async () => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue({
        id: 1,
        name: 'a',
        date: new Date(Date.UTC(2020, 0, 1)),
        value: 1000n,
        users: [],
      });

      await service.getActivity(1);

      const call = firstCallArg<{ include: { users: { orderBy: unknown } } }>(
        prisma.activity.findUnique,
      );
      expect(call.include.users.orderBy).toEqual({ user_id: 'asc' });
    });

    it('returns null for a miss so the view can 404', async () => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue(null);
      await expect(service.getActivity(12)).resolves.toBeNull();
    });
  });

  describe('remove_activity', () => {
    /**
     * ⚠️ Plan §4 rule 10. `ActivityUser.activity` is `on_delete=CASCADE` in `models.py`, but
     * the **database** constraint is `NO ACTION` / `DEFERRABLE INITIALLY DEFERRED` — measured
     * on `fondodev` and on the test database. Django cascades in Python; Prisma does not
     * cascade at all. Without the child delete, every activity that has been through
     * `__add_users` (i.e. all of them) would raise a deferred FK violation at `COMMIT`.
     */
    it('deletes the ActivityUser children first, in one transaction', async () => {
      const { service, prisma } = build();

      await service.removeActivity(5);

      expect(prisma.activityUser.deleteMany).toHaveBeenCalledWith({ where: { activity_id: 5 } });
      expect(prisma.activity.deleteMany).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const batch = firstCallArg<unknown[]>(prisma.$transaction);
      expect(Array.isArray(batch)).toBe(true);
      expect(batch).toHaveLength(2);
    });

    /** `filter(id=id).delete()` — no existence check, so a miss is a silent no-op (view: 200). */
    it('does not look the activity up first', async () => {
      const { service, prisma } = build();
      await service.removeActivity(999);
      expect(prisma.activity.findUnique).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // patch_activity — the bare `except:`
  // ==========================================================================
  describe('patch_activity', () => {
    it('updates name, date and value, then re-reads through get_activity', async () => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue({
        id: 1,
        name: 'New Activity for tests',
        date: new Date(Date.UTC(2020, 10, 7)),
        value: 30000n,
        users: [],
      });

      const result = await service.patchActivity('activity', 1, {
        name: 'New Activity for tests',
        value: 30000,
        date: '2020-11-7',
      });

      expect(prisma.activity.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          name: 'New Activity for tests',
          date: new Date(Date.UTC(2020, 10, 7)),
          value: 30000n,
        },
      });
      expect(result).toEqual({
        id: 1,
        name: 'New Activity for tests',
        date: '2020-11-07',
        value: 30000n,
        users: [],
      });
    });

    /**
     * ⚠️ `__update_activity` assigns `data['value']` **raw**; `BigIntegerField.get_prep_value`
     * is also `int()`, so the stored number matches `create_activity` on every input that
     * converts. Same measured table as the create path.
     */
    it.each<[unknown, bigint]>([
      ['30000', 30000n],
      [30000.7, 30000n],
      [true, 1n],
    ])('stores the same number as create_activity for value %p', async (input, expected) => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue({
        id: 1,
        name: 'a',
        date: new Date(Date.UTC(2020, 0, 1)),
        value: expected,
        users: [],
      });

      await service.patchActivity('activity', 1, { name: 'a', value: input, date: '2020-01-01' });

      expect(prisma.activity.update).toHaveBeenCalledWith(
        containing({ data: containing({ value: expected }) }),
      );
    });

    /**
     * ⚠️ The whole error contract of `PATCH /api/activity/<id>` is one bare `except:`. Every
     * row below is a **404** in v1 — not a 400, not a 500. Narrowing any of them would be a
     * client-visible divergence.
     */
    describe('the bare `except:` — every failure is null (-> 404)', () => {
      it('swallows Activity.DoesNotExist', async () => {
        const { service, prisma } = build();
        prisma.activity.update.mockRejectedValue(notFound());
        await expect(
          service.patchActivity('activity', 2, { name: 'a', value: 1, date: '2020-01-01' }),
        ).resolves.toBeNull();
      });

      it.each(['name', 'value', 'date'])(
        'swallows a missing %s key (KeyError)',
        async (missing) => {
          const { service } = build();
          const body: Record<string, unknown> = { name: 'a', value: 1, date: '2020-01-01' };
          delete body[missing];
          await expect(service.patchActivity('activity', 1, body)).resolves.toBeNull();
        },
      );

      it('swallows a non-numeric value (ValueError)', async () => {
        const { service } = build();
        await expect(
          service.patchActivity('activity', 1, { name: 'a', value: 'abc', date: '2020-01-01' }),
        ).resolves.toBeNull();
      });

      /**
       * ⚠️ The `null` case: **404 here, 500 on the create path.** `get_prep_value(None)`
       * returns `None` and the `NOT NULL` violation lands inside the `except:`.
       */
      it('swallows a null value where create_activity 500s', async () => {
        const { service } = build();
        await expect(
          service.patchActivity('activity', 1, { name: 'a', value: null, date: '2020-01-01' }),
        ).resolves.toBeNull();
      });

      it('swallows a null name', async () => {
        const { service } = build();
        await expect(
          service.patchActivity('activity', 1, { name: null, value: 1, date: '2020-01-01' }),
        ).resolves.toBeNull();
      });

      it('swallows an invalid date', async () => {
        const { service } = build();
        await expect(
          service.patchActivity('activity', 1, { name: 'a', value: 1, date: 'not-a-date' }),
        ).resolves.toBeNull();
      });

      it('swallows a non-dict body (TypeError on the subscript)', async () => {
        const { service } = build();
        await expect(service.patchActivity('activity', 1, 'nope')).resolves.toBeNull();
      });

      it('swallows ActivityUser.DoesNotExist', async () => {
        const { service, prisma } = build();
        prisma.activityUser.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.patchActivity('user', 1, { id: 9, state: 2 })).resolves.toBeNull();
      });

      it.each(['id', 'state'])('swallows a missing %s key on the user path', async (missing) => {
        const { service } = build();
        const body: Record<string, unknown> = { id: 9, state: 2 };
        delete body[missing];
        await expect(service.patchActivity('user', 1, body)).resolves.toBeNull();
      });

      it('swallows a non-numeric state', async () => {
        const { service } = build();
        await expect(service.patchActivity('user', 1, { id: 9, state: 'x' })).resolves.toBeNull();
      });
    });

    /**
     * `ActivityUser.objects.get(activity_id = id, id = activity_user_id)` — the **pair** is
     * the lookup, so a valid `ActivityUser` id belonging to another activity is a
     * `DoesNotExist`, not a cross-activity write.
     */
    it('matches the ActivityUser on both its id and its activity_id', async () => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue({
        id: 1,
        name: 'a',
        date: new Date(Date.UTC(2020, 0, 1)),
        value: 1n,
        users: [],
      });

      await service.patchActivity('user', 1, { id: 42, state: 2 });

      expect(prisma.activityUser.updateMany).toHaveBeenCalledWith({
        where: { id: 42, activity_id: 1 },
        data: { state: 2 },
      });
    });

    /**
     * ⚠️ Django validates `choices` in `full_clean()`, which `save()` never calls, so v1
     * writes an out-of-range `state` without complaint. Ported, not tightened.
     */
    it.each([7, -1])('writes an out-of-choices state %i, as v1 does', async (state) => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue({
        id: 1,
        name: 'a',
        date: new Date(Date.UTC(2020, 0, 1)),
        value: 1n,
        users: [],
      });

      await service.patchActivity('user', 1, { id: 42, state });

      expect(prisma.activityUser.updateMany).toHaveBeenCalledWith(containing({ data: { state } }));
    });

    /** The response is a fresh `get_activity(id)`, not the mutated in-memory object. */
    it('re-reads the activity after a successful user update', async () => {
      const { service, prisma } = build();
      prisma.activity.findUnique.mockResolvedValue({
        id: 1,
        name: 'a',
        date: new Date(Date.UTC(2020, 0, 1)),
        value: 1n,
        users: [{ id: 42, state: 2, user: profileRow() }],
      });

      const result = await service.patchActivity('user', 1, { id: 42, state: 2 });

      expect(prisma.activity.findUnique).toHaveBeenCalledTimes(1);
      expect(result?.users[0].state).toBe(2);
    });
  });
});

// ============================================================================
// helpers
// ============================================================================

/**
 * The first argument of a mock's first call, typed. `jest.Mock.mock.calls` is `any[][]`,
 * which the lint rules reject at every use site; naming the narrowing once keeps the
 * assertions readable.
 */
function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0][0] as T;
}

/** `expect.objectContaining`, typed — `expect.*` returns `any`. */
function containing(value: object): unknown {
  return expect.objectContaining(value);
}

function profileRow(): {
  user_ptr_id: number;
  identification: bigint;
  role: number;
  birthdate: Date | null;
  auth_user: { email: string; first_name: string; last_name: string };
} {
  return {
    user_ptr_id: 7,
    identification: 99999n,
    role: 3,
    birthdate: null,
    auth_user: { email: 'm@mail.com', first_name: 'Foo', last_name: 'Bar' },
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function notFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found', {
    code: 'P2025',
    clientVersion: 'test',
  });
}

interface MockedPrisma {
  $transaction: jest.Mock;
  activityYear: { findFirst: jest.Mock; findMany: jest.Mock; update: jest.Mock; create: jest.Mock };
  activity: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  activityUser: { createMany: jest.Mock; updateMany: jest.Mock; deleteMany: jest.Mock };
  userProfile: { findMany: jest.Mock };
}

function build(options: { lastYear?: { id: number } | null } = {}): {
  service: ActivityService;
  prisma: MockedPrisma;
} {
  const prisma: MockedPrisma = {
    // Interactive form (`create_activity`) runs the callback against the same mock; array
    // form (`remove_activity`) just resolves.
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.resolve([]),
    ),
    activityYear: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.lastYear === undefined ? { id: 1 } : options.lastYear),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 9 }),
    },
    activity: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 77 }),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    activityUser: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { service: new ActivityService(prisma as unknown as PrismaService), prisma };
}
