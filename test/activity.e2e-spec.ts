import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedActivity,
  seedActivityUser,
  seedActivityYear,
  seedUser,
  type SeededUser,
} from './support/abstract-test';
import { rawRequestFor } from './support/raw-request';

/**
 * Phase 5 e2e — the port of `fondo_api/tests/test_activity_views.py` (**11 methods**),
 * DB-backed, through the whole `AppModule` pipeline.
 *
 * Every `it(...)` naming a v1 test names it verbatim so `manual-tester` and the reviewer can
 * diff the two files method by method. The cells beyond that block cover what v1's suite does
 * not: the authorisation matrix, the URL layer's two different trailing-slash answers, the
 * wire shape of the bodiless 204/304, `BigInt` rendering (rule **5b**), the ISO date spelling
 * (**not** rule 5c's Spanish), the `ActivityUser` cascade the database will not do for us
 * (rule 10), and the parser policy (**C10**).
 *
 * ## No expectation moves
 *
 * Phase 5 owns **no** rows in `MIGRATION_PLAN.md` §5 — the register's `Phase` column has no
 * `P5` entry. Every v1 assertion below is reproduced as v1 makes it, including the ones that
 * look like defects: a bodiless **304** from a `POST`, a **204** where a modern API would
 * send `200 []`, a **200** from `DELETE` on an id that never existed, and a **404** for every
 * conceivable `PATCH` failure.
 *
 * ## Fixture differences from `AbstractTest`, all deliberate
 *
 * * v1 pins `id = 1` / `id = 2` on the activities it creates. v2 lets the sequence assign
 *   them (plan §4: v2 never sets a primary key on a table v1 also writes), so "the activity
 *   that does not exist" is computed from the real ids.
 * * v1's `create_user()` seeds **one** ADMIN, so `test_create_activity` asserts
 *   `activities[0].users.count() == 1`. The role-matrix cells need four users, so the
 *   membership counts below are computed from the seeded set rather than hard-coded — except
 *   in the ported cells, which seed exactly one user as v1 does.
 */
/**
 * `expect.any(Number)`, typed. `expect.any` returns `any`, which the lint rules reject inside
 * an object literal, and the sequence-assigned ids are the one field these cells cannot pin
 * (plan §4: v2 never sets a primary key on a table v1 also writes).
 */
const ANY_NUMBER: unknown = expect.any(Number);

describe('Phase 5 — /api/activity (port of test_activity_views.py)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let token: string;

  /** `setUp`'s JSON fixture, transcribed from `test_activity_views.py:19-23`. */
  const activityJson = {
    name: 'New Activity for tests',
    value: 30000,
    date: '2020-11-7',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    // `AbstractTest.create_user()` — one ADMIN, and nothing else.
    admin = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    token = await obtainToken(app, 'mail_for_tests@mail.com');
  });

  const asAdmin = (): Record<string, string> => authHeader(token);
  const server = (): App => app.getHttpServer();
  const raw = rawRequestFor(() => app.getHttpServer() as unknown as Server);

  const createActivity = async (yearId: number, body: object = activityJson): Promise<number> => {
    await request(server())
      .post(`/api/activity/year/${String(yearId)}`)
      .set(asAdmin())
      .send(body)
      .expect(201);
    const rows = await prisma.activity.findMany({ orderBy: { id: 'desc' }, take: 1 });
    return rows[0].id;
  };

  // ==========================================================================
  // The eleven v1 tests
  // ==========================================================================

  /** `test_get_years_empty` — ⚠️ **204**, not `200 []`. */
  it('test_get_years_empty: 204 No Content on an empty table', async () => {
    const response = await request(server()).get('/api/activity/year').set(asAdmin()).expect(204);

    expect(response.text).toBe('');
    // `Response.rendered_content` deletes the header when the renderer produced no bytes.
    expect(response.headers['content-type']).toBeUndefined();
  });

  /** `test_get_years` */
  it('test_get_years: 200 ordered by -year, enable echoed', async () => {
    await seedActivityYear(prisma, { year: 2020 });
    await seedActivityYear(prisma, { year: 2021 });

    const response = await request(server()).get('/api/activity/year').set(asAdmin()).expect(200);
    const body = response.body as { id: number; year: number; enable: boolean }[];

    expect(body).toHaveLength(2);
    expect(body[0].year).toBe(2021);
    expect(body[0].enable).toBe(true);
    expect(body[1].year).toBe(2020);
    expect(body[1].enable).toBe(true);
  });

  /** `test_create_year` — 201, then **304** on the second call, both bodiless. */
  it('test_create_year: 201 then 304, no body either time', async () => {
    const created = await request(server()).post('/api/activity/year').set(asAdmin()).expect(201);
    expect(created.text).toBe('');

    // `date.today().year` in Bogota — the same reading the service makes.
    const year = Number(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
      }).format(new Date()),
    );
    const years = await prisma.activityYear.findMany();
    expect(years).toHaveLength(1);
    expect(years[0].year).toBe(BigInt(year));
    expect(years[0].enable).toBe(true);

    const again = await request(server()).post('/api/activity/year').set(asAdmin()).expect(304);
    expect(again.text).toBe('');
    expect(await prisma.activityYear.count()).toBe(1);
  });

  /** `test_create_year_disabling_others` */
  it('test_create_year_disabling_others: the highest other year is disabled', async () => {
    const old = await seedActivityYear(prisma, { year: 2000 });

    await request(server()).post('/api/activity/year').set(asAdmin()).expect(201);

    const row = await prisma.activityYear.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.enable).toBe(false);
  });

  /** `test_get_activities` */
  it('test_get_activities: only the requested year, id and name only', async () => {
    const year2020 = await seedActivityYear(prisma, { year: 2020 });
    const year2021 = await seedActivityYear(prisma, { year: 2021 });
    const first = await seedActivity(prisma, {
      yearId: year2020.id,
      name: 'Test Activity 1',
      value: 1000,
      date: '2020-01-01',
    });
    await seedActivity(prisma, {
      yearId: year2021.id,
      name: 'Test Activity 2',
      value: 1000,
      date: '2021-01-01',
    });

    const response = await request(server())
      .get(`/api/activity/year/${String(year2020.id)}`)
      .set(asAdmin())
      .expect(200);
    const body = response.body as { id: number; name: string }[];

    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(first);
    expect(body[0].name).toBe('Test Activity 1');
    // `ActivityGeneralSerializer` is `('id','name')` — not the date it sorts by, not the value.
    expect(Object.keys(body[0])).toEqual(['id', 'name']);
  });

  /** `test_create_activity` */
  it('test_create_activity: 201, one ActivityUser per active user at state 0', async () => {
    const year2020 = await seedActivityYear(prisma, { year: 2020 });

    const response = await request(server())
      .post(`/api/activity/year/${String(year2020.id)}`)
      .set(asAdmin())
      .send(activityJson)
      .expect(201);
    expect(response.text).toBe('');

    const activities = await prisma.activity.findMany({ include: { users: true } });
    expect(activities).toHaveLength(1);
    expect(activities[0].name).toBe('New Activity for tests');
    expect(activities[0].value).toBe(30000n);
    expect(activities[0].date.toISOString()).toBe('2020-11-07T00:00:00.000Z');
    expect(activities[0].year_id).toBe(year2020.id);
    // v1: `self.assertEqual(activities[0].users.count(), 1)` — one seeded user.
    expect(activities[0].users).toHaveLength(1);
    expect(activities[0].users[0].state).toBe(0); // NOT_PAID
    expect(activities[0].users[0].user_id).toBe(admin.id);
  });

  /** `test_get_activity_not_found` */
  it('test_get_activity_not_found: 404 with a zero-byte body', async () => {
    const response = await request(server()).get('/api/activity/12').set(asAdmin()).expect(404);
    expect(response.text).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
  });

  /** `test_get_activity` */
  it('test_get_activity: 200 with ActivityDetailSerializer', async () => {
    const year2020 = await seedActivityYear(prisma, { year: 2020 });
    const activityId = await createActivity(year2020.id);

    const response = await request(server())
      .get(`/api/activity/${String(activityId)}`)
      .set(asAdmin())
      .expect(200);
    const body = response.body as {
      id: number;
      name: string;
      value: number;
      date: string;
      users: { id: number; state: number; user: Record<string, unknown> }[];
    };

    expect(body.id).toBe(activityId);
    expect(body.name).toBe('New Activity for tests');
    expect(body.value).toBe(30000);
    // ⚠️ ISO, not the Spanish babel spelling. `test_activity_views.py:148`.
    expect(body.date).toBe('2020-11-07');
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toEqual(expect.any(Number));
    expect(body.users[0].state).toBe(0);
    expect(Object.keys(body)).toEqual(['id', 'name', 'date', 'value', 'users']);
  });

  /** `test_delete_activity` */
  it('test_delete_activity: 200 and the row is gone', async () => {
    const year2020 = await seedActivityYear(prisma, { year: 2020 });
    const activityId = await seedActivity(prisma, {
      yearId: year2020.id,
      name: 'Test Activity 1',
      value: 1000,
      date: '2020-01-01',
    });

    const response = await request(server())
      .delete(`/api/activity/${String(activityId)}`)
      .set(asAdmin())
      .expect(200);
    expect(response.text).toBe('');

    expect(await prisma.activity.count()).toBe(0);
  });

  /** `test_update_activity` — including the 404 for an id that does not exist. */
  it('test_update_activity: 200 with the updated detail, then 404 for a missing id', async () => {
    const year2020 = await seedActivityYear(prisma, { year: 2020 });
    const activityId = await seedActivity(prisma, {
      yearId: year2020.id,
      name: 'Test Activity 1',
      value: 1000,
      date: '2020-01-01',
    });

    const response = await request(server())
      .patch(`/api/activity/${String(activityId)}`)
      .set(asAdmin())
      .send(activityJson)
      .expect(200);
    const body = response.body as Record<string, unknown>;

    expect(body.id).toBe(activityId);
    expect(body.name).toBe('New Activity for tests');
    expect(body.value).toBe(30000);
    expect(body.date).toBe('2020-11-07');
    // v1 seeds the activity directly, so it has no members — `get_users` returns [].
    expect(body.users).toEqual([]);

    const missing = await request(server())
      .patch(`/api/activity/${String(activityId + 1000)}`)
      .set(asAdmin())
      .send(activityJson)
      .expect(404);
    expect(missing.text).toBe('');
  });

  /** `test_update_activity_user` */
  it('test_update_activity_user: ?patch=user sets the state, then 404 for a missing activity', async () => {
    const year2020 = await seedActivityYear(prisma, { year: 2020 });
    const activityId = await createActivity(year2020.id);
    const activityUser = await prisma.activityUser.findFirstOrThrow({
      where: { activity_id: activityId },
    });

    const response = await request(server())
      .patch(`/api/activity/${String(activityId)}?patch=user`)
      .set(asAdmin())
      .send({ id: activityUser.id, state: 2 })
      .expect(200);
    const body = response.body as Record<string, unknown> & {
      users: { id: number; state: number }[];
    };

    expect(body.id).toBe(activityId);
    expect(body.name).toBe('New Activity for tests');
    expect(body.value).toBe(30000);
    expect(body.date).toBe('2020-11-07');
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toEqual(expect.any(Number));
    expect(body.users[0].state).toBe(2);

    await request(server())
      .patch('/api/activity/123?patch=user')
      .set(asAdmin())
      .send({ id: activityUser.id, state: 2 })
      .expect(404);
  });

  /** `test_update_activity_bad_request` */
  it('test_update_activity_bad_request: ?patch=invalid is a 400', async () => {
    const response = await request(server())
      .patch('/api/activity/1?patch=invalid')
      .set(asAdmin())
      .expect(400);
    expect(response.text).toBe('');
  });

  // ==========================================================================
  // Beyond v1's suite — the URL layer (plan §4 rule 14, docs/adding-a-route.md §1)
  // ==========================================================================
  describe('the URL conf', () => {
    /**
     * ⚠️ **The lone detail-route exception.** `^api/activity/(?P<id>[0-9]+)/?$` is the only
     * `<id>` pattern in v1 that ends `/?$`. Sent raw, because supertest re-serialises the
     * request target (condition **C27**).
     */
    it('accepts a trailing slash on /api/activity/<id> — the one route that does', async () => {
      const year2020 = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year2020.id);

      const withSlash = await raw(
        `/api/activity/${String(activityId)}/`,
        'GET',
        `Host: localhost\r\nAuthorization: Token ${token}\r\n`,
      );
      expect(withSlash.status).toBe(200);

      // positive control: the same request without the slash, same answer
      const without = await raw(
        `/api/activity/${String(activityId)}`,
        'GET',
        `Host: localhost\r\nAuthorization: Token ${token}\r\n`,
      );
      expect(without.status).toBe(200);
      expect(without.body).toBe(withSlash.body);
    });

    /** `^api/activity/year/(?P<id_year>[0-9]+)$` — **no** `/?`, so the slashed form 404s. */
    it('rejects a trailing slash on /api/activity/year/<id_year>', async () => {
      const year2020 = await seedActivityYear(prisma, { year: 2020 });

      const withSlash = await raw(
        `/api/activity/year/${String(year2020.id)}/`,
        'GET',
        `Host: localhost\r\nAuthorization: Token ${token}\r\n`,
      );
      expect(withSlash.status).toBe(404);

      const without = await raw(
        `/api/activity/year/${String(year2020.id)}`,
        'GET',
        `Host: localhost\r\nAuthorization: Token ${token}\r\n`,
      );
      expect(without.status).toBe(200);
    });

    /** `^api/activity/year/?$` — optional, so both forms reach `ActivityYearView`. */
    it('accepts either form of /api/activity/year', async () => {
      await seedActivityYear(prisma, { year: 2020 });
      for (const target of ['/api/activity/year', '/api/activity/year/']) {
        const response = await raw(
          target,
          'GET',
          `Host: localhost\r\nAuthorization: Token ${token}\r\n`,
        );
        expect([target, response.status]).toEqual([target, 200]);
      }
    });

    /** Case-sensitive, like Django's `url()` and unlike Express (finding F2). */
    it('404s an upper-cased path before any guard runs', async () => {
      const response = await raw('/API/activity/year', 'GET', 'Host: localhost\r\n');
      expect(response.status).toBe(404);
    });

    /**
     * ⚠️ **Condition C20's backstop, exercised from the outside.** `/api/activity/year` also
     * matches Express's `api/activity/:id`. If {@link ActivityDetailController} were
     * registered first, `RolesGuard` would find the URL table resolving `ActivityYearView`
     * against a controller declaring `ActivityDetailView` and raise a **500**. A 200 here
     * proves the declaration order in `ActivityModule` is the one Django's resolver implies.
     */
    it('routes /api/activity/year to ActivityYearView, not ActivityDetailView (C20)', async () => {
      await seedActivityYear(prisma, { year: 2020 });
      const response = await request(server()).get('/api/activity/year').set(asAdmin()).expect(200);
      // The year list, not an activity detail and not a 404/500.
      expect(response.body).toEqual([{ id: ANY_NUMBER, year: 2020, enable: true }]);
    });
  });

  // ==========================================================================
  // Beyond v1's suite — authorisation (docs/adding-a-route.md §9)
  // ==========================================================================
  describe('the authorisation matrix', () => {
    const tokens: Partial<Record<Role, string>> = {};

    beforeEach(async () => {
      for (const role of [Role.PRESIDENT, Role.TREASURER, Role.MEMBER]) {
        const email = `role_${String(role)}@mail.com`;
        await seedUser(prisma, { email, identification: BigInt(1000 + role), role });
        tokens[role] = await obtainToken(app, email);
      }
      tokens[Role.ADMIN] = token;
    });

    const header = (role: Role): Record<string, string> => authHeader(tokens[role] as string);

    /**
     * `ActivityYearView` / `ActivityYearDetailView`: `GET 3`, `POST 1`.
     * `ActivityDetailView`: `GET 3`, `PATCH 1`, `DELETE 1`.
     *
     * The rules are **ceilings** (`role <= N`), so every role reads and only ADMIN (0) and
     * PRESIDENT (1) write. ⚠️ **The TREASURER cannot touch activities** — this is the one
     * domain the PRESIDENT has, and Q23/Q25 kept them out of CAPs and `PATCH /api/user`.
     */
    it.each([
      [Role.ADMIN, 201],
      [Role.PRESIDENT, 201],
      [Role.TREASURER, 403],
      [Role.MEMBER, 403],
    ])('POST /api/activity/year: role %i -> %i', async (role, expected) => {
      await request(server()).post('/api/activity/year').set(header(role)).expect(expected);
    });

    it.each([Role.ADMIN, Role.PRESIDENT, Role.TREASURER, Role.MEMBER])(
      'GET /api/activity/year: role %i -> 204 (all roles read)',
      async (role) => {
        await request(server()).get('/api/activity/year').set(header(role)).expect(204);
      },
    );

    it.each([
      [Role.ADMIN, 201],
      [Role.PRESIDENT, 201],
      [Role.TREASURER, 403],
      [Role.MEMBER, 403],
    ])('POST /api/activity/year/<id>: role %i -> %i', async (role, expected) => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      await request(server())
        .post(`/api/activity/year/${String(year.id)}`)
        .set(header(role))
        .send(activityJson)
        .expect(expected);
    });

    it.each([Role.ADMIN, Role.PRESIDENT, Role.TREASURER, Role.MEMBER])(
      'GET /api/activity/year/<id>: role %i -> 200',
      async (role) => {
        const year = await seedActivityYear(prisma, { year: 2020 });
        await request(server())
          .get(`/api/activity/year/${String(year.id)}`)
          .set(header(role))
          .expect(200);
      },
    );

    it.each([
      [Role.ADMIN, 200],
      [Role.PRESIDENT, 200],
      [Role.TREASURER, 403],
      [Role.MEMBER, 403],
    ])('PATCH /api/activity/<id>: role %i -> %i', async (role, expected) => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await seedActivity(prisma, {
        yearId: year.id,
        name: 'a',
        value: 1000,
        date: '2020-01-01',
      });
      await request(server())
        .patch(`/api/activity/${String(activityId)}`)
        .set(header(role))
        .send(activityJson)
        .expect(expected);
    });

    it.each([
      [Role.ADMIN, 200],
      [Role.PRESIDENT, 200],
      [Role.TREASURER, 403],
      [Role.MEMBER, 403],
    ])('DELETE /api/activity/<id>: role %i -> %i', async (role, expected) => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await seedActivity(prisma, {
        yearId: year.id,
        name: 'a',
        value: 1000,
        date: '2020-01-01',
      });
      await request(server())
        .delete(`/api/activity/${String(activityId)}`)
        .set(header(role))
        .expect(expected);
    });

    it.each([Role.ADMIN, Role.PRESIDENT, Role.TREASURER, Role.MEMBER])(
      'GET /api/activity/<id>: role %i -> 200 (all roles read every member’s profile)',
      async (role) => {
        const year = await seedActivityYear(prisma, { year: 2020 });
        const activityId = await createActivity(year.id);
        await request(server())
          .get(`/api/activity/${String(activityId)}`)
          .set(header(role))
          .expect(200);
      },
    );

    /**
     * ⚠️ Plan §4 rule 13. `list_permissions` has no `OPTIONS` key for any view, so
     * `APIRolePermission`'s bare `except` denies it for **every** role, ADMIN included —
     * inside `APIView.initial()`, before `dispatch` could raise `MethodNotAllowed`. A 405
     * here would mean the guard was skipped.
     */
    it.each(['/api/activity/year', '/api/activity/year/1', '/api/activity/1'])(
      'OPTIONS %s is 403 even for ADMIN',
      async (path) => {
        await request(server()).options(path).set(asAdmin()).expect(403);
      },
    );

    /** A method the view does not implement is a **403**, not a 405 (guard before dispatch). */
    it.each([
      ['/api/activity/year', 'put'],
      ['/api/activity/year', 'delete'],
      ['/api/activity/year/1', 'put'],
      ['/api/activity/year/1', 'delete'],
      ['/api/activity/1', 'put'],
      ['/api/activity/1', 'post'],
    ] as const)('%s %s is 403 for ADMIN, not 405', async (path, method) => {
      await request(server())[method](path).set(asAdmin()).expect(403);
    });

    it('401s an unauthenticated caller before anything else', async () => {
      await request(server()).get('/api/activity/year').expect(401);
      await request(server()).post('/api/activity/year').expect(401);
      await request(server()).delete('/api/activity/1').expect(401);
    });
  });

  // ==========================================================================
  // Beyond v1's suite — the response envelope (finding F4)
  // ==========================================================================
  describe('DRF response headers', () => {
    it.each([
      ['/api/activity/year', 'GET, POST, HEAD, OPTIONS'],
      ['/api/activity/year/1', 'GET, POST, HEAD, OPTIONS'],
      ['/api/activity/1', 'GET, PATCH, DELETE, HEAD, OPTIONS'],
    ])('%s carries Allow: %s and Vary: Accept', async (path, allow) => {
      const response = await request(server()).get(path).set(asAdmin());
      expect(response.headers['allow']).toBe(allow);
      expect(response.headers['vary']).toContain('Accept');
    });

    /** DRF attaches `default_response_headers` to the 403 raised in `initial()` too (F1/F4). */
    it('carries them on a permission denial as well', async () => {
      const email = 'member_headers@mail.com';
      await seedUser(prisma, { email, identification: 4242n, role: Role.MEMBER });
      const memberToken = await obtainToken(app, email);

      const response = await request(server())
        .delete('/api/activity/1')
        .set(authHeader(memberToken))
        .expect(403);
      expect(response.headers['allow']).toBe('GET, PATCH, DELETE, HEAD, OPTIONS');
    });
  });

  // ==========================================================================
  // Beyond v1's suite — the wire format (rule 5b, rule 5c)
  // ==========================================================================
  describe('the wire format', () => {
    /**
     * ⚠️ Rule **5b**. `Activity.value` and `ActivityYear.year` are `BigIntegerField`s, which
     * DRF renders as bare JSON **numbers**. The reflex `BigInt.prototype.toJSON = toString`
     * fix would emit `"30000"` and `"2020"`. Asserted on the raw response text, because
     * `JSON.parse` erases the difference.
     */
    it('renders year and value as bare JSON numbers, not strings', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);

      const years = await request(server()).get('/api/activity/year').set(asAdmin()).expect(200);
      expect(years.text).toContain('"year":2020');
      expect(years.text).not.toContain('"year":"2020"');

      const detail = await request(server())
        .get(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .expect(200);
      expect(detail.text).toContain('"value":30000');
      expect(detail.text).not.toContain('"value":"30000"');
      // the nested UserProfileSerializer's identification is a BigIntegerField too
      expect(detail.text).toContain('"identification":99999');
    });

    /**
     * ⚠️ Rule **5c does not apply here.** `ActivityDetailSerializer.date` is a plain
     * `ModelSerializer` field, so DRF renders ISO. `payday_limit` and `from_date` next door in
     * Phase 4 render `7 nov. 2020`; this one must not.
     */
    it('renders date as ISO YYYY-MM-DD, not the Spanish babel spelling', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);

      const response = await request(server())
        .get(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .expect(200);

      expect(response.text).toContain('"date":"2020-11-07"');
      expect(response.text).not.toMatch(/nov\./);
    });

    it('renders Content-Type: application/json with no charset', async () => {
      await seedActivityYear(prisma, { year: 2020 });
      const response = await request(server()).get('/api/activity/year').set(asAdmin()).expect(200);
      expect(response.headers['content-type']).toBe('application/json');
    });
  });

  // ==========================================================================
  // Beyond v1's suite — the parser policy (condition C10)
  // ==========================================================================
  describe('the parser policy', () => {
    /**
     * ⚠️ **`ActivityYearView.post` never touches `request.data`** (`views/activity.py:38`), so
     * DRF never negotiates a parser and no `Content-Type` can 415 it. This is one of the two
     * regressions that produced condition **C10**; without `@DrfNoRequestData()` the
     * interceptor answers 415 here.
     */
    it('POST /api/activity/year with text/plain is a 201 (C10)', async () => {
      await request(server())
        .post('/api/activity/year')
        .set(asAdmin())
        .set('Content-Type', 'text/plain')
        .send('not json at all')
        .expect(201);
    });

    /** The positive control: a handler that *does* read the body still 415s. */
    it('POST /api/activity/year/<id> with text/plain is a 415', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      await request(server())
        .post(`/api/activity/year/${String(year.id)}`)
        .set(asAdmin())
        .set('Content-Type', 'text/plain')
        .send('not json at all')
        .expect(415);
    });

    /**
     * ⚠️ `ActivityDetailView.patch` returns the 400 **before** it evaluates `request.data`, so
     * an unparsable body under `?patch=invalid` is a 400 and not a 415 — and the same body
     * under a valid `patch=` *is* a 415. One handler, two parser outcomes.
     */
    it('PATCH ?patch=invalid with text/plain is a 400, but a valid patch= is a 415', async () => {
      await request(server())
        .patch('/api/activity/1?patch=invalid')
        .set(asAdmin())
        .set('Content-Type', 'text/plain')
        .send('nope')
        .expect(400);

      await request(server())
        .patch('/api/activity/1?patch=activity')
        .set(asAdmin())
        .set('Content-Type', 'text/plain')
        .send('nope')
        .expect(415);
    });

    /** `DELETE` never has request data either. */
    it('DELETE /api/activity/<id> is a 200 whatever the Content-Type says', async () => {
      await request(server())
        .delete('/api/activity/9999')
        .set(asAdmin())
        .set('Content-Type', 'text/plain')
        .expect(200);
    });
  });

  // ==========================================================================
  // Beyond v1's suite — side effects (plan §4 rule 8, rule 10)
  // ==========================================================================
  describe('side effects', () => {
    /**
     * ⚠️ **Plan §4 rule 10 — the cascade is ours to write.** `ActivityUser.activity` is
     * `on_delete=CASCADE` in `models.py:87`, but every FK in this database is `NO ACTION` /
     * `DEFERRABLE INITIALLY DEFERRED` (measured on `fondodev` and here). Django cascades in
     * Python; Prisma does not cascade at all. Without the explicit child delete this cell is
     * a deferred FK violation at `COMMIT`, i.e. a 500.
     */
    it('DELETE removes the ActivityUser children the database will not cascade', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);
      const other = await createActivity(year.id, { ...activityJson, name: 'Other' });

      expect(await prisma.activityUser.count({ where: { activity_id: activityId } })).toBe(1);

      await request(server())
        .delete(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .expect(200);

      expect(await prisma.activityUser.count({ where: { activity_id: activityId } })).toBe(0);
      expect(await prisma.activity.findUnique({ where: { id: activityId } })).toBeNull();
      // and it touched nothing else
      expect(await prisma.activityUser.count({ where: { activity_id: other } })).toBe(1);
      expect(await prisma.activity.count()).toBe(1);
    });

    /** `filter(id=id).delete()` — no existence check, so a miss is still a 200. */
    it('DELETE on an id that never existed is a 200', async () => {
      const response = await request(server())
        .delete('/api/activity/987654')
        .set(asAdmin())
        .expect(200);
      expect(response.text).toBe('');
    });

    /**
     * `__add_users` filters `is_active = True`. A soft-deleted member is excluded, and the
     * order is the inherited pk.
     */
    it('attaches only active users, in id order', async () => {
      const second = await seedUser(prisma, {
        email: 'second@mail.com',
        identification: 1111n,
        role: Role.MEMBER,
      });
      await seedUser(prisma, {
        email: 'inactive@mail.com',
        identification: 2222n,
        role: Role.MEMBER,
        isActive: false,
      });
      const year = await seedActivityYear(prisma, { year: 2020 });

      const activityId = await createActivity(year.id);

      const rows = await prisma.activityUser.findMany({
        where: { activity_id: activityId },
        orderBy: { id: 'asc' },
      });
      expect(rows.map((row) => row.user_id)).toEqual([admin.id, second.id]);
      expect(rows.every((row) => row.state === 0)).toBe(true);
    });

    /**
     * ⚠️ **`create_year` has no transaction, and the retry is not inert.** Verified against v1
     * source: no `@transaction.atomic`, and no `ATOMIC_REQUESTS` in any settings module, so
     * Django is in autocommit. The disable commits on its own statement; the insert then
     * collides and the view answers **304** on a request that did write.
     * `docs/phase-5-prework.md` §2. Ported as written — do **not** add a transaction.
     */
    it('a same-year retry re-disables the highest other year and still answers 304', async () => {
      const bogotaYear = Number(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Bogota',
          year: 'numeric',
        }).format(new Date()),
      );
      const older = await seedActivityYear(prisma, { year: bogotaYear - 6 });
      await request(server()).post('/api/activity/year').set(asAdmin()).expect(201);
      expect(
        (await prisma.activityYear.findUniqueOrThrow({ where: { id: older.id } })).enable,
      ).toBe(false);

      // re-enable by hand, exactly the state production is in, then retry
      await prisma.activityYear.update({ where: { id: older.id }, data: { enable: true } });
      await request(server()).post('/api/activity/year').set(asAdmin()).expect(304);

      expect(
        (await prisma.activityYear.findUniqueOrThrow({ where: { id: older.id } })).enable,
      ).toBe(false);
    });

    /**
     * ⚠️ **Not "disable the previous year".** With a gap in the table the row disabled is the
     * highest *other* year, whatever it is — here 2019, with 2020 and 2021 absent.
     */
    it('disables the highest other year across a gap, and only that one', async () => {
      const bogotaYear = Number(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Bogota',
          year: 'numeric',
        }).format(new Date()),
      );
      const y2018 = await seedActivityYear(prisma, { year: 2018 });
      const y2019 = await seedActivityYear(prisma, { year: 2019 });

      await request(server()).post('/api/activity/year').set(asAdmin()).expect(201);

      expect(
        (await prisma.activityYear.findUniqueOrThrow({ where: { id: y2019.id } })).enable,
      ).toBe(false);
      // 2018 is untouched — exactly one row is written
      expect(
        (await prisma.activityYear.findUniqueOrThrow({ where: { id: y2018.id } })).enable,
      ).toBe(true);
      expect(
        (await prisma.activityYear.findFirstOrThrow({ where: { year: BigInt(bogotaYear) } }))
          .enable,
      ).toBe(true);
    });

    /**
     * Two enabled years is a state production is already in
     * (`docs/phase-5-prework.md` §1). Nothing enforces "exactly one", and the serializer
     * echoes both.
     */
    it('serves two enabled years without complaint', async () => {
      await seedActivityYear(prisma, { year: 2020, enable: true });
      await seedActivityYear(prisma, { year: 2026, enable: true });

      const response = await request(server()).get('/api/activity/year').set(asAdmin()).expect(200);
      expect((response.body as { enable: boolean }[]).filter((y) => y.enable)).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Beyond v1's suite — the error contract
  // ==========================================================================
  describe('the error contract', () => {
    /** `GET /api/activity/year/<id>` never 404s: nothing looks the year up. */
    it('GET /api/activity/year/<unknown> is a 200 with []', async () => {
      const response = await request(server())
        .get('/api/activity/year/987654')
        .set(asAdmin())
        .expect(200);
      expect(response.body).toEqual([]);
    });

    /** ⚠️ A missing body key on `create_activity` is an uncaught `KeyError` → **500**. */
    it.each(['name', 'value', 'date'])(
      'POST /api/activity/year/<id> without %s is a 500, and writes nothing',
      async (missing) => {
        const year = await seedActivityYear(prisma, { year: 2020 });
        const body: Record<string, unknown> = { ...activityJson };
        delete body[missing];

        await request(server())
          .post(`/api/activity/year/${String(year.id)}`)
          .set(asAdmin())
          .send(body)
          .expect(500);

        expect(await prisma.activity.count()).toBe(0);
        expect(await prisma.activityUser.count()).toBe(0);
      },
    );

    /**
     * ⚠️ An `id_year` that does not exist is a **500**: the FK is `DEFERRABLE INITIALLY
     * DEFERRED`, so the violation surfaces at `COMMIT` — when `transaction.atomic` exits —
     * and nothing catches it. Not a 404 and not a 400.
     */
    it('POST /api/activity/year/<unknown> is a 500 and rolls the whole unit back', async () => {
      await request(server())
        .post('/api/activity/year/987654')
        .set(asAdmin())
        .send(activityJson)
        .expect(500);

      expect(await prisma.activity.count()).toBe(0);
      expect(await prisma.activityUser.count()).toBe(0);
    });

    /**
     * ⚠️ **`patch_activity`'s bare `except:` is the whole error contract.** Every row here is
     * a 404 with a zero-byte body in v1 — never a 400 and never a 500.
     */
    it.each<[string, string, object]>([
      ['a missing name', 'activity', { value: 1, date: '2020-01-01' }],
      ['a missing value', 'activity', { name: 'a', date: '2020-01-01' }],
      ['a missing date', 'activity', { name: 'a', value: 1 }],
      ['a non-numeric value', 'activity', { name: 'a', value: 'abc', date: '2020-01-01' }],
      ['a null value', 'activity', { name: 'a', value: null, date: '2020-01-01' }],
      ['a null name', 'activity', { name: null, value: 1, date: '2020-01-01' }],
      ['an invalid date', 'activity', { name: 'a', value: 1, date: '2020-13-01' }],
      ['a missing id', 'user', { state: 1 }],
      ['a missing state', 'user', { id: 1 }],
      ['a non-numeric state', 'user', { id: 1, state: 'x' }],
      ['an unknown ActivityUser', 'user', { id: 987654, state: 1 }],
    ])('PATCH with %s (?patch=%s) is a 404 with no body', async (_label, patch, body) => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);

      const response = await request(server())
        .patch(`/api/activity/${String(activityId)}?patch=${patch}`)
        .set(asAdmin())
        .send(body)
        .expect(404);
      expect(response.text).toBe('');
    });

    /**
     * The positive control for the block above: the same route, the same shape of body, a
     * **200**. Without it every 404 could be a broken route rather than the bare `except:`.
     */
    it('positive control: a well-formed PATCH on the same route is a 200', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);

      await request(server())
        .patch(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .send(activityJson)
        .expect(200);
    });

    /**
     * **P5-F1.** `name` is assigned through `TextField.get_prep_value`, which is `str()` for a
     * non-string — CPython's **repr** for a container, measured on the pinned stack:
     * `['a']` -> `"['a']"`, `{'a': 1}` -> `"{'a': 1}"`. On the create path it is only visible
     * in the row; on the patch path `patch_activity` answers with a fresh `get_activity(id)`,
     * so the stored string goes straight back on the wire.
     */
    it.each<[unknown, string]>([
      [['a'], "['a']"],
      [[1, 2], '[1, 2]'],
      [[], '[]'],
      [{ a: 1 }, "{'a': 1}"],
      [{}, '{}'],
      [{ a: [1, { b: 2 }] }, "{'a': [1, {'b': 2}]}"],
      [5, '5'],
      [5.5, '5.5'],
      [true, 'True'],
      ['x', 'x'],
    ])('P5-F1: POST /api/activity/year/<id> with name %p stores %p', async (name, expected) => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      await request(server())
        .post(`/api/activity/year/${String(year.id)}`)
        .set(asAdmin())
        .send({ ...activityJson, name })
        .expect(201);

      const row = await prisma.activity.findFirstOrThrow({ where: { year_id: year.id } });
      expect(row.name).toBe(expected);
    });

    it.each<[unknown, string]>([
      [['a'], "['a']"],
      [{ a: 1 }, "{'a': 1}"],
      [{ a: [1, { b: 2 }] }, "{'a': [1, {'b': 2}]}"],
      ['x', 'x'],
    ])(
      'P5-F1: PATCH /api/activity/<id> with name %p answers %p in the 200 body',
      async (name, expected) => {
        const year = await seedActivityYear(prisma, { year: 2020 });
        const activityId = await createActivity(year.id);

        const response = await request(server())
          .patch(`/api/activity/${String(activityId)}`)
          .set(asAdmin())
          .send({ ...activityJson, name })
          .expect(200);
        expect((response.body as { name: string }).name).toBe(expected);

        const row = await prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
        expect(row.name).toBe(expected);
      },
    );

    /** `?patch=` present but empty is `''`, which is neither value — a 400. */
    it('PATCH ?patch= (empty) is a 400', async () => {
      await request(server()).patch('/api/activity/1?patch=').set(asAdmin()).expect(400);
    });

    /** `QueryDict.get` returns the **last** value of a repeated key. */
    it('PATCH ?patch=invalid&patch=activity takes the last value', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);

      await request(server())
        .patch(`/api/activity/${String(activityId)}?patch=invalid&patch=activity`)
        .set(asAdmin())
        .send(activityJson)
        .expect(200);

      await request(server())
        .patch(`/api/activity/${String(activityId)}?patch=activity&patch=invalid`)
        .set(asAdmin())
        .send(activityJson)
        .expect(400);
    });

    /** No `patch=` at all defaults to `'activity'`. */
    it('PATCH with no patch= defaults to activity', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);

      const response = await request(server())
        .patch(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .send(activityJson)
        .expect(200);
      expect((response.body as { name: string }).name).toBe('New Activity for tests');
    });

    /**
     * ⚠️ **The measured asymmetry.** `create_activity` calls `int(data['value'])`;
     * `__update_activity` assigns it raw and lets `BigIntegerField.get_prep_value` — which is
     * also `int()` — do the work. They agree on every value that converts, and the response is
     * a **fresh** `get_activity(id)`, so the stored number is what the caller sees.
     */
    it.each<[unknown, number]>([
      ['30000', 30000],
      [30000.7, 30000],
      [30000.0, 30000],
      [true, 1],
    ])('create and patch both store %p as %i', async (input, expected) => {
      const year = await seedActivityYear(prisma, { year: 2020 });

      const created = await createActivity(year.id, { ...activityJson, value: input });
      expect((await prisma.activity.findUniqueOrThrow({ where: { id: created } })).value).toBe(
        BigInt(expected),
      );

      const patched = await request(server())
        .patch(`/api/activity/${String(created)}`)
        .set(asAdmin())
        .send({ name: 'a', date: '2020-01-01', value: input })
        .expect(200);
      expect((patched.body as { value: number }).value).toBe(expected);
    });

    /**
     * ⚠️ …and the one input on which they part. `int(None)` is a `TypeError` on the create
     * path (uncaught → **500**); `get_prep_value(None)` returns `None` on the update path and
     * the `NOT NULL` violation lands in the bare `except:` (→ **404**). Measured on the pinned
     * stack in the v1 container, not inferred.
     */
    it('a null value is a 500 on create and a 404 on patch', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });

      await request(server())
        .post(`/api/activity/year/${String(year.id)}`)
        .set(asAdmin())
        .send({ ...activityJson, value: null })
        .expect(500);

      const activityId = await createActivity(year.id);
      await request(server())
        .patch(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .send({ name: 'a', date: '2020-01-01', value: null })
        .expect(404);
    });

    /**
     * ⚠️ `state` is not validated against `STATE_TYPES`: Django checks `choices` in
     * `full_clean()`, which `save()` never calls. v1 writes it; so does v2.
     */
    it.each([7, -1])('PATCH ?patch=user writes an out-of-choices state %i', async (state) => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await createActivity(year.id);
      const row = await prisma.activityUser.findFirstOrThrow({
        where: { activity_id: activityId },
      });

      const response = await request(server())
        .patch(`/api/activity/${String(activityId)}?patch=user`)
        .set(asAdmin())
        .send({ id: row.id, state })
        .expect(200);

      expect((response.body as { users: { state: number }[] }).users[0].state).toBe(state);
    });

    /**
     * ⚠️ `get(activity_id = id, id = activity_user_id)` — the **pair** is the lookup, so an
     * `ActivityUser` id from another activity is a 404, not a cross-activity write.
     */
    it('PATCH ?patch=user refuses an ActivityUser belonging to another activity', async () => {
      const year = await seedActivityYear(prisma, { year: 2020 });
      const first = await createActivity(year.id);
      const second = await createActivity(year.id, { ...activityJson, name: 'Other' });
      const foreign = await prisma.activityUser.findFirstOrThrow({
        where: { activity_id: second },
      });

      await request(server())
        .patch(`/api/activity/${String(first)}?patch=user`)
        .set(asAdmin())
        .send({ id: foreign.id, state: 2 })
        .expect(404);

      expect(
        (await prisma.activityUser.findUniqueOrThrow({ where: { id: foreign.id } })).state,
      ).toBe(0);
    });

    /**
     * Python's `int` is arbitrary precision and PostgreSQL compares an `integer` column
     * against an out-of-range literal happily, so v1 resolves, queries and misses. `Number()`
     * would lose precision and Prisma would 500. See `activity-path-id.ts`.
     */
    it('an id far outside int4 is the handler’s own miss path, not a 500', async () => {
      await request(server()).get('/api/activity/99999999999999999999').set(asAdmin()).expect(404);
      await request(server())
        .delete('/api/activity/99999999999999999999')
        .set(asAdmin())
        .expect(200);
      const response = await request(server())
        .get('/api/activity/year/99999999999999999999')
        .set(asAdmin())
        .expect(200);
      expect(response.body).toEqual([]);
    });

    /**
     * The `ActivityUser` rows come back ordered by `user_id`, which for an activity created
     * through the API is also insertion order.
     */
    it('GET /api/activity/<id> orders the users by user_id', async () => {
      const second = await seedUser(prisma, {
        email: 'ordered@mail.com',
        identification: 3333n,
        role: Role.MEMBER,
      });
      const year = await seedActivityYear(prisma, { year: 2020 });
      const activityId = await seedActivity(prisma, {
        yearId: year.id,
        name: 'a',
        value: 1000,
        date: '2020-01-01',
      });
      // inserted in the *reverse* of user_id order, so the ordering cannot pass by accident
      await seedActivityUser(prisma, { activityId, userId: second.id });
      await seedActivityUser(prisma, { activityId, userId: admin.id });

      const response = await request(server())
        .get(`/api/activity/${String(activityId)}`)
        .set(asAdmin())
        .expect(200);
      const users = (response.body as { users: { user: { id: number } }[] }).users;
      expect(users.map((u) => u.user.id)).toEqual([admin.id, second.id]);
    });
  });
});
