import { Role } from '../auth/permissions/roles';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { DrfException } from '../common/http/drf.exception';
import { EmailTemplate } from '../mail/email-template';
import type { MailService } from '../mail/mail.service';
import type { NotificationService } from '../notifications/notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import { PowerService } from './power.service';
import type { UserService } from './user.service';

const actor = (id: number, role = Role.MEMBER): AuthenticatedUser => ({
  id,
  username: `u${id}@mail.com`,
  email: `u${id}@mail.com`,
  isActive: true,
  profile: { role, identification: BigInt(id) },
});

const POWER = {
  id: 3,
  state: 0,
  meeting_date: new Date(Date.UTC(2020, 0, 1)),
  requester_id: 1,
  requestee_id: 2,
  requester: {
    identification: 99999n,
    auth_user: { first_name: 'Foo Name', last_name: 'Foo Last Name' },
  },
  requestee: {
    identification: 1001n,
    auth_user: { first_name: 'Ana', last_name: 'Ruiz' },
  },
};

describe('PowerService (unit)', () => {
  let prisma: {
    power: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };
  let users: { getProfile: jest.Mock; getUserEmails: jest.Mock };
  let mail: { sendMail: jest.Mock };
  let notifications: { sendNotification: jest.Mock };
  let service: PowerService;

  beforeEach(() => {
    prisma = {
      power: {
        create: jest.fn().mockResolvedValue({ id: 3 }),
        findUnique: jest.fn().mockResolvedValue(POWER),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    users = {
      getProfile: jest.fn((id: number) => Promise.resolve({ user_ptr_id: id })),
      getUserEmails: jest.fn().mockResolvedValue(['a@mail.com', 'b@mail.com']),
    };
    mail = { sendMail: jest.fn().mockResolvedValue(true) };
    notifications = { sendNotification: jest.fn().mockResolvedValue(undefined) };
    service = new PowerService(
      prisma as unknown as PrismaService,
      users as unknown as UserService,
      mail as unknown as MailService,
      notifications as unknown as NotificationService,
    );
  });

  describe('post', () => {
    it('creates a PENDING row and pushes a notification to the requestee only', async () => {
      await expect(
        service.handlePowerRequest(actor(1), {
          type: 'post',
          meeting_date: '2020-01-01',
          requestee: 2,
        }),
      ).resolves.toBeUndefined();

      expect(firstArg(prisma.power.create).data).toMatchObject({
        state: 0,
        requester_id: 1,
        requestee_id: 2,
      });
      expect(notifications.sendNotification).toHaveBeenCalledWith(
        [2],
        'Te han enviado una solicitud para ser apoderado en una reunion. Revisala',
        '/tool/power',
      );
    });

    it('publishes AFTER the row is written and outside any transaction', async () => {
      const order: string[] = [];
      prisma.power.create.mockImplementation(() => {
        order.push('create');
        return Promise.resolve({ id: 3 });
      });
      notifications.sendNotification.mockImplementation(() => {
        order.push('publish');
        return Promise.resolve();
      });

      await service.handlePowerRequest(actor(1), {
        type: 'post',
        meeting_date: '2020-01-01',
        requestee: 2,
      });
      expect(order).toEqual(['create', 'publish']);
    });

    it('rejects a malformed meeting_date, as Django’s DateField does', async () => {
      await expect(
        service.handlePowerRequest(actor(1), {
          type: 'post',
          meeting_date: '01/01/2020',
          requestee: 2,
        }),
      ).rejects.toThrow(/invalid date format/);
    });

    /**
     * ## Major 6 — this was a THIRD hand-rolled port of Django's date coercion
     *
     * v1: `Power.objects.create(meeting_date = request['meeting_date'])` — the raw body string
     * into a `DateField`, so `to_python` → `parse_date` → `datetime.date`.
     *
     * ⚠️ **The cell above could not see any of this.** `'01/01/2020'` is rejected by both
     * stacks, so it discriminates against nothing that was actually wrong. B1, B2 and Major 5
     * all walked past this function because it was never spelled `strptime` and never spelled
     * `Date.UTC` — Major 5's own write-up claimed *"the two hand-rolled ports of one builtin
     * are gone"* when there were three. Found by `nestjs-reviewer`.
     *
     * Every row measured against the pinned CPython 3.9.25 / Django 2.2.27.
     */
    it.each([
      ['2020-1-1', 2020, 1, 1, 'date_re is \\d{1,2}; the old regex demanded \\d{2}'],
      ['٢٠٢٠-٠١-٠١', 2020, 1, 1, 'date_re is Unicode-aware and int() folds — D42 axis 4'],
      ['2020-01-01\n', 2020, 1, 1, "Python's $ also matches before one trailing newline"],
    ])('Major 6: accepts %j  // %s', async (raw, year, month, day) => {
      await service.handlePowerRequest(actor(1), {
        type: 'post',
        meeting_date: raw,
        requestee: 2,
      });
      const call = prisma.power.create.mock.calls[0] as [{ data: { meeting_date: Date } }];
      const written = call[0].data.meeting_date;
      expect(written.toISOString().slice(0, 10)).toBe(
        `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      );
    });

    /**
     * ⚠️ **The three that mattered most: v2 wrote a row v1 refuses, AND sent the notification
     * that follows it.** The old body had no calendar check at all — `split('-').map(Number)`
     * straight into a `Date`, so February 30th rolled into March 1st and month 13 into January
     * of the next year. Measured: v1 raises `ValueError: day 30 must be in range 1..29 for
     * month 2 in year 2020` / `month must be in 1..12, not 13` / `year must be in 1..9999`.
     */
    it.each([
      ['2020-02-30', 'rolled to 2020-03-01'],
      ['2020-13-01', 'rolled to 2021-01-01'],
      ['0000-01-01', 'wrote year 0 — B2, unguarded on this path'],
    ])('Major 6: refuses %j and writes NOTHING  // was: %s', async (raw) => {
      await expect(
        service.handlePowerRequest(actor(1), {
          type: 'post',
          meeting_date: raw,
          requestee: 2,
        }),
        // ⚠️ Nit 4 — pins WHICH ValidationError branch fired. v1 distinguishes `invalid`
        // ("has an invalid date format", a regex miss) from `invalid_date` ("has the correct
        // format (YYYY-MM-DD) but it is an invalid date", a calendar miss). All three rows
        // here are calendar/range misses, so a bare `.toThrow()` would also have passed if the
        // regex had rejected them for the wrong reason.
      ).rejects.toThrow(/but it is an invalid date/);
      // ⚠️ Minor 13 — the docblock said "the row AND the notification"; the cell asserted only
      // the row. Prose claiming more than the cell arbitrates, in the commit that fixed exactly
      // that pattern (Major 7). Both are asserted now.
      expect(prisma.power.create).not.toHaveBeenCalled();
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('reads the requester side for obj=requested, newest first', async () => {
      await service.handlePowerRequest(actor(1), { type: 'get', page: 1, obj: 'requested' });
      expect(prisma.power.count).toHaveBeenCalledWith({ where: { requester_id: 1 } });
    });

    it('reads the requestee side for obj=requestee', async () => {
      await service.handlePowerRequest(actor(1), { type: 'get', page: 1, obj: 'requestee' });
      expect(prisma.power.count).toHaveBeenCalledWith({ where: { requestee_id: 1 } });
    });

    it('returns the empty envelope for an unrecognised obj, not an error', async () => {
      await expect(
        service.handlePowerRequest(actor(1), { type: 'get', page: 1, obj: 'nonsense' }),
      ).resolves.toEqual({ list: [], num_pages: 1, count: 0 });
    });

    it('raises for a missing obj — the 500 `test_get_powers_exception` asserts', async () => {
      await expect(service.handlePowerRequest(actor(1), { type: 'get', page: 2 })).rejects.toThrow(
        "KeyError: 'obj'",
      );
    });

    it('raises for a quoted page — Python cannot order a str against an int', async () => {
      await expect(
        service.handlePowerRequest(actor(1), { type: 'get', page: '1', obj: 'requested' }),
      ).rejects.toThrow(/not supported between instances/);
    });

    it('raises for page 0 — `Paginator.page(0)` is EmptyPage', async () => {
      prisma.power.count.mockResolvedValue(5);
      await expect(
        service.handlePowerRequest(actor(1), { type: 'get', page: 0, obj: 'requested' }),
      ).rejects.toThrow(/EmptyPage/);
    });
  });

  describe('patch — deviations D2 and D5', () => {
    it('D2: refuses a caller who is not the requestee, with DRF’s generic 403', async () => {
      const error = await service
        .handlePowerRequest(actor(1), { type: 'patch', id: 3, state: 1 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DrfException);
      expect((error as DrfException).drfBody).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
      expect(prisma.power.update).not.toHaveBeenCalled();
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('D2: an ADMIN who is not the requestee is refused too — this is ownership, not role', async () => {
      await expect(
        service.handlePowerRequest(actor(1, Role.ADMIN), { type: 'patch', id: 3, state: 1 }),
      ).rejects.toBeInstanceOf(DrfException);
    });

    it('D5: the approval letter goes to every member in Bcc, with an empty To', async () => {
      await service.handlePowerRequest(actor(2), { type: 'patch', id: 3, state: 1 });

      expect(prisma.power.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { state: 1 } });
      expect(mail.sendMail).toHaveBeenCalledWith(
        EmailTemplate.POWER_APPROVED,
        // ⚠️ v1 puts every address here, with an empty Bcc.
        [],
        {
          requester_full_name: 'Foo Name Foo Last Name',
          requester_identification: 99999n,
          requestee_full_name: 'Ana Ruiz',
          requestee_identification: 1001n,
          meeting_date: '1 ene. 2020',
        },
        ['a@mail.com', 'b@mail.com'],
      );
    });

    it('sends nothing when the state is a rejection', async () => {
      await service.handlePowerRequest(actor(2), { type: 'patch', id: 3, state: 2 });
      expect(prisma.power.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { state: 2 } });
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('sends nothing for the string "1" — v1 compares the submitted value with `== 1`', async () => {
      await service.handlePowerRequest(actor(2), { type: 'patch', id: 3, state: '1' });
      expect(prisma.power.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { state: 1 } });
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('raises for an unknown power id — v1’s DoesNotExist, which the view turns into a 500', async () => {
      prisma.power.findUnique.mockResolvedValue(null);
      await expect(
        service.handlePowerRequest(actor(2), { type: 'patch', id: 3, state: 1 }),
      ).rejects.toThrow(/Power matching query does not exist/);
    });
  });

  describe('the multiplexer itself', () => {
    it('lower-cases the type, as `request["type"].lower()` does', async () => {
      await service.handlePowerRequest(actor(1), {
        type: 'POST',
        meeting_date: '2020-01-01',
        requestee: 2,
      });
      expect(prisma.power.create).toHaveBeenCalled();
    });

    it('returns undefined for an unrecognised type — v1 falls off the elif chain', async () => {
      await expect(
        service.handlePowerRequest(actor(1), { type: 'delete' }),
      ).resolves.toBeUndefined();
    });

    it('raises AttributeError for a non-string type', async () => {
      await expect(service.handlePowerRequest(actor(1), { type: 5 })).rejects.toThrow(
        /AttributeError/,
      );
    });

    it('raises KeyError for a missing type', async () => {
      await expect(service.handlePowerRequest(actor(1), {})).rejects.toThrow("KeyError: 'type'");
    });
  });
});

/** The first argument of a mock's first call, typed so eslint does not see `any`. */
function firstArg(mock: jest.Mock): { data: unknown } {
  return (mock.mock.calls[0] as [{ data: unknown }])[0];
}
