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
 * Parity finding **F8** — malformed `multipart/form-data`, through the whole pipeline.
 *
 * Round 2 reported three content types crossing the 400/500 line in opposite directions. The
 * cause turned out to be one thing rather than three: v2 parsed multipart with **busboy**
 * (under multer), a strict RFC parser that aborts on anything malformed, while v1 uses
 * **Django's**, which raises in exactly three places and salvages everything else.
 * `src/common/http/django-multipart.ts` ports Django's; this file is its behaviour seen from
 * the outside.
 *
 * Two endpoints, because the same parse result surfaces differently:
 *
 *  * `POST /api-token-auth` reads `request.data['username']` through a serializer, so an
 *    empty parse is a **400** naming the missing fields — which makes the parse result
 *    *visible* — and the route is zero-write for bad credentials;
 *  * `PATCH /api/user` does `obj['file']`, so an empty parse is a `MultiValueDictKeyError`,
 *    i.e. an uncaught **500**. That is where round 2 saw its 500s.
 *
 * Every v1 column below was measured on the live oracle (`api.settings.production`).
 */
describe('Phase 3 — F8: Django multipart parsing', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: SeededUser;
  let member: SeededUser;
  let adminToken: string;
  let memberToken: string;

  const server = (): App => app.getHttpServer();

  /** A well-formed two-field body, the positive control every malformed cell is measured against. */
  const WELL_FORMED =
    '--zzz\r\nContent-Disposition: form-data; name="username"\r\n\r\nnobody@example.com\r\n' +
    '--zzz\r\nContent-Disposition: form-data; name="password"\r\n\r\nwrong\r\n' +
    '--zzz--\r\n';

  /** A well-formed single **file** part, which `PATCH /api/user` needs. */
  const TSV_UPLOAD =
    '--zzz\r\nContent-Disposition: form-data; name="file"; filename="f.tsv"\r\n' +
    'Content-Type: text/plain\r\n\r\n99999999\t1\t2\t3\t4\r\n--zzz--\r\n';

  const BOTH_REQUIRED = {
    username: ['This field is required.'],
    password: ['This field is required.'],
  };

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
      email: 'multipart.admin@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    member = await seedUser(prisma, {
      email: 'multipart.member@mail.com',
      identification: 1001n,
      role: Role.MEMBER,
    });
    adminToken = await obtainToken(app, admin.email);
    memberToken = await obtainToken(app, member.email);
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (contentType: string, body: string): request.Test =>
    request(server()).post('/api-token-auth').set('Content-Type', contentType).send(body);

  const patchUsers = (contentType: string, body: string): request.Test =>
    request(server())
      .patch('/api/user')
      .set(authHeader(adminToken))
      .set('Content-Type', contentType)
      .send(body);

  describe('`POST /api-token-auth`, where the parse result is visible', () => {
    it('the positive control: a well-formed body reaches the serializer with both fields', async () => {
      const response = await token('multipart/form-data; boundary=zzz', WELL_FORMED);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        non_field_errors: ['Unable to log in with provided credentials.'],
      });
    });

    it('no `boundary` parameter at all is NOT a parse error — the view sees empty data', async () => {
      // v1 400 {"username":[…],"password":[…]}; v2 answered
      // `Multipart form parse error - Multipart: Boundary not found` before this fix.
      const response = await token('multipart/form-data', WELL_FORMED);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(BOTH_REQUIRED);
    });

    it('an EMPTY `boundary=` is a 400 with Django`s own diagnostic — F8`s sharpest row', async () => {
      // v1 400 with this exact detail; v2 answered a bare **500** before this fix.
      const response = await token('multipart/form-data; boundary=', WELL_FORMED);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        detail: 'Multipart form parse error - Invalid boundary in multipart: ',
      });
    });

    it.each([
      ['a trailing space', 'multipart/form-data; boundary="zzz "', 'zzz '],
      ['a tab', 'multipart/form-data; boundary="a\tb"', 'a\tb'],
      ['202 characters', `multipart/form-data; boundary=${'a'.repeat(202)}`, 'a'.repeat(202)],
    ])('rejects a boundary with %s (cgi.valid_boundary)', async (_name, contentType, shown) => {
      const response = await token(contentType, WELL_FORMED);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        detail: `Multipart form parse error - Invalid boundary in multipart: ${shown}`,
      });
    });

    it('accepts a 201-character boundary — the limit is 201, not 200', async () => {
      const response = await token(`multipart/form-data; boundary=${'a'.repeat(201)}`, WELL_FORMED);
      // The body's own boundary is `zzz`, so the whole body becomes one part whose header
      // yields `username`; only `password` is missing. Measured identically on v1.
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ password: ['This field is required.'] });
    });

    it.each([
      ['a body that is not multipart at all', 'garbage not multipart at all\n', BOTH_REQUIRED],
      [
        'a part with no Content-Disposition',
        '--zzz\r\n\r\nno disposition\r\n--zzz--\r\n',
        BOTH_REQUIRED,
      ],
      [
        'a part truncated mid-stream',
        '--zzz\r\nContent-Disposition: form-data; name="username"\r\n\r\nnobody@example.com\r\n',
        { password: ['This field is required.'] },
      ],
      [
        'a body using a different boundary',
        '--www\r\nContent-Disposition: form-data; name="username"\r\n\r\nx\r\n--www--\r\n',
        { password: ['This field is required.'] },
      ],
    ])('salvages %s rather than 400ing the parse', async (_name, body, expected) => {
      const response = await token('multipart/form-data; boundary=zzz', body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(expected);
    });

    it('accepts a quoted boundary and a differently-cased parameter name', async () => {
      for (const contentType of [
        'multipart/form-data; boundary="zzz"',
        'multipart/form-data; BOUNDARY=zzz',
      ]) {
        const response = await token(contentType, WELL_FORMED);
        expect(response.body).toEqual({
          non_field_errors: ['Unable to log in with provided credentials.'],
        });
      }
    });

    it('is still a 415 for `multipart/mixed`, which no parser declares', async () => {
      const response = await token('multipart/mixed; boundary=zzz', WELL_FORMED);
      expect(response.status).toBe(415);
      expect(response.body).toEqual({
        detail: 'Unsupported media type "multipart/mixed; boundary=zzz" in request.',
      });
    });
  });

  describe("`PATCH /api/user`, where an empty parse is `obj['file']` raising KeyError", () => {
    it('the positive control: a file part reaches the handler and the request succeeds', async () => {
      const response = await patchUsers('multipart/form-data; boundary=zzz', TSV_UPLOAD);
      expect(response.status).toBe(200);
      expect(response.text).toBe('');
    });

    it.each([
      ['no boundary parameter', 'multipart/form-data', TSV_UPLOAD],
      ['a body that is not multipart', 'multipart/form-data; boundary=zzz', 'garbage\n'],
    ])('is an uncaught 500 for %s — the KeyError, as in v1', async (_name, ct, body) => {
      const response = await patchUsers(ct, body);
      expect(response.status).toBe(500);
    });

    it('is a 400 for an empty boundary, not a 500', async () => {
      const response = await patchUsers('multipart/form-data; boundary=', TSV_UPLOAD);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        detail: 'Multipart form parse error - Invalid boundary in multipart: ',
      });
    });
  });

  describe('the parse error is raised where DRF raises it — after the guards', () => {
    it('answers 401 for a bad token even though the boundary is invalid', async () => {
      const response = await request(server())
        .patch('/api/user')
        .set('Authorization', 'Token deadbeef')
        .set('Content-Type', 'multipart/form-data; boundary=')
        .send(TSV_UPLOAD);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'Invalid token.' });
    });

    it('answers 403 for a MEMBER even though the boundary is invalid', async () => {
      const response = await request(server())
        .patch('/api/user')
        .set(authHeader(memberToken))
        .set('Content-Type', 'multipart/form-data; boundary=')
        .send(TSV_UPLOAD);
      expect(response.status).toBe(403);
    });

    it('answers 406 before the parser runs at all — F6 precedes F8', async () => {
      const response = await request(server())
        .patch('/api/user')
        .set(authHeader(adminToken))
        .set('Accept', 'application/xml')
        .set('Content-Type', 'multipart/form-data; boundary=')
        .send(TSV_UPLOAD);
      expect(response.status).toBe(406);
    });
  });

  describe("Django's `SuspiciousOperation` limits — a 400, not a 500 and not a widening", () => {
    const fields = (count: number): string =>
      `${Array.from(
        { length: count },
        (_unused, index) =>
          `--zzz\r\nContent-Disposition: form-data; name="k${index}"\r\n\r\nv\r\n`,
      ).join('')}--zzz--\r\n`;

    it('accepts exactly 1000 fields and rejects 1001', async () => {
      const accepted = await token('multipart/form-data; boundary=zzz', fields(1000));
      expect(accepted.status).toBe(400);
      expect(accepted.body).toEqual(BOTH_REQUIRED);

      const refused = await token('multipart/form-data; boundary=zzz', fields(1001));
      expect(refused.status).toBe(400);
      // Django answers its own HTML `<h1>Bad Request (400)</h1>` page here rather than a DRF
      // envelope — the registered D13 species, rendered as v2's `{"message": …}` analogue.
      expect(refused.body).toEqual({ message: 'Bad Request' });
    });

    it('accepts a 2 MiB field and rejects one over DATA_UPLOAD_MAX_MEMORY_SIZE', async () => {
      const field = (size: number): string =>
        `--zzz\r\nContent-Disposition: form-data; name="username"\r\n\r\n${'x'.repeat(size)}` +
        '\r\n--zzz--\r\n';

      const accepted = await token('multipart/form-data; boundary=zzz', field(2 * 1024 * 1024));
      expect(accepted.status).toBe(400);
      expect(accepted.body).toEqual({ password: ['This field is required.'] });

      const refused = await token(
        'multipart/form-data; boundary=zzz',
        field(2.5 * 1024 * 1024 + 1),
      );
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ message: 'Bad Request' });
    });
  });
});
