import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { Role } from '../src/auth/permissions/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
  authHeader,
  obtainToken,
  resetDatabase,
  seedAdminUser,
  seedBasicUsers,
  seedUser,
  seedUserWithoutProfile,
  type SeededUser,
} from './support/abstract-test';

/**
 * Phase 1 e2e — `POST /api-token-auth` and the DRF authentication envelope.
 *
 * Every status/body assertion here was captured from the pinned v1 stack
 * (`Django==2.2.27`, `djangorestframework==3.11.2`) under v1's `REST_FRAMEWORK` settings;
 * see `docs/phase-1-drf-auth-bodies.md` for the derivation and the exact probe. v1's own
 * suite asserts none of them — `fondo_api/tests/abstract_test.py:get_token` only ever posts
 * valid credentials — so reading the source and running it was the only way to know.
 */
describe('Phase 1 — token authentication', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let inactive: SeededUser;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    admin = await seedAdminUser(prisma);
    await seedBasicUsers(prisma);
    inactive = await seedUser(prisma, {
      email: 'inactive@mail.com',
      identification: 424242n,
      role: Role.MEMBER,
      isActive: false,
    });
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  describe('POST /api-token-auth — ObtainAuthToken', () => {
    it('returns a 40-hex-character token for valid credentials', async () => {
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD })
        .expect(200);
      expect(Object.keys(response.body as object)).toEqual(['token']);
      expect((response.body as { token: string }).token).toMatch(/^[0-9a-f]{40}$/);
    });

    it('is get-or-create — logging in twice returns the same token, never rotated', async () => {
      // Members' clients cache the token; DRF's `Token.objects.get_or_create(user=user)`
      // guarantees stability and v1 relies on it.
      const first = await obtainToken(app, ADMIN_EMAIL);
      const second = await obtainToken(app, ADMIN_EMAIL);
      expect(second).toBe(first);

      const rows = await prisma.authToken.count({ where: { user_id: admin.id } });
      expect(rows).toBe(1);
    });

    it("accepts the optional trailing slash v1's url regex allows", async () => {
      // `url(r'^api-token-auth/?$', ...)`
      await request(app.getHttpServer())
        .post('/api-token-auth/')
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD })
        .expect(200);
    });

    it("accepts a form-encoded body as DRF's FormParser does", async () => {
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .type('form')
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD })
        .expect(200);
    });

    /**
     * §5 D18 / review finding S3 — request media-type handling. Every expectation below was
     * captured from the pinned stack (`Django==2.2.27`, `djangorestframework==3.11.2`) by
     * driving `rest_framework.request.Request` with DRF's `DEFAULT_PARSER_CLASSES`; the
     * transcript is in `docs/phase-1-drf-auth-bodies.md` §6.
     */
    describe('media types (D18)', () => {
      it("accepts multipart/form-data as DRF's MultiPartParser does", async () => {
        // The load-bearing row: Phase 3's `PATCH /api/user` and Phase 4's `PATCH /api/loan`
        // are multipart TSV uploads declaring `@parser_classes((MultiPartParser,))`.
        const response = await request(app.getHttpServer())
          .post('/api-token-auth')
          .field('username', ADMIN_EMAIL)
          .field('password', TEST_PASSWORD)
          .expect(200);

        expect((response.body as { token: string }).token).toMatch(/^[0-9a-f]{40}$/);
      });

      it("415s an unsupported media type, with DRF's wording", async () => {
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'text/plain')
          .send('username=admin')
          .expect(415)
          .expect({ detail: 'Unsupported media type "text/plain" in request.' });
      });

      it('keeps the Content-Type parameters in the 415 message, as DRF does', async () => {
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'application/xml; charset=utf-8')
          .send('<x/>')
          .expect(415)
          .expect({
            detail: 'Unsupported media type "application/xml; charset=utf-8" in request.',
          });
      });

      it('415s a binary body', async () => {
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from([0x00, 0x01, 0x02]))
          .expect(415)
          .expect({ detail: 'Unsupported media type "application/octet-stream" in request.' });
      });

      it('does NOT 415 an empty body, whatever the Content-Type', async () => {
        // `_load_stream` sets the stream to None when CONTENT_LENGTH is 0, so DRF returns an
        // empty QueryDict without negotiating and the serializer reports missing fields.
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'text/plain')
          .expect(400)
          .expect({
            username: ['This field is required.'],
            password: ['This field is required.'],
          });
      });

      it("renders CPython's own message for a malformed JSON body", async () => {
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'application/json')
          .send('not json')
          .expect(400)
          .expect({ detail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)' });
      });

      it("reports the character offset CPython reports, not Node's", async () => {
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'application/json')
          .send('{"username" "a"}')
          .expect(400)
          .expect({
            detail: "JSON parse error - Expecting ':' delimiter: line 1 column 13 (char 12)",
          });
      });

      describe('C11 / R4 — a top-level non-dict body is a serializer error, not a parse error', () => {
        // body-parser's `strict: true` rejected these with a SyntaxError CPython never
        // raises. `json.loads('5')` returns the int and DRF's serializer reports the type.
        it.each([
          ['5', 'int'],
          ['1.5', 'float'],
          ['"abc"', 'str'],
          ['true', 'bool'],
          ['null', 'NoneType'],
          ['[1, 2]', 'list'],
        ])('body %s -> "got %s"', async (body, pythonType) => {
          await request(app.getHttpServer())
            .post('/api-token-auth')
            .set('Content-Type', 'application/json')
            .send(body)
            .expect(400)
            .expect({
              non_field_errors: [`Invalid data. Expected a dictionary, but got ${pythonType}.`],
            });
        });
      });

      it('authenticates before parsing: a bad token 401s even on a malformed body', async () => {
        // DRF's `initial()` runs `perform_authentication` before the handler ever touches
        // `request.data`, so the parse error is never reached. This is the ordering the
        // deferred-parse design exists to preserve.
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Authorization', 'Token deadbeef')
          .set('Content-Type', 'application/json')
          .send('not json')
          .expect(401)
          .expect({ detail: 'Invalid token.' });
      });
    });

    it('authenticates by auth_user.username, not by email', async () => {
      // The plan says "v1 sets username = email everywhere". v1 *writes* that, but the live
      // `fondodev` database has two users where they differ (`ainhoa.montanez` /
      // `criss9413@hotmail.com`), and DRF authenticates against `username` because
      // AUTH_USER_MODEL is Django's default. Looking up `email` would lock them out.
      // See docs/phase-1-deviations.md §2.1.
      await prisma.authUser.update({
        where: { id: admin.id },
        data: { username: 'legacy.login.name' },
      });

      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: 'legacy.login.name', password: TEST_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD })
        .expect(400)
        .expect({ non_field_errors: ['Unable to log in with provided credentials.'] });

      await prisma.authUser.update({
        where: { id: admin.id },
        data: { username: ADMIN_EMAIL },
      });
    });

    it('does not update last_login — DRF calls authenticate(), not login()', async () => {
      await obtainToken(app, ADMIN_EMAIL);
      const user = await prisma.authUser.findUnique({
        where: { id: admin.id },
        select: { last_login: true },
      });
      expect(user?.last_login).toBeNull();
    });

    it("400s a wrong password with DRF's non_field_errors body", async () => {
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: ADMIN_EMAIL, password: 'wrong' })
        .expect(400);
      expect(response.body).toEqual({
        non_field_errors: ['Unable to log in with provided credentials.'],
      });
    });

    it('400s an unknown user with the identical body — no enumeration oracle', async () => {
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: 'nobody@mail.com', password: TEST_PASSWORD })
        .expect(400);
      expect(response.body).toEqual({
        non_field_errors: ['Unable to log in with provided credentials.'],
      });
    });

    it('400s a deactivated member with the identical body', async () => {
      // `DELETE /api/user/<id>` is a soft delete (`is_active = false`), and
      // `ModelBackend.user_can_authenticate` then refuses the login.
      expect(inactive.id).toBeGreaterThan(0);
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: 'inactive@mail.com', password: TEST_PASSWORD })
        .expect(400);
      expect(response.body).toEqual({
        non_field_errors: ['Unable to log in with provided credentials.'],
      });
    });

    it('400s missing fields, username key first', async () => {
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({})
        .expect(400);
      expect(response.body).toEqual({
        username: ['This field is required.'],
        password: ['This field is required.'],
      });
      expect(Object.keys(response.body as object)).toEqual(['username', 'password']);
    });

    it('400s a blank username and a blank password distinctly from missing', async () => {
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: '', password: TEST_PASSWORD })
        .expect(400)
        .expect({ username: ['This field may not be blank.'] });

      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: ADMIN_EMAIL, password: '' })
        .expect(400)
        .expect({ password: ['This field may not be blank.'] });
    });

    it('trims the username but not the password', async () => {
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: `  ${ADMIN_EMAIL}  `, password: TEST_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api-token-auth')
        .send({ username: ADMIN_EMAIL, password: ` ${TEST_PASSWORD} ` })
        .expect(400)
        .expect({ non_field_errors: ['Unable to log in with provided credentials.'] });
    });

    it("405s a GET, matching DRF's MethodNotAllowed body and Allow header", async () => {
      // `ObtainAuthToken` defines only `post`; Nest would 404 without an explicit fallback.
      const response = await request(app.getHttpServer()).get('/api-token-auth');
      expect(response.status).toBe(405);
      expect(response.body).toEqual({ detail: 'Method "GET" not allowed.' });
      expect(response.headers.allow).toBe('POST, OPTIONS');
    });

    describe('C10 / R1 — the 405 fallback never reads the body', () => {
      // `APIView.dispatch` resolves `http_method_not_allowed` and raises from there;
      // `request.data` is never touched, so no parser is ever negotiated. Without
      // `@DrfNoRequestData()` the interceptor fired first and answered 415 / 400.
      it('405s a PUT carrying a text/plain body, rather than 415ing', async () => {
        const response = await request(app.getHttpServer())
          .put('/api-token-auth')
          .set('Content-Type', 'text/plain')
          .send('anything at all');

        expect(response.status).toBe(405);
        expect(response.body).toEqual({ detail: 'Method "PUT" not allowed.' });
        expect(response.headers.allow).toBe('POST, OPTIONS');
      });

      it('405s a PATCH carrying malformed JSON, rather than 400ing', async () => {
        const response = await request(app.getHttpServer())
          .patch('/api-token-auth')
          .set('Content-Type', 'application/json')
          .send('{');

        expect(response.status).toBe(405);
        expect(response.body).toEqual({ detail: 'Method "PATCH" not allowed.' });
      });

      it('still 415s the same media type on POST — only the fallback is exempt', async () => {
        await request(app.getHttpServer())
          .post('/api-token-auth')
          .set('Content-Type', 'text/plain')
          .send('anything at all')
          .expect(415);
      });
    });

    it('405s the other unhandled methods too', async () => {
      const server = app.getHttpServer();
      const calls = {
        PUT: () => request(server).put('/api-token-auth'),
        PATCH: () => request(server).patch('/api-token-auth'),
        DELETE: () => request(server).delete('/api-token-auth'),
      };
      for (const [method, call] of Object.entries(calls)) {
        const response = await call();
        expect(response.status).toBe(405);
        expect(response.body).toEqual({ detail: `Method "${method}" not allowed.` });
      }
    });
  });

  describe('the Authorization header (TokenAuthentication)', () => {
    let token: string;

    beforeAll(async () => {
      token = await obtainToken(app, ADMIN_EMAIL);
    });

    it('authenticates `Token <key>` — the scheme is Token, never Bearer', async () => {
      await request(app.getHttpServer()).get('/health').set(authHeader(token)).expect(200);
    });

    it('401s an unknown token with `Invalid token.` and a Token challenge', async () => {
      // On a *wrong-method* request too: DRF runs `initial()` (authentication) before it
      // dispatches to `http_method_not_allowed`, so the 401 wins over the 405.
      const response = await request(app.getHttpServer())
        .get('/api-token-auth')
        .set('Authorization', `Token ${'0'.repeat(40)}`);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'Invalid token.' });
      expect(response.headers['www-authenticate']).toBe('Token');
    });

    it('401s a token belonging to a deactivated user', async () => {
      const staleToken = await prisma.authToken.create({
        data: { key: 'c'.repeat(40), user_id: inactive.id, created: new Date() },
        select: { key: true },
      });
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .set('Authorization', `Token ${staleToken.key}`)
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'User inactive or deleted.' });
      await prisma.authToken.delete({ where: { key: staleToken.key } });
    });

    it('401s a keyword-only header', async () => {
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .set('Authorization', 'Token')
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        detail: 'Invalid token header. No credentials provided.',
      });
    });

    it('401s a token containing spaces', async () => {
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .set('Authorization', 'Token abc def')
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        detail: 'Invalid token header. Token string should not contain spaces.',
      });
    });

    it('runs authentication before permissions, so a bad token 401s even on a public route', async () => {
      // v1: `permission_classes = []` clears permissions, never authenticators. The login
      // endpoint itself refuses to run while a broken token is attached.
      const response = await request(app.getHttpServer())
        .post('/api-token-auth')
        .set('Authorization', `Token ${'9'.repeat(40)}`)
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'Invalid token.' });
    });

    it('ignores a non-Token scheme entirely, leaving the request anonymous', async () => {
      // `TokenAuthentication.authenticate` returns None for a scheme it does not own; the
      // 401 then comes from IsAuthenticated with a *different* body.
      await request(app.getHttpServer())
        .post('/api-token-auth')
        .set('Authorization', `Bearer ${token}`)
        .send({ username: ADMIN_EMAIL, password: TEST_PASSWORD })
        .expect(200);
    });

    it('matches the scheme case-insensitively', async () => {
      await request(app.getHttpServer())
        .get('/health')
        .set('Authorization', `token ${token}`)
        .expect(200);
    });

    it('shares its tokens with v1 — the key column round-trips unchanged', async () => {
      // Parity criterion: "the same token string authenticates against both APIs". Both read
      // and write `authtoken_token.key` as the 40-hex primary key, with no encoding layer.
      const row = await prisma.authToken.findUnique({
        where: { key: token },
        select: { key: true, user_id: true },
      });
      expect(row).toEqual({ key: token, user_id: admin.id });
    });
  });

  describe('an auth_user row with no fondo_api_userprofile sibling', () => {
    it('authenticates but is denied by the role check, as in v1', async () => {
      const orphanId = await seedUserWithoutProfile(prisma, 'orphan@mail.com');
      const orphanToken = await prisma.authToken.create({
        data: { key: 'd'.repeat(40), user_id: orphanId, created: new Date() },
        select: { key: true },
      });
      // /health is @Public(), so it proves authentication itself succeeded...
      await request(app.getHttpServer())
        .get('/health')
        .set(authHeader(orphanToken.key))
        .expect(200);
      // ...while the role matrix denies anything guarded. Covered exhaustively in
      // role-matrix.e2e-spec.ts; asserted here for the authentication half.
      const row = await prisma.authUser.findUnique({
        where: { id: orphanId },
        select: { profile: true },
      });
      expect(row?.profile).toBeNull();
    });
  });
});
