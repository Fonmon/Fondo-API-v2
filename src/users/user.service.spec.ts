import { HttpStatus } from '@nestjs/common';
import { Role } from '../auth/permissions/roles';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import type { PlainDate } from '../common/utils/date.util';
import { ApiException } from '../common/http/api.exception';
import { DrfException } from '../common/http/drf.exception';
import type { AppConfigService } from '../config/app-config.service';
import { EmailTemplate } from '../mail/email-template';
import type { MailService } from '../mail/mail.service';
import type { NotificationService } from '../notifications/notification.service';
import { DjangoPasswordService } from '../auth/password/django-password.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  birthdayInYear,
  normalizeEmail,
  normalizeUsername,
  resolveDetailUserId,
  UserService,
} from './user.service';

/**
 * `fondo_api/services/user.py:UserService`, unit level — the ORM and both external boundaries
 * (SES, SQS) are mocked, matching v1's `@patch.object(MailService, 'send_mail')` shape.
 *
 * The DB-backed behaviour lives in `test/user.e2e-spec.ts`; what is here is the logic that can
 * be wrong without any database being involved.
 */
describe('UserService (unit)', () => {
  describe('normalizeEmail — `BaseUserManager.normalize_email`', () => {
    it('lowercases only the domain part', () => {
      expect(normalizeEmail('Foo.Bar@EXAMPLE.COM')).toBe('Foo.Bar@example.com');
    });

    it('leaves an address with no @ alone', () => {
      expect(normalizeEmail('notanemail')).toBe('notanemail');
    });

    it('splits on the LAST @, as Django’s rsplit does', () => {
      expect(normalizeEmail('a@b@EXAMPLE.COM')).toBe('a@b@example.com');
    });
  });

  describe('normalizeUsername — NFKC', () => {
    it('normalises compatibility characters', () => {
      // U+FF41 FULLWIDTH LATIN SMALL LETTER A -> 'a'
      expect(normalizeUsername('ａ@mail.com')).toBe('a@mail.com');
    });
  });

  describe('birthdayInYear — deviation D19', () => {
    it('moves an ordinary birthdate to the current year', () => {
      expect(birthdayInYear({ year: 1995, month: 11, day: 7 }, 2026)).toEqual({
        year: 2026,
        month: 11,
        day: 7,
      });
    });

    it('keeps 29 February in a leap year', () => {
      expect(birthdayInYear({ year: 2000, month: 2, day: 29 }, 2028)).toEqual({
        year: 2028,
        month: 2,
        day: 29,
      });
    });

    it('clamps 29 February to 28 February in a non-leap year, where v1 raises ValueError', () => {
      // ⚠️ 28, not 1 March: `relativedelta(years=+1)` maps 29 Feb to 28 Feb, and Phase 7 clones
      // this very task with `repeat = 4`. Choosing 1 March would put the first notification a
      // day after every repeat of itself.
      expect(birthdayInYear({ year: 2000, month: 2, day: 29 }, 2026)).toEqual({
        year: 2026,
        month: 2,
        day: 28,
      });
    });

    it('applies the Gregorian century rule', () => {
      expect(birthdayInYear({ year: 2000, month: 2, day: 29 }, 2100).day).toBe(28);
      expect(birthdayInYear({ year: 2000, month: 2, day: 29 }, 2000).day).toBe(29);
    });
  });

  describe('resolveDetailUserId — deviation D14, split by verb', () => {
    const actor = { id: 42 } as AuthenticatedUser;

    it('GET substitutes the caller for -1, as v1 does', () => {
      expect(resolveDetailUserId(-1, actor, 'GET')).toBe(42);
    });

    it('PATCH substitutes it too — v1 404s unconditionally, so nothing can depend on that', () => {
      expect(resolveDetailUserId(-1, actor, 'PATCH')).toBe(42);
    });

    it('DELETE never does — a self soft-delete of the only ADMIN is unrecoverable', () => {
      expect(resolveDetailUserId(-1, actor, 'DELETE')).toBe(-1);
    });

    it('passes every other id through unchanged, including -2', () => {
      for (const verb of ['GET', 'PATCH', 'DELETE'] as const) {
        expect(resolveDetailUserId(7, actor, verb)).toBe(7);
        expect(resolveDetailUserId(-2, actor, verb)).toBe(-2);
      }
    });
  });

  describe('createUser', () => {
    const config = { hostUrlApp: 'http://localhost:3000' } as AppConfigService;
    let prisma: {
      $transaction: jest.Mock;
      authUser: { create: jest.Mock };
      userFinance: { create: jest.Mock };
      userPreference: { create: jest.Mock };
    };
    let mail: { sendMail: jest.Mock };
    let notifications: { removeAllSubscriptions: jest.Mock };
    let service: UserService;

    beforeEach(() => {
      prisma = {
        $transaction: jest.fn((callback: (tx: unknown) => Promise<void>) => callback(prisma)),
        authUser: {
          create: jest.fn().mockResolvedValue({
            id: 12,
            email: 'mail@mail.com',
            first_name: 'Foo Name',
            last_name: 'Last Name',
          }),
        },
        userFinance: { create: jest.fn().mockResolvedValue(undefined) },
        userPreference: { create: jest.fn().mockResolvedValue(undefined) },
      };
      mail = { sendMail: jest.fn().mockResolvedValue(true) };
      notifications = { removeAllSubscriptions: jest.fn() };
      service = new UserService(
        prisma as unknown as PrismaService,
        mail as unknown as MailService,
        notifications as unknown as NotificationService,
        new DjangoPasswordService(),
        config,
      );
    });

    const body = {
      first_name: 'Foo Name',
      last_name: 'Last Name',
      identification: 123,
      email: 'mail@mail.com',
      role: 2,
    };

    it('creates both MTI halves, the finance zeros and the preference row', async () => {
      await service.createUser(body);

      const data = firstArg(prisma.authUser.create).data as Record<string, unknown>;
      expect(data.username).toBe('mail@mail.com');
      expect(data.email).toBe('mail@mail.com');
      expect(data.is_active).toBe(false);
      expect(data.is_staff).toBe(false);
      expect(data.is_superuser).toBe(false);
      expect((data.profile as { create: Record<string, unknown> }).create).toMatchObject({
        identification: 123n,
        role: 2,
        birthdate: null,
      });

      expect(firstArg(prisma.userFinance.create).data).toMatchObject({
        contributions: 0n,
        balance_contributions: 0n,
        total_quota: 0n,
        available_quota: 0n,
        utilized_quota: 0n,
        user_id: 12,
      });
      expect(firstArg(prisma.userPreference.create).data).toMatchObject({
        notifications: false,
        primary_color: '#800000',
        secondary_color: '#c83737',
        user_id: 12,
      });
    });

    it('stores an unusable password, not an empty one', async () => {
      await service.createUser(body);
      const data = firstArg(prisma.authUser.create).data as { password: string };
      expect(data.password).toMatch(/^![A-Za-z0-9]{40}$/);
    });

    it('sends the activation email with v1’s exact parameter names', async () => {
      await service.createUser(body);
      expect(mail.sendMail).toHaveBeenCalledWith(EmailTemplate.USER_ACTIVATION, ['mail@mail.com'], {
        user_full_name: 'Foo Name Last Name',
        user_id: 12,
        user_key: expect.stringMatching(/^[0-9a-f]{50}$/) as unknown,
        host_url: 'http://localhost:3000',
      });
    });

    it('aborts the transaction and answers 409 "Invalid email" when the send fails', async () => {
      mail.sendMail.mockResolvedValue(false);

      const error = await service.createUser(body).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect((error as ApiException).body).toEqual({ message: 'Invalid email' });
      // The rollback is the transaction's: the callback threw, so nothing committed.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('is a 500, not a 409, when a required field is missing — v1’s uncaught KeyError', async () => {
      await expect(service.createUser({ email: 'x@y.com' })).rejects.toThrow(
        "KeyError: 'identification'",
      );
    });

    it('normalises the email domain but not the username', async () => {
      await service.createUser({ ...body, email: 'Foo@EXAMPLE.COM' });
      const data = firstArg(prisma.authUser.create).data as Record<string, string>;
      expect(data.email).toBe('Foo@example.com');
      expect(data.username).toBe('Foo@EXAMPLE.COM');
    });
  });

  describe('getUserByEmail — deviation D17 / Q27', () => {
    const build = (rows: { id: number; username: string }[]): UserService => {
      const prisma = {
        authUser: {
          findMany: jest.fn().mockResolvedValue(
            rows.map((row) => ({
              ...row,
              email: 'shared@mail.com',
              password: 'p',
              last_login: null,
              first_name: 'A',
              last_name: 'B',
            })),
          ),
        },
      };
      return new UserService(
        prisma as unknown as PrismaService,
        {} as MailService,
        {} as NotificationService,
        new DjangoPasswordService(),
        {} as AppConfigService,
      );
    };

    it('returns null when nothing matches', async () => {
      await expect(build([]).getUserByEmail('shared@mail.com')).resolves.toBeNull();
    });

    it('returns the only match even when its username differs — D15 makes that possible', async () => {
      const service = build([{ id: 5, username: 'old@mail.com' }]);
      await expect(service.getUserByEmail('shared@mail.com')).resolves.toMatchObject({ id: 5 });
    });

    it('picks the account whose username IS the email when several share it', async () => {
      // The live shape: id 7 `criss9413@hotmail.com` and id 14 `ainhoa.montanez`.
      const service = build([
        { id: 7, username: 'shared@mail.com' },
        { id: 14, username: 'ainhoa.montanez' },
      ]);
      await expect(service.getUserByEmail('shared@mail.com')).resolves.toMatchObject({ id: 7 });
    });

    /**
     * **C32** — the D15 + P3-D2 interaction. Neither row has the address as its `username`,
     * which is a state only v2 can reach (D15 stopped writing `username = email`; P3-D2 lets
     * the duplicate-email PATCH through with a 200). Returning `null` here would re-create
     * the silent non-delivery D17 exists to fix, from an ordinary member self-service edit.
     */
    it('falls back to the lowest id when several share it and none is canonical', async () => {
      const service = build([
        { id: 13, username: 'a.child' },
        { id: 14, username: 'b.child' },
      ]);
      await expect(service.getUserByEmail('shared@mail.com')).resolves.toMatchObject({ id: 13 });
    });

    it('asks the database for the ordering the fallback depends on', () => {
      // The fallback is only *deterministic* because of `orderBy: { id: 'asc' }`; without it
      // the answer is whatever the planner returns. Pinned here as well as in the e2e cell.
      const prisma = {
        authUser: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new UserService(
        prisma as unknown as PrismaService,
        {} as MailService,
        {} as NotificationService,
        new DjangoPasswordService(),
        {} as AppConfigService,
      );
      void service.getUserByEmail('shared@mail.com');
      expect(prisma.authUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { id: 'asc' } }),
      );
    });
  });

  describe('createBirthdateNotification — the year is Bogota’s, not the host’s (C28)', () => {
    /**
     * v1: `today_year = datetime.now().year` (`services/user.py:268`), and Django pins the
     * **process** zone to `TIME_ZONE = 'America/Bogota'` in `Settings.__init__`
     * (`api/settings/base.py:121`), so `datetime.now()` is Bogota-local wall clock.
     *
     * The discriminating instant is any UTC time between 00:00 and 05:00 on 1 January: it is
     * still 31 December in Bogota (UTC−5). A host-zone read answers 2026 where v1 answers
     * 2025, and the birthday `SchedulerTask` is written a **full year** out — `repeat = 4`
     * then clones that error forward, so the member's notification is skipped, not merely
     * late. This test fails against `new Date().getFullYear()` **because `jest.config.ts`
     * pins the harness host zone to UTC** — a developer laptop already at −05:00 would
     * otherwise make the buggy line pass by coincidence. Do not unpin it.
     * (`process.env.TZ = ...` from inside a test is a no-op: jest's vm context does not
     * propagate the change to V8's cached zone. Measured.)
     */
    const member: AuthenticatedUser = {
      id: 5,
      username: 'm@mail.com',
      email: 'm@mail.com',
      isActive: true,
      profile: { role: Role.MEMBER, identification: 1n },
    };

    const scheduleFor = async (
      nowIso: string,
    ): Promise<{ year: number; month: number; day: number }> => {
      jest.useFakeTimers().setSystemTime(new Date(nowIso));
      try {
        const notifications = {
          removeSchNotifications: jest.fn().mockResolvedValue(0),
          scheduleNotification: jest.fn().mockResolvedValue(undefined),
        };
        const prisma: {
          $transaction: jest.Mock;
          userProfile: { findUnique: jest.Mock; update: jest.Mock; findMany: jest.Mock };
          authUser: { update: jest.Mock };
        } = {
          $transaction: jest.fn((callback: (tx: unknown) => Promise<void>) => callback(prisma)),
          userProfile: {
            findUnique: jest.fn().mockResolvedValue({
              user_ptr_id: 5,
              identification: 1n,
              role: Role.MEMBER,
              birthdate: new Date(Date.UTC(1995, 10, 7)),
              auth_user: { first_name: 'Foo', last_name: 'Bar', email: 'm@mail.com' },
            }),
            update: jest.fn().mockResolvedValue(undefined),
            findMany: jest.fn().mockResolvedValue([{ user_ptr_id: 5 }, { user_ptr_id: 9 }]),
          },
          authUser: { update: jest.fn().mockResolvedValue(undefined) },
        };
        const service = new UserService(
          prisma as unknown as PrismaService,
          {} as MailService,
          notifications as unknown as NotificationService,
          new DjangoPasswordService(),
          {} as AppConfigService,
        );

        await service.updateUser(member, 5, {
          type: 'personal',
          personal: {
            first_name: 'Foo',
            last_name: 'Bar',
            email: 'm@mail.com',
            identification: 1,
            role: Role.MEMBER,
            birthdate: '1995-11-07',
          },
        });

        expect(notifications.scheduleNotification).toHaveBeenCalledTimes(1);
        return (notifications.scheduleNotification.mock.calls[0] as [PlainDate])[0];
      } finally {
        jest.useRealTimers();
      }
    };

    it('schedules in 2025 at 2026-01-01T02:00Z — still 31 December in Bogota', async () => {
      await expect(scheduleFor('2026-01-01T02:00:00.000Z')).resolves.toEqual({
        year: 2025,
        month: 11,
        day: 7,
      });
    });

    it('schedules in 2026 at 2026-01-01T05:00Z — midnight in Bogota, the year has turned', async () => {
      await expect(scheduleFor('2026-01-01T05:00:00.000Z')).resolves.toEqual({
        year: 2026,
        month: 11,
        day: 7,
      });
    });

    it('is unaffected by the host zone in the middle of the day', async () => {
      await expect(scheduleFor('2026-06-15T18:00:00.000Z')).resolves.toEqual({
        year: 2026,
        month: 11,
        day: 7,
      });
    });
  });

  describe('updateUser — the D1 section gate runs before the row is loaded', () => {
    const member: AuthenticatedUser = {
      id: 5,
      username: 'm@mail.com',
      email: 'm@mail.com',
      isActive: true,
      profile: { role: Role.MEMBER, identification: 1n },
    };

    const service = (): UserService =>
      new UserService(
        {
          userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
          userFinance: { findFirst: jest.fn().mockResolvedValue(null) },
          userPreference: { findFirst: jest.fn().mockResolvedValue(null) },
        } as unknown as PrismaService,
        {} as MailService,
        {} as NotificationService,
        new DjangoPasswordService(),
        {} as AppConfigService,
      );

    it('403s a declared finance write before any lookup, so ids cannot be enumerated', async () => {
      // The target does not exist, and the answer is still 403 rather than 404.
      await expect(
        service().updateUser(member, 999, { type: 'finance', finance: {} }),
      ).rejects.toBeInstanceOf(DrfException);
    });

    it('403s a member editing someone else’s personal section, again before the lookup', async () => {
      await expect(
        service().updateUser(member, 999, { type: 'personal', personal: {} }),
      ).rejects.toBeInstanceOf(DrfException);
    });

    it('raises KeyError for a body with no `type` — a 500, not a 400', async () => {
      await expect(service().updateUser(member, 5, { personal: {} })).rejects.toThrow(
        "KeyError: 'type'",
      );
    });

    it('raises KeyError for a missing `preferences` section — it is read outside the bare except', async () => {
      await expect(service().updateUser(member, 5, { type: 'preferences' })).rejects.toThrow(
        "KeyError: 'preferences'",
      );
    });
  });
});

/** The first argument of a mock's first call, typed so eslint does not see `any`. */
function firstArg(mock: jest.Mock): { data: unknown } {
  return (mock.mock.calls[0] as [{ data: unknown }])[0];
}
