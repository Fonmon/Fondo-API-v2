import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
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

  /**
   * `app.init()` wires the app up but never binds a socket, so the server has no address until
   * something listens; supertest hides this by calling `listen(0)` per request. The raw probe
   * needs a real port, so it binds one ephemeral listener and reuses it — supertest then reuses
   * the same address, and `app.close()` tears it down.
   */
  async function listeningPort(): Promise<number> {
    // supertest types `App` as `Server | string`; the Nest adapter always hands back a Server.
    const httpServer = server() as unknown as Server;
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', resolve);
      });
    }
    return (httpServer.address() as AddressInfo).port;
  }

  /**
   * A request written straight onto the socket, because **supertest cannot express a
   * fragment**: superagent normalises the URL and strips everything from the `#` on before it
   * writes the request line, so `POST /password_reset#frag` reaches the app as
   * `POST /password_reset` and the N4 cells below would pass against the unfixed code. This
   * sends the bytes verbatim, exactly as the raw-socket probe against v1 did.
   *
   * `headerLines` is a raw, already-CRLF-terminated header block, so a cell can forge a
   * `Host:` (condition **C19**) — something supertest also cannot express, because Node
   * derives the `Host` header from the connection.
   */
  async function rawRequest(
    target: string,
    method = 'POST',
    headerLines = 'Host: localhost\r\n',
  ): Promise<{
    status: number;
    location: string | undefined;
    headers: Record<string, string>;
    body: string;
  }> {
    const port = await listeningPort();
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `${method} ${target} HTTP/1.1\r\n${headerLines}Content-Length: 0\r\n` +
            'Connection: close\r\n\r\n',
        );
      });
      let buffer = '';
      socket.setEncoding('latin1');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
      });
      socket.on('end', () => {
        resolve(buffer);
      });
      socket.on('error', reject);
    });

    const [rawHead, ...rest] = raw.split('\r\n\r\n');
    const head = rawHead.split('\r\n');
    const status = Number(head[0].split(' ')[1]);
    const headers: Record<string, string> = {};
    for (const line of head.slice(1)) {
      const separator = line.indexOf(':');
      if (separator > 0) {
        headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
    }
    return { status, location: headers['location'], headers, body: rest.join('\r\n\r\n') };
  }

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
  // Round 2 — N1 / N2 / N3: the order and the encoding of the URL layer
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

  describe('N3 — percent-encoded literal segments reach the view, as in Django (C17)', () => {
    it('serves POST /api%2Dtoken%2Dauth — Django dispatches on the decoded PATH_INFO', async () => {
      const response = await request(server())
        .post('/api%2Dtoken%2Dauth')
        .send({ username: 'a', password: 'b' });

      // v1: 400 {"non_field_errors":["Unable to log in with provided credentials."]}
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        non_field_errors: ['Unable to log in with provided credentials.'],
      });
    });

    it('subscribes through POST /api/%6Eotification/subscribe and writes the row', async () => {
      const response = await request(server())
        .post('/api/%6Eotification/subscribe')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(200);
      expect(await countSubscriptions()).toBe(1);
    });

    it('401s the same encoded path unauthenticated — the guards still run', async () => {
      await request(server()).post('/%61pi/notification/subscribe').expect(401);
      expect(await countSubscriptions()).toBe(0);
    });

    it('does not widen the surface: decoding cannot smuggle a path v1 404s', async () => {
      // `%41PI` decodes to `API`, which the case-sensitive table refuses (F2 still holds).
      const response = await request(server())
        .post('/%41PI/notification/subscribe')
        .set(authHeader(memberToken))
        .send(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'Not Found' });
      expect(await countSubscriptions()).toBe(0);
    });

    it('still 404s an encoded separator — %2F decodes to a path with an extra segment', async () => {
      await request(server()).post('/api/notification/sub%2Fscribe').expect(404);
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

  // ---------------------------------------------------------------------------
  // Round 3 — N4: gunicorn drops the fragment before Django ever runs
  // ---------------------------------------------------------------------------

  describe('N4 — the request-target fragment reaches neither PATH_INFO nor Location (C18)', () => {
    // gunicorn's `parse_request_line` splits the target with `urlsplit` and `create()` copies
    // only `path` and `query` into the WSGI environ (`wsgi.py:97,191-194`); the fragment stays
    // on the request object, reachable only through `RAW_URI`, which Django never reads.
    // Statuses and Locations below are v1's, over a raw socket on :8443.

    it('301s a bare fragment — v1: 301 /password_reset/, v2 before the fix: 404', async () => {
      const { status, location } = await rawRequest('/password_reset#frag');

      expect(status).toBe(301);
      expect(location).toBe('/password_reset/');
    });

    it('drops a fragment after a query — v2 before the fix echoed `#frag` into Location', async () => {
      const { status, location } = await rawRequest('/password_reset?a=1#frag');

      expect(status).toBe(301);
      expect(location).toBe('/password_reset/?a=1');
    });

    it('still 404s the percent-encoded %23 — the control that the fix did not over-reach', async () => {
      // `%23` is not a delimiter: it decodes to a literal `#` *inside* PATH_INFO, so the path
      // is `/password_reset#frag`, which no pattern matches in either direction. 404 in v1
      // both before and after the fix.
      const { status, location } = await rawRequest('/password_reset%23frag');

      expect(status).toBe(404);
      expect(location).toBeUndefined();
    });

    it('splits on the first #, so a `?` inside the fragment is not a query string', async () => {
      // v1: POST /password_reset#frag?a=1 -> 301 /password_reset/ — no `?a=1`, because
      // `urlsplit` removed the fragment before it went looking for a `?`.
      const { status, location } = await rawRequest('/password_reset#frag?a=1');

      expect(status).toBe(301);
      expect(location).toBe('/password_reset/');
    });

    it('resolves a normal route carrying a fragment rather than 404ing it', async () => {
      // The resolver reads the same split, so the fragment must not reach the URL table
      // either. Unauthenticated, so this is the guard's 401 and not a 404.
      const { status } = await rawRequest('/api/notification/subscribe#frag');

      expect(status).toBe(401);
    });
  });
  // ---------------------------------------------------------------------------
  // Consider C5 — the URL table's `$` is only exact because Django >= 2.2.25
  // ---------------------------------------------------------------------------

  describe('C5 — a trailing %0A is a URL-conf 404, over the real transport', () => {
    // gunicorn's `unquote_to_wsgi_str` puts a literal `\n` in `PATH_INFO`, so this is a
    // reachable request target, not a theoretical one. Python's `$` matches before a trailing
    // newline; Django 2.2.25+ uses `re.fullmatch` for `$`-terminated patterns (CVE-2021-44420)
    // and 404s it. Live v1: 404 on all three. JS `$` agrees — by coincidence of that fix.
    it.each(['/api/notification/subscribe%0A', '/password_reset/%0A', '/api-token-auth%0A'])(
      '404s %s',
      async (target) => {
        const { status } = await rawRequest(target, 'POST');

        expect(status).toBe(404);
      },
    );

    it('serves the same targets without the %0A — the control', async () => {
      // 401 (guarded, unauthenticated) and 301 (APPEND_SLASH), not 404.
      expect((await rawRequest('/api/notification/subscribe', 'POST')).status).toBe(401);
      expect((await rawRequest('/password_reset', 'POST')).status).toBe(301);
    });
  });

  // ---------------------------------------------------------------------------
  // C19 / S3 — ALLOWED_HOSTS: the branch of CommonMiddleware that is not a no-op
  // ---------------------------------------------------------------------------

  describe('C19 — a forged Host is a 400 before anything else runs', () => {
    // ⚠️ SECURITY REGRESSION CELLS. `CommonMiddleware.process_request` calls
    // `request.get_host()` (django/middleware/common.py:47) before the APPEND_SLASH check,
    // and `get_host()` raises `DisallowedHost` -> 400 for a host outside ALLOWED_HOSTS.
    // Phase 3's `PasswordResetView` builds the emailed reset link's domain from that same
    // call (`fondo_api/views/auth.py:37-42`), so deleting the middleware these cells cover
    // reintroduces reset-link poisoning. Every status below was measured on the live v1.
    //
    // The suite runs with ENVIRONMENT=test, i.e. v1's `test.py`: `ALLOWED_HOSTS = []` with
    // `DEBUG = True`, which `get_host()` turns into `['localhost', '127.0.0.1', '[::1]']`.
    // Measured against `api.settings.development` (identical settings) on the live v1.
    const preflight = (host: string): string =>
      `Host: ${host}\r\nOrigin: http://x.test\r\nAccess-Control-Request-Method: GET\r\n`;

    // `/api/notification/subscribe` rather than `/api/loan`: the loan route resolves in the
    // URL table but has no v2 controller until Phase 4, so its 404 would mask the 400.
    it('400s a guarded route — v1: 400 (Host: localhost -> 401), v2 before: served', async () => {
      const { status } = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        'Host: evil.test\r\n',
      );

      expect(status).toBe(400);
    });

    it('400s ahead of the APPEND_SLASH 301 — v1: 400 (Host: localhost -> 301)', async () => {
      const forged = await rawRequest('/password_reset', 'OPTIONS', preflight('evil.test'));
      const allowed = await rawRequest('/password_reset', 'OPTIONS', preflight('localhost'));

      expect(forged.status).toBe(400);
      expect(forged.location).toBeUndefined();
      expect(allowed.status).toBe(301);
    });

    it('400s ahead of the CORS preflight short-circuit — v1: 400 (Host: localhost -> 200)', async () => {
      const forged = await rawRequest('/nope/nope', 'OPTIONS', preflight('evil.test'));
      const allowed = await rawRequest('/nope/nope', 'OPTIONS', preflight('localhost'));

      expect(forged.status).toBe(400);
      expect(allowed.status).toBe(200);
    });

    it('400s ahead of authentication, credentials or not', async () => {
      const anonymous = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        'Host: evil.test\r\n',
      );
      const authenticated = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        `Host: evil.test\r\nAuthorization: Token ${adminToken}\r\n`,
      );

      expect(anonymous.status).toBe(400);
      expect(authenticated.status).toBe(400);
    });

    it('carries no Vary, no X-Frame-Options and no Access-Control-* — slots 4-8 never ran', async () => {
      // v1's 400 is built by the exception wrapper around slot 3, so nothing below it
      // decorates the response. Measured: Server/Date/Connection/Content-Type only.
      const { status, headers } = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        preflight('evil.test'),
      );

      expect(status).toBe(400);
      expect(headers['vary']).toBeUndefined();
      expect(headers['x-frame-options']).toBeUndefined();
      expect(headers['access-control-allow-origin']).toBeUndefined();
      expect(headers['x-powered-by']).toBeUndefined();
    });

    it('renders the D13 JSON body where v1 renders `<h1>Bad Request (400)</h1>`', async () => {
      const { headers, body } = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        'Host: evil.test\r\n',
      );

      expect(body).toBe('{"message":"Bad Request"}');
      expect(headers['content-type']).toBe('application/json');
    });

    it.each([
      ['localhost', 401],
      ['LOCALHOST', 401],
      ['localhost:9999', 401],
      ['localhost.', 401],
      ['127.0.0.1', 401],
      ['[::1]', 401],
      ['evil.test', 400],
      ['local_host', 400],
      ['localhost:', 400],
      ['.localhost', 400],
    ])('Host: %s -> %s, matching v1 exactly', async (host, expected) => {
      const { status } = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        `Host: ${host}\r\n`,
      );

      expect(status).toBe(expected);
    });

    it('ignores X-Forwarded-Host — USE_X_FORWARDED_HOST is False in v1 (P2-D9)', async () => {
      const { status } = await rawRequest(
        '/api/notification/subscribe',
        'POST',
        'Host: localhost\r\nX-Forwarded-Host: evil.test\r\n',
      );

      expect(status).toBe(401);
    });

    it('does not disturb the supertest transport, which sends Host: 127.0.0.1:<port>', async () => {
      const response = await request(server()).post('/api/notification/subscribe');

      expect(response.status).toBe(401);
    });
  });
});
