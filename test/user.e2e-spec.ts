import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { EmailTemplate } from '../src/mail/email-template';
import { MailService } from '../src/mail/mail.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedUser,
  type SeededUser,
} from './support/abstract-test';

/**
 * Phase 3 e2e — the port of `fondo_api/tests/test_user_views.py` (**31 methods**), DB-backed,
 * through the whole `AppModule` pipeline.
 *
 * ## How the port is organised
 *
 * Every `it(...)` below names its v1 counterpart, so `manual-tester` and the reviewer can diff
 * the two files method by method. Where the expectation **changes**, the reason is a registered
 * deviation and the cell says which one; there are four:
 *
 * | v1 test | v1 expectation | v2 | why |
 * |---|---|---|---|
 * | `test_patch_user` | `user.username == 'mail_updated@mail.com2'` | username **unchanged** | **D15** |
 * | `test_patch_user_conflict` (email half) | **409** | **200** | **D15** — the 409 came from the `username` write |
 * | `test_patch_power_denied` | ADMIN rejects its own request | **403** for the requester, 200 for the requestee | **D2** |
 * | `test_patch_power_approved` | ADMIN approves its own request | **403** for the requester, 200 for the requestee | **D2** |
 *
 * ## Fixture differences from `AbstractTest`, all deliberate
 *
 *  * v1 pins `id = 1` on the admin. v2 lets the sequence assign ids (plan §4: v2 never sets a
 *    primary key on a table v1 also writes), so "the user that does not exist" is a computed
 *    id rather than the literal `2`.
 *  * v1 patches `MailService.send_mail` with `@patch.object`. v2 overrides the provider — the
 *    same seam, checked the same way (`mock.assert_called_once_with(...)` becomes
 *    `expect(sendMail).toHaveBeenCalledWith(...)`).
 */
describe('Phase 3 — /api/user (port of test_user_views.py)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let admin: SeededUser;
  let members: SeededUser[];
  let token: string;
  /** An id no row has — v1's literal `2`, which only worked because it pinned `id = 1`. */
  let missingId: number;

  const sendMail = jest.fn<Promise<boolean>, unknown[]>();

  // `setUp`'s JSON fixtures, transcribed from `test_user_views.py:23-113`.
  const objectJson = {
    first_name: 'Foo Name',
    last_name: 'Last Name',
    identification: 123,
    email: 'mail@mail.com',
    username: 'mail@mail.com',
    role: 2,
  };
  const objectJsonIdentificationR = {
    first_name: 'Foo Name 2',
    last_name: 'Last Name 2',
    identification: 99999,
    email: 'mail2@mail.com',
    username: 'mail2@mail.com',
    role: 2,
  };
  const objectJsonEmailR = {
    first_name: 'Foo Name 3',
    last_name: 'Last Name 3',
    identification: 1234,
    email: 'mail_for_tests@mail.com',
    username: 'mail_for_tests@mail.com',
    role: 2,
  };
  const userUpdate = (): Record<string, unknown> => ({
    personal: {
      identification: 123,
      first_name: 'Foo Name update',
      last_name: 'Last Name update',
      email: 'mail_updated@mail.com2',
      role: 2,
      birthdate: '1995-11-07',
    },
    finance: {
      contributions: 2000,
      balance_contributions: 2000,
      total_quota: 1000,
      utilized_quota: 500,
    },
  });
  const userUpdateSameFinance = (): Record<string, unknown> => ({
    finance: {
      contributions: 2000,
      balance_contributions: 2000,
      total_quota: 1000,
      available_quota: 500,
      utilized_quota: 0,
    },
    personal: {
      identification: 123,
      first_name: 'Foo Name update',
      last_name: 'Last Name update',
      email: 'mail_updated@mail.com2',
      role: 2,
    },
  });
  const userUpdateEmailR = (): Record<string, unknown> => ({
    personal: {
      identification: 12312451241243,
      first_name: 'Foo Name update',
      last_name: 'Last Name update',
      email: 'mail@mail.com',
      role: 2,
    },
    finance: {
      contributions: 2000,
      balance_contributions: 2000,
      total_quota: 1000,
      utilized_quota: 500,
    },
  });
  const userUpdateIdentificationR = (): Record<string, unknown> => ({
    personal: {
      identification: 123,
      first_name: 'Foo Name update',
      last_name: 'Last Name update',
      email: 'mail2@m2ail.com',
      role: 2,
    },
    finance: {
      contributions: 2000,
      balance_contributions: 2000,
      total_quota: 1000,
      utilized_quota: 500,
    },
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({ sendMail })
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    notifications = app.get(NotificationService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(true);
    await resetDatabase(prisma);

    // `AbstractTest.create_user()` — one ADMIN, identification 99999.
    admin = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    // `AbstractTest.create_basic_users()` — ten TREASURERs, identification `i * 1001`.
    members = [];
    for (let i = 1; i <= 10; i += 1) {
      members.push(
        await seedUser(prisma, {
          email: `mail_for_tests_${i * 1001}@mail.com`,
          identification: BigInt(i * 1001),
          role: Role.TREASURER,
        }),
      );
    }
    token = await obtainToken(app, 'mail_for_tests@mail.com');
    missingId = admin.id + 10_000;
  });

  const asAdmin = (): Record<string, string> => authHeader(token);
  const countUsers = (): Promise<number> => prisma.userProfile.count();
  const countFinance = (): Promise<number> => prisma.userFinance.count();

  // ==========================================================================
  // POST /api/user
  // ==========================================================================

  /** `test_success_post` */
  it('test_success_post: creates all four rows and sends the activation email', async () => {
    await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(201);

    const created = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    expect(created.auth_user.first_name).toBe('Foo Name');
    expect(created.identification).toBe(123n);
    expect(created.auth_user.email).toBe('mail@mail.com');
    expect(created.role).toBe(2);
    expect(created.key_activation).not.toBeNull();
    expect(created.auth_user.is_active).toBe(false);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(EmailTemplate.USER_ACTIVATION, ['mail@mail.com'], {
      user_full_name: 'Foo Name Last Name',
      user_id: created.user_ptr_id,
      user_key: created.key_activation,
      host_url: 'http://localhost:3000',
    });

    await expect(countUsers()).resolves.toBe(12);
    await expect(countFinance()).resolves.toBe(12);
  });

  it('test_success_post: the activation key is 25 random bytes as 50 hex characters', async () => {
    await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(201);

    const created = await prisma.userProfile.findFirstOrThrow({ where: { identification: 123n } });
    expect(created.key_activation).toMatch(/^[0-9a-f]{50}$/);
  });

  it('test_success_post: the new member has an unusable password until activation', async () => {
    await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(201);

    const created = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    // v1: `assertFalse('pbkdf2_sha256' in user.password)` before activation.
    expect(created.auth_user.password.startsWith('!')).toBe(true);
    expect(created.auth_user.password).not.toContain('pbkdf2_sha256');
  });

  /** `test_invalid_email` — the mail-failure rollback, across all four tables. */
  it('test_invalid_email: a failed send rolls every row back and answers 409', async () => {
    sendMail.mockResolvedValue(false);

    const response = await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(409);

    expect(response.body).toEqual({ message: 'Invalid email' });
    await expect(countUsers()).resolves.toBe(11);
    await expect(countFinance()).resolves.toBe(11);
    await expect(prisma.userPreference.count()).resolves.toBe(11);
    await expect(prisma.authUser.count()).resolves.toBe(11);
  });

  /** `test_unsuccess_post_identification` */
  it('test_unsuccess_post_identification: a duplicate identification is 409', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJsonIdentificationR)
      .expect(409);

    expect(response.body).toEqual({ message: 'Identification/email already exists' });
    await expect(countUsers()).resolves.toBe(11);
    await expect(countFinance()).resolves.toBe(11);
  });

  /** `test_unsuccess_post_email` */
  it('test_unsuccess_post_email: a duplicate email is 409 (via the UNIQUE username)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJsonEmailR)
      .expect(409);

    expect(response.body).toEqual({ message: 'Identification/email already exists' });
    await expect(countUsers()).resolves.toBe(11);
    await expect(countFinance()).resolves.toBe(11);
  });

  it('POST /api/user is ADMIN-only — list_permissions["UserView"]["POST"] = 0', async () => {
    const memberToken = await obtainToken(app, members[0].email);
    await request(app.getHttpServer())
      .post('/api/user')
      .set(authHeader(memberToken))
      .send(objectJson)
      .expect(403);
  });

  // ==========================================================================
  // GET /api/user
  // ==========================================================================

  /** `test_get_users` */
  it('test_get_users: page 1 holds ten of eleven members', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/user?page=1')
      .set(asAdmin())
      .expect(200);

    const body = response.body as { list: Record<string, unknown>[]; num_pages: number };
    expect(body.list).toHaveLength(10);
    expect(body.num_pages).toBe(2);
    for (const user of body.list) {
      expect(user.id).not.toBeNull();
      expect(user.identification).not.toBeNull();
      expect(user.full_name).not.toBeNull();
      expect(user.email).not.toBeNull();
      expect(user.role).not.toBeNull();
    }
  });

  /** `test_get_users_all` — no `page` parameter at all. */
  it('test_get_users_all: no page parameter returns every member, with no envelope counters', async () => {
    const response = await request(app.getHttpServer()).get('/api/user').set(asAdmin()).expect(200);

    const body = response.body as Record<string, unknown>;
    expect(body.list).toHaveLength(11);
    expect(body).not.toHaveProperty('num_pages');
    expect(body).not.toHaveProperty('count');
  });

  /** `test_get_users_empty` */
  it('test_get_users_empty: a page past the last is 200 with an empty list', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/user?page=3')
      .set(asAdmin())
      .expect(200);

    expect(response.body).toEqual({ list: [], num_pages: 2, count: 11 });
  });

  /** `test_get_users_error_pagination` */
  it('test_get_users_error_pagination: page 0 is a 400 with v1’s message', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/user?page=0')
      .set(asAdmin())
      .expect(400);

    expect(response.body).toEqual({ message: 'Page number must be greater than 0' });
  });

  it('a non-numeric page is a 500, as `int("abc")` is in v1', async () => {
    await request(app.getHttpServer()).get('/api/user?page=abc').set(asAdmin()).expect(500);
  });

  it('only active members are listed — the soft delete hides them', async () => {
    await prisma.authUser.update({ where: { id: members[0].id }, data: { is_active: false } });

    const response = await request(app.getHttpServer()).get('/api/user').set(asAdmin()).expect(200);
    expect((response.body as { list: unknown[] }).list).toHaveLength(10);
  });

  // ==========================================================================
  // GET /api/user/<id>
  // ==========================================================================

  /** `test_get_user` */
  it('test_get_user: returns user, finance and preferences', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/user/${admin.id}`)
      .set(asAdmin())
      .expect(200);

    const body = response.body as {
      user: Record<string, unknown>;
      finance: Record<string, unknown>;
      preferences: Record<string, unknown>;
    };
    expect(body.user.id).toBe(admin.id);
    expect(body.user.identification).toBe(99999);
    expect(body.user.first_name).toBe('Foo Name');
    expect(body.user.last_name).toBe('Foo Last Name');
    expect(body.user.email).toBe('mail_for_tests@mail.com');
    expect(body.user.role).toBe(0);
    expect(body.user.role_display).toBe('ADMIN');
    expect(body.finance.contributions).toBe(2000);
    expect(body.finance.balance_contributions).toBe(2000);
    expect(body.finance.total_quota).toBe(1000);
    expect(body.finance.available_quota).toBe(500);
    expect(body.finance.utilized_quota).toBe(0);
    // ⚠️ `UserFullInfoSerializer` extends `Serializer`, so its inert `Meta.fields` does NOT
    // drop `preferences`. Reading Meta instead of the declared fields would lose these.
    expect(body.preferences).toEqual({
      notifications: false,
      primary_color: '#800000',
      secondary_color: '#c83737',
    });
  });

  it('the user object keeps DRF’s Meta.fields key order', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/user/${admin.id}`)
      .set(asAdmin())
      .expect(200);

    expect(Object.keys((response.body as { user: object }).user)).toEqual([
      'full_name',
      'identification',
      'email',
      'role_display',
      'id',
      'first_name',
      'last_name',
      'role',
      'birthdate',
    ]);
  });

  it('total_savingaccounts sums the member’s ACTIVE saving accounts only', async () => {
    await prisma.savingAccount.createMany({
      data: [
        { created_at: new Date(), end_date: new Date(), state: 0, value: 700n, user_id: admin.id },
        { created_at: new Date(), end_date: new Date(), state: 0, value: 300n, user_id: admin.id },
        { created_at: new Date(), end_date: new Date(), state: 1, value: 999n, user_id: admin.id },
      ],
    });

    const response = await request(app.getHttpServer())
      .get(`/api/user/${admin.id}`)
      .set(asAdmin())
      .expect(200);
    expect(
      (response.body as { finance: { total_savingaccounts: number } }).finance.total_savingaccounts,
    ).toBe(1000);
  });

  /** `test_get_session_user` — the `-1` sentinel. */
  it('test_get_session_user: GET /api/user/-1 is the caller', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/user/-1')
      .set(asAdmin())
      .expect(200);

    const body = response.body as { user: Record<string, unknown> };
    expect(body.user.id).toBe(admin.id);
    expect(body.user.identification).toBe(99999);
    expect(body.user.role_display).toBe('ADMIN');
  });

  /** `test_get_user_not_found` */
  it('test_get_user_not_found: an unknown id is a zero-byte 404', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/user/${missingId}`)
      .set(asAdmin())
      .expect(404);

    expect(response.text).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
  });

  // ==========================================================================
  // DELETE /api/user/<id>
  // ==========================================================================

  /** `test_delete_user` */
  it('test_delete_user: soft-deletes, then the member’s own token stops working', async () => {
    await request(app.getHttpServer()).delete(`/api/user/${missingId}`).set(asAdmin()).expect(404);

    await request(app.getHttpServer()).delete(`/api/user/${admin.id}`).set(asAdmin()).expect(200);

    const row = await prisma.authUser.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.is_active).toBe(false);

    // The token survives, but `TokenAuthGuard` refuses an inactive user.
    await request(app.getHttpServer()).get(`/api/user/${admin.id}`).set(asAdmin()).expect(401);

    // And a fresh login is refused too — v1's test asserts this by expecting a KeyError on
    // `response.data['token']`.
    const login = await request(app.getHttpServer())
      .post('/api-token-auth')
      .send({ username: 'mail_for_tests@mail.com', password: 'password' });
    expect(login.status).toBe(400);
    expect(login.body).not.toHaveProperty('token');
  });

  /** **D14** — the sentinel is refused on DELETE and only on DELETE. */
  it('D14: DELETE /api/user/-1 never means "me" — it 404s and the ADMIN stays active', async () => {
    await request(app.getHttpServer()).delete('/api/user/-1').set(asAdmin()).expect(404);

    const row = await prisma.authUser.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.is_active).toBe(true);
  });

  it('DELETE is ADMIN-only — list_permissions["UserDetailView"]["DELETE"] = 0', async () => {
    const memberToken = await obtainToken(app, members[0].email);
    await request(app.getHttpServer())
      .delete(`/api/user/${members[0].id}`)
      .set(authHeader(memberToken))
      .expect(403);
  });

  // ==========================================================================
  // PATCH /api/user/<id>
  // ==========================================================================

  /** `test_patch_user` */
  it('test_patch_user: updates the personal section (D15: username is left alone)', async () => {
    const body = { ...userUpdate(), type: 'personal' };

    await request(app.getHttpServer())
      .patch(`/api/user/${missingId}`)
      .set(asAdmin())
      .send(body)
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send(body)
      .expect(200);

    const row = await prisma.userProfile.findUniqueOrThrow({
      where: { user_ptr_id: admin.id },
      include: { auth_user: true },
    });
    expect(row.auth_user.first_name).toBe('Foo Name update');
    expect(row.auth_user.last_name).toBe('Last Name update');
    expect(row.auth_user.email).toBe('mail_updated@mail.com2');
    // ⚠️ **D15.** v1 asserts `user.username == 'mail_updated@mail.com2'`. v2 stops rewriting
    // the login name, so it is still the address the account was created with.
    expect(row.auth_user.username).toBe('mail_for_tests@mail.com');
    expect(row.birthdate?.toISOString().slice(0, 10)).toBe('1995-11-07');
  });

  /** `test_patch_user_finance` */
  it('test_patch_user_finance: writes the finance section and derives available_quota', async () => {
    const body = { ...userUpdate(), type: 'finance' };

    await request(app.getHttpServer())
      .patch(`/api/user/${missingId}`)
      .set(asAdmin())
      .send(body)
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send(body)
      .expect(200);

    const finance = await prisma.userFinance.findFirstOrThrow({ where: { user_id: admin.id } });
    expect(finance.contributions).toBe(2000n);
    expect(finance.balance_contributions).toBe(2000n);
    expect(finance.total_quota).toBe(1000n);
    expect(finance.utilized_quota).toBe(500n);
    expect(finance.available_quota).toBe(500n);
  });

  /** `test_patch_user_not_finance` — the "nothing changed, so nothing is written" branch. */
  it('test_patch_user_not_finance: an unchanged finance section is a no-op', async () => {
    const personal = { ...userUpdateSameFinance(), type: 'personal' };
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send(personal)
      .expect(200);

    const row = await prisma.userProfile.findUniqueOrThrow({
      where: { user_ptr_id: admin.id },
      include: { auth_user: true },
    });
    expect(row.auth_user.first_name).toBe('Foo Name update');
    expect(row.auth_user.email).toBe('mail_updated@mail.com2');

    const before = await prisma.userFinance.findFirstOrThrow({ where: { user_id: admin.id } });

    const finance = { ...userUpdateSameFinance(), type: 'finance' };
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send(finance)
      .expect(200);

    const after = await prisma.userFinance.findFirstOrThrow({ where: { user_id: admin.id } });
    expect(after.contributions).toBe(2000n);
    expect(after.balance_contributions).toBe(2000n);
    expect(after.total_quota).toBe(1000n);
    expect(after.utilized_quota).toBe(0n);
    // ⚠️ Still 500, not `total - utilized = 1000`: nothing changed, so nothing was recomputed.
    expect(after.available_quota).toBe(500n);
    // …and `last_modified` did not move either, which is what the monthly file relies on.
    expect(after.last_modified).toEqual(before.last_modified);
  });

  /** `test_patch_user_conflict` — split, because D15 changes one half of it. */
  it('test_patch_user_conflict: a duplicate identification is still 409', async () => {
    await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(201);

    const body = { ...userUpdateIdentificationR(), type: 'personal' };
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send(body)
      .expect(409);
  });

  it('test_patch_user_conflict: **D15** — a duplicate email is no longer 409', async () => {
    await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(201);

    const body = { ...userUpdateEmailR(), type: 'personal' };
    // ⚠️ v1 answers **409** here, because it writes `user.username = obj['email']` into a
    // UNIQUE column. That is the same defect that makes any personal edit to live users 13 and
    // 14 a bare 409. v2 does not write `username`, so the edit succeeds and `auth_user.email`
    // — which has no unique constraint — simply holds the duplicate.
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send(body)
      .expect(200);

    const row = await prisma.authUser.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.email).toBe('mail@mail.com');
    expect(row.username).toBe('mail_for_tests@mail.com');
  });

  /** `test_patch_preferences_not_found` */
  it('test_patch_preferences_not_found: an unknown id is 404', async () => {
    await request(app.getHttpServer())
      .patch(`/api/user/${missingId}`)
      .set(asAdmin())
      .send({ type: 'preferences', preferences: { notifications: true } })
      .expect(404);
  });

  /** `test_patch_preferences_notifications` */
  it('test_patch_preferences_notifications: toggles the flag both ways', async () => {
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send({
        type: 'preferences',
        preferences: { notifications: true, primary_color: '#fff', secondary_color: '#000' },
      })
      .expect(200);

    let preference = await prisma.userPreference.findFirstOrThrow({ where: { user_id: admin.id } });
    expect(preference.notifications).toBe(true);
    expect(preference.primary_color).toBe('#fff');
    expect(preference.secondary_color).toBe('#000');

    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send({
        type: 'preferences',
        preferences: { notifications: false, primary_color: '#fff', secondary_color: '#000' },
      })
      .expect(200);

    preference = await prisma.userPreference.findFirstOrThrow({ where: { user_id: admin.id } });
    expect(preference.notifications).toBe(false);
  });

  /**
   * **F5 / P2-D4 corrected** — `remove_all_subscriptions` is live code, wired here.
   * `services/user.py:217-218` fires it **only** on the `true → false` transition.
   */
  it('wipes every push subscription on the notifications true → false transition only', async () => {
    const removeAll = jest.spyOn(notifications, 'removeAllSubscriptions');
    const preferences = {
      notifications: true,
      primary_color: '#fff',
      secondary_color: '#000',
    };
    const patch = (notificationsOn: boolean): request.Test =>
      request(app.getHttpServer())
        .patch(`/api/user/${admin.id}`)
        .set(asAdmin())
        .send({
          type: 'preferences',
          preferences: { ...preferences, notifications: notificationsOn },
        });

    await patch(true).expect(200);
    expect(removeAll).not.toHaveBeenCalled();

    // false -> false: no transition, no wipe.
    await patch(false).expect(200);
    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(removeAll).toHaveBeenCalledWith(admin.id);

    removeAll.mockClear();
    await patch(false).expect(200);
    expect(removeAll).not.toHaveBeenCalled();
    removeAll.mockRestore();
  });

  it('a preferences body missing a colour is a 404, because v1 catches everything', async () => {
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send({ type: 'preferences', preferences: { notifications: true } })
      .expect(404);
  });

  it('an unrecognised `type` falls through to preferences, as v1 does', async () => {
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send({
        type: 'banana',
        preferences: { notifications: true, primary_color: '#111', secondary_color: '#222' },
      })
      .expect(200);

    const preference = await prisma.userPreference.findFirstOrThrow({
      where: { user_id: admin.id },
    });
    expect(preference.primary_color).toBe('#111');
  });

  it('a body with no `type` is a 500 — `obj["type"]` is an uncaught KeyError', async () => {
    await request(app.getHttpServer())
      .patch(`/api/user/${admin.id}`)
      .set(asAdmin())
      .send({ personal: {} })
      .expect(500);
  });

  // ==========================================================================
  // D1 — the authorisation rule (no v1 counterpart; v1 has no check at all)
  // ==========================================================================

  describe('D1 — PATCH authorisation', () => {
    let memberToken: string;
    let member: SeededUser;

    beforeEach(async () => {
      member = await seedUser(prisma, {
        email: 'plain.member@mail.com',
        identification: 500001n,
        role: Role.MEMBER,
      });
      memberToken = await obtainToken(app, member.email);
    });

    const personalBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: 'personal',
      personal: {
        first_name: 'Foo Name',
        last_name: 'Foo Last Name',
        email: 'plain.member@mail.com',
        identification: 500001,
        role: Role.MEMBER,
        ...overrides,
      },
      // v1's client posts the finance block on every save. It must be **invisible** here.
      finance: {
        contributions: 2000,
        balance_contributions: 2000,
        total_quota: 999999,
        utilized_quota: 0,
      },
    });

    it('lets a member save their own profile while echoing role, identification and finance', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .send(personalBody({ first_name: 'Renamed' }))
        .expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: member.id },
        include: { auth_user: true },
      });
      expect(row.auth_user.first_name).toBe('Renamed');
      // The declared section was `personal`, so the finance block was ignored entirely.
      const finance = await prisma.userFinance.findFirstOrThrow({ where: { user_id: member.id } });
      expect(finance.total_quota).toBe(1000n);
    });

    it('403s a member who actually changes their own role — the escalation D1 closes', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .send(personalBody({ role: Role.ADMIN }))
        .expect(403);

      const row = await prisma.userProfile.findUniqueOrThrow({ where: { user_ptr_id: member.id } });
      expect(row.role).toBe(Role.MEMBER);
    });

    /**
     * **C37 (m5)** — the status alone is not the assertion. A 403 that nevertheless wrote the
     * column is exactly the failure D16 exists to prevent, and it would have been green here
     * until the row check below was added. The `role` cell above is the model.
     */
    it('D16/Q26: 403s a member who changes their own identification, and does not write it', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .send(personalBody({ identification: 500002 }))
        .expect(403);

      const row = await prisma.userProfile.findUniqueOrThrow({ where: { user_ptr_id: member.id } });
      expect(row.identification).toBe(500001n);
    });

    /**
     * **C37 (m5)** — the positive control for D16. Without it, "identification is never
     * writable by anyone" would be indistinguishable from a correct policy, and the cell above
     * would still pass if the column had simply become read-only for everybody.
     */
    it('D16 positive control: an ADMIN changes another member’s identification and the row moves', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(asAdmin())
        .send(personalBody({ identification: 500002 }))
        .expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({ where: { user_ptr_id: member.id } });
      expect(row.identification).toBe(500002n);
    });

    /**
     * **C37 (m5)** — the control that keeps the pair honest: the *same* body, from the two
     * roles, in one cell. If the D16 gate ever stopped distinguishing ADMIN from member — in
     * either direction — one of these two halves fails.
     */
    it('D16: the identical body is a 403 from the member and a 200 from the ADMIN', async () => {
      const body = personalBody({ identification: 500003 });

      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .send(body)
        .expect(403);
      await expect(
        prisma.userProfile
          .findUniqueOrThrow({ where: { user_ptr_id: member.id } })
          .then((row) => row.identification),
      ).resolves.toBe(500001n);

      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(asAdmin())
        .send(body)
        .expect(200);
      await expect(
        prisma.userProfile
          .findUniqueOrThrow({ where: { user_ptr_id: member.id } })
          .then((row) => row.identification),
      ).resolves.toBe(500003n);
    });

    /**
     * **C37 (§4 item 5)** — `email` is in the `personal` section's writable set and **D16
     * deliberately does not guard it**: a member changing their own address is ordinary
     * self-service. Unmeasured until now, and it is the write that makes M5 (and therefore
     * C32) reachable — D15 no longer moves `username` with it, so this row's `username` and
     * `email` diverge here, permanently.
     */
    it('C37: a member changes their own email, and D15 leaves the username behind', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .send(personalBody({ email: 'moved.member@mail.com' }))
        .expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: member.id },
        include: { auth_user: true },
      });
      expect(row.auth_user.email).toBe('moved.member@mail.com');
      // D15: the login credential is *not* rotated silently. This is the divergence that
      // gives D17 nothing to match, which is what C32's fallback answers.
      expect(row.auth_user.username).toBe('plain.member@mail.com');
      expect(row.identification).toBe(500001n);
    });

    it('403s a member editing somebody else’s personal section', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${members[0].id}`)
        .set(authHeader(memberToken))
        .send(personalBody())
        .expect(403);
    });

    it('403s a declared finance write by a member — even an empty or unchanged one', async () => {
      for (const finance of [
        {},
        { contributions: 2000, balance_contributions: 2000, total_quota: 1000, utilized_quota: 0 },
      ]) {
        await request(app.getHttpServer())
          .patch(`/api/user/${member.id}`)
          .set(authHeader(memberToken))
          .send({ type: 'finance', finance })
          .expect(403);
      }
    });

    it('403s a finance write by a PRESIDENT, on their own row', async () => {
      const president = await seedUser(prisma, {
        email: 'president@mail.com',
        identification: 500009n,
        role: Role.PRESIDENT,
      });
      const presidentToken = await obtainToken(app, president.email);

      await request(app.getHttpServer())
        .patch(`/api/user/${president.id}`)
        .set(authHeader(presidentToken))
        .send({
          type: 'finance',
          finance: {
            contributions: 1,
            balance_contributions: 1,
            total_quota: 1,
            utilized_quota: 0,
          },
        })
        .expect(403);
    });

    it('lets a TREASURER write anybody’s finance section', async () => {
      const treasurerToken = await obtainToken(app, members[0].email);
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(treasurerToken))
        .send({
          type: 'finance',
          finance: {
            contributions: 10,
            balance_contributions: 20,
            total_quota: 30,
            utilized_quota: 5,
          },
        })
        .expect(200);

      const finance = await prisma.userFinance.findFirstOrThrow({ where: { user_id: member.id } });
      expect(finance.total_quota).toBe(30n);
      expect(finance.available_quota).toBe(25n);
    });

    /**
     * ⚠️ **The m6 cell, carried deliberately (C37 §4 item 3).** `canWriteSection` allows the
     * `finance` section to `[ADMIN, TREASURER]` on **any** target, self included, which is
     * exactly what the §5 **D1** table states. The tension the reviewer raised is with **Q12**
     * ("quota comes exclusively from the treasurer's monthly file"): a treasurer may set their
     * own `available_quota` between uploads and borrow against it.
     *
     * Operator **Q31/Q12** settled it — this is accepted fund practice, the treasurer is
     * already trusted with everyone else's quota, and **D28 was withdrawn** on the identical
     * question for loans. So this cell asserts the exposure so a future reader finds a
     * decision rather than an oversight: **if it ever starts failing, that is a *policy*
     * change and needs an operator, not a fix.** The loan twin is
     * `test/loan.e2e-spec.ts` — "D28 (WITHDRAWN, Q31): a TREASURER may approve their own loan".
     */
    it('m6 (Q31/Q12): a TREASURER may write their OWN finance section — accepted, not a bug', async () => {
      const treasurer = members[0];
      const treasurerToken = await obtainToken(app, treasurer.email);

      await request(app.getHttpServer())
        .patch(`/api/user/${treasurer.id}`)
        .set(authHeader(treasurerToken))
        .send({
          type: 'finance',
          finance: {
            contributions: 11,
            balance_contributions: 22,
            total_quota: 33,
            utilized_quota: 3,
          },
        })
        .expect(200);

      const finance = await prisma.userFinance.findFirstOrThrow({
        where: { user_id: treasurer.id },
      });
      expect(finance.total_quota).toBe(33n);
      expect(finance.utilized_quota).toBe(3n);
      expect(finance.available_quota).toBe(30n);
    });

    it('lets a TREASURER keep self-service on their own personal section', async () => {
      const treasurer = members[0];
      const treasurerToken = await obtainToken(app, treasurer.email);
      await request(app.getHttpServer())
        .patch(`/api/user/${treasurer.id}`)
        .set(authHeader(treasurerToken))
        .send({
          type: 'personal',
          personal: {
            first_name: 'Tesorero',
            last_name: 'Foo Last Name',
            email: treasurer.email,
            identification: Number(treasurer.identification),
            role: Role.TREASURER,
          },
        })
        .expect(200);
    });

    it('403s a TREASURER editing another member’s personal section', async () => {
      const treasurerToken = await obtainToken(app, members[0].email);
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(treasurerToken))
        .send(personalBody())
        .expect(403);
    });

    it('lets an ADMIN change a role, and only an ADMIN', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(asAdmin())
        .send(personalBody({ role: Role.TREASURER }))
        .expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({ where: { user_ptr_id: member.id } });
      expect(row.role).toBe(Role.TREASURER);
    });

    /** **D14** — PATCH adopts the sentinel; v1 404s it unconditionally. */
    it('D14: PATCH /api/user/-1 edits the caller instead of 404ing', async () => {
      await request(app.getHttpServer())
        .patch('/api/user/-1')
        .set(authHeader(memberToken))
        .send(personalBody({ first_name: 'Yo Mismo' }))
        .expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: member.id },
        include: { auth_user: true },
      });
      expect(row.auth_user.first_name).toBe('Yo Mismo');
    });

    it('the 403 body is DRF’s generic one, indistinguishable from a role denial', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .send(personalBody({ role: Role.ADMIN }))
        .expect(403);

      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
    });
  });

  // ==========================================================================
  // D19 / D20 — the birthdate notification
  // ==========================================================================

  describe('the birthdate SchedulerTask (D19, D20, Phase 7a)', () => {
    const patchBirthdate = (id: number, birthdate: string): request.Test =>
      request(app.getHttpServer())
        .patch(`/api/user/${id}`)
        .set(asAdmin())
        .send({
          type: 'personal',
          personal: {
            first_name: 'Foo Name',
            last_name: 'Foo Last Name',
            email: `member${id}@mail.com`,
            identification: 900000 + id,
            role: Role.MEMBER,
            birthdate,
          },
        });

    it('writes one YEARLY task carrying every *other* active member', async () => {
      await patchBirthdate(members[0].id, '1995-11-07').expect(200);

      const tasks = await prisma.schedulerTask.findMany();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].repeat).toBe(4);
      expect(tasks[0].type).toBe(0);
      expect(tasks[0].processed).toBe(false);

      const [row] = await prisma.$queryRaw<{ payload: string }[]>`
        SELECT payload::text AS payload FROM fondo_api_schedulertask
      `;
      expect(row.payload).toContain('"type"=>"birthdate"');
      expect(row.payload).toContain(`"owner_id"=>"${members[0].id}"`);
      expect(row.payload).toContain('"message"=>"Hoy está cumpliendo años Foo Name Foo Last Name"');
      expect(row.payload).toContain('"target"=>"/"');
      // Ten of the eleven active members: the owner is removed from the list.
      const ids = /"user_ids"=>"\[([^\]]*)\]"/.exec(row.payload)?.[1] ?? '';
      const parsed = ids.split(', ').map(Number);
      expect(parsed).toHaveLength(10);
      expect(parsed).not.toContain(members[0].id);
    });

    it('replaces the task when the birthdate changes, rather than accumulating', async () => {
      await patchBirthdate(members[0].id, '1995-11-07').expect(200);
      await patchBirthdate(members[0].id, '1990-01-02').expect(200);

      await expect(prisma.schedulerTask.count()).resolves.toBe(1);
      const [row] = await prisma.$queryRaw<{ run_date: Date }[]>`
        SELECT run_date FROM fondo_api_schedulertask
      `;
      expect(row.run_date.toISOString().slice(5, 10)).toBe('01-02');
    });

    /**
     * **D20, live today.** `get_users_attr("id")` filters `is_active=True`, so
     * `user_ids.remove(user.id)` raises `ValueError` for a soft-deleted member — a 500 that
     * rolls the whole edit back. `fondodev` has two inactive users.
     */
    it('D20: editing a soft-deleted member succeeds instead of 500ing', async () => {
      await prisma.authUser.update({ where: { id: members[1].id }, data: { is_active: false } });

      await patchBirthdate(members[1].id, '1980-03-04').expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: members[1].id },
      });
      expect(row.birthdate?.toISOString().slice(0, 10)).toBe('1980-03-04');

      const [task] = await prisma.$queryRaw<{ payload: string }[]>`
        SELECT payload::text AS payload FROM fondo_api_schedulertask
      `;
      // Ten active members remain, and the inactive owner was never in the list to remove.
      const ids = /"user_ids"=>"\[([^\]]*)\]"/.exec(task.payload)?.[1] ?? '';
      expect(ids.split(', ')).toHaveLength(10);
    });

    /**
     * **D19, latent.** `date(2000, 2, 29).replace(year=<non-leap>)` raises `ValueError` in v1,
     * 500s and rolls the edit back. v2 clamps to 28 February — where `relativedelta(years=+1)`
     * puts it, so the first task agrees with every yearly clone of itself.
     */
    it('D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year', async () => {
      await patchBirthdate(members[2].id, '2000-02-29').expect(200);

      const [row] = await prisma.$queryRaw<{ run_date: Date }[]>`
        SELECT run_date FROM fondo_api_schedulertask
      `;
      const year = new Date().getFullYear();
      const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      expect(row.run_date.toISOString().slice(5, 10)).toBe(isLeap ? '02-29' : '02-28');
    });

    it('a personal update without a birthdate key writes no task at all', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${members[3].id}`)
        .set(asAdmin())
        .send({
          type: 'personal',
          personal: {
            first_name: 'Sin',
            last_name: 'Cumple',
            email: members[3].email,
            identification: Number(members[3].identification),
            role: Role.TREASURER,
          },
        })
        .expect(200);

      await expect(prisma.schedulerTask.count()).resolves.toBe(0);
    });

    it('a malformed birthdate is a 500 and rolls the whole edit back', async () => {
      await patchBirthdate(members[4].id, '07/11/1995').expect(500);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: members[4].id },
        include: { auth_user: true },
      });
      expect(row.birthdate).toBeNull();
      expect(row.auth_user.first_name).toBe('Foo Name');
      await expect(prisma.schedulerTask.count()).resolves.toBe(0);
    });
  });

  // ==========================================================================
  // POST /api/user/activate/<id>
  // ==========================================================================

  const createAndFetch = async (): Promise<{ id: number; key: string }> => {
    await request(app.getHttpServer())
      .post('/api/user')
      .set(asAdmin())
      .send(objectJson)
      .expect(201);
    const created = await prisma.userProfile.findFirstOrThrow({ where: { identification: 123n } });
    return { id: created.user_ptr_id, key: created.key_activation as string };
  };

  /** `test_activation_successful` */
  it('test_activation_successful: sets the password, activates and clears the key', async () => {
    const { id, key } = await createAndFetch();

    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ password: 'newPassword123', identification: 123, key })
      .expect(200);

    const row = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    expect(row.auth_user.is_active).toBe(true);
    expect(row.auth_user.password).toContain('pbkdf2_sha256');
    expect(row.key_activation).toBeNull();

    // …and the member can now actually log in.
    await request(app.getHttpServer())
      .post('/api-token-auth')
      .send({ username: 'mail@mail.com', password: 'newPassword123' })
      .expect(200);
  });

  it('the activation route is public — no Authorization header needed', async () => {
    const { id, key } = await createAndFetch();
    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ password: 'newPassword123', identification: 123, key })
      .expect(200);
  });

  /** `test_activation_unsuccessful_1` — wrong identification. */
  it('test_activation_unsuccessful_1: a mismatched identification is 404', async () => {
    const { id, key } = await createAndFetch();

    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ password: 'newPassword123', identification: 1234, key })
      .expect(404);

    const row = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    expect(row.auth_user.is_active).toBe(false);
    expect(row.auth_user.password).not.toContain('pbkdf2_sha256');
    expect(row.key_activation).not.toBeNull();
  });

  /** `test_activation_unsuccessful_2` — empty key. */
  it('test_activation_unsuccessful_2: an empty key is 404 before any query', async () => {
    const { id } = await createAndFetch();

    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ password: 'newPassword123', identification: 1234, key: '' })
      .expect(404);

    const row = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    expect(row.auth_user.is_active).toBe(false);
    expect(row.key_activation).not.toBeNull();
  });

  /** `test_activation_unsuccessful_3` — no key at all. */
  it('test_activation_unsuccessful_3: a missing key is 404', async () => {
    const { id } = await createAndFetch();

    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ password: 'newPassword123', identification: 1234 })
      .expect(404);

    const row = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    expect(row.auth_user.is_active).toBe(false);
  });

  /**
   * **C37 (m7)** — implemented, documented in `docs/phase-3-deviations.md` §2.9, and never
   * measured: `docs/parity-phase-3.md` §11 records that the round had no disposable user left.
   *
   * `set_password(None)` in Django stores an **unusable** password (`!` + 40 random chars),
   * so `{"password": null}` on this **public, unauthenticated** endpoint activates the account
   * and burns the `key_activation` while leaving nobody able to log in. Reproduced from v1
   * deliberately — a client doing this in v1 gets the same silent outcome — but it is an
   * account-taking-over route, so the outcome is pinned here rather than trusted.
   */
  it('C37: `"password": null` activates the account with an unusable password', async () => {
    const { id, key } = await createAndFetch();

    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ password: null, identification: 123, key })
      .expect(200);

    const row = await prisma.userProfile.findFirstOrThrow({
      where: { identification: 123n },
      include: { auth_user: true },
    });
    expect(row.auth_user.is_active).toBe(true);
    expect(row.key_activation).toBeNull();
    // `UNUSABLE_PASSWORD_PREFIX` + 40 chars, and emphatically not a usable hash.
    expect(row.auth_user.password.startsWith('!')).toBe(true);
    expect(row.auth_user.password).not.toContain('pbkdf2_sha256');
    expect(row.auth_user.password).toHaveLength(41);

    // The account is active and unreachable: no password logs in, including the empty one.
    for (const password of ['', 'newPassword123', row.auth_user.password]) {
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: 'mail@mail.com', password })
        .expect(400);
    }
  });

  it('a missing password is a 500 — it is read outside v1’s try block', async () => {
    const { id, key } = await createAndFetch();
    await request(app.getHttpServer())
      .post(`/api/user/activate/${id}`)
      .send({ identification: 123, key })
      .expect(500);
  });

  it('GET on the activation route is DRF’s 405 — the only /api/user route where it is reachable', async () => {
    const response = await request(app.getHttpServer()).get('/api/user/activate/1').expect(405);
    expect(response.body).toEqual({ detail: 'Method "GET" not allowed.' });
    expect(response.headers.allow).toBe('POST, OPTIONS');
  });

  /**
   * Parity finding **F4**, the Phase 3 half. `OPTIONS` is reachable here for the same reason
   * the 405 is: `permission_classes = []`, so `APIRolePermission` never gets to deny it.
   * Body captured from the live v1.
   */
  describe('F4 — OPTIONS on the activation route is DRF’s metadata document', () => {
    it('answers 200 with the 172-byte document', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/user/activate/1')
        .expect(200);

      expect(response.text).toBe(
        '{"name":"User Activate","description":"","renders":["application/json","text/html"],' +
          '"parses":["application/json","application/x-www-form-urlencoded","multipart/form-data"]}',
      );
      expect(response.headers['content-length']).toBe('172');
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.headers.vary).toBe('Accept, Origin');
    });

    it('does not depend on the id existing — no row is read', async () => {
      await request(app.getHttpServer()).options('/api/user/activate/999999').expect(200);
    });

    it('401s OPTIONS carrying a broken token, as DRF authenticates first', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/user/activate/1')
        .set('Authorization', `Token ${'0'.repeat(40)}`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'Invalid token.' });
    });

    it('leaves a GUARDED view’s OPTIONS a 403 — list_permissions has no OPTIONS key', async () => {
      // The control: v1 denies `OPTIONS` on every guarded view for every role, ADMIN
      // included, through `APIRolePermission`'s bare `except`. F4 must not have widened that.
      const response = await request(app.getHttpServer()).options('/api/user/power').set(asAdmin());

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
    });
  });

  // ==========================================================================
  // PATCH /api/user — the monthly TSV
  // ==========================================================================

  /** `test_bulk_update_users` */
  it('test_bulk_update_users: applies the TSV and skips unknown identifications', async () => {
    // v1 creates three users with identification 1, 2, 3; the file also carries a fourth line
    // for identification 4, which exists in no row and must be logged and skipped.
    const created: SeededUser[] = [];
    for (let i = 1; i <= 3; i += 1) {
      created.push(
        await seedUser(prisma, {
          email: `mail${i}@mail.com`,
          identification: BigInt(i),
          role: Role.MEMBER,
        }),
      );
      await prisma.userFinance.updateMany({
        where: { user_id: created[i - 1].id },
        data: {
          contributions: 0n,
          balance_contributions: 0n,
          total_quota: 0n,
          available_quota: 0n,
          utilized_quota: 0n,
        },
      });
    }

    const tsv =
      '1\t100\t1000\t200\t300\r\n' +
      '2\t400\t1000\t500\t600\r\n' +
      '3\t700\t1000\t800\t900\r\n' +
      '4\t0\t0\t0\t0\r\n';

    const response = await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      .attach('file', Buffer.from(tsv, 'utf8'), 'testfile.txt')
      .expect(200);
    expect(response.text).toBe('');

    const expected = [
      { balance: 100n, total: 1000n, contributions: 200n, utilized: 300n, available: 700n },
      { balance: 400n, total: 1000n, contributions: 500n, utilized: 600n, available: 400n },
      { balance: 700n, total: 1000n, contributions: 800n, utilized: 900n, available: 100n },
    ];
    for (const [index, want] of expected.entries()) {
      const finance = await prisma.userFinance.findFirstOrThrow({
        where: { user_id: created[index].id },
      });
      expect(finance.balance_contributions).toBe(want.balance);
      expect(finance.total_quota).toBe(want.total);
      expect(finance.contributions).toBe(want.contributions);
      expect(finance.utilized_quota).toBe(want.utilized);
      expect(finance.available_quota).toBe(want.available);
    }
  });

  it('the TSV column order is identification, balance, TOTAL QUOTA, contributions, utilized', async () => {
    const target = await seedUser(prisma, {
      email: 'tsv.order@mail.com',
      identification: 777n,
      role: Role.MEMBER,
    });

    await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      .attach('file', Buffer.from('777\t11\t22\t33\t44\n', 'utf8'), 'f.txt')
      .expect(200);

    const finance = await prisma.userFinance.findFirstOrThrow({ where: { user_id: target.id } });
    expect(finance.balance_contributions).toBe(11n);
    expect(finance.total_quota).toBe(22n);
    expect(finance.contributions).toBe(33n);
    expect(finance.utilized_quota).toBe(44n);
  });

  it('rounds each column half-even, as CPython’s round() does', async () => {
    const target = await seedUser(prisma, {
      email: 'tsv.round@mail.com',
      identification: 778n,
      role: Role.MEMBER,
    });

    await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      // 0.5 -> 0 and 1.5 -> 2 under banker's rounding; Math.round would give 1 and 2.
      .attach('file', Buffer.from('778\t0.5\t1.5\t2.5\t3.5\n', 'utf8'), 'f.txt')
      .expect(200);

    const finance = await prisma.userFinance.findFirstOrThrow({ where: { user_id: target.id } });
    expect(finance.balance_contributions).toBe(0n);
    expect(finance.total_quota).toBe(2n);
    expect(finance.contributions).toBe(2n);
    expect(finance.utilized_quota).toBe(4n);
  });

  it('discards the whole upload when a line is malformed — @transaction.atomic', async () => {
    const target = await seedUser(prisma, {
      email: 'tsv.bad@mail.com',
      identification: 779n,
      role: Role.MEMBER,
    });

    await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      .attach('file', Buffer.from('779\t1\t2\t3\t4\nnonsense\n', 'utf8'), 'f.txt')
      .expect(500);

    const finance = await prisma.userFinance.findFirstOrThrow({ where: { user_id: target.id } });
    expect(finance.total_quota).toBe(1000n);
  });

  /**
   * ⚠️ Measured on the live v1: **500**, not 415. `@parser_classes((MultiPartParser,))` on a
   * *method* of an `APIView` is a no-op — the decorator is for function-based views — so the
   * default parsers apply, the JSON body parses to `{}` and `obj['file']` raises `KeyError`.
   * An earlier v2 revision answered 415 here and was wrong.
   */
  it('is a 500 for a JSON body — the MultiPartParser decorator is a no-op in v1', async () => {
    await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      .send({ file: 'x' })
      .expect(500);
  });

  it('is a 500 for a multipart body with no `file` part — the same KeyError', async () => {
    await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      .field('notfile', 'x')
      .expect(500);
  });

  it('is a 415 for text/plain — that one IS outside the default parser list', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/user')
      .set(asAdmin())
      .set('Content-Type', 'text/plain')
      .send('1\t1\t1\t1\t1')
      .expect(415);

    expect(response.body).toEqual({
      detail: 'Unsupported media type "text/plain" in request.',
    });
  });

  it('is [0, 2] — a MEMBER may not upload the monthly file', async () => {
    const member = await seedUser(prisma, {
      email: 'bulk.member@mail.com',
      identification: 500100n,
      role: Role.MEMBER,
    });
    const memberToken = await obtainToken(app, member.email);

    await request(app.getHttpServer())
      .patch('/api/user')
      .set(authHeader(memberToken))
      .attach('file', Buffer.from('1\t1\t1\t1\t1\n', 'utf8'), 'f.txt')
      .expect(403);
  });

  // ==========================================================================
  // POST /api/user/<app>
  // ==========================================================================

  /** `test_user_apps_not_found` */
  it('test_user_apps_not_found: an unknown app is 404', async () => {
    await request(app.getHttpServer()).post('/api/user/noexist').set(asAdmin()).expect(404);
  });

  /** `test_get_users_birthdate` */
  it('test_get_users_birthdate: returns every active member’s birthdate', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user/birthdates')
      .set(asAdmin())
      .expect(200);

    const body = response.body as { birthdate: string | null; full_name: string }[];
    expect(body).toHaveLength(11);
    for (const entry of body) {
      expect(entry.birthdate).toBeNull();
      expect(entry.full_name).toBe('Foo Name Foo Last Name');
    }
  });

  it('the birthdates branch never reads the body, so any Content-Type works (C10)', async () => {
    await request(app.getHttpServer())
      .post('/api/user/birthdates')
      .set(asAdmin())
      .set('Content-Type', 'text/plain')
      .send('not json at all')
      .expect(200);
  });

  it('the power branch DOES read the body, and v1 swallows the 415 into a 500', async () => {
    // `request.data` is evaluated inside `UserAppsView.post`'s `try`, so DRF's
    // `UnsupportedMediaType` is caught by `except Exception` and reported as a 500.
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .set('Content-Type', 'text/plain')
      .send('not json at all')
      .expect(500);
    expect(response.text).toBe('');
  });

  // ==========================================================================
  // Powers of attorney
  // ==========================================================================

  /** `test_get_powers_exception` — a missing `obj` key. */
  it('test_get_powers_exception: a missing `obj` is a zero-byte 500', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'get', page: 2 })
      .expect(500);

    expect(response.text).toBe('');
  });

  /**
   * Parity finding **F1**. `UserAppsView.post`'s `except Exception: return Response(status=500)`
   * is a **DRF** response, so `finalize_response` puts the view's `default_response_headers`
   * on it. Measured on the live v1 (`api.settings.production`, gunicorn):
   *
   * ```
   * HTTP/1.1 500 Internal Server Error
   * Vary: Accept, Origin
   * Allow: POST, OPTIONS
   * Content-Length: 0
   * ```
   *
   * v2 used to strip both headers off every 500, which is right only for the *uncaught* kind
   * (`GET /api/user?page=abc`, asserted below). Every input that reaches this `except` is
   * covered by one of the seven cells the tester listed; three of them are asserted here.
   */
  describe('F1 — the caught 500 keeps Allow and Vary: Accept', () => {
    it.each([
      ['a page below 1 (Paginator.EmptyPage)', { type: 'get', obj: 'requested', page: 0 }],
      ['a missing `page`', { type: 'get', obj: 'requested' }],
      ['a missing `type`', { obj: 'requested', page: 1 }],
    ])('%s', async (_case, body) => {
      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send(body)
        .expect(500);

      expect(response.text).toBe('');
      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.headers.vary).toBe('Accept, Origin');
      // Still the zero-byte DRF body, so still no Content-Type (P3-D6's other half).
      expect(response.headers['content-type']).toBeUndefined();
    });

    it('still strips them from an uncaught 500 — Django threw that response away', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/user?page=abc')
        .set(asAdmin())
        .expect(500);

      expect(response.headers.allow).toBeUndefined();
      expect(response.headers.vary).toBe('Origin');
    });

    it('keeps them on the 500 that swallowed DRF’s 415, too', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .set('Content-Type', 'text/plain')
        .send('not json at all')
        .expect(500);

      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.headers.vary).toBe('Accept, Origin');
    });
  });

  /** `test_get_powers_empty` */
  it('test_get_powers_empty: an empty page 2 still reports num_pages 1', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'get', page: 2, obj: 'requestee' })
      .expect(200);

    expect(response.body).toEqual({ list: [], num_pages: 1, count: 0 });
  });

  /** `test_post_power` */
  it('test_post_power: creates the request and answers 200 with an empty body', async () => {
    await expect(prisma.power.count()).resolves.toBe(0);
    const requestee = members[0];

    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'post', meeting_date: '2020-01-01', requestee: requestee.id })
      .expect(200);

    // v1: `self.assertEqual(response.data, None)` — DRF renders `None` as zero bytes.
    expect(response.text).toBe('');
    const powers = await prisma.power.findMany();
    expect(powers).toHaveLength(1);
    expect(powers[0].state).toBe(0);
    expect(powers[0].requester_id).toBe(admin.id);
    expect(powers[0].requestee_id).toBe(requestee.id);
    expect(powers[0].meeting_date.toISOString().slice(0, 10)).toBe('2020-01-01');
  });

  /** `test_get_powers_pagination` */
  it('test_get_powers_pagination: eleven requests paginate ten and two pages', async () => {
    const requestee = members[0];
    for (let i = 0; i < 11; i += 1) {
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'post', meeting_date: '2020-01-01', requestee: requestee.id })
        .expect(200);
    }

    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'get', page: 1, obj: 'requested' })
      .expect(200);

    const body = response.body as { list: Record<string, unknown>[]; num_pages: number };
    expect(body.list).toHaveLength(10);
    expect(body.num_pages).toBe(2);
    // `order_by('-id')`, and `PowerSerializer` renders `meeting_date` as ISO, not Spanish.
    expect(body.list[0].meeting_date).toBe('2020-01-01');
    expect(body.list[0].requester).toBe('Foo Name Foo Last Name');
    expect(Object.keys(body.list[0])).toEqual([
      'id',
      'state',
      'meeting_date',
      'requestee',
      'requester',
    ]);
  });

  /** `test_patch_power_denied` — **D2** changes who may do this. */
  it('test_patch_power_denied: only the requestee may reject (D2)', async () => {
    const requestee = members[0];
    await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'post', meeting_date: '2020-01-01', requestee: requestee.id })
      .expect(200);
    const power = await prisma.power.findFirstOrThrow();

    // ⚠️ v1 lets the **requester** (here the ADMIN) reject its own request — no ownership
    // check at all. D2/Q17 restricts it to the requestee.
    await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'patch', id: power.id, state: 2 })
      .expect(403);

    const requesteeToken = await obtainToken(app, requestee.email);
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(authHeader(requesteeToken))
      .send({ type: 'patch', id: power.id, state: 2 })
      .expect(200);

    expect(response.text).toBe('');
    await expect(
      prisma.power.findUniqueOrThrow({ where: { id: power.id } }).then((row) => row.state),
    ).resolves.toBe(2);
    expect(sendMail).not.toHaveBeenCalled();
  });

  /** `test_patch_power_approved` — **D2** and **D5**. */
  it('test_patch_power_approved: the requestee approves, and the letter fans out blind (D5)', async () => {
    const requestee = members[0];
    await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'post', meeting_date: '2020-01-01', requestee: requestee.id })
      .expect(200);
    const power = await prisma.power.findFirstOrThrow();

    const requesteeToken = await obtainToken(app, requestee.email);
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(authHeader(requesteeToken))
      .send({ type: 'patch', id: power.id, state: 1 })
      .expect(200);

    expect(response.text).toBe('');
    await expect(
      prisma.power.findUniqueOrThrow({ where: { id: power.id } }).then((row) => row.state),
    ).resolves.toBe(1);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [template, recipients, params, bcc] = sendMail.mock.calls[0] as [
      EmailTemplate,
      string[],
      Record<string, unknown>,
      string[],
    ];
    expect(template).toBe(EmailTemplate.POWER_APPROVED);
    // ⚠️ **D5.** v1 passes every member's address as `recipients` with an empty `bcc`,
    // disclosing all of them to all of them. v2 inverts it.
    expect(recipients).toEqual([]);
    expect(bcc).toHaveLength(11);
    expect(bcc).toContain('mail_for_tests@mail.com');
    expect(params).toEqual({
      requester_full_name: 'Foo Name Foo Last Name',
      requester_identification: 99999n,
      requestee_full_name: 'Foo Name Foo Last Name',
      requestee_identification: 1001n,
      // `format_date(..., locale='es')` — Spanish here, ISO in the serializer.
      meeting_date: '1 ene. 2020',
    });
  });

  it('an unknown power id is a 500, as `Power.objects.get` raising DoesNotExist is', async () => {
    await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'patch', id: 99999, state: 1 })
      .expect(500);
  });

  it('sends no letter when the submitted state is the string "1" — v1 compares `== 1`', async () => {
    const requestee = members[0];
    await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'post', meeting_date: '2020-01-01', requestee: requestee.id })
      .expect(200);
    const power = await prisma.power.findFirstOrThrow();
    const requesteeToken = await obtainToken(app, requestee.email);

    await request(app.getHttpServer())
      .post('/api/user/power')
      .set(authHeader(requesteeToken))
      .send({ type: 'patch', id: power.id, state: '1' })
      .expect(200);

    // The row is approved (Django coerces on save) but `power.state == 1` is False in Python,
    // because `save()` does not refresh the in-memory value. No email.
    await expect(
      prisma.power.findUniqueOrThrow({ where: { id: power.id } }).then((row) => row.state),
    ).resolves.toBe(1);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('an unrecognised power `type` is a 200 with an empty body', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/user/power')
      .set(asAdmin())
      .send({ type: 'delete' })
      .expect(200);
    expect(response.text).toBe('');
  });

  // ==========================================================================
  // C20 — the /api/user/<x> view collision, on the real controllers
  // ==========================================================================

  describe('C20 — the URL table, not Express, decides which view answers', () => {
    it('DELETE /api/user/power is UserAppsView, which has no DELETE: 403 even for ADMIN', async () => {
      await request(app.getHttpServer()).delete('/api/user/power').set(asAdmin()).expect(403);
    });

    it('GET /api/user/power is UserAppsView too: 403, not a user lookup', async () => {
      await request(app.getHttpServer()).get('/api/user/power').set(asAdmin()).expect(403);
    });

    it('POST /api/user/<id> is UserDetailView, which has no POST: 403', async () => {
      await request(app.getHttpServer())
        .post(`/api/user/${admin.id}`)
        .set(asAdmin())
        .send({})
        .expect(403);
    });

    it('the internal dispatch prefixes are unreachable from outside', async () => {
      await request(app.getHttpServer())
        .get(`/api/user/detail/${admin.id}`)
        .set(asAdmin())
        .expect(404);
      await request(app.getHttpServer()).post('/api/user/apps/power').set(asAdmin()).expect(404);
    });

    it('a trailing slash on a detail route 404s, as v1’s regex does', async () => {
      await request(app.getHttpServer()).get(`/api/user/${admin.id}/`).set(asAdmin()).expect(404);
    });

    it('an out-of-range id 404s rather than 500ing on the Int column', async () => {
      await request(app.getHttpServer())
        .get('/api/user/99999999999999999999')
        .set(asAdmin())
        .expect(404);
    });
  });

  // ==========================================================================
  // Phase 4 deviations on the user routes — D25, D26, D27
  //
  // These are user-route behaviours, so they live beside the rest of the user suite rather
  // than in `test/loan.e2e-spec.ts`. They are Phase **4** work: D25 must land with D10 (same
  // predicate, same roles), and D26/D27 were decided in the same operator round.
  // ==========================================================================

  describe('D25 — GET /api/user/<id> is the owner plus roles [0,1,2]', () => {
    it('a MEMBER reads their own detail', async () => {
      const member = await seedUser(prisma, {
        email: 'd25-member@mail.com',
        identification: 31_001n,
        role: Role.MEMBER,
      });
      const memberToken = await obtainToken(app, member.email);
      await request(app.getHttpServer())
        .get(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .expect(200);
    });

    it('GET /api/user/-1 stays on the owner branch and is unaffected', async () => {
      const member = await seedUser(prisma, {
        email: 'd25-self@mail.com',
        identification: 31_002n,
        role: Role.MEMBER,
      });
      const memberToken = await obtainToken(app, member.email);
      const response = await request(app.getHttpServer())
        .get('/api/user/-1')
        .set(authHeader(memberToken))
        .expect(200);
      expect((response.body as { user: { id: number } }).user.id).toBe(member.id);
    });

    it.each([
      ['ADMIN', Role.ADMIN],
      ['PRESIDENT', Role.PRESIDENT],
      ['TREASURER', Role.TREASURER],
    ])('%s reads any member’s detail', async (label, role) => {
      const privileged = await seedUser(prisma, {
        email: `d25-${label}@mail.com`,
        identification: BigInt(32_000 + role),
        role,
      });
      const privilegedToken = await obtainToken(app, privileged.email);
      await request(app.getHttpServer())
        .get(`/api/user/${members[0].id}`)
        .set(authHeader(privilegedToken))
        .expect(200);
    });

    /**
     * ⚠️ The exposure this closes, stated as the assertion: v1 gates only on `GET: 3`, so any
     * member could read `utilized_quota` (another member's outstanding debt) and
     * `total_savingaccounts` (their CAP deposits). Operator **Q29a**: no client screen does
     * this, so nothing breaks.
     */
    it('a MEMBER is refused another member’s detail — the finance block is the point', async () => {
      const member = await seedUser(prisma, {
        email: 'd25-stranger@mail.com',
        identification: 31_003n,
        role: Role.MEMBER,
      });
      const memberToken = await obtainToken(app, member.email);
      const response = await request(app.getHttpServer())
        .get(`/api/user/${members[0].id}`)
        .set(authHeader(memberToken))
        .expect(403);
      // Byte-identical to a role denial, so it is not an id-enumeration oracle.
      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });

      // Positive control: the same caller reading their OWN record is a 200 carrying finance,
      // so the 403 above is D25 and not a broken route.
      const own = await request(app.getHttpServer())
        .get(`/api/user/${member.id}`)
        .set(authHeader(memberToken))
        .expect(200);
      expect(own.body).toHaveProperty('finance.utilized_quota');
    });

    /**
     * ⚠️ **Registered divergence**: the check precedes the lookup, so a MEMBER asking for an
     * id that does not exist gets a **403** where v1 gives a 404. That is deliberate — it is
     * the same ordering `updateUser`'s section gate uses, and it stops the route being an
     * id-enumeration oracle. See `docs/phase-4-deviations.md` §D25.
     */
    it('for a MEMBER a non-existent id is also 403, not 404 (registered)', async () => {
      const member = await seedUser(prisma, {
        email: 'd25-missing@mail.com',
        identification: 31_004n,
        role: Role.MEMBER,
      });
      const memberToken = await obtainToken(app, member.email);
      await request(app.getHttpServer())
        .get(`/api/user/${missingId}`)
        .set(authHeader(memberToken))
        .expect(403);
      // A privileged caller still gets v1's 404 for the same id.
      await request(app.getHttpServer()).get(`/api/user/${missingId}`).set(asAdmin()).expect(404);
    });

    it('the unrestricted list and POST /api/user/birthdates are untouched', async () => {
      const member = await seedUser(prisma, {
        email: 'd25-list@mail.com',
        identification: 31_005n,
        role: Role.MEMBER,
      });
      const memberToken = await obtainToken(app, member.email);
      // The list carries no finance at all, which is why it stays open.
      const list = await request(app.getHttpServer())
        .get('/api/user')
        .set(authHeader(memberToken))
        .expect(200);
      expect((list.body as { list: unknown[] }).list.length).toBeGreaterThan(1);
      expect(JSON.stringify(list.body)).not.toContain('utilized_quota');

      await request(app.getHttpServer())
        .post('/api/user/birthdates')
        .set(authHeader(memberToken))
        .expect(200);
    });
  });

  describe('D26 — a power request naming yourself is refused at creation, with 406', () => {
    it('requester === requestee is 406 and writes no row', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'post', meeting_date: '2020-01-01', requestee: admin.id })
        .expect(406);
      expect(response.body).toEqual({
        message: 'Requester and requestee must be different users',
      });
      await expect(prisma.power.count()).resolves.toBe(0);
    });

    it('the 406 survives UserAppsView’s blanket `except Exception` — it is not a 500', async () => {
      // ⚠️ The whole handler body is wrapped in `except Exception: return 500` in v1. Without
      // `ApiException.deviation`'s marker this refusal would be laundered into a 500 and be
      // invisible to both the caller and `manual-tester`.
      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'post', meeting_date: '2020-01-01', requestee: admin.id })
        .expect(406);
      expect(response.status).not.toBe(500);
    });

    it('no self-addressed push notification is produced, because the refusal precedes the row', async () => {
      const spy = jest.spyOn(notifications, 'sendNotification');
      spy.mockClear();
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'post', meeting_date: '2020-01-01', requestee: admin.id })
        .expect(406);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('a request naming somebody else still works — positive control', async () => {
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'post', meeting_date: '2020-01-01', requestee: members[0].id })
        .expect(200);
      await expect(prisma.power.count()).resolves.toBe(1);
    });

    /**
     * ⚠️ **No `(requester, meeting_date)` uniqueness rule** — operator **Q30a**. A second
     * request superseding the first is the fund's live idiom (member 14 holds rows 18 and 20
     * for the 2026-01-31 assembly). A uniqueness rule would break real behaviour, so this
     * cell exists to stop one being added.
     */
    it('Q30a: a SECOND request for the same assembly is allowed — the supersede idiom', async () => {
      for (const requestee of [members[0].id, members[1].id]) {
        await request(app.getHttpServer())
          .post('/api/user/power')
          .set(asAdmin())
          .send({ type: 'post', meeting_date: '2026-01-31', requestee })
          .expect(200);
      }
      await expect(prisma.power.count({ where: { requester_id: admin.id } })).resolves.toBe(2);
    });

    it('Q30a: even two requests naming the SAME requestee for one assembly are allowed', async () => {
      for (let i = 0; i < 2; i += 1) {
        await request(app.getHttpServer())
          .post('/api/user/power')
          .set(asAdmin())
          .send({ type: 'post', meeting_date: '2026-01-31', requestee: members[0].id })
          .expect(200);
      }
      await expect(prisma.power.count()).resolves.toBe(2);
    });
  });

  describe('D27 — power state transitions 0->1 and 0->2 only', () => {
    const createPower = async (): Promise<{ id: number; requesteeToken: string }> => {
      const requestee = members[0];
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'post', meeting_date: '2020-01-01', requestee: requestee.id })
        .expect(200);
      const power = await prisma.power.findFirstOrThrow({ orderBy: { id: 'desc' } });
      return { id: power.id, requesteeToken: await obtainToken(app, requestee.email) };
    };

    it('0 -> 1 is allowed and sends the letter once', async () => {
      const { id, requesteeToken } = await createPower();
      sendMail.mockClear();
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: 1 })
        .expect(200);
      expect(sendMail).toHaveBeenCalledTimes(1);
      await expect(
        prisma.power.findUniqueOrThrow({ where: { id } }).then((p) => p.state),
      ).resolves.toBe(1);
    });

    it('0 -> 2 is allowed and sends nothing', async () => {
      const { id, requesteeToken } = await createPower();
      sendMail.mockClear();
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: 2 })
        .expect(200);
      expect(sendMail).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ The v1 defect: `handle_power_request` writes `power.state` unconditionally and mails
     * on approval, so re-approving an already-approved power **re-sends the fund-wide
     * power-of-attorney letter to every active member, unbounded**. Same class as D9.
     */
    it('1 -> 1 is 409 with NO second letter', async () => {
      const { id, requesteeToken } = await createPower();
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: 1 })
        .expect(200);
      sendMail.mockClear();

      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: 1 })
        .expect(409);
      expect(response.body).toEqual({ message: 'Invalid state transition' });
      expect(sendMail).not.toHaveBeenCalled();
    });

    it.each([
      [1, 2],
      [2, 1],
      [2, 2],
      [1, 0],
      [2, 0],
    ])('%i -> %i is 409 and leaves the row alone', async (from, to) => {
      const { id, requesteeToken } = await createPower();
      await prisma.power.update({ where: { id }, data: { state: from } });

      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: to })
        .expect(409);
      await expect(
        prisma.power.findUniqueOrThrow({ where: { id } }).then((p) => p.state),
      ).resolves.toBe(from);
    });

    it('0 -> 0 is 409 too — a no-op write is still not a legal transition', async () => {
      const { id, requesteeToken } = await createPower();
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: 0 })
        .expect(409);
    });

    it('the 409 survives UserAppsView’s blanket `except Exception`', async () => {
      const { id, requesteeToken } = await createPower();
      await prisma.power.update({ where: { id }, data: { state: 2 } });
      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: 1 })
        .expect(409);
      expect(response.status).not.toBe(500);
    });

    /**
     * ⚠️ **D2 still runs first, and its 403 body must stay generic.** An ownership failure
     * must be indistinguishable from a role denial, so it must not leak "that transition would
     * have been illegal anyway".
     */
    it('D2 precedes D27: a non-requestee gets the generic 403, not a 409', async () => {
      const { id } = await createPower();
      await prisma.power.update({ where: { id }, data: { state: 1 } });
      const response = await request(app.getHttpServer())
        .post('/api/user/power')
        .set(asAdmin())
        .send({ type: 'patch', id, state: 1 })
        .expect(403);
      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
    });

    /**
     * ⚠️ **v1's quirk is preserved**: `power.state == 1` compares the *submitted* value, and
     * Django does not refresh the instance after `save()`. So `{"state": "1"}` writes 1 to the
     * column (the field coerces) and then compares `'1' == 1`, which is `False` in Python — the
     * row is approved and **no email is sent**. D27 guards on the *coerced* value, so the
     * transition is still legal; only the mail branch keeps the quirk.
     */
    it('a stringified state approves the row but sends no mail (v1 quirk, kept)', async () => {
      const { id, requesteeToken } = await createPower();
      sendMail.mockClear();
      await request(app.getHttpServer())
        .post('/api/user/power')
        .set(authHeader(requesteeToken))
        .send({ type: 'patch', id, state: '1' })
        .expect(200);
      await expect(
        prisma.power.findUniqueOrThrow({ where: { id } }).then((p) => p.state),
      ).resolves.toBe(1);
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // D35 + P5-F1 — `null` and non-scalar values on every `CharField`/`TextField` site
  //
  // v1's `TextField.get_prep_value` is `to_python`, measured on the pinned stack:
  //
  //   TextField().get_prep_value(None)      -> None        (SQL NULL, not 'None')
  //   TextField().get_prep_value(['a'])     -> "['a']"     (CPython repr, not a type name)
  //   TextField().get_prep_value({'a': 1})  -> "{'a': 1}"
  //
  // Every cell below states which v1 line decides the status, because the four sites answer
  // a `null` **differently**: `create_user` 409 (its `except IntegrityError`), the email half
  // 500 (`UserManager._create_user`'s `ValueError`, raised before any SQL),
  // `__update_user_personal` 409, `__update_user_preferences` 404 (its bare `except`).
  // ==========================================================================
  describe('D35 — a JSON `null` on a NOT NULL text column', () => {
    /**
     * `first_name = None` reaches `auth_user.first_name`, which is `NOT NULL`; PostgreSQL
     * raises `23502`, Django wraps it as `IntegrityError`, and `create_user`'s
     * `except IntegrityError` answers the (misleading) 409 it answers for a duplicate.
     */
    it.each([['first_name'], ['last_name']])(
      'POST /api/user with `%s: null` is 409, not a member named None',
      async (field) => {
        const response = await request(app.getHttpServer())
          .post('/api/user')
          .set(asAdmin())
          .send({ ...objectJson, [field]: null })
          .expect(409);

        expect(response.body).toEqual({ message: 'Identification/email already exists' });
        await expect(countUsers()).resolves.toBe(11);
        await expect(countFinance()).resolves.toBe(11);
        await expect(prisma.userPreference.count()).resolves.toBe(11);
        // The mail send is the last statement inside v1's atomic block, so a row that never
        // reached the database never reached SES either.
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    /**
     * ⚠️ **`email` is not the 409 the D35 register row predicted — it is a 500.** v1 passes
     * `obj['email']` to `UserProfile.objects.create_user(...)` as *both* `email` and
     * `username`, and `UserManager._create_user` opens with
     * `if not username: raise ValueError('The given username must be set')` — **before** any
     * SQL. Measured in the container: `email=None` and `email=''` both raise it. So a falsy
     * email is an uncaught `ValueError` (a bare 500), not `IntegrityError`.
     */
    it.each([[null], [''], [0], [false]])(
      'POST /api/user with a falsy `email` (%p) is 500 — `_create_user`’s ValueError',
      async (email) => {
        await request(app.getHttpServer())
          .post('/api/user')
          .set(asAdmin())
          .send({ ...objectJson, email })
          .expect(500);

        await expect(countUsers()).resolves.toBe(11);
        await expect(prisma.authUser.count()).resolves.toBe(11);
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    /**
     * **DELTA-F1** — `normalize_email` has three branches, and v2 had two.
     *
     * ```python
     * email = email or ''   # falsy -> '', but `_create_user`'s ValueError fired first
     * email.strip()         # truthy str -> fine;  truthy non-str -> AttributeError
     * ```
     *
     * Measured in the container: `['a']`, `{'a': 1}`, `True` and `5` each raise
     * `AttributeError: '<type>' object has no attribute 'strip'`, so v1 answers **500** and
     * writes nothing. v2 answered **201** and created an account whose username was the four
     * characters of a rendered list — with an activation email sent — because the value was
     * coerced to text before it was inspected.
     */
    it.each([[['a']], [[1, 2]], [true], [5], [5.5], [{ a: 1 }], [{ a: ['b'] }]])(
      'POST /api/user with a truthy non-string `email` (%p) is 500 and writes nothing',
      async (email) => {
        await request(app.getHttpServer())
          .post('/api/user')
          .set(asAdmin())
          .send({ ...objectJson, email })
          .expect(500);

        await expect(countUsers()).resolves.toBe(11);
        await expect(prisma.authUser.count()).resolves.toBe(11);
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    /**
     * The discriminator between branch two and branch three: a *string* that merely looks
     * non-stringy still has `.strip`, so it creates. Without this cell, refusing every email
     * would pass the block above.
     */
    it.each([
      ['"0"', '0'],
      ['"false"', 'false'],
      ['"[a]"', '[a]'],
    ])(
      'POST /api/user with the string %s still creates — it has `.strip`',
      async (_label, email) => {
        await request(app.getHttpServer())
          .post('/api/user')
          .set(asAdmin())
          .send({ ...objectJson, email, identification: 555_000 + email.length })
          .expect(201);
      },
    );

    /** The positive control: the same body with every field present still creates. */
    it('POST /api/user with the unmodified fixture still creates (positive control)', async () => {
      await request(app.getHttpServer())
        .post('/api/user')
        .set(asAdmin())
        .send(objectJson)
        .expect(201);
      await expect(countUsers()).resolves.toBe(12);
    });

    /** `__update_user_personal`: `except IntegrityError: return (False, 409)`. */
    it.each([['first_name'], ['last_name'], ['email']])(
      'PATCH /api/user/<id> personal with `%s: null` is 409 and writes nothing',
      async (field) => {
        const personal = { ...(userUpdate().personal as Record<string, unknown>), [field]: null };
        await request(app.getHttpServer())
          .patch(`/api/user/${admin.id}`)
          .set(asAdmin())
          .send({ ...userUpdate(), type: 'personal', personal })
          .expect(409);

        const row = await prisma.userProfile.findUniqueOrThrow({
          where: { user_ptr_id: admin.id },
          include: { auth_user: true },
        });
        expect(row.auth_user.first_name).toBe('Foo Name');
        expect(row.auth_user.last_name).toBe('Foo Last Name');
        expect(row.auth_user.email).toBe('mail_for_tests@mail.com');
      },
    );

    /** `__update_user_preferences` wraps everything in a **bare** `except` → 404. */
    it.each([['primary_color'], ['secondary_color']])(
      'PATCH /api/user/<id> preferences with `%s: null` is 404 and writes nothing',
      async (field) => {
        await request(app.getHttpServer())
          .patch(`/api/user/${admin.id}`)
          .set(asAdmin())
          .send({
            type: 'preferences',
            preferences: {
              notifications: true,
              primary_color: '#fff',
              secondary_color: '#000',
              [field]: null,
            },
          })
          .expect(404);

        const preference = await prisma.userPreference.findFirstOrThrow({
          where: { user_id: admin.id },
        });
        expect(preference.primary_color).toBe('#800000');
        expect(preference.secondary_color).toBe('#c83737');
        expect(preference.notifications).toBe(false);
      },
    );
  });

  describe('P5-F1 — a non-scalar value is stored as CPython’s repr', () => {
    it('POST /api/user with `first_name: ["a"]` stores the four characters [\'a\']', async () => {
      await request(app.getHttpServer())
        .post('/api/user')
        .set(asAdmin())
        .send({ ...objectJson, first_name: ['a'], last_name: { a: 1 } })
        .expect(201);

      const created = await prisma.userProfile.findFirstOrThrow({
        where: { identification: 123n },
        include: { auth_user: true },
      });
      expect(created.auth_user.first_name).toBe("['a']");
      expect(created.auth_user.last_name).toBe("{'a': 1}");
      // …and it reaches the activation email through `'{} {}'.format(first, last)`.
      expect(sendMail).toHaveBeenCalledWith(
        EmailTemplate.USER_ACTIVATION,
        ['mail@mail.com'],
        expect.objectContaining({ user_full_name: "['a'] {'a': 1}" }),
      );
    });

    it('PATCH /api/user/<id> personal with `first_name: ["a"]` stores the repr', async () => {
      const personal = {
        ...(userUpdate().personal as Record<string, unknown>),
        first_name: ['a'],
        last_name: { a: [1, { b: 2 }] },
      };
      await request(app.getHttpServer())
        .patch(`/api/user/${admin.id}`)
        .set(asAdmin())
        .send({ ...userUpdate(), type: 'personal', personal })
        .expect(200);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: admin.id },
        include: { auth_user: true },
      });
      expect(row.auth_user.first_name).toBe("['a']");
      expect(row.auth_user.last_name).toBe("{'a': [1, {'b': 2}]}");
    });

    it('PATCH /api/user/<id> preferences with a non-scalar colour stores the repr', async () => {
      await request(app.getHttpServer())
        .patch(`/api/user/${admin.id}`)
        .set(asAdmin())
        .send({
          type: 'preferences',
          preferences: { notifications: true, primary_color: ['a'], secondary_color: { a: 1 } },
        })
        .expect(200);

      const preference = await prisma.userPreference.findFirstOrThrow({
        where: { user_id: admin.id },
      });
      expect(preference.primary_color).toBe("['a']");
      expect(preference.secondary_color).toBe("{'a': 1}");
    });
  });

  /**
   * **D38 — the one D35 site v2 deliberately does not follow v1 to.**
   *
   * `activate_user` filters on `key_activation = obj['key']`. Django turns a `None` rhs into
   * `IS NULL` (measured — `str(qs.query)` ends `"key_activation" IS NULL`), and
   * `key_activation` is `NULL` on **every already-activated member**. So in v1 an
   * unauthenticated `POST /api/user/activate/<id>` with `{"key": null, "identification": …,
   * "password": "…"}` matches a live account, calls `set_password`, and hands the caller that
   * member's login. `identification` is readable by any member through `GET /api/user`.
   *
   * v2 refuses. Registered as a fix, not ported.
   */
  describe('D38 — `key: null` never matches an activated member', () => {
    it('is 404 against an already-activated member and leaves the password alone', async () => {
      const { id, key } = await createAndFetch();
      await request(app.getHttpServer())
        .post(`/api/user/activate/${id}`)
        .send({ password: 'newPassword123', identification: 123, key })
        .expect(200);

      const activated = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: id },
        include: { auth_user: true },
      });
      expect(activated.key_activation).toBeNull();

      await request(app.getHttpServer())
        .post(`/api/user/activate/${id}`)
        .send({ password: 'attackerPassword', identification: 123, key: null })
        .expect(404);

      const after = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: id },
        include: { auth_user: true },
      });
      expect(after.auth_user.password).toBe(activated.auth_user.password);

      // The original password still works and the attacker's does not.
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: 'mail@mail.com', password: 'newPassword123' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: 'mail@mail.com', password: 'attackerPassword' })
        .expect(400);
    });

    it('is 404 against a pending member too — v1 agrees here (positive control)', async () => {
      const { id } = await createAndFetch();
      await request(app.getHttpServer())
        .post(`/api/user/activate/${id}`)
        .send({ password: 'newPassword123', identification: 123, key: null })
        .expect(404);

      const row = await prisma.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: id },
        include: { auth_user: true },
      });
      expect(row.key_activation).not.toBeNull();
      expect(row.auth_user.is_active).toBe(false);
    });
  });
});
