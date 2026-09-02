import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { EmailTemplate } from '../src/mail/email-template';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  csrfTokensMatch,
  maskCsrfSecret,
  newCsrfSecret,
  unmaskCsrfToken,
} from '../src/password-reset/django-csrf';
import { PasswordResetTokenService } from '../src/password-reset/password-reset-token.service';
import { resetDatabase, seedUser } from './support/abstract-test';

/**
 * Phase 3 e2e — password reset, the four `django.contrib.auth` pages and v1's own
 * `PasswordResetView.post`.
 *
 * v1 has **no tests at all** for this flow (`fondo_api/tests/` contains no auth-view file), so
 * nothing here is a port. Every expectation is derived from one of:
 *
 *  * the measured live-v1 header table in `docs/parity-phase-2.md` §R3.6 (the three `Vary`
 *    strings and their element order, the `Set-Cookie` on each route, the 302);
 *  * `Django==2.2.27` source read inside the v1 image (`contrib/auth/views.py`,
 *    `middleware/csrf.py`);
 *  * HTML captured by rendering v1's own templates through that Django (see
 *    `src/password-reset/templates/`).
 */
describe('Phase 3 — password reset', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: PasswordResetTokenService;
  /** `django_session` rows present before this suite runs; nothing here may change it. */
  let sessionRowsBefore: number;
  const sendMail = jest.fn<Promise<boolean>, unknown[]>();

  const MEMBER_EMAIL = 'reset.member@mail.com';
  let memberId: number;

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
    tokens = app.get(PasswordResetTokenService);
    await resetDatabase(prisma);
    const member = await seedUser(prisma, {
      email: MEMBER_EMAIL,
      identification: 700001n,
      role: Role.MEMBER,
    });
    memberId = member.id;
    sessionRowsBefore = await prisma.djangoSession.count();
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(true);
  });

  const csrfPair = (): { cookie: string; field: string } => {
    const secret = newCsrfSecret();
    return { cookie: maskCsrfSecret(secret), field: maskCsrfSecret(secret) };
  };

  const currentUser = async (): Promise<{
    id: number;
    password: string;
    last_login: Date | null;
  }> => {
    const row = await prisma.authUser.findUniqueOrThrow({
      where: { id: memberId },
      select: { id: true, password: true, last_login: true },
    });
    return row;
  };

  const uidOf = (id: number): string => Buffer.from(String(id), 'utf8').toString('base64url');

  // -------------------------------------------------------------------------

  describe('GET /password_reset/', () => {
    it('renders the Spanish form and sets a csrftoken cookie', async () => {
      const response = await request(app.getHttpServer()).get('/password_reset/').expect(200);

      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.text).toContain('<h2>Recuperación de contraseña</h2>');
      expect(response.text).toContain('name="csrfmiddlewaretoken"');
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((cookie) => cookie.startsWith('csrftoken='))).toBe(true);
    });

    /**
     * ⚠️ **The whole point of condition C21's depth model.** `PasswordResetView` carries
     * `@method_decorator(csrf_protect)`, which runs *below* all eight middlewares, so its
     * `Cookie` is patched into `Vary` **before** `corsheaders` adds `Origin`. Measured on the
     * live v1: `Cookie, Origin`.
     */
    it('answers Vary: Cookie, Origin — in that order', async () => {
      const response = await request(app.getHttpServer())
        .get('/password_reset/')
        .set('Origin', 'https://app.test')
        .expect(200);

      expect(response.headers.vary).toBe('Cookie, Origin');
    });

    it('re-uses a csrftoken the browser already has, and issues a different mask of it', async () => {
      const { cookie } = csrfPair();
      const response = await request(app.getHttpServer())
        .get('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .expect(200);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      const reissued = cookies.find((each) => each.startsWith('csrftoken='));
      expect(reissued).toContain(`csrftoken=${cookie}`);

      const field = /name="csrfmiddlewaretoken" value="([A-Za-z0-9]{64})"/.exec(response.text);
      expect(field).not.toBeNull();
      // A fresh mask of the same secret: a different string that still compares equal.
      expect(field?.[1]).not.toBe(cookie);
      expect(unmaskCsrfToken(field?.[1] as string)).toBe(unmaskCsrfToken(cookie));
      expect(csrfTokensMatch(cookie, field?.[1] as string)).toBe(true);
    });
  });

  describe('POST /password_reset/', () => {
    it('403s without a CSRF cookie, with Django’s failure page', async () => {
      const response = await request(app.getHttpServer())
        .post('/password_reset/')
        .type('form')
        .send({ email: MEMBER_EMAIL })
        .expect(403);

      expect(response.text).toContain('CSRF verification failed. Request aborted.');
      expect(response.text).toContain('this site requires a CSRF cookie when submitting forms');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('403s with a mismatched token, and the page omits the cookie advice', async () => {
      const { cookie } = csrfPair();
      const response = await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: MEMBER_EMAIL, csrfmiddlewaretoken: maskCsrfSecret(newCsrfSecret()) })
        .expect(403);

      expect(response.text).toContain('CSRF verification failed. Request aborted.');
      expect(response.text).not.toContain('this site requires a CSRF cookie');
    });

    it('sends the reset email and redirects to /password_reset/done/', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: MEMBER_EMAIL, csrfmiddlewaretoken: field })
        .expect(302);

      expect(response.headers.location).toBe('/password_reset/done/');
      expect(sendMail).toHaveBeenCalledTimes(1);
      const [template, recipients, params] = sendMail.mock.calls[0] as [
        EmailTemplate,
        string[],
        Record<string, string>,
      ];
      expect(template).toBe(EmailTemplate.PASSWORD_RESET);
      expect(recipients).toEqual([MEMBER_EMAIL]);
      expect(params.username).toBe(MEMBER_EMAIL);
      // `get_current_site` falls back to `RequestSite`, whose domain is the Host header —
      // which is why C19 had to close first. Supertest addresses the ephemeral server by IP.
      expect(params.domain).toMatch(/^127\.0\.0\.1:\d+$/);
      // `'https' if settings.ENVIRONMENT == 'production' else 'http'` — the suite is `test`.
      expect(params.protocol).toBe('http');
      expect(params.uid).toBe(uidOf(memberId));
      expect(params.token).toMatch(/^[0-9a-z]{1,13}-[0-9a-f]{20}$/);
    });

    it('redirects identically for an unknown address — no user enumeration', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: 'nobody@mail.com', csrfmiddlewaretoken: field })
        .expect(302);

      expect(response.headers.location).toBe('/password_reset/done/');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('redirects identically for a malformed address', async () => {
      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: 'not-an-email', csrfmiddlewaretoken: field })
        .expect(302);

      expect(sendMail).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ **Condition C19, made live by this phase.** `PasswordResetView` builds the emailed
     * link's host from `get_current_site(request)`, i.e. from the `Host` header. Without
     * `ALLOWED_HOSTS` an attacker sets `Host: evil.test` and the victim's reset token is
     * delivered to a domain they control. `DjangoAllowedHostsMiddleware` refuses first, and
     * the refusal is a **400 before the view runs** — so no mail is sent either.
     */
    it('C19: a forged Host is a 400 before the link is built, and no mail is sent', async () => {
      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .set('Host', 'evil.test')
        .type('form')
        .send({ email: MEMBER_EMAIL, csrfmiddlewaretoken: field })
        .expect(400);

      expect(sendMail).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ Verified live: v1 answers **302 and sends nothing** for a JSON body, because
     * `PasswordResetForm(request.POST)` reads `HttpRequest.POST`, which Django populates only
     * for `x-www-form-urlencoded` and `multipart/form-data`. Reading `request.data` here would
     * have made v2 email a member where v1 does not.
     */
    it('ignores a JSON body entirely — request.POST is form-only', async () => {
      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .set('X-CSRFToken', field)
        .send({ email: MEMBER_EMAIL })
        .expect(302);

      expect(sendMail).not.toHaveBeenCalled();
    });

    it('ignores a text/plain body and still redirects — never a 415', async () => {
      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .set('X-CSRFToken', field)
        .set('Content-Type', 'text/plain')
        .send(`email=${MEMBER_EMAIL}`)
        .expect(302);

      expect(sendMail).not.toHaveBeenCalled();
    });

    it('accepts a multipart body — the other content type request.POST parses', async () => {
      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .field('email', MEMBER_EMAIL)
        .field('csrfmiddlewaretoken', field)
        .expect(302);

      expect(sendMail).toHaveBeenCalledTimes(1);
    });

    it('PUT behaves exactly like POST — ProcessFormView defines `put = post`', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .put('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: MEMBER_EMAIL, csrfmiddlewaretoken: field })
        .expect(302);

      expect(response.headers.location).toBe('/password_reset/done/');
      expect(sendMail).toHaveBeenCalledTimes(1);
    });

    it('carries no Set-Cookie and no Cookie in Vary — the response is a redirect', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .set('Origin', 'https://app.test')
        .type('form')
        .send({ email: MEMBER_EMAIL, csrfmiddlewaretoken: field })
        .expect(302);

      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers.vary).toBe('Origin');
    });
  });

  describe('D17 / Q27 — two members sharing an email address', () => {
    it('resets the account whose username equals the email, not the child account', async () => {
      const shared = 'shared.parent@mail.com';
      const parent = await seedUser(prisma, {
        email: shared,
        identification: 700010n,
        role: Role.MEMBER,
      });
      // The custodial account: same email, its own username. `seedUser` keeps them equal, so
      // the child's username is set directly — exactly the live shape of users 13 and 14.
      const child = await prisma.authUser.create({
        data: {
          password: 'x',
          username: 'child.account',
          email: shared,
          first_name: 'Child',
          last_name: 'Account',
          is_superuser: false,
          is_staff: false,
          is_active: true,
          date_joined: new Date(),
          profile: { create: { identification: 700011n, role: Role.MEMBER } },
        },
        select: { id: true },
      });

      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: shared, csrfmiddlewaretoken: field })
        .expect(302);

      // ⚠️ v1 sends **nothing** here: `.get()` raises MultipleObjectsReturned into a bare
      // `except` and the member is shown the success page anyway. Four of fifteen live members
      // are in this state today.
      expect(sendMail).toHaveBeenCalledTimes(1);
      const [, , params] = sendMail.mock.calls[0] as [
        EmailTemplate,
        string[],
        Record<string, string>,
      ];
      expect(params.uid).toBe(uidOf(parent.id));
      expect(params.uid).not.toBe(uidOf(child.id));
      expect(params.username).toBe(shared);
    });

    it('sends nothing when no account has the shared address as its username', async () => {
      const shared = 'orphan.shared@mail.com';
      for (const [index, username] of ['first.child', 'second.child'].entries()) {
        await prisma.authUser.create({
          data: {
            password: 'x',
            username,
            email: shared,
            first_name: 'A',
            last_name: 'B',
            is_superuser: false,
            is_staff: false,
            is_active: true,
            date_joined: new Date(),
            profile: { create: { identification: BigInt(700020 + index), role: Role.MEMBER } },
          },
        });
      }

      const { cookie, field } = csrfPair();
      await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: shared, csrfmiddlewaretoken: field })
        .expect(302);

      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe('GET /reset/<uid>/<token>/ — the two-step hop', () => {
    it('302s to set-password and hands the token back in a cookie, never in a session row', async () => {
      const user = await currentUser();
      const token = tokens.makeToken(user);
      const response = await request(app.getHttpServer())
        .get(`/reset/${uidOf(memberId)}/${token}/`)
        .set('Origin', 'https://app.test')
        .expect(302);

      expect(response.headers.location).toBe(`/reset/${uidOf(memberId)}/set-password/`);
      const cookies = response.headers['set-cookie'] as unknown as string[];
      const reset = cookies.find((each) => each.startsWith('_password_reset_token='));
      expect(reset).toBeDefined();
      expect(reset).toContain(`_password_reset_token=${token}`);
      expect(reset).toContain('HttpOnly');
      expect(reset).toContain('Path=/reset/');

      // P3-D3: v1 writes a `django_session` row here. v2 writes none.
      await expect(prisma.djangoSession.count()).resolves.toBe(sessionRowsBefore);

      // Measured on v1: `Origin, Cookie` — the session patch is at slot 2, *above* corsheaders.
      expect(response.headers.vary).toBe('Origin, Cookie');
      // ⚠️ No `private`: Django 2.2's `add_never_cache_headers` does not pass it (3.0 does).
      expect(response.headers['cache-control']).toBe(
        'max-age=0, no-cache, no-store, must-revalidate',
      );
    });

    it('renders the invalid-link page for a bad token, with no cookie at all', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reset/${uidOf(memberId)}/abcdefg-0123456789abcdef0123/`)
        .set('Origin', 'https://app.test')
        .expect(200);

      expect(response.text).toContain('El enlace de restauración de contraseña es inválido');
      expect(response.headers['set-cookie']).toBeUndefined();
      // No session access, no csrf_token in the rendered branch.
      expect(response.headers.vary).toBe('Origin');
    });

    it('renders the invalid-link page for an unknown uid', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reset/${uidOf(999999)}/abcdefg-0123456789abcdef0123/`)
        .expect(200);

      expect(response.text).toContain('El enlace de restauración de contraseña es inválido');
    });

    it('404s a token that does not match the URL conf pattern', async () => {
      // `[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}` — no second hyphen allowed.
      await request(app.getHttpServer())
        .get(`/reset/${uidOf(memberId)}/aaa-bbb-ccc/`)
        .expect(404);
    });
  });

  describe('GET /reset/<uid>/set-password/', () => {
    it('renders the form when the cookie carries a valid token', async () => {
      const user = await currentUser();
      const token = tokens.makeToken(user);
      const response = await request(app.getHttpServer())
        .get(`/reset/${uidOf(memberId)}/set-password/`)
        .set('Cookie', `_password_reset_token=${token}`)
        .set('Origin', 'https://app.test')
        .expect(200);

      expect(response.text).toContain('<h2>Cambio de contraseña</h2>');
      expect(response.text).toContain('name="new_password1"');
      // Measured on v1: `Origin, Cookie`. `PasswordResetConfirmView` has **no** `csrf_protect`
      // decorator, so the cookie is written by `CsrfViewMiddleware` at slot 4 — below
      // corsheaders in the response phase, hence `Origin` first.
      expect(response.headers.vary).toBe('Origin, Cookie');
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((each) => each.startsWith('csrftoken='))).toBe(true);
    });

    it('renders the invalid-link page without the cookie, but still varies on Cookie', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reset/${uidOf(memberId)}/set-password/`)
        .set('Origin', 'https://app.test')
        .expect(200);

      expect(response.text).toContain('El enlace de restauración de contraseña es inválido');
      // The session is *accessed* on this branch whether or not it validates, and
      // `SessionMiddleware` keys `Vary: Cookie` on access, not on outcome.
      expect(response.headers.vary).toBe('Origin, Cookie');
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('POST /reset/<uid>/set-password/', () => {
    const post = async (token: string, body: Record<string, string>): Promise<request.Response> => {
      const { cookie, field } = csrfPair();
      return request(app.getHttpServer())
        .post(`/reset/${uidOf(memberId)}/set-password/`)
        .set('Cookie', [`csrftoken=${cookie}`, `_password_reset_token=${token}`])
        .type('form')
        .send({ ...body, csrfmiddlewaretoken: field });
    };

    it('changes the password, clears the cookie and redirects to /reset/done/', async () => {
      const before = await currentUser();
      const token = tokens.makeToken(before);
      const response = await post(token, {
        new_password1: 'una-clave-larga',
        new_password2: 'una-clave-larga',
      }).then((r) => r);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/reset/done/');
      const after = await currentUser();
      expect(after.password).not.toBe(before.password);
      expect(after.password.startsWith('pbkdf2_sha256$')).toBe(true);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((each) => each.startsWith('_password_reset_token=;'))).toBe(true);
    });

    it('makes the link single-use: the same token no longer validates', async () => {
      const before = await currentUser();
      const token = tokens.makeToken(before);
      await post(token, { new_password1: 'otra-clave-larga', new_password2: 'otra-clave-larga' });

      const replay = await post(token, {
        new_password1: 'tercera-clave',
        new_password2: 'tercera-clave',
      });
      expect(replay.status).toBe(200);
      expect(replay.text).toContain('El enlace de restauración de contraseña es inválido');
    });

    it("re-renders with Django's own mismatch message", async () => {
      const token = tokens.makeToken(await currentUser());
      const response = await post(token, { new_password1: 'abc', new_password2: 'xyz' });

      expect(response.status).toBe(200);
      expect(response.text).toContain(
        '<div class="alert alert-danger"><ul class="errorlist"><li>The two password fields ' +
          'didn&#39;t match.</li></ul></div>',
      );
    });

    it('applies v1’s two password validators, and only those two', async () => {
      const token = tokens.makeToken(await currentUser());

      const numeric = await post(token, { new_password1: '12345678', new_password2: '12345678' });
      expect(numeric.text).toContain('<li>This password is entirely numeric.</li>');

      const similar = await post(token, {
        new_password1: MEMBER_EMAIL,
        new_password2: MEMBER_EMAIL,
      });
      expect(similar.text).toContain('<li>The password is too similar to the username.</li>');

      // v1 removed MinimumLengthValidator and CommonPasswordValidator from the defaults, so a
      // short, common password is accepted.
      const short = await post(token, { new_password1: 'ab', new_password2: 'ab' });
      expect(short.status).toBe(302);
    });

    it('refuses without the reset cookie', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post(`/reset/${uidOf(memberId)}/set-password/`)
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ new_password1: 'x-y-z-w', new_password2: 'x-y-z-w', csrfmiddlewaretoken: field })
        .expect(200);

      expect(response.text).toContain('El enlace de restauración de contraseña es inválido');
    });
  });

  /**
   * Parity finding **F2**. `HttpResponseRedirect` is an ordinary `HttpResponse`, so all three
   * redirects this controller emits carry Django's default `Content-Type: text/html;
   * charset=utf-8` with `Content-Length: 0` — an empty *HTML* body. v2 sent none, which is
   * DRF's empty-body rule leaking onto a Django view that does not have it. Measured on the
   * live v1 for each of the three.
   */
  describe('F2 — every 302 carries Django’s default Content-Type', () => {
    const expectDjangoRedirect = (response: request.Response, location: string): void => {
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(location);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['content-length']).toBe('0');
      expect(response.text).toBe('');
    };

    it('POST /password_reset/ — the anti-enumeration redirect', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .type('form')
        .send({ email: 'nobody@mail.com', csrfmiddlewaretoken: field });

      expectDjangoRedirect(response, '/password_reset/done/');
    });

    it('GET /reset/<uid>/<valid token>/ — the two-step hop', async () => {
      const token = tokens.makeToken(await currentUser());
      const response = await request(app.getHttpServer()).get(
        `/reset/${uidOf(memberId)}/${token}/`,
      );

      expectDjangoRedirect(response, `/reset/${uidOf(memberId)}/set-password/`);
    });

    it('POST /reset/<uid>/set-password/ — the successful password change', async () => {
      const token = tokens.makeToken(await currentUser());
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post(`/reset/${uidOf(memberId)}/set-password/`)
        .set('Cookie', [`csrftoken=${cookie}`, `_password_reset_token=${token}`])
        .type('form')
        .send({
          new_password1: 'una-clave-para-f2',
          new_password2: 'una-clave-para-f2',
          csrfmiddlewaretoken: field,
        });

      expectDjangoRedirect(response, '/reset/done/');
    });

    it('the APPEND_SLASH 301 still carries it too — the control that did not regress', async () => {
      const response = await request(app.getHttpServer()).get('/password_reset').expect(301);

      expect(response.headers.location).toBe('/password_reset/');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['content-length']).toBe('0');
    });
  });

  describe('the two static pages', () => {
    it('GET /password_reset/done/ renders the Spanish confirmation', async () => {
      const response = await request(app.getHttpServer())
        .get('/password_reset/done/')
        .set('Origin', 'https://app.test')
        .expect(200);

      expect(response.text).toContain('<h2>ENVIADO</h2>');
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('GET /reset/done/ renders the success page and links to HOST_URL_APP', async () => {
      const response = await request(app.getHttpServer()).get('/reset/done/').expect(200);

      expect(response.text).toContain('<h2>Cambio de contraseña exitoso</h2>');
      expect(response.text).toContain('<a href="http://localhost:3000">Ir a página principal</a>');
    });
  });

  describe('method handling — CSRF is checked before the method is', () => {
    /**
     * ⚠️ Measured on the live v1: `DELETE /password_reset/` with **no** csrftoken cookie is a
     * **403**, not a 405. `CsrfViewMiddleware.process_view` runs before the view's `dispatch`
     * resolves a handler, so an unsafe method is refused on CSRF grounds first. Splitting
     * these routes into `@Get`/`@Post`/`@All` would put Nest's router in front of the check
     * and invert both statuses.
     */
    it('403s an unsafe method with no CSRF cookie, whatever the method', async () => {
      for (const path of ['/password_reset/', '/password_reset/done/', '/reset/done/']) {
        const response = await request(app.getHttpServer()).delete(path).expect(403);
        expect(response.text).toContain('CSRF verification failed. Request aborted.');
      }
    });

    it('405s a DELETE on the form page once the CSRF token is present', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .delete('/password_reset/')
        .set('Cookie', `csrftoken=${cookie}`)
        .set('X-CSRFToken', field)
        .expect(405);

      // `ProcessFormView` defines get/post/put; `View` adds head/options.
      expect(response.headers.allow).toBe('GET, POST, PUT, HEAD, OPTIONS');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.text).toBe('');
    });

    it('405s a POST on the done page once the CSRF token is present', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .post('/password_reset/done/')
        .set('Cookie', `csrftoken=${cookie}`)
        .set('X-CSRFToken', field);

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
    });

    /**
     * ⚠️ `PasswordResetConfirmView.dispatch` returns the invalid-link page **before**
     * `super().dispatch()`, which is where Django checks the method at all. Verified live:
     * `DELETE /reset/<uid>/set-password/` with a valid csrftoken is a **200**.
     */
    it('renders the invalid-link page for ANY method when the link is invalid', async () => {
      const { cookie, field } = csrfPair();
      const response = await request(app.getHttpServer())
        .delete(`/reset/${uidOf(memberId)}/set-password/`)
        .set('Cookie', `csrftoken=${cookie}`)
        .set('X-CSRFToken', field)
        .expect(200);

      expect(response.text).toContain('El enlace de restauración de contraseña es inválido');
    });

    it('answers a bare OPTIONS with 200 and an Allow list, as django.views.View does', async () => {
      const response = await request(app.getHttpServer()).options('/password_reset/').expect(200);
      expect(response.headers.allow).toBe('GET, POST, PUT, HEAD, OPTIONS');
      expect(response.headers['content-length']).toBe('0');
    });

    it('301s the slash-less form path, as CommonMiddleware does', async () => {
      const response = await request(app.getHttpServer()).get('/password_reset').expect(301);
      expect(response.headers.location).toBe('/password_reset/');
    });
  });

  describe('token scheme', () => {
    it('produces a token the URL conf accepts', () => {
      const token = tokens.makeToken({ id: 1, password: 'x', last_login: null });
      expect(token).toMatch(/^[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}$/);
    });

    it('rejects a token older than PASSWORD_RESET_TIMEOUT_DAYS', () => {
      const user = { id: 1, password: 'x', last_login: null };
      const issued = new Date('2026-01-01T00:00:00Z');
      const token = tokens.makeToken(user, issued);

      expect(tokens.checkToken(user, token, new Date('2026-01-03T23:00:00Z'))).toBe(true);
      expect(tokens.checkToken(user, token, new Date('2026-01-04T01:00:00Z'))).toBe(false);
    });

    it('rejects a token for a different user, a changed password or a new login', () => {
      const user = { id: 1, password: 'x', last_login: null };
      const token = tokens.makeToken(user);

      expect(tokens.checkToken({ ...user, id: 2 }, token)).toBe(false);
      expect(tokens.checkToken({ ...user, password: 'y' }, token)).toBe(false);
      expect(tokens.checkToken({ ...user, last_login: new Date() }, token)).toBe(false);
      expect(tokens.checkToken(null, token)).toBe(false);
      expect(tokens.checkToken(user, 'garbage')).toBe(false);
      expect(tokens.checkToken(user, undefined)).toBe(false);
    });

    it('never leaves a session row behind, on any route', async () => {
      await expect(prisma.djangoSession.count()).resolves.toBe(sessionRowsBefore);
    });
  });
});
