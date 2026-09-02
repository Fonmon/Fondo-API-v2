import { All, Body, Controller, Get, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { DjangoStack, onBeforeHeaders } from '../common/http/before-headers';
import { patchVaryHeaders } from '../common/http/django-cors.middleware';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { AppConfigService } from '../config/app-config.service';
import {
  CSRF_COOKIE_AGE,
  CSRF_COOKIE_NAME,
  CSRF_FIELD_NAME,
  CSRF_HEADER_NAME,
  csrfTokensMatch,
  maskCsrfSecret,
  REASON_BAD_TOKEN,
  REASON_NO_CSRF_COOKIE,
  sanitizeCsrfToken,
  unmaskCsrfToken,
} from './django-csrf';
import { PasswordResetHtmlRenderer, renderFieldErrors } from './html-template.renderer';
import { PasswordResetService } from './password-reset.service';

/**
 * `PasswordResetView` (v1's override) plus the three `django.contrib.auth` pages the URL conf
 * mounts around it — `api/urls.py:22-26`.
 *
 * ```python
 * url(r'^password_reset/$',      PasswordResetView.as_view(),      name='password_reset')
 * url(r'^password_reset/done/$', auth_views.PasswordResetDoneView.as_view(), ...)
 * url(r'^reset/(?P<uidb64>[0-9A-Za-z_\-]+)/(?P<token>[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20})/$',
 *     auth_views.PasswordResetConfirmView.as_view(), name='password_reset_confirm')
 * url(r'^reset/done/$',          auth_views.PasswordResetCompleteView.as_view(), ...)
 * ```
 *
 * ⚠️ `set-password` is not a fifth pattern: it happens to match the *token* regex
 * (`set` = 3 chars, `password` = 8), which is how Django's own two-step flow addresses itself.
 *
 * ---
 *
 * # The design decision: **v2 has no sessions, and does not grow one for this**
 *
 * Django's `PasswordResetConfirmView.dispatch` (2.2.27, `contrib/auth/views.py:272-278`) does:
 *
 * ```python
 * if self.token_generator.check_token(self.user, token):
 *     self.request.session[INTERNAL_RESET_SESSION_TOKEN] = token
 *     redirect_url = self.request.path.replace(token, INTERNAL_RESET_URL_TOKEN)
 *     return HttpResponseRedirect(redirect_url)
 * ```
 *
 * so a **GET writes a `django_session` row** and 302s to `/reset/<uid>/set-password/`. v2 has
 * no session model, no session store and no `sessionid`. The fork was: port sessions, or
 * reproduce the hop without them?
 *
 * **Decision: reproduce the hop with a cookie that carries the token, and no server-side
 * state.** The reasoning, in the order it was decided:
 *
 * 1. **The hop itself must stay.** It is not an implementation detail — it exists so the
 *    reset token leaves the URL bar before the form page loads. And this form page loads a
 *    **third-party stylesheet** (`stackpath.bootstrapcdn.com`, in
 *    `password_reset_confirm.html`), so with the token still in the path it would be handed to
 *    that CDN in the `Referer` header. Collapsing the two steps into one would be a real
 *    regression, not a simplification.
 * 2. **The state being carried is one opaque string, scoped to one browser, for one minute.**
 *    A `django_session` row would be a table v2 otherwise never touches, a `session_data`
 *    codec, a `sessionid` cookie, an expiry sweep — all to hold a value the client may as well
 *    hold itself.
 * 3. **The cookie needs no signing of its own**, which is what makes it *strictly less* state
 *    rather than a shortcut. Django's session is not a trust boundary here either: the second
 *    request re-runs `token_generator.check_token(user, session_token)`, so the session is
 *    only a *carrier*. v2 carries the same token in an `HttpOnly` cookie and re-runs the same
 *    check. Forging it requires forging the token — an HMAC over the user's id, password hash
 *    and last login.
 * 4. **It keeps the shared database clean during parity.** v1 keeps writing `django_session`
 *    rows; v2 writes none, so a round of parity testing cannot be misread as v2 leaving state
 *    behind (the round-3 sweep already had to delete one such row by hand).
 *
 * Registered as **P3-D3**. Observable differences, all in headers: no `sessionid` cookie, no
 * `django_session` row on the GET, and the reset cookie is named `_password_reset_token`.
 * `Vary: Cookie` is unaffected and still correct — the response genuinely does vary by cookie.
 *
 * ---
 *
 * # `Vary` element order falls out of depth, and this is the proof
 *
 * v1 answers three different `Vary` strings on these routes, and the *order* differs:
 *
 * | route | `Vary` | who added `Cookie`, and at what depth |
 * |---|---|---|
 * | `GET /password_reset/` | **`Cookie, Origin`** | `PasswordResetView`'s `@method_decorator(csrf_protect)` — **below** all eight middlewares, {@link DjangoStack.VIEW} |
 * | `GET /reset/<uid>/<valid token>/` | **`Origin, Cookie`** | `SessionMiddleware`, slot **2** |
 * | `GET /reset/<uid>/set-password/` | **`Origin, Cookie`** | `CsrfViewMiddleware`, slot **4** (that view has no `csrf_protect` decorator — only `PasswordResetView` does) |
 *
 * Condition **C21** built the depth model for exactly this, and it works: hooks run in
 * descending depth, so a `Cookie` patched at depth 9 lands *before* `corsheaders` adds `Origin`
 * at depth 8, and one patched at depth 4 or 2 lands *after* it. No per-route string, no sorting
 * — the three orders are a consequence of registering each hook where its v1 counterpart lives.
 * That is why the depths below are `VIEW`, `SESSION` and `CSRF` rather than one convenient
 * constant.
 */
@Public()
@Controller()
export class PasswordResetController {
  /** `django.contrib.auth.views.INTERNAL_RESET_URL_TOKEN`. */
  private static readonly INTERNAL_RESET_URL_TOKEN = 'set-password';

  /**
   * v2's replacement for `INTERNAL_RESET_SESSION_TOKEN` (`'_password_reset_token'`), carried
   * in a cookie of the same name instead of in a session row. See the class comment.
   */
  private static readonly RESET_COOKIE = '_password_reset_token';

  constructor(
    private readonly resets: PasswordResetService,
    private readonly html: PasswordResetHtmlRenderer,
    private readonly config: AppConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // /password_reset/
  // -------------------------------------------------------------------------

  /**
   * `PasswordResetView.get` — the email form.
   *
   * `{% csrf_token %}` in the template calls Django's `get_token()`, which sets
   * `CSRF_COOKIE_USED`, which makes `csrf_protect`'s response phase write the cookie **and**
   * patch `Vary: Cookie`. The decorator sits below the middleware stack, hence
   * {@link DjangoStack.VIEW} and hence `Cookie, Origin`.
   */
  @Get('password_reset')
  passwordResetForm(@Req() request: Request, @Res() response: Response): void {
    const csrfToken = this.issueCsrfCookie(request, response, DjangoStack.VIEW);
    this.sendHtml(response, this.html.render('password_reset_form.eta', { csrf_token: csrfToken }));
  }

  /**
   * `PasswordResetView.post` — v1's own override, not Django's.
   *
   * The redirect is **unconditional**: a missing address, an unknown one and an ambiguous one
   * all land on `/password_reset/done/`. No user enumeration.
   *
   * ⚠️ No cookie and no `Vary: Cookie` here — measured. `csrf_protect`'s response phase only
   * writes the cookie when the *template* asked for a token, and this response is a redirect.
   */
  @Post('password_reset')
  async passwordResetPost(
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    if (this.rejectCsrf(request, response)) {
      return;
    }
    const form = asForm(body);
    await this.resets.requestReset(form.email, request.headers.host ?? '');
    this.redirect(response, '/password_reset/done/');
  }

  /** `PasswordResetDoneView` — a `TemplateView`, no cookies, no session access. */
  @Get('password_reset/done')
  passwordResetDone(@Res() response: Response): void {
    this.sendHtml(response, this.html.render('password_reset_done.eta'));
  }

  // -------------------------------------------------------------------------
  // /reset/<uid>/<token>/ and /reset/<uid>/set-password/
  // -------------------------------------------------------------------------

  /**
   * `PasswordResetConfirmView.dispatch` + `get`.
   *
   * Three outcomes, matching v1 exactly:
   *
   * | request | v1 | v2 |
   * |---|---|---|
   * | valid token in the URL | store it in the session, **302** to `…/set-password/` | store it in the reset cookie, **302** |
   * | `set-password` + a valid stored token | render the form (`validlink=True`) | same |
   * | anything else | render the "invalid or already used" page (200) | same |
   *
   * ⚠️ `@method_decorator(never_cache)` is on this view, so both responses carry
   * `Cache-Control: max-age=0, no-cache, no-store, must-revalidate, private` and an `Expires`
   * in the past.
   */
  @Get('reset/:uidb64/:token')
  async resetConfirm(
    @Param('uidb64') uidb64: string,
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    addNeverCacheHeaders(response);
    const user = await this.resets.getUserFromUidb64(uidb64);

    if (user !== null && token !== PasswordResetController.INTERNAL_RESET_URL_TOKEN) {
      if (this.resets.checkToken(user, token)) {
        // v1: `self.request.session[INTERNAL_RESET_SESSION_TOKEN] = token`, which is what
        // makes SessionMiddleware write a `django_session` row and patch `Vary: Cookie` at
        // slot 2. v2 stores it in the cookie instead — same carrier role, no row.
        this.setResetCookie(request, response, token);
        this.redirect(
          response,
          `/reset/${uidb64}/${PasswordResetController.INTERNAL_RESET_URL_TOKEN}/`,
        );
        return;
      }
      this.renderInvalidLink(response);
      return;
    }

    if (user !== null && token === PasswordResetController.INTERNAL_RESET_URL_TOKEN) {
      // The session (here: the cookie) is *read* on this branch whether or not it is valid, so
      // `Vary: Cookie` is patched at slot 2 either way — `SessionMiddleware.process_response`
      // keys on `request.session.accessed`, not on the outcome. Measured on v1.
      this.varyOnCookie(response, DjangoStack.SESSION);
      const stored = readCookie(request, PasswordResetController.RESET_COOKIE);
      if (this.resets.checkToken(user, stored)) {
        this.renderSetPasswordForm(request, response, []);
        return;
      }
    }

    this.renderInvalidLink(response);
  }

  /** `PasswordResetConfirmView.post` — `SetPasswordForm`. */
  @Post('reset/:uidb64/:token')
  async resetConfirmPost(
    @Param('uidb64') uidb64: string,
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    addNeverCacheHeaders(response);
    if (this.rejectCsrf(request, response)) {
      return;
    }

    const user = await this.resets.getUserFromUidb64(uidb64);
    this.varyOnCookie(response, DjangoStack.SESSION);
    const stored = readCookie(request, PasswordResetController.RESET_COOKIE);

    if (
      user === null ||
      token !== PasswordResetController.INTERNAL_RESET_URL_TOKEN ||
      !this.resets.checkToken(user, stored)
    ) {
      this.renderInvalidLink(response);
      return;
    }

    const form = asForm(body);
    const errors = await this.resets.setPassword(
      user,
      typeof form.new_password1 === 'string' ? form.new_password1 : '',
      typeof form.new_password2 === 'string' ? form.new_password2 : '',
    );
    if (errors.length > 0) {
      this.renderSetPasswordForm(request, response, errors);
      return;
    }

    // v1: `del self.request.session[INTERNAL_RESET_SESSION_TOKEN]`, which modifies the session
    // and therefore re-writes the cookie. v2 clears its own.
    this.clearResetCookie(response);
    this.redirect(response, '/reset/done/');
  }

  /** `PasswordResetCompleteView` — a `TemplateView`; `{% host %}` is the only variable. */
  @Get('reset/done')
  resetDone(@Res() response: Response): void {
    this.sendHtml(response, this.html.render('password_reset_complete.eta'));
  }

  // -------------------------------------------------------------------------
  // method fallbacks
  // -------------------------------------------------------------------------

  /**
   * Django's `View.http_method_not_allowed` / `View.options`, which Nest would otherwise 404.
   *
   * ⚠️ `ProcessFormView` defines `put = post`, so **`PUT /password_reset/` behaves exactly
   * like a POST** in v1 — a genuine, if unlikely, part of the contract. That is why the two
   * form routes below list `PUT` in `Allow` and why `@Put` aliases are registered.
   */
  @DrfNoRequestData()
  @All('password_reset')
  passwordResetOther(@Req() request: Request, @Res() response: Response): void {
    this.methodFallback(request, response, 'GET, POST, PUT, HEAD, OPTIONS');
  }

  @DrfNoRequestData()
  @All('password_reset/done')
  passwordResetDoneOther(@Req() request: Request, @Res() response: Response): void {
    this.methodFallback(request, response, 'GET, HEAD, OPTIONS');
  }

  @DrfNoRequestData()
  @All('reset/done')
  resetDoneOther(@Req() request: Request, @Res() response: Response): void {
    this.methodFallback(request, response, 'GET, HEAD, OPTIONS');
  }

  @DrfNoRequestData()
  @All('reset/:uidb64/:token')
  resetConfirmOther(@Req() request: Request, @Res() response: Response): void {
    this.methodFallback(request, response, 'GET, POST, PUT, HEAD, OPTIONS');
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * `View.options` (200, `Allow`, `Content-Length: 0`) or `HttpResponseNotAllowed` (405 with
   * `Allow` and an empty `text/html` body).
   */
  private methodFallback(request: Request, response: Response, allow: string): void {
    response.setHeader('Allow', allow);
    if (request.method === 'OPTIONS') {
      response.setHeader('Content-Length', '0');
      response.status(HttpStatus.OK).end();
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.status(HttpStatus.METHOD_NOT_ALLOWED).end();
  }

  private renderSetPasswordForm(
    request: Request,
    response: Response,
    errors: readonly string[],
  ): void {
    const csrfToken = this.issueCsrfCookie(request, response, DjangoStack.CSRF);
    this.sendHtml(
      response,
      this.html.render('password_reset_confirm.eta', {
        validlink: 'true',
        csrf_token: csrfToken,
        field_errors: renderFieldErrors(errors),
      }),
    );
  }

  /** The `{% else %}` branch: no form, therefore no `{% csrf_token %}` and no cookie. */
  private renderInvalidLink(response: Response): void {
    this.sendHtml(
      response,
      this.html.render('password_reset_confirm.eta', {
        validlink: '',
        csrf_token: '',
        field_errors: '',
      }),
    );
  }

  /**
   * `get_token(request)` + `CsrfViewMiddleware._set_token`.
   *
   * The cookie carries the token the request already had (Django re-sets the *same* value to
   * renew the expiry) or a fresh one; the form field is always a **new mask of the same
   * secret**, which is why the two strings never match and why comparison unmasks both.
   *
   * @param depth where v1's counterpart patches `Vary: Cookie` — {@link DjangoStack.VIEW} for
   *   `PasswordResetView`'s `csrf_protect` decorator, {@link DjangoStack.CSRF} for the
   *   middleware acting on a view without one.
   */
  private issueCsrfCookie(
    request: Request,
    response: Response,
    depth: typeof DjangoStack.VIEW | typeof DjangoStack.CSRF,
  ): string {
    const { token: cookieToken } = sanitizeCsrfToken(readCookie(request, CSRF_COOKIE_NAME));
    const secret = unmaskCsrfToken(cookieToken);

    appendSetCookie(response, {
      name: CSRF_COOKIE_NAME,
      value: cookieToken,
      maxAge: CSRF_COOKIE_AGE,
      path: '/',
      sameSite: 'Lax',
      // `CSRF_COOKIE_SECURE = True` in `api/settings/production.py:20`, default False elsewhere.
      secure: this.config.environment === 'production',
      httpOnly: false,
    });
    this.varyOnCookie(response, depth);

    /* istanbul ignore next -- `sanitizeCsrfToken` never returns an unmaskable token */
    return maskCsrfSecret(secret ?? cookieToken);
  }

  /** v2's stand-in for `request.session[INTERNAL_RESET_SESSION_TOKEN] = token`. */
  private setResetCookie(request: Request, response: Response, token: string): void {
    void request;
    appendSetCookie(response, {
      name: PasswordResetController.RESET_COOKIE,
      value: token,
      // The token's own lifetime; the cookie cannot outlive what it carries.
      maxAge: 3 * 86400,
      path: '/reset/',
      sameSite: 'Lax',
      secure: this.config.environment === 'production',
      // Nothing client-side reads it, and it is a credential for the duration of the flow.
      httpOnly: true,
    });
    // v1's `SessionMiddleware.process_response` patches `Vary: Cookie` at slot 2 — above
    // `corsheaders`, which is why this route answers `Origin, Cookie` and `/password_reset/`
    // answers `Cookie, Origin`.
    this.varyOnCookie(response, DjangoStack.SESSION);
  }

  private clearResetCookie(response: Response): void {
    appendSetCookie(response, {
      name: PasswordResetController.RESET_COOKIE,
      value: '',
      maxAge: 0,
      path: '/reset/',
      sameSite: 'Lax',
      secure: this.config.environment === 'production',
      httpOnly: true,
    });
    this.varyOnCookie(response, DjangoStack.SESSION);
  }

  /** `patch_vary_headers(response, ('Cookie',))`, at the depth v1's caller sits. */
  private varyOnCookie(response: Response, depth: number): void {
    onBeforeHeaders(response, depth as never, (finished) => {
      patchVaryHeaders(finished, ['Cookie']);
    });
  }

  /**
   * `CsrfViewMiddleware.process_view` for an unsafe method, minus the `Referer` branch.
   *
   * ⚠️ The `Referer` check runs only `if request.is_secure()`, and v1 sets no
   * `SECURE_PROXY_SSL_HEADER` (verified: `settings.SECURE_PROXY_SSL_HEADER is None`), so
   * behind its load balancer `is_secure()` is `False` and that branch is **dead in
   * production**. Not ported; registered as P3-D5.
   *
   * @returns `true` when the request was rejected and a response has been sent.
   */
  private rejectCsrf(request: Request, response: Response): boolean {
    const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
    if (cookieToken === undefined) {
      this.sendCsrfFailure(response, REASON_NO_CSRF_COOKIE);
      return true;
    }
    const { token: sanitized } = sanitizeCsrfToken(cookieToken);

    const body = asForm(request.body);
    const fromBody = body[CSRF_FIELD_NAME];
    const fromHeader = request.headers[CSRF_HEADER_NAME];
    const submitted =
      typeof fromBody === 'string' && fromBody !== ''
        ? fromBody
        : typeof fromHeader === 'string'
          ? fromHeader
          : '';

    if (!csrfTokensMatch(sanitized, submitted)) {
      this.sendCsrfFailure(response, REASON_BAD_TOKEN);
      return true;
    }
    return false;
  }

  /** `django.views.csrf.csrf_failure` with `DEBUG = False`: the built-in 403 page. */
  private sendCsrfFailure(response: Response, reason: string): void {
    const page = this.html.render('csrf_failure.eta', {
      no_cookie_help:
        reason === REASON_NO_CSRF_COOKIE
          ? '  <p>You are seeing this message because this site requires a CSRF cookie when ' +
            'submitting forms. This cookie is required for security reasons, to ensure that ' +
            'your browser is not being hijacked by third parties.</p>\n' +
            '  <p>If you have configured your browser to disable cookies, please re-enable ' +
            'them, at least for this site, or for &#39;same-origin&#39; requests.</p>\n\n'
          : '',
    });
    response.setHeader('Content-Type', 'text/html');
    response.status(HttpStatus.FORBIDDEN).send(page);
  }

  private sendHtml(response: Response, body: string): void {
    // Django's `TemplateResponse` default: `text/html; charset=utf-8`.
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.status(HttpStatus.OK).send(body);
  }

  /** `django.shortcuts.redirect(to)` — a **302**, `Location` verbatim, empty body. */
  private redirect(response: Response, location: string): void {
    response.setHeader('Location', location);
    response.status(HttpStatus.FOUND).end();
  }
}

/** A parsed form/JSON body as a plain record; never throws. */
function asForm(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

/**
 * One cookie out of the `Cookie` header.
 *
 * Parsed here rather than with `cookie-parser` because nothing else in v2 reads cookies and a
 * global parser would be one more thing shaping every request.
 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/**
 * `HttpResponse.set_cookie` — including Python's attribute order.
 *
 * ⚠️ `http.cookies.Morsel.OutputString` emits `sorted(self.items())`, so the attributes come
 * out **alphabetically by their internal key**: `expires`, `max-age`, `path`, `samesite`,
 * `secure`, rendered as `expires`, `Max-Age`, `Path`, `SameSite`, `Secure`. Express's
 * `res.cookie` uses a different order, which would show up in any header diff, so the string
 * is built by hand.
 */
function appendSetCookie(
  response: Response,
  options: {
    name: string;
    value: string;
    maxAge: number;
    path: string;
    sameSite: string;
    secure: boolean;
    httpOnly: boolean;
  },
): void {
  const expires = new Date(Date.now() + options.maxAge * 1000).toUTCString();
  const parts = [
    `${options.name}=${options.value}`,
    `expires=${expires}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
  ];
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) {
    parts.push('Secure');
  }
  const existing = response.getHeader('Set-Cookie');
  const all = existing === undefined ? [] : ([] as string[]).concat(existing as string[]);
  all.push(parts.join('; '));
  response.setHeader('Set-Cookie', all);
}

/**
 * `django.utils.cache.add_never_cache_headers`, which
 * `@method_decorator(never_cache)` on `PasswordResetConfirmView.dispatch` applies.
 *
 * `patch_response_headers(response, -1)` clamps the timeout to 0, sets `Expires` to *now* and
 * adds `max-age=0`; `patch_cache_control` then appends the four flags. The element order is
 * the dict's insertion order, which is why `max-age=0` comes first.
 */
function addNeverCacheHeaders(response: Response): void {
  response.setHeader('Expires', new Date().toUTCString());
  response.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate, private');
}
