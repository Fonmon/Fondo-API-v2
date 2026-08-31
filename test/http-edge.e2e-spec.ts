import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { SQS_CLIENT } from '../src/notifications/sqs.client';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedUser,
  type SeededUser,
} from './support/abstract-test';
import { V1_TEST_SUBSCRIPTION } from './support/push-subscription.fixture';

/**
 * Regressions for the three HTTP-edge findings of the Phase 2 parity report
 * (`docs/parity-phase-2.md`) plus the header set they were found alongside.
 *
 * **Why these have their own file.** F1, F2 and F3 are all the same species of bug: a
 * *framework default* silently diverging from Django, on a surface no controller mentions.
 * None of them could fail a controller unit test, and F1 in particular was invisible to the
 * whole e2e suite because `app.enableCors()` lived in `main.ts`, which the suites never
 * execute. Everything that shapes a response now lives in `AppModule`, and this file boots
 * the real one.
 *
 * Every expectation below is a byte the running v1 produced (gunicorn,
 * `api.settings.production`, `DEBUG = False`) for the same request.
 */
describe('Phase 2 — HTTP edge parity (F1-F4, N1-N3)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let member: SeededUser;
  let adminToken: string;
  let memberToken: string;
  const sqs = { send: jest.fn() };

  const server = (): App => app.getHttpServer();

  async function countSubscriptions(): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) AS count FROM fondo_api_notificationsubscriptions',
    );
    return Number(rows[0].count);
  }

  async function storedEndpoints(): Promise<(string | null)[]> {
    const rows = await prisma.$queryRawUnsafe<{ endpoint: string | null }[]>(
      "SELECT subscription -> 'endpoint' AS endpoint FROM fondo_api_notificationsubscriptions",
    );
    return rows.map((row) => row.endpoint);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SQS_CLIENT)
      .useValue(sqs)
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    admin = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    member = await seedUser(prisma, {
      email: 'member@mail.com',
      identification: 1001n,
      role: Role.MEMBER,
    });
    adminToken = await obtainToken(app, admin.email);
    memberToken = await obtainToken(app, member.email);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM fondo_api_notificationsubscriptions');
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // F1 — a bare OPTIONS is authenticated and permission-checked
  // ---------------------------------------------------------------------------

  describe('F1 — OPTIONS is not a free pass (condition C14)', () => {
    it('401s a bare OPTIONS with no credentials — v1: 401, v2 before: 204', async () => {
      const response = await request(server()).options('/api/notification/subscribe');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        detail: 'Authentication credentials were not provided.',
      });
      expect(response.headers['www-authenticate']).toBe('Token');
    });

    it.each([
      ['ADMIN', (): string => adminToken],
      ['MEMBER', (): string => memberToken],
    ])(
      '403s a bare OPTIONS for %s — list_permissions[NotificationView] declares only POST',
      async (_role, token) => {
        const response = await request(server())
          .options('/api/notification/subscribe')
          .set(authHeader(token()));

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          detail: 'You do not have permission to perform this action.',
        });
      },
    );

    it('403s a bare OPTIONS that carries an Origin, and still decorates it with CORS', async () => {
      const response = await request(server())
        .options('/api/notification/subscribe')
        .set(authHeader(adminToken))
        .set('Origin', 'http://x.test');

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      // v1 adds the OPTIONS trio to *any* OPTIONS response carrying an Origin, not only to
      // the short-circuited preflight.
      expect(response.headers['access-control-allow-methods']).toBe(
        'DELETE, GET, OPTIONS, PATCH, POST, PUT',
      );
      expect(response.headers['access-control-max-age']).toBe('86400');
      expect(response.headers.vary).toBe('Accept, Origin');
    });

    it('answers a genuine preflight with 200 and no body, ahead of the guards', async () => {
      const response = await request(server())
        .options('/api/notification/subscribe')
        .set('Origin', 'http://x.test')
        .set('Access-Control-Request-Method', 'POST');

      // ⚠️ 200, not 204: `corsheaders` returns `http.HttpResponse()`.
      expect(response.status).toBe(200);
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['content-length']).toBe('0');
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-headers']).toBe(
        'accept, accept-encoding, authorization, content-type, dnt, origin, user-agent, ' +
          'x-csrftoken, x-requested-with',
      );
      expect(response.headers['access-control-allow-methods']).toBe(
        'DELETE, GET, OPTIONS, PATCH, POST, PUT',
      );
      expect(response.headers['access-control-max-age']).toBe('86400');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      // The view never ran, so DRF's per-view headers are absent.
      expect(response.headers.allow).toBeUndefined();
    });

    it('short-circuits a preflight with no Origin too, without the CORS headers', async () => {
      const response = await request(server())
        .options('/api/notification/subscribe')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(200);
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-max-age']).toBeUndefined();
    });

    it('short-circuits a preflight on a URL that does not resolve — corsheaders runs first', async () => {
      const response = await request(server())
        .options('/API/notification/subscribe')
        .set('Origin', 'http://x.test')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(200);
    });

    it.each(['get', 'put', 'patch', 'delete'] as const)(
      '403s an unmapped %s, via the @All fallback',
      async (method) => {
        const response = await request(server())
          [method]('/api/notification/subscribe')
          .set(authHeader(adminToken));

        expect(response.status).toBe(403);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // F2 / P2-D5 / S7 — the URL conf runs before the guards (condition C9)
  // ---------------------------------------------------------------------------

  describe('F2 — routing is case-sensitive, as Django `url()` is', () => {
    it('404s POST /API/notification/subscribe and writes nothing — was 200 + a row', async () => {
      const response = await request(server())
        .post('/API/notification/subscribe')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'Not Found' });
      expect(await countSubscriptions()).toBe(0);
    });

    it('404s the same URL unauthenticated — it is not a route at all', async () => {
      await request(server()).post('/API/notification/subscribe').expect(404);
    });

    it('still serves the correctly-cased path', async () => {
      await request(server())
        .post('/api/notification/subscribe')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION)
        .expect(200);
      expect(await countSubscriptions()).toBe(1);
    });

    it('leaves the operation segment case-insensitive — `[a-zA-Z]+` matches SUBSCRIBE', async () => {
      // v1 resolves it, then the view falls through to its empty 405.
      const response = await request(server())
        .post('/api/notification/SUBSCRIBE')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(405);
      expect(response.text).toBe('');
      expect(await countSubscriptions()).toBe(0);
    });
  });

  describe('P2-D5 — the [a-zA-Z]+ constraint 404s before authentication', () => {
    it('404s an unauthenticated POST /api/notification/sub1 (was 401)', async () => {
      const response = await request(server()).post('/api/notification/sub1');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'Not Found' });
      expect(response.headers['www-authenticate']).toBeUndefined();
    });

    it('404s it authenticated as well', async () => {
      await request(server())
        .post('/api/notification/sub1')
        .set(authHeader(adminToken))
        .expect(404);
    });
  });

  describe('S7 — the trailing slash follows v1’s table, route by route', () => {
    it('accepts /api/notification/subscribe/ — the pattern carries /?', async () => {
      await request(server())
        .post('/api/notification/subscribe/')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION)
        .expect(200);
    });

    it.each([
      '/api/notification/subscribe//',
      '/api/notification/',
      '/api/notification',
      '/api/notification/subscribe/extra',
      '/api-token-auth//',
      '/api/alexa',
    ])('404s %s before any guard', async (path) => {
      await request(server()).post(path).expect(404);
    });

    it('accepts both forms of /api-token-auth, which carries /?', async () => {
      await request(server())
        .post('/api-token-auth/')
        .send({ username: admin.email, password: 'password' })
        .expect(200);
    });
  });

  describe('APPEND_SLASH — CommonMiddleware 301s the four mandatory-slash paths', () => {
    it('301s POST /password_reset to /password_reset/ (DEBUG is off in production)', async () => {
      const response = await request(server()).post('/password_reset');

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe('/password_reset/');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      // ⚠️ `CommonMiddleware` sits above the CORS and clickjacking middlewares, so this one
      // response carries none of their headers. Verified live, Origin included.
      expect(response.headers.vary).toBeUndefined();
      expect(response.headers['x-frame-options']).toBeUndefined();
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('keeps the query string, as get_full_path does', async () => {
      const response = await request(server()).get('/password_reset?next=a%20b');

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe('/password_reset/?next=a%20b');
    });

    it('does not invent a redirect for a path whose slashed form does not resolve either', async () => {
      await request(server()).get('/nope').expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Round 2 — N1 / N2: the order and the encoding of the URL layer
  // ---------------------------------------------------------------------------

  describe('N1 — APPEND_SLASH fires above corsheaders, resolution below it (C15)', () => {
    it.each(['/password_reset', '/password_reset/done', '/reset/done', '/reset/MQ/abc-def'])(
      '301s a genuine preflight on %s — v1: 301, v2 before the fix: 200',
      async (path) => {
        // `CommonMiddleware` is 3rd in v1's MIDDLEWARE and `corsheaders.CorsMiddleware` is
        // 8th/last, so the redirect is returned before the preflight short-circuit ever runs.
        const response = await request(server())
          .options(path)
          .set('Origin', 'https://x.test')
          .set('Access-Control-Request-Method', 'POST');

        expect(response.status).toBe(301);
        expect(response.headers.location).toBe(`${path}/`);
        expect(response.headers['content-length']).toBe('0');
        // The response never passes back through CORS or clickjacking.
        expect(response.headers.vary).toBeUndefined();
        expect(response.headers['x-frame-options']).toBeUndefined();
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers['access-control-allow-methods']).toBeUndefined();
        expect(response.headers['access-control-max-age']).toBeUndefined();
      },
    );

    it('301s the same preflight without an Origin — corsheaders does not require one', async () => {
      const response = await request(server())
        .options('/password_reset')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe('/password_reset/');
    });

    it('still 200s a preflight on a path nothing resolves — the 404 is *below* corsheaders', async () => {
      // The mirror of the case above, and the reason the URL layer is two middlewares: in
      // v1 the resolver 404 comes from `BaseHandler`, under all eight middlewares.
      const response = await request(server())
        .options('/nope/nope')
        .set('Origin', 'https://x.test')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(200);
      expect(response.headers['content-length']).toBe('0');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    it('leaves a bare OPTIONS on an APPEND_SLASH path a 301 as well, not a guard 401', async () => {
      await request(server()).options('/password_reset').expect(301);
    });
  });

  describe('N2 — the 301 Location is escape_uri_path(PATH_INFO), not the target (C16)', () => {
    it.each([
      ['/password%5Freset', '/password_reset/'],
      ['/password%5freset', '/password_reset/'],
      ['/pass%77ord_reset', '/password_reset/'],
      ['/password_reset%2Fdone', '/password_reset/done/'],
      ['/reset/M%51/abc-def', '/reset/MQ/abc-def/'],
    ])('redirects %s to %s — v1 decodes, then re-encodes', async (target, location) => {
      const response = await request(server()).post(target);

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(location);
    });

    it('leaves an already-encoded query string alone (iri_to_uri keeps `%` safe)', async () => {
      const response = await request(server()).post('/password_reset?a=%C3%B1&b=1');

      expect(response.headers.location).toBe('/password_reset/?a=%C3%B1&b=1');
    });
  });

  // ---------------------------------------------------------------------------
  // F3 — QueryDict last-value semantics
  // ---------------------------------------------------------------------------

  describe('F3 — a repeated form field stores the last value', () => {
    it('stores the last `endpoint`, not the array (was "[’a’, ’b’]")', async () => {
      await request(server())
        .post('/api/notification/subscribe')
        .set(authHeader(memberToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('endpoint=https://parity.test/dup1&endpoint=https://parity.test/dup2&keys=k')
        .expect(200);

      expect(await storedEndpoints()).toEqual(['https://parity.test/dup2']);
    });

    it('does the same for a repeated multipart field', async () => {
      await request(server())
        .post('/api/notification/subscribe')
        .set(authHeader(memberToken))
        .field('endpoint', 'https://parity.test/multi1')
        .field('endpoint', 'https://parity.test/multi2')
        .field('keys', 'k')
        .expect(200);

      expect(await storedEndpoints()).toEqual(['https://parity.test/multi2']);
    });

    it('leaves a single-valued form field alone', async () => {
      await request(server())
        .post('/api/notification/subscribe')
        .set(authHeader(memberToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('endpoint=https://parity.test/single&keys=k')
        .expect(200);

      expect(await storedEndpoints()).toEqual(['https://parity.test/single']);
    });
  });

  // ---------------------------------------------------------------------------
  // F4 — the response header set
  // ---------------------------------------------------------------------------

  describe('F4 — response headers match v1', () => {
    it('puts DRF’s per-view headers on a 403 the guard raised', async () => {
      const response = await request(server())
        .get('/api/notification/subscribe')
        .set(authHeader(adminToken));

      expect(response.status).toBe(403);
      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.headers.vary).toBe('Accept, Origin');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      // DRF's JSONRenderer has `charset = None`.
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers.etag).toBeUndefined();
    });

    it('omits Content-Type entirely on a zero-byte DRF body', async () => {
      // `Response(status=405)` — `if not ret: del self['Content-Type']`.
      const response = await request(server())
        .post('/api/notification/suscribe')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(405);
      expect(response.text).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.headers.vary).toBe('Accept, Origin');
    });

    it('gives ObtainAuthToken no `Vary: Accept` — it declares one renderer', async () => {
      const response = await request(server()).post('/api-token-auth').send({});

      expect(response.status).toBe(400);
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers.allow).toBe('POST, OPTIONS');
    });

    it('drops Allow and Vary: Accept on a 500, as Django’s handler does', async () => {
      // No `endpoint` key -> the service raises; v1 500s here too (§4.4).
      const response = await request(server())
        .post('/api/notification/subscribe')
        .set(authHeader(memberToken))
        .set('Origin', 'http://x.test')
        .send({});

      expect(response.status).toBe(500);
      expect(response.headers.allow).toBeUndefined();
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('patches Vary: Origin onto a resolver 404 as well', async () => {
      const response = await request(server()).get('/nope');

      expect(response.status).toBe(404);
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers.allow).toBeUndefined();
    });
  });
});
