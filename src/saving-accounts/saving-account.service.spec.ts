import { Role } from '../auth/permissions/roles';
import type { NotificationService } from '../notifications/notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CLOSE_SAVING_ACCOUNT_PAYLOAD_TYPE,
  type SchedulerTaskRepository,
} from '../scheduler/scheduler-task.repository';
import type { UserService } from '../users/user.service';
import { SavingAccountService } from './saving-account.service';
import type { SavingAccountRow } from './dto/saving-account.serializers';

/**
 * `fondo_api/services/saving_account.py`, unit level — Prisma, `UserService`,
 * `NotificationService` and `SchedulerTaskRepository` all mocked.
 *
 * ⚠️ **v1 ships no test for this module.** There is no `fondo_api/tests/test_saving_account*`
 * of any kind, so nothing here is a port: the cells are written from the v1 source plus the
 * operator answers **Q19**–**Q24**, **Q38** and **Q39**, which are the specification for
 * **D12** — functionality v1 never built (`# TODO: schedule task for closing CAP`).
 *
 * The DB-backed half is `test/saving-account.e2e-spec.ts`.
 */
function accountRow(overrides: Partial<SavingAccountRow> = {}): SavingAccountRow {
  return {
    id: 3,
    created_at: new Date('2023-03-14T13:47:00.182Z'),
    end_date: new Date('2024-02-28T00:00:00.000Z'),
    state: 0,
    value: 900000n,
    user_id: 15,
    user: { auth_user: { first_name: 'Angi Paola', last_name: 'Sanchez Quilindo' } },
    ...overrides,
  };
}

interface Harness {
  service: SavingAccountService;
  prisma: {
    savingAccount: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  users: { getUserIds: jest.Mock };
  notifications: { sendNotification: jest.Mock };
  tasks: { createCloseSavingAccountTask: jest.Mock };
}

function build(
  options: {
    rows?: SavingAccountRow[];
    count?: number;
    existing?: { id: number } | { state: number } | null;
    updatedCount?: number;
    createdId?: number;
  } = {},
): Harness {
  const prisma = {
    savingAccount: {
      create: jest.fn().mockResolvedValue({ id: options.createdId ?? 42 }),
      findMany: jest.fn().mockResolvedValue(options.rows ?? []),
      findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
      count: jest.fn().mockResolvedValue(options.count ?? options.rows?.length ?? 0),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: options.updatedCount ?? 1 }),
    },
  };
  const users = { getUserIds: jest.fn().mockResolvedValue([1, 2]) };
  const notifications = { sendNotification: jest.fn().mockResolvedValue('published') };
  const tasks = { createCloseSavingAccountTask: jest.fn().mockResolvedValue(7001) };

  const service = new SavingAccountService(
    prisma as unknown as PrismaService,
    users as unknown as UserService,
    notifications as unknown as NotificationService,
    tasks as unknown as SchedulerTaskRepository,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  return { service, prisma, users, notifications, tasks };
}

describe('SavingAccountService (unit)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // create_account
  // ==========================================================================
  describe('create_account', () => {
    it('writes the row for the caller, with the Python-side defaults spelled out', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-08T15:04:05.000Z'));
      const { service, prisma } = build({ createdId: 42 });

      await expect(service.createAccount(15, { end_date: '2027-02-28' })).resolves.toBe(42);

      expect(prisma.savingAccount.create).toHaveBeenCalledWith({
        data: {
          created_at: new Date('2026-09-08T15:04:05.000Z'),
          end_date: new Date('2027-02-28T00:00:00.000Z'),
          state: 0,
          value: 0n,
          user_id: 15,
        },
        select: { id: true },
      });
    });

    /**
     * ⚠️ **The account is always created for the caller.** v1 reads `request.user.id` and
     * never looks at the body for a target, so a treasurer cannot open a CAP *for* someone.
     */
    it('ignores any user_id in the body', async () => {
      const { service, prisma } = build();

      await service.createAccount(15, { end_date: '2027-02-28', user_id: 1, value: 500000 });

      const [call] = prisma.savingAccount.create.mock.calls as [
        { data: { user_id: number; value: bigint } },
      ][];
      expect(call[0].data.user_id).toBe(15);
      // `value` is not a create-time field in v1 either — a new CAP always starts at 0.
      expect(call[0].data.value).toBe(0n);
    });

    /** `DateField.to_python` accepts `\d{1,2}` month/day, which v1's own fixtures rely on. */
    it('accepts a single-digit month and day, as Django does', async () => {
      const { service, prisma } = build();

      await service.createAccount(15, { end_date: '2027-2-8' });

      const [call] = prisma.savingAccount.create.mock.calls as [{ data: { end_date: Date } }][];
      expect(call[0].data.end_date.toISOString()).toBe('2027-02-08T00:00:00.000Z');
    });

    /** `obj['end_date']` is a bare subscript with nothing around it: `KeyError` → **500**. */
    it('raises for a body with no end_date, and writes nothing', async () => {
      const { service, prisma, tasks, notifications } = build();

      await expect(service.createAccount(15, {})).rejects.toThrow("KeyError: 'end_date'");

      expect(prisma.savingAccount.create).not.toHaveBeenCalled();
      expect(tasks.createCloseSavingAccountTask).not.toHaveBeenCalled();
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });

    it.each([['not-a-date'], ['2027-13-01'], ['2027-02-30'], [null], [5]])(
      'raises for an unparseable end_date %p (v1: ValidationError → 500)',
      async (value) => {
        const { service, prisma } = build();

        await expect(service.createAccount(15, { end_date: value })).rejects.toThrow();
        expect(prisma.savingAccount.create).not.toHaveBeenCalled();
      },
    );

    /**
     * ⚠️ Q22's "no member notification" is about the **close and the revalue**. The *create*
     * notification is v1 behaviour (`services/saving_account.py:20-24`) and stays: it goes to
     * every active ADMIN and TREASURER, not to the member.
     */
    it('notifies active ADMINs and TREASURERs — v1 text and target, verbatim', async () => {
      const { service, users, notifications } = build();

      await service.createAccount(15, { end_date: '2027-02-28' });

      expect(users.getUserIds).toHaveBeenCalledWith([Role.ADMIN, Role.TREASURER]);
      expect(notifications.sendNotification).toHaveBeenCalledWith(
        [1, 2],
        'Ha sido creada una nueva CAP',
        '/manage/caps',
      );
    });

    it('does not notify the member who owns the CAP', async () => {
      const { service, notifications } = build();

      await service.createAccount(15, { end_date: '2027-02-28' });

      const [recipients] = notifications.sendNotification.mock.calls[0] as [number[]];
      expect(recipients).not.toContain(15);
    });

    /** A publish that fails does not roll the CAP back — v1 has no transaction here. */
    it('returns the id even when the notification could not be delivered', async () => {
      const { service, notifications } = build({ createdId: 42 });
      notifications.sendNotification.mockResolvedValue('failed');

      await expect(service.createAccount(15, { end_date: '2027-02-28' })).resolves.toBe(42);
    });

    // ------------------------------------------------------------------
    // D12 — the close task. v1's `# TODO`, built.
    // ------------------------------------------------------------------
    describe('D12 — the close task', () => {
      it('schedules one close task at local midnight on end_date', async () => {
        const { service, tasks } = build({ createdId: 42 });

        await service.createAccount(15, { end_date: '2027-02-28' });

        expect(tasks.createCloseSavingAccountTask).toHaveBeenCalledTimes(1);
        const [runDate, payload] = tasks.createCloseSavingAccountTask.mock.calls[0] as [
          Date,
          Record<string, unknown>,
        ];
        // 00:00 America/Bogota is 05:00Z — the same shape Django wrote for every birthday row.
        expect(runDate.toISOString()).toBe('2027-02-28T05:00:00.000Z');
        expect(payload).toEqual({
          type: CLOSE_SAVING_ACCOUNT_PAYLOAD_TYPE,
          saving_account_id: 42,
        });
      });

      /**
       * ⚠️ **Condition C77, obligation (i)/(ii)**: the inserted row's `repeat` must be `0`,
       * and a cell must assert it. Here the guarantee is structural — the repository method
       * takes **no `repeat` parameter at all**, so a caller cannot supply a non-zero one.
       * This cell pins that the signature stays that way: the call carries exactly two
       * arguments, and neither is a repeat.
       *
       * The literal `0` in the SQL is asserted end-to-end in `test/saving-account.e2e-spec.ts`,
       * which reads the row back out of the database.
       */
      it('cannot give the close task a non-zero repeat (C77)', async () => {
        const { service, tasks } = build();

        await service.createAccount(15, { end_date: '2027-02-28' });

        const call = tasks.createCloseSavingAccountTask.mock.calls[0] as unknown[];
        expect(call).toHaveLength(2);
        expect(call.some((argument) => argument === 1 || argument === 4)).toBe(false);
      });

      /**
       * ⚠️ Written **unconditionally**, including for a CAP whose `end_date` is already past.
       * The runner selects with `<=` (**D7**), so such a CAP closes on the very next pass
       * rather than never. Branching here would recreate v1's gap in a new place.
       */
      it('schedules the task even when end_date is already in the past', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-09-08T15:00:00.000Z'));
        const { service, tasks } = build();

        await service.createAccount(15, { end_date: '2024-02-28' });

        expect(tasks.createCloseSavingAccountTask).toHaveBeenCalledTimes(1);
        const [runDate] = tasks.createCloseSavingAccountTask.mock.calls[0] as [Date];
        expect(runDate.toISOString()).toBe('2024-02-28T05:00:00.000Z');
      });

      it('carries no recipient list, message or target — a close notifies nobody (Q22)', async () => {
        const { service, tasks } = build();

        await service.createAccount(15, { end_date: '2027-02-28' });

        const [, payload] = tasks.createCloseSavingAccountTask.mock.calls[0] as [
          Date,
          Record<string, unknown>,
        ];
        expect(Object.keys(payload).sort()).toEqual(['saving_account_id', 'type']);
      });
    });
  });

  // ==========================================================================
  // get_accounts
  // ==========================================================================
  describe('get_accounts', () => {
    it('filters to the caller and orders by -created_at, -id', async () => {
      const { service, prisma } = build({ rows: [accountRow()], count: 1 });

      await service.getAccounts(15, 1);

      expect(prisma.savingAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: 15, state: 0 },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          skip: 0,
          take: 10,
        }),
      );
    });

    it('drops the user filter for all_accounts, keeping the state filter', async () => {
      const { service, prisma } = build({ rows: [], count: 0 });

      await service.getAccounts(15, 1, true, 1);

      expect(prisma.savingAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { state: 1 } }),
      );
    });

    /**
     * ⚠️ **`state` is always applied.** Unlike `get_loans`, there is no "all states" escape
     * value — so the default list is the **open** CAPs only, and a closed CAP is invisible
     * until `?state=1` is asked for.
     */
    it('always constrains state — there is no "every state" value here', async () => {
      const { service, prisma } = build();

      await service.getAccounts(15, 1, true, 0);
      await service.getAccounts(15, 1, true, 1);

      for (const call of prisma.savingAccount.findMany.mock.calls as [
        { where: Record<string, unknown> },
      ][]) {
        expect(call[0].where).toHaveProperty('state');
      }
    });

    it('serialises the rows it returns', async () => {
      const { service } = build({ rows: [accountRow()], count: 1 });

      const result = await service.getAccounts(15, 1);

      expect(result.list).toEqual([
        {
          value: 900000n,
          created_at: '14 mar. 2023',
          state: 0,
          user_full_name: 'Angi Paola Sanchez Quilindo',
          id: 3,
          end_date: '28 feb. 2024',
        },
      ]);
    });

    describe('the pagination envelope', () => {
      it('reports num_pages and count alongside the page', async () => {
        const { service } = build({ rows: [accountRow()], count: 23 });

        const result = await service.getAccounts(15, 2);

        expect(result).toMatchObject({ num_pages: 3, count: 23 });
      });

      /** ⚠️ A page past the last one is a **200 with an empty list**, not a 404. */
      it('returns an empty list, not an error, past the last page', async () => {
        const { service, prisma } = build({ count: 5 });

        const result = await service.getAccounts(15, 9);

        expect(result).toEqual({ list: [], num_pages: 1, count: 5 });
        expect(prisma.savingAccount.findMany).not.toHaveBeenCalled();
      });

      /** ⚠️ `num_pages` is **never 0** — Django computes `ceil(max(1, count) / per_page)`. */
      it('reports num_pages 1 for an empty result set', async () => {
        const { service } = build({ count: 0 });

        expect(await service.getAccounts(15, 1)).toEqual({ list: [], num_pages: 1, count: 0 });
      });

      it('pages ten at a time', async () => {
        const { service, prisma } = build({ count: 30 });

        await service.getAccounts(15, 3);

        expect(prisma.savingAccount.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ skip: 20, take: 10 }),
        );
      });
    });

    /** `paginate=false` returns `{'list': [...]}` with **no** `num_pages` and no `count`. */
    it('omits num_pages and count entirely when paginate is false', async () => {
      const { service, prisma } = build({ rows: [accountRow()] });

      const result = await service.getAccounts(15, 1, false, 0, false);

      expect(Object.keys(result)).toEqual(['list']);
      expect(prisma.savingAccount.count).not.toHaveBeenCalled();
      expect(prisma.savingAccount.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.anything() as unknown }),
      );
    });
  });

  // ==========================================================================
  // update_account
  // ==========================================================================
  describe('update_account', () => {
    /** ⚠️ **Q21** — `value` is the new **total balance**, a replacement, not a deposit. */
    it('replaces state and value outright', async () => {
      const { service, prisma } = build({ existing: { id: 3 } });

      await expect(service.updateAccount({ id: 3, state: 1, value: 500000 })).resolves.toBe(true);

      expect(prisma.savingAccount.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { state: 1, value: 500000n },
      });
    });

    it('does not add to the existing balance', async () => {
      const { service, prisma } = build({ existing: { id: 3 } });

      await service.updateAccount({ id: 3, state: 0, value: 100 });

      const [call] = prisma.savingAccount.update.mock.calls as [{ data: { value: bigint } }][];
      expect(call[0].data.value).toBe(100n);
    });

    /** The **only** 404 path: a well-formed body naming a row that does not exist. */
    it('returns false — the view’s 404 — for an id no CAP has', async () => {
      const { service, prisma } = build({ existing: null });

      await expect(service.updateAccount({ id: 9999, state: 1, value: 0 })).resolves.toBe(false);

      expect(prisma.savingAccount.update).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ `obj['id']` sits *inside* v1's `try`, but `except SavingAccount.DoesNotExist` does
     * not catch `KeyError`, so a missing `id` escapes as a **500** rather than becoming the
     * 404. The other two subscripts are outside the `try` entirely.
     */
    it('raises rather than 404ing when id is missing', async () => {
      const { service } = build({ existing: { id: 3 } });

      await expect(service.updateAccount({ state: 1, value: 0 })).rejects.toThrow("KeyError: 'id'");
    });

    it.each(['state', 'value'])(
      'raises when %s is missing, after the row was found',
      async (key) => {
        const { service, prisma } = build({ existing: { id: 3 } });
        const body: Record<string, unknown> = { id: 3, state: 1, value: 0 };
        delete body[key];

        await expect(service.updateAccount(body)).rejects.toThrow(`KeyError: '${key}'`);
        expect(prisma.savingAccount.update).not.toHaveBeenCalled();
      },
    );

    /**
     * ⚠️ **The ordering is observable.** A body missing `state` *and* naming a non-existent
     * id is a **404**, not a 500, because v1 looks the row up before it touches `obj['state']`.
     */
    it('404s rather than raising when the row is missing AND state is absent', async () => {
      const { service } = build({ existing: null });

      await expect(service.updateAccount({ id: 9999 })).resolves.toBe(false);
    });

    /** Django coerces the pk through `int()`: a non-numeric id is a ValueError → **500**. */
    it('raises for a non-numeric id, rather than 404ing', async () => {
      const { service } = build({ existing: null });

      await expect(service.updateAccount({ id: 'abc', state: 1, value: 0 })).rejects.toThrow(
        /invalid literal for int/,
      );
    });

    /**
     * ⚠️ **`state` is written with no choices validation.** `Model.save()` does not call
     * `full_clean()`, so `PUT {state: 7}` writes a 7 — and that row then matches no list
     * filter, is not counted by `total_savingaccounts`, and is skipped by D12's close.
     * Ported rather than narrowed; registered in `docs/phase-6-deviations.md`.
     */
    it('writes a state outside 0-1 without complaint (v1 does not validate choices)', async () => {
      const { service, prisma } = build({ existing: { id: 3 } });

      await expect(service.updateAccount({ id: 3, state: 7, value: 0 })).resolves.toBe(true);

      expect(prisma.savingAccount.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { state: 7, value: 0n },
      });
    });

    it('accepts a negative value, as BigIntegerField does', async () => {
      const { service, prisma } = build({ existing: { id: 3 } });

      await service.updateAccount({ id: 3, state: 0, value: -1 });

      const [call] = prisma.savingAccount.update.mock.calls as [{ data: { value: bigint } }][];
      expect(call[0].data.value).toBe(-1n);
    });

    /** Django's `int()` truncates a float; the plan's `toDjangoInt` reproduces it. */
    it('truncates a fractional value, as int() does', async () => {
      const { service, prisma } = build({ existing: { id: 3 } });

      await service.updateAccount({ id: 3, state: 0, value: 1500.9 });

      const [call] = prisma.savingAccount.update.mock.calls as [{ data: { value: bigint } }][];
      expect(call[0].data.value).toBe(1500n);
    });

    it('sends no notification on an update (Q22)', async () => {
      const { service, notifications } = build({ existing: { id: 3 } });

      await service.updateAccount({ id: 3, state: 1, value: 0 });

      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // D12 — close_account (the compare-and-set)
  // ==========================================================================
  describe('close_account (D12, C78)', () => {
    it('is a compare-and-set on state, never a read-modify-write', async () => {
      const { service, prisma } = build({ updatedCount: 1 });

      await expect(service.closeAccount(3)).resolves.toBe('closed');

      expect(prisma.savingAccount.updateMany).toHaveBeenCalledWith({
        where: { id: 3, state: 0 },
        data: { state: 1 },
      });
      // No read before the write: the statement *is* the check.
      expect(prisma.savingAccount.findUnique).not.toHaveBeenCalled();
    });

    /** Idempotent on rerun — the claim-then-crash window depends on this (P7-D2). */
    it('is a no-op, not an error, when the CAP is already closed', async () => {
      const { service } = build({ updatedCount: 0, existing: { state: 1 } });

      await expect(service.closeAccount(3)).resolves.toBe('already-closed');
    });

    /** A CAP a treasurer put into an out-of-range state is not silently "closed". */
    it('reports already-closed for a row whose state is neither 0 nor 1', async () => {
      const { service } = build({ updatedCount: 0, existing: { state: 7 } });

      await expect(service.closeAccount(3)).resolves.toBe('already-closed');
    });

    /**
     * ⚠️ **Zero rows updated has two meanings and they must not be collapsed.** Already
     * closed is the designed rerun; *gone* is a task naming a CAP that no longer exists, and
     * that is left loud rather than reported as success.
     */
    it('throws when no CAP has that id at all', async () => {
      const { service } = build({ updatedCount: 0, existing: null });

      await expect(service.closeAccount(3)).rejects.toThrow(/Saving account 3 does not exist/);
    });
  });

  // ==========================================================================
  // D12 — the reconciliation query (C78, Q38)
  // ==========================================================================
  describe('find_unclosed_past_due (the independent check, C78)', () => {
    /** ⚠️ Strictly `<`: a CAP whose `end_date` is **today** is not overdue. */
    it('asks for state = 0 AND end_date < today, in America/Bogota', async () => {
      const { service, prisma } = build();
      prisma.savingAccount.findMany.mockResolvedValue([{ id: 3 }, { id: 8 }]);

      await expect(service.findUnclosedPastDue({ year: 2026, month: 9, day: 8 })).resolves.toEqual([
        3, 8,
      ]);

      expect(prisma.savingAccount.findMany).toHaveBeenCalledWith({
        where: { state: 0, end_date: { lt: new Date('2026-09-08T00:00:00.000Z') } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
    });

    /**
     * ⚠️ **C28.** At `2026-09-08T02:00Z` the host (UTC in this harness) says the 8th and
     * Bogota says the **7th**. Anchoring on the host would report a CAP ending on the 7th as
     * overdue several hours before its own close task was even due.
     */
    it('defaults "today" to Bogota, not the host zone', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-08T02:00:00.000Z'));
      const { service, prisma } = build();

      await service.findUnclosedPastDue();

      const [call] = prisma.savingAccount.findMany.mock.calls as [
        { where: { end_date: { lt: Date } } },
      ][];
      expect(call[0].where.end_date.lt.toISOString()).toBe('2026-09-07T00:00:00.000Z');
      expect(new Date().getUTCDate()).toBe(8); // the host really is on the 8th here
    });

    it('returns an empty list when every CAP is reconciled', async () => {
      const { service } = build();

      await expect(service.findUnclosedPastDue({ year: 2026, month: 9, day: 8 })).resolves.toEqual(
        [],
      );
    });
  });
});
