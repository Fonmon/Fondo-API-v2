import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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
  seedUser,
  type SeededUser,
} from './support/abstract-test';

/**
 * Parity finding **F6** — DRF's content negotiation, through the whole `AppModule` pipeline.
 *
 * ## Why this is an e2e file and not only a unit one
 *
 * The finding is about **ordering**, not about the negotiation function: v1 raises
 * `NotAcceptable` in `APIView.initial()`, *before* `perform_authentication`, *before*
 * `check_permissions`, before `dispatch` picks the handler and before any write. A unit test
 * of `selectRenderer` cannot see any of that. Each cell below therefore pairs an
 * unacceptable `Accept` with a request that would otherwise produce a **different**
 * status — 401, 403, 405, 415, 400, 200, and a 200 that writes a row — and asserts the 406
 * displaces it. Both columns were measured on the live v1 (`api.settings.production`,
 * gunicorn).
 *
 * ## Every cell carries its positive control
 *
 * A test asserting only "406" would pass against an implementation that 406s everything.
 * Each block asserts the *same request* under `Accept: star/star` too, so the cell can only
 * pass if the 406 is caused by the header and not by the request being broken — the
 * countermeasure the false-green register (`MIGRATION_PLAN.md` §7) requires.
 */
describe('Phase 3 — F6: DRF content negotiation (406 before authentication)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let member: SeededUser;
  let adminToken: string;
  let memberToken: string;

  const server = (): App => app.getHttpServer();
  const UNACCEPTABLE = 'application/xml';
  const NOT_ACCEPTABLE_BODY = { detail: 'Could not satisfy the request Accept header.' };
  const NOT_FOUND_BODY = { detail: 'Not found.' };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication<INestApplication<App>>(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    admin = await seedUser(prisma, {
      email: 'negotiation.admin@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    member = await seedUser(prisma, {
      email: 'negotiation.member@mail.com',
      identification: 1001n,
      role: Role.MEMBER,
    });
    adminToken = await obtainToken(app, admin.email);
    memberToken = await obtainToken(app, member.email);
  });

  afterAll(async () => {
    await app.close();
  });

  const asAdmin = (): Record<string, string> => authHeader(adminToken);

  describe('the 406 displaces every status that comes after it in `initial()`', () => {
    it('displaces the 200 — GET /api/user', async () => {
      const ok = await request(server()).get('/api/user').set(asAdmin()).set('Accept', '*/*');
      expect(ok.status).toBe(200);

      const refused = await request(server())
        .get('/api/user')
        .set(asAdmin())
        .set('Accept', UNACCEPTABLE);
      expect(refused.status).toBe(406);
      expect(refused.body).toEqual(NOT_ACCEPTABLE_BODY);
    });

    it('displaces the 401 from a bad token — negotiation precedes authentication', async () => {
      const unauthorised = await request(server())
        .get('/api/user')
        .set('Authorization', 'Token deadbeef')
        .set('Accept', '*/*');
      expect(unauthorised.status).toBe(401);

      const refused = await request(server())
        .get('/api/user')
        .set('Authorization', 'Token deadbeef')
        .set('Accept', UNACCEPTABLE);
      expect(refused.status).toBe(406);
      expect(refused.body).toEqual(NOT_ACCEPTABLE_BODY);
    });

    it('displaces the 401 from no credentials at all', async () => {
      expect((await request(server()).get('/api/user').set('Accept', '*/*')).status).toBe(401);
      expect((await request(server()).get('/api/user').set('Accept', UNACCEPTABLE)).status).toBe(
        406,
      );
    });

    it('displaces the 403 — negotiation precedes the permission check', async () => {
      const denied = await request(server())
        .post('/api/user')
        .set(authHeader(memberToken))
        .set('Accept', '*/*')
        .send({});
      expect(denied.status).toBe(403);

      const refused = await request(server())
        .post('/api/user')
        .set(authHeader(memberToken))
        .set('Accept', UNACCEPTABLE)
        .send({});
      expect(refused.status).toBe(406);
    });

    it('displaces the 405 — negotiation precedes the handler lookup in `dispatch`', async () => {
      const notAllowed = await request(server())
        .get(`/api/user/activate/${admin.id}`)
        .set('Accept', '*/*');
      expect(notAllowed.status).toBe(405);
      expect(notAllowed.body).toEqual({ detail: 'Method "GET" not allowed.' });

      const refused = await request(server())
        .get(`/api/user/activate/${admin.id}`)
        .set('Accept', UNACCEPTABLE);
      expect(refused.status).toBe(406);
      expect(refused.body).toEqual(NOT_ACCEPTABLE_BODY);
    });

    it('displaces the 415 — negotiation precedes `request.data`', async () => {
      const unsupported = await request(server())
        .post('/api/user')
        .set(asAdmin())
        .set('Accept', '*/*')
        .set('Content-Type', 'text/plain')
        .send('x');
      expect(unsupported.status).toBe(415);

      const refused = await request(server())
        .post('/api/user')
        .set(asAdmin())
        .set('Accept', UNACCEPTABLE)
        .set('Content-Type', 'text/plain')
        .send('x');
      expect(refused.status).toBe(406);
    });

    it('displaces the 200 metadata document on `OPTIONS /api-token-auth` (JSONRenderer only)', async () => {
      const metadata = await request(server()).options('/api-token-auth').set('Accept', '*/*');
      expect(metadata.status).toBe(200);

      const refused = await request(server())
        .options('/api-token-auth')
        .set('Accept', UNACCEPTABLE);
      expect(refused.status).toBe(406);
    });

    it('makes `Accept: text/html` a 406 on `/api-token-auth` but not on a browsable view', async () => {
      // `ObtainAuthToken.renderer_classes = (JSONRenderer,)`; every `fondo_api` view keeps
      // DRF's default pair, so `text/html` selects BrowsableAPIRenderer there — v1 renders an
      // HTML page and v2 answers JSON, which is registered as **P3-D8**, not a 406.
      const tokenRoute = await request(server())
        .post('/api-token-auth')
        .set('Accept', 'text/html')
        .send({});
      expect(tokenRoute.status).toBe(406);

      const browsable = await request(server())
        .get('/api/user')
        .set(asAdmin())
        .set('Accept', 'text/html');
      expect(browsable.status).toBe(200);
    });
  });

  describe('⚠️ the write case — v1 refuses before any side effect, and now so does v2', () => {
    it('does not soft-delete the user it would have deleted under `Accept: star/star`', async () => {
      const victim = await seedUser(prisma, {
        email: 'negotiation.victim@mail.com',
        identification: 424242n,
        role: Role.MEMBER,
      });

      const refused = await request(server())
        .delete(`/api/user/${victim.id}`)
        .set(asAdmin())
        .set('Accept', UNACCEPTABLE);
      expect(refused.status).toBe(406);
      expect(
        (await prisma.authUser.findUniqueOrThrow({ where: { id: victim.id } })).is_active,
      ).toBe(true);

      // Positive control — the identical request without the header really does mutate, so
      // the assertion above cannot be passing because the route is inert.
      const deleted = await request(server())
        .delete(`/api/user/${victim.id}`)
        .set(asAdmin())
        .set('Accept', '*/*');
      expect(deleted.status).toBe(200);
      expect(
        (await prisma.authUser.findUniqueOrThrow({ where: { id: victim.id } })).is_active,
      ).toBe(false);
    });
  });

  describe('the `Accept` values that agree on both stacks', () => {
    it.each([
      '*/*',
      'application/json',
      'application/*',
      'application/json; charset=utf-8',
      'application/json;foo',
      'zzz, application/json',
      // DRF sorts by specificity, not by q: JSON wins despite the lower q.
      'application/json;q=0.1,text/html;q=0.9',
    ])('serves JSON for Accept: %s', async (accept) => {
      const response = await request(server())
        .get('/api/user')
        .set(asAdmin())
        .set('Accept', accept);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/json');
    });

    it.each(['application/xml', 'text/plain', 'nonsense/nonsense', ','])(
      'is a 406 for Accept: %s',
      async (accept) => {
        const response = await request(server())
          .get('/api/user')
          .set(asAdmin())
          .set('Accept', accept);
        expect(response.status).toBe(406);
        expect(response.body).toEqual(NOT_ACCEPTABLE_BODY);
      },
    );

    it('leaves the four plain-Django password-reset pages alone — they never negotiate', async () => {
      for (const accept of ['*/*', 'text/html', 'application/xml', 'nonsense/nonsense']) {
        const response = await request(server()).get('/password_reset/').set('Accept', accept);
        expect(response.status).toBe(200);
      }
    });
  });

  describe('the 406 keeps the DRF headers v1 attaches before `initial()` runs', () => {
    it('carries `Allow`, `Vary: Accept, Origin` and a bare `application/json`', async () => {
      const response = await request(server())
        .get('/api/user')
        .set(asAdmin())
        .set('Accept', UNACCEPTABLE)
        .set('Origin', 'http://x.test');
      expect(response.status).toBe(406);
      expect(response.headers.allow).toBe('GET, POST, PATCH, HEAD, OPTIONS');
      expect(response.headers.vary).toBe('Accept, Origin');
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.text).toBe(JSON.stringify(NOT_ACCEPTABLE_BODY));
    });

    it('has no `Vary: Accept` on `/api-token-auth`, which declares one renderer', async () => {
      const response = await request(server())
        .options('/api-token-auth')
        .set('Accept', UNACCEPTABLE)
        .set('Origin', 'http://x.test');
      expect(response.status).toBe(406);
      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.headers.vary).toBe('Origin');
    });
  });

  describe('the `?format=` override — a 404 before authentication, not a 406', () => {
    it('404s an unknown format, and does so on a bad token too', async () => {
      const refused = await request(server())
        .get('/api/user?format=xml')
        .set(asAdmin())
        .set('Accept', '*/*');
      expect(refused.status).toBe(404);
      expect(refused.body).toEqual(NOT_FOUND_BODY);

      const unauthenticated = await request(server())
        .get('/api/user?format=xml')
        .set('Authorization', 'Token deadbeef')
        .set('Accept', '*/*');
      expect(unauthenticated.status).toBe(404);
    });

    it('serves the request for a format a renderer declares — the positive control', async () => {
      for (const format of ['json', 'api']) {
        const response = await request(server())
          .get(`/api/user?format=${format}`)
          .set(asAdmin())
          .set('Accept', '*/*');
        expect(response.status).toBe(200);
      }
    });

    it('takes the LAST value of a repeated `format`, as `QueryDict` does', async () => {
      expect(
        (await request(server()).get('/api/user?format=xml&format=json').set(asAdmin())).status,
      ).toBe(200);
      expect(
        (await request(server()).get('/api/user?format=json&format=xml').set(asAdmin())).status,
      ).toBe(404);
    });

    it('narrows the renderers and then still negotiates', async () => {
      const response = await request(server())
        .get('/api/user?format=json')
        .set(asAdmin())
        .set('Accept', UNACCEPTABLE);
      expect(response.status).toBe(406);
    });

    it('ignores an empty `?format=`', async () => {
      expect((await request(server()).get('/api/user?format=').set(asAdmin())).status).toBe(200);
    });

    it('404s `?format=api` on `/api-token-auth`, which has no such renderer', async () => {
      const response = await request(server())
        .post('/api-token-auth?format=api')
        .set('Accept', '*/*')
        .send({});
      expect(response.status).toBe(404);
      expect(response.body).toEqual(NOT_FOUND_BODY);
    });
  });
});
