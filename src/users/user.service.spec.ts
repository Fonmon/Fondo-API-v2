import { HttpStatus } from '@nestjs/common';
import { Role } from '../auth/permissions/roles';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
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
  djangoFileLines,
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

  describe('djangoFileLines — `File.__iter__`', () => {
    it('splits on \\r\\n, \\r and \\n', () => {
      expect(djangoFileLines(Buffer.from('a\r\nb\nc\rd'))).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does not produce a trailing empty line for a terminated file', () => {
      expect(djangoFileLines(Buffer.from('a\r\nb\r\n'))).toEqual(['a', 'b']);
    });

    it('DOES produce an empty line for a genuine blank one — which v1 then 500s on', () => {
      expect(djangoFileLines(Buffer.from('a\n\nb\n'))).toEqual(['a', '', 'b']);
    });

    it('is empty for an empty file', () => {
      expect(djangoFileLines(Buffer.from(''))).toEqual([]);
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

    it('returns null when several share it and none is canonical', async () => {
      const service = build([
        { id: 13, username: 'a.child' },
        { id: 14, username: 'b.child' },
      ]);
      await expect(service.getUserByEmail('shared@mail.com')).resolves.toBeNull();
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
