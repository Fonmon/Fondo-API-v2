import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DjangoPasswordService } from '../../src/auth/password/django-password.service';
import { Role } from '../../src/auth/permissions/roles';
import { Prisma } from '../../src/prisma/prisma-client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { todayForAutoNowDateColumn } from '../../src/common/utils/timezone.util';
import { assertDisposableDatabase } from '../shared-database-guard';
import { TEST_DATABASE_URL } from '../test-database';

/**
 * The v2 counterpart of `fondo_api/tests/abstract_test.py:AbstractTest`.
 *
 * v1's helpers and what replaces them:
 *
 * | v1 | v2 |
 * |---|---|
 * | `create_user()` — one ADMIN, identification 99999, `mail_for_tests@mail.com` | {@link seedAdminUser} |
 * | `create_basic_users()` — ten TREASURERs, identification `i*1001` | {@link seedBasicUsers} |
 * | `get_token(username, password)` | {@link obtainToken} |
 * | `get_auth_header(token)` | {@link authHeader} |
 *
 * Differences from v1, all deliberate:
 *  * v1 pins `id = 1` on the admin. v2 lets the sequence assign ids — plan §4 forbids v2
 *    setting a primary key on a table v1 also writes, and nothing in these tests depends on
 *    the value. The seeded id is returned instead.
 *  * `UserProfile.objects.create_user` fills `is_superuser`, `is_staff`, `date_joined` and
 *    hashes the password for free. In v2 each is explicit, because Django's `auto_now_add`
 *    is application-side and the columns have no DB default (plan §4.5).
 */
export const TEST_PASSWORD = 'password';
export const ADMIN_EMAIL = 'mail_for_tests@mail.com';

export interface SeededUser {
  readonly id: number;
  readonly email: string;
  readonly role: Role;
  readonly identification: bigint;
}

const passwords = new DjangoPasswordService();

/**
 * Deletes every row Phases 1-3 can touch, in FK-safe order.
 *
 * Phase 3 added `fondo_api_power`, `fondo_api_schedulertask` (the birthday task) and
 * `fondo_api_savingaccount` (read by `UserFinanceSerializer.get_total_savingaccounts`).
 * Phase 4 adds `fondo_api_loan` and `fondo_api_loandetail`. Phase 5 adds the three activity
 * tables — and they must be listed **child first** even though `CASCADE` would cover it,
 * because `fondo_api_activityuser`'s FKs are `NO ACTION`/`DEFERRABLE` in the database (plan
 * §4 rule 10) and the explicit order is the same one `removeActivity` has to use.
 *
 * ⚠️ `fondo_api_loan` has a **self-referential** FK (`prev_loan_id`) as well as the FK from
 * `fondo_api_loandetail`, so the two must be truncated together — `CASCADE` covers it, and
 * `RESTART IDENTITY` matters here because `bulk_update_loans` selects by id.
 *
 * The e2e database is disposable (`test/test-database.ts`) and never the shared dev one, but
 * suites still start from a clean slate so ordering between files cannot matter.
 *
 * ⚠️ Condition **C25**: "disposable" is *checked*, not assumed. `assertDisposableDatabase`
 * refuses a database Django owns, so a `TEST_DATABASE_URL` pointed at `fondodev` fails here
 * instead of truncating the 94-row parity fixture. The check is memoised per URL, so this
 * costs one round trip for the whole run.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await assertDisposableDatabase(TEST_DATABASE_URL);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE authtoken_token, fondo_api_notificationsubscriptions, ' +
      'fondo_api_schedulertask, fondo_api_power, fondo_api_savingaccount, ' +
      'fondo_api_loandetail, fondo_api_loan, ' +
      'fondo_api_activityuser, fondo_api_activity, fondo_api_activityyear, ' +
      'fondo_api_userfinance, fondo_api_userpreference, fondo_api_userprofile, auth_user ' +
      'RESTART IDENTITY CASCADE',
  );
}

/**
 * `Loan.objects.create(...)` for an e2e fixture, with every application-set default supplied.
 *
 * ⚠️ `created_at` is `auto_now_add` and `state` / `payment` have Python-side defaults, so none
 * of them has a DB default (plan §4 rule 5). `rate` must be given as a **string** — a JS float
 * would not round-trip through `numeric(5,3)`.
 */
export async function seedLoan(
  prisma: PrismaService,
  options: {
    userId: number;
    value: bigint;
    timelimit: number;
    fee: number;
    rate: string;
    disbursementDate: string;
    state?: number;
    payment?: number;
    comments?: string | null;
    createdAt?: Date;
    prevLoanId?: number | null;
    refinancedLoan?: bigint | null;
    disbursementValue?: bigint | null;
  },
): Promise<number> {
  const loan = await prisma.loan.create({
    data: {
      value: options.value,
      timelimit: options.timelimit,
      disbursement_date: new Date(`${options.disbursementDate}T00:00:00.000Z`),
      payment: options.payment ?? 0,
      created_at: options.createdAt ?? new Date(),
      fee: options.fee,
      comments: options.comments === undefined ? '' : options.comments,
      state: options.state ?? 0,
      rate: new Prisma.Decimal(options.rate),
      user_id: options.userId,
      prev_loan_id: options.prevLoanId ?? null,
      refinanced_loan: options.refinancedLoan ?? null,
      disbursement_value: options.disbursementValue ?? null,
    },
    select: { id: true },
  });
  return loan.id;
}

/**
 * `LoanDetail.objects.create(...)`.
 *
 * v1's `test_bulk_update_loans` creates these with **only** `payday_limit` and `loan`, letting
 * the model defaults supply the rest (`0` for the four money columns, `date.today` for
 * `from_date`). Those defaults are Python-side, so they are spelled out here.
 */
export async function seedLoanDetail(
  prisma: PrismaService,
  options: {
    loanId: number;
    paydayLimit: string;
    fromDate?: string;
    totalPayment?: bigint;
    minimumPayment?: bigint;
    interests?: bigint;
    capitalBalance?: bigint;
  },
): Promise<number> {
  const detail = await prisma.loanDetail.create({
    data: {
      total_payment: options.totalPayment ?? 0n,
      minimum_payment: options.minimumPayment ?? 0n,
      payday_limit: new Date(`${options.paydayLimit}T00:00:00.000Z`),
      interests: options.interests ?? 0n,
      capital_balance: options.capitalBalance ?? 0n,
      // `DateField(default=date.today)` — Bogota, never the host zone (condition C28).
      from_date:
        options.fromDate === undefined
          ? todayForAutoNowDateColumn()
          : new Date(`${options.fromDate}T00:00:00.000Z`),
      loan_id: options.loanId,
    },
    select: { id: true },
  });
  return detail.id;
}

/**
 * `ActivityYear.objects.create(year=…)` — Phase 5.
 *
 * `enable` is `BooleanField(default=True)`, a **Python-side** default with no DB default
 * (plan §4 rule 5), so it is spelled out. It is settable because production holds two enabled
 * rows and a fixture that could not reproduce that would be the wrong shape to test against
 * (`docs/phase-5-prework.md` §1).
 */
export async function seedActivityYear(
  prisma: PrismaService,
  options: { year: bigint | number; enable?: boolean },
): Promise<{ id: number; year: bigint }> {
  return prisma.activityYear.create({
    data: { year: BigInt(options.year), enable: options.enable ?? true },
    select: { id: true, year: true },
  });
}

/**
 * `Activity.objects.create(...)` — Phase 5. Creates **no** `ActivityUser` rows, exactly like
 * v1's own `test_get_activities` / `test_delete_activity` / `test_update_activity` fixtures,
 * which is why `test_update_activity` can assert `users == []`.
 */
export async function seedActivity(
  prisma: PrismaService,
  options: { yearId: number; name: string; value: bigint | number; date: string },
): Promise<number> {
  const activity = await prisma.activity.create({
    data: {
      name: options.name,
      value: BigInt(options.value),
      date: new Date(`${options.date}T00:00:00.000Z`),
      year_id: options.yearId,
    },
    select: { id: true },
  });
  return activity.id;
}

/** `ActivityUser.objects.create(...)` — `state` defaults to `0 NOT_PAID`, Python-side. */
export async function seedActivityUser(
  prisma: PrismaService,
  options: { activityId: number; userId: number; state?: number },
): Promise<number> {
  const row = await prisma.activityUser.create({
    data: {
      state: options.state ?? 0,
      activity_id: options.activityId,
      user_id: options.userId,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * `SavingAccount.objects.create(...)` — Phase 6.
 *
 * ⚠️ v1 has **no** saving-account fixtures at all (no `test_saving_account_views.py`), so
 * this helper has no `setUp` to transcribe. Its shape comes from the model: `created_at` is
 * `auto_now_add` and `state` / `value` carry Python-side defaults, so none of the three has a
 * database default and all three are spelled out (plan §4 rule 5).
 *
 * `endDate` is a `@db.Date`, written at UTC midnight — reading it back with `fromDateColumn`
 * then returns the same calendar day in every server zone (rule 5c).
 */
export async function seedSavingAccount(
  prisma: PrismaService,
  options: {
    userId: number;
    endDate: string;
    state?: number;
    value?: bigint | number;
    createdAt?: Date;
  },
): Promise<number> {
  const account = await prisma.savingAccount.create({
    data: {
      created_at: options.createdAt ?? new Date(),
      end_date: new Date(`${options.endDate}T00:00:00.000Z`),
      state: options.state ?? 0,
      value: BigInt(options.value ?? 0),
      user_id: options.userId,
    },
    select: { id: true },
  });
  return account.id;
}

/** `AbstractTest.create_user` — the ADMIN every v1 view test authenticates as. */
export async function seedAdminUser(prisma: PrismaService): Promise<SeededUser> {
  return seedUser(prisma, {
    email: ADMIN_EMAIL,
    identification: 99999n,
    role: Role.ADMIN,
  });
}

/** `AbstractTest.create_basic_users` — ten TREASURERs with identification `i * 1001`. */
export async function seedBasicUsers(prisma: PrismaService): Promise<SeededUser[]> {
  const users: SeededUser[] = [];
  for (let i = 1; i <= 10; i += 1) {
    users.push(
      await seedUser(prisma, {
        email: `mail_for_tests_${i * 1001}@mail.com`,
        identification: BigInt(i * 1001),
        role: Role.TREASURER,
      }),
    );
  }
  return users;
}

/**
 * Creates both halves of the `UserProfile(User)` multi-table inheritance plus the
 * `UserFinance` / `UserPreference` rows `AbstractTest` creates, with a Django-format
 * password hash.
 *
 * `username` is set equal to `email`: `UserProfile.USERNAME_FIELD` is `email`, but
 * `AUTH_USER_MODEL` is Django's default so authentication resolves against `username`. v1
 * keeps them equal on every write path and so must every fixture.
 */
export async function seedUser(
  prisma: PrismaService,
  options: {
    email: string;
    identification: bigint;
    role: Role;
    password?: string;
    isActive?: boolean;
    firstName?: string;
    lastName?: string;
  },
): Promise<SeededUser> {
  const password = await passwords.hash(options.password ?? TEST_PASSWORD);
  const user = await prisma.authUser.create({
    data: {
      password,
      username: options.email,
      email: options.email,
      first_name: options.firstName ?? 'Foo Name',
      last_name: options.lastName ?? 'Foo Last Name',
      is_superuser: false,
      is_staff: false,
      is_active: options.isActive ?? true,
      // auto_now_add, application-set: there is no DB default.
      date_joined: new Date(),
      profile: {
        create: {
          identification: options.identification,
          role: options.role,
          key_activation: null,
          birthdate: null,
        },
      },
    },
    select: { id: true },
  });

  await prisma.userFinance.create({
    data: {
      contributions: 2000n,
      balance_contributions: 2000n,
      total_quota: 1000n,
      utilized_quota: 0n,
      available_quota: 500n,
      last_modified: new Date(),
      user_id: user.id,
    },
  });
  await prisma.userPreference.create({
    data: {
      notifications: false,
      primary_color: '#800000',
      secondary_color: '#c83737',
      user_id: user.id,
    },
  });

  return {
    id: user.id,
    email: options.email,
    role: options.role,
    identification: options.identification,
  };
}

/** Creates an `auth_user` row with **no** `fondo_api_userprofile` sibling. */
export async function seedUserWithoutProfile(
  prisma: PrismaService,
  email: string,
): Promise<number> {
  const user = await prisma.authUser.create({
    data: {
      password: await passwords.hash(TEST_PASSWORD),
      username: email,
      email,
      first_name: 'No',
      last_name: 'Profile',
      is_superuser: true,
      is_staff: true,
      is_active: true,
      date_joined: new Date(),
    },
    select: { id: true },
  });
  return user.id;
}

/** `AbstractTest.get_token` — a real `POST /api-token-auth` round trip. */
export async function obtainToken(
  app: INestApplication<App>,
  username: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api-token-auth')
    .send({ username, password })
    .expect(200);
  return (response.body as { token: string }).token;
}

/** `AbstractTest.get_auth_header` — `{'HTTP_AUTHORIZATION': "Token {}"}`. */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Token ${token}` };
}
