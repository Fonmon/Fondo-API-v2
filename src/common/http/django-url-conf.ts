/**
 * v1's URL configuration, transcribed pattern by pattern — review condition **C9**.
 *
 * ## Why v2 needs its own copy of the URL table
 *
 * Django resolves a URL with an **ordered list of anchored regexes** and 404s before any
 * authentication runs. Express matches with path-to-regexp under two defaults that Django
 * does not share, and Express 5 dropped inline parameter patterns, so three v1 behaviours
 * were unreachable from the route decorators. All three are the same gap and are closed here
 * at once, because the widening reaches every route Phases 3-8 will add:
 *
 * | # | v1 | Express default | Consequence measured on the live pair |
 * |---|---|---|---|
 * | **F2** | `url()` regexes are case-**sensitive** | `caseSensitive: false` | `POST /API/notification/subscribe` **wrote a subscription row** in v2; v1 404s |
 * | **P2-D5** | `(?P<operation>[a-zA-Z]+)` constrains the segment *in the URL conf* | no inline patterns in path-to-regexp v8 | unauthenticated `POST /api/notification/sub1` — v1 **404**, v2 **401** |
 * | **S7** | the trailing slash is per-route, not a rule | `strict: false` (both forms always) | `DELETE /api/user/5/` is an inert **404** in v1 and a **real soft delete** in v2 (Phase 3) |
 *
 * ## There is no trailing-slash *rule* to write down — only this table
 *
 * The reviewer's S7 asked for a rule. v1 does not have one. Collection routes carry `/?`
 * (`^api/loan/?$`), detail routes do not (`^api/loan/(?P<id>[0-9]+)$`), *except*
 * `^api/activity/(?P<id>[0-9]+)/?$`, which does — and the four `password_reset` / `reset`
 * paths make the slash **mandatory**, with `APPEND_SLASH` 301ing the bare form. Any blanket
 * rule would 404 URLs v1 serves or serve URLs v1 404s, so the table is transcribed verbatim
 * and each entry's v1 source line is quoted next to it. Every status in the "v1" column below
 * was verified against the running v1 (`~/Projects/Fondo-API` @ `5bef585`, gunicorn, DEBUG
 * off), not inferred from the regex.
 *
 * ## `Allow` and `Vary: Accept` come from the same table
 *
 * DRF sets `default_response_headers` on **every** response an `APIView` produces, including
 * the 401 and 403 raised in `initial()` — `Allow: <implemented methods>` and, when the view
 * has more than one renderer, `Vary: Accept`. That is per *view*, which is what this table
 * keys, so it is the natural place to reproduce them (finding F4). Each `allow` string below
 * was read off a live v1 response rather than derived from the view class.
 *
 * @see `~/Projects/Fondo-API/api/urls.py` and `~/Projects/Fondo-API/fondo_api/urls.py`
 */

/**
 * DRF's `APIView.default_response_headers`, per view. `null` for a plain Django view.
 *
 * ⚠️ **Phase 3 must widen this to carry `Vary: Cookie`.** Two v1 middlewares patch `Cookie`
 * into `Vary` from *outside* DRF: `CsrfViewMiddleware`, when it sets the `csrftoken` cookie on
 * a form page, and `SessionMiddleware`, when a view touches the session.
 *
 * This was first recorded as affecting one route. The round-3 sweep found it is **three kept
 * routes**, and that the element order is not constant between them:
 *
 * | route | `Vary` | also |
 * |---|---|---|
 * | `GET /password_reset/` | `Cookie, Origin` | `Set-Cookie: csrftoken` |
 * | `GET /reset/<uid>/<valid token>/` | `Origin, Cookie` | **302** → `/reset/<uid>/set-password/` |
 * | `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `Set-Cookie: csrftoken` |
 *
 * ⚠️ **`Cookie, Origin` on the first, `Origin, Cookie` on the other two.** Django does not
 * sort `Vary`; `patch_vary_headers` appends whatever is not already present, so the order is a
 * function of *which middleware got there first*, not of the header's meaning. That is
 * irrelevant if Phase 3 transcribes the string per route and load-bearing the moment anyone
 * builds it by joining a set — which is why it is written down here.
 *
 * `GET /api/authorize` also answers `Vary: Accept, Origin, Cookie`, but that is Alexa account
 * linking and is **not migrated** (plan §1), so it is out of scope rather than a fourth row.
 *
 * ⚠️ **Phase 3 scope, and probably a Phase 3 *design* question, not a one-liner:
 * `GET /reset/<uid>/<token>/` performs a database write.** With a *valid* token,
 * `PasswordResetConfirmView.dispatch` (Django 2.2.27,
 * `django/contrib/auth/views.py:272-278`) does:
 *
 * ```python
 * self.request.session[INTERNAL_RESET_SESSION_TOKEN] = token   # '_password_reset_token'
 * redirect_url = self.request.path.replace(token, INTERNAL_RESET_URL_TOKEN)  # 'set-password'
 * ```
 *
 * so `SessionMiddleware` persists the modified session and a **`django_session` row is
 * inserted on a GET**, before the 302. That is where both the `Cookie` in `Vary` and the
 * `sessionid` cookie on those two routes come from. **v2 has no session model at all** — no
 * `django_session` mapping, no session store, no `sessionid`. Reproducing this is a decision
 * about how far the password-reset flow is ported (real server-side sessions vs. a signed
 * token carrying the same state), not a header to add, so it belongs to whoever lands
 * `PasswordResetConfirmView`. **Do not build it as part of the header work.**
 */
export interface DrfViewHeaders {
  /** `Allow` — `[m.upper() for m in http_method_names if hasattr(self, m)]`, DRF's order. */
  readonly allow: string;
  /** `Vary: Accept`, set when the view has more than one renderer class. */
  readonly varyAccept: boolean;
}

export interface DjangoUrlPattern {
  /** The v1 regex, transcribed verbatim (Python named groups become plain groups). */
  readonly regex: RegExp;
  /** The v1 view class, or the Django view for the auth pages. Documentation only. */
  readonly view: string;
  /** The headers DRF attaches to every response from this view. */
  readonly drf: DrfViewHeaders | null;
}

const DRF_JSON_ONLY = (allow: string): DrfViewHeaders => ({ allow, varyAccept: false });
const DRF = (allow: string): DrfViewHeaders => ({ allow, varyAccept: true });

/**
 * `api/urls.py` followed by `fondo_api/urls.py`, in v1's order (first match wins in Django;
 * v2 only asks whether *some* pattern matches, but the order is kept so the two files can be
 * diffed against each other).
 *
 * ⚠️ `^api/alexa/?$` is **deliberately absent**: Alexa is not migrated (plan §1), so v2 has
 * no route behind it and a request there must 404 rather than reach a guard.
 */
export const DJANGO_URL_CONF: readonly DjangoUrlPattern[] = [
  // --- api/urls.py -------------------------------------------------------------------
  // url(r'^password_reset/$', PasswordResetView.as_view(), name='password_reset')
  { regex: /^password_reset\/$/, view: 'PasswordResetView', drf: null },
  // url(r'^password_reset/done/$', auth_views.PasswordResetDoneView.as_view(), ...)
  { regex: /^password_reset\/done\/$/, view: 'PasswordResetDoneView', drf: null },
  // url(r'^reset/(?P<uidb64>[0-9A-Za-z_\-]+)/(?P<token>[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20})/$', ...)
  // (`\-` in v1's character class is `-` here; a trailing `-` needs no escape in JS.)
  {
    regex: /^reset\/[0-9A-Za-z_-]+\/[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}\/$/,
    view: 'PasswordResetConfirmView',
    drf: null,
  },
  // url(r'^reset/done/$', auth_views.PasswordResetCompleteView.as_view(), ...)
  { regex: /^reset\/done\/$/, view: 'PasswordResetCompleteView', drf: null },
  // url(r'^api-token-auth/?$', views.obtain_auth_token, ...)
  // ObtainAuthToken sets `renderer_classes = (JSONRenderer,)` — the one view with no
  // `Vary: Accept`. Verified live: `Allow: POST, OPTIONS`, `Vary: Origin` only.
  { regex: /^api-token-auth\/?$/, view: 'ObtainAuthToken', drf: DRF_JSON_ONLY('POST, OPTIONS') },

  // --- fondo_api/urls.py -------------------------------------------------------------
  // url(r'^api/authorize/?$', AuthView.as_view(), ...)
  { regex: /^api\/authorize\/?$/, view: 'AuthView', drf: DRF('GET, POST, HEAD, OPTIONS') },

  // url(r'^api/loan/?$', LoanView.as_view(), ...)
  { regex: /^api\/loan\/?$/, view: 'LoanView', drf: DRF('GET, POST, PATCH, HEAD, OPTIONS') },
  // url(r'^api/loan/(?P<id>[0-9]+)$', LoanDetailView.as_view(), ...) — no `/?`
  {
    regex: /^api\/loan\/[0-9]+$/,
    view: 'LoanDetailView',
    drf: DRF('GET, PATCH, HEAD, OPTIONS'),
  },
  // url(r'^api/loan/(?P<id>[0-9]+)/(?P<app>[a-zA-Z]+)$', LoanAppsView.as_view(), ...)
  { regex: /^api\/loan\/[0-9]+\/[a-zA-Z]+$/, view: 'LoanAppsView', drf: DRF('POST, OPTIONS') },

  // url(r'^api/user/?$', UserView.as_view(), ...)
  { regex: /^api\/user\/?$/, view: 'UserView', drf: DRF('GET, POST, PATCH, HEAD, OPTIONS') },
  // url(r'^api/user/(?P<app>-?[a-zA-Z]+)$', UserAppsView.as_view(), ...)
  { regex: /^api\/user\/-?[a-zA-Z]+$/, view: 'UserAppsView', drf: DRF('POST, OPTIONS') },
  // url(r'^api/user/(?P<id>-?[0-9]+)$', UserDetailView.as_view(), ...) — the `-1` sentinel
  {
    regex: /^api\/user\/-?[0-9]+$/,
    view: 'UserDetailView',
    drf: DRF('GET, PATCH, DELETE, HEAD, OPTIONS'),
  },
  // url(r'^api/user/activate/(?P<id>[0-9]+)$', UserActivateView.as_view(), ...)
  { regex: /^api\/user\/activate\/[0-9]+$/, view: 'UserActivateView', drf: DRF('POST, OPTIONS') },

  // url(r'^api/activity/(?P<id>[0-9]+)/?$', ActivityDetailView.as_view(), ...)
  // ⚠️ The one detail route that accepts a trailing slash. Not a rule — a v1 inconsistency.
  {
    regex: /^api\/activity\/[0-9]+\/?$/,
    view: 'ActivityDetailView',
    drf: DRF('GET, PATCH, DELETE, HEAD, OPTIONS'),
  },
  // url(r'^api/activity/year/?$', ActivityYearView.as_view(), ...)
  {
    regex: /^api\/activity\/year\/?$/,
    view: 'ActivityYearView',
    drf: DRF('GET, POST, HEAD, OPTIONS'),
  },
  // url(r'^api/activity/year/(?P<id_year>[0-9]+)$', ActivityYearDetailView.as_view(), ...)
  {
    regex: /^api\/activity\/year\/[0-9]+$/,
    view: 'ActivityYearDetailView',
    drf: DRF('GET, POST, HEAD, OPTIONS'),
  },

  // url(r'^api/notification/(?P<operation>[a-zA-Z]+)/?$', NotificationView.as_view(), ...)
  {
    regex: /^api\/notification\/[a-zA-Z]+\/?$/,
    view: 'NotificationView',
    drf: DRF('POST, OPTIONS'),
  },

  // url(r'^api/file/?$', FileView.as_view(), ...)
  { regex: /^api\/file\/?$/, view: 'FileView', drf: DRF('GET, POST, HEAD, OPTIONS') },
  // url(r'^api/file/(?P<id>[0-9]+)$', FileDetailView.as_view(), ...)
  { regex: /^api\/file\/[0-9]+$/, view: 'FileDetailView', drf: DRF('GET, HEAD, OPTIONS') },

  // url(r'^api/admin/?$', AdminView.as_view(), ...)
  { regex: /^api\/admin\/?$/, view: 'AdminView', drf: DRF('GET, HEAD, OPTIONS') },

  // url(r'^api/saving-account/?$', SavingAccountView.as_view(), ...)
  {
    regex: /^api\/saving-account\/?$/,
    view: 'SavingAccountView',
    drf: DRF('GET, POST, PUT, HEAD, OPTIONS'),
  },

  // --- v2-only ------------------------------------------------------------------------
  // `GET /health` has no v1 counterpart (registered as P0-D2). Listed here because the
  // resolver is fail-closed: a path absent from this table cannot reach a controller.
  { regex: /^health\/?$/, view: 'HealthController (v2 only, P0-D2)', drf: null },
];

/**
 * The URL conf `DjangoUrlResolverMiddleware` resolves against, injected rather than imported.
 *
 * The table is **fail-closed**: a path it does not list cannot reach a controller. That is the
 * point (a missing entry is an immediate 404 in the owning phase's tests rather than a surface
 * wider than v1's), but it also means a suite that mounts a *synthetic* controller — such as
 * `test/json-bigint.e2e-spec.ts`, whose `/__bigint/...` probe stands in for a Phase 3 route —
 * has to say so:
 *
 * ```ts
 * .overrideProvider(DJANGO_URL_CONF_TOKEN)
 * .useValue([...DJANGO_URL_CONF, { regex: /^__bigint\/.+$/, view: 'probe', drf: null }])
 * ```
 *
 * An override is deliberately noisy: it is the one way a test can widen the URL surface, and
 * it can only widen it for that test.
 */
export const DJANGO_URL_CONF_TOKEN = 'DJANGO_URL_CONF';

/**
 * Django's `URLResolver.resolve` reduced to what v2 needs: does *some* pattern match, and
 * which view answers.
 *
 * @param pathInfo the **decoded** path, leading slash included (WSGI `PATH_INFO`).
 */
export function resolveDjangoUrl(
  pathInfo: string,
  urlConf: readonly DjangoUrlPattern[] = DJANGO_URL_CONF,
): DjangoUrlPattern | null {
  // Django's root resolver strips the leading `/` before matching; the patterns in urls.py
  // are written without it (`r'^api/loan/?$'`).
  const candidate = pathInfo.startsWith('/') ? pathInfo.slice(1) : pathInfo;
  return urlConf.find((entry) => entry.regex.test(candidate)) ?? null;
}

/**
 * `PATH_INFO` as a WSGI server hands it to Django: percent-decoded, UTF-8, with invalid
 * escapes left alone (CPython's `urllib.parse.unquote(..., errors='replace')`).
 *
 * This is load-bearing, not defensive: v1 serves `POST /api/notification/%73ubscribe`
 * (decoded to `subscribe`) with a 401 and 404s `/api/notification/sub%2Fscribe` (decoded to
 * a path with an extra segment). Both verified live. Express leaves `req.path` encoded, so
 * without this the table would disagree with Django in both directions.
 */
export function decodePathInfo(rawPath: string): string {
  return rawPath.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escaped) => {
    const bytes = new Uint8Array(escaped.length / 3);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(escaped.slice(index * 3 + 1, index * 3 + 3), 16);
    }
    return UTF8_REPLACING.decode(bytes);
  });
}

/** `errors='replace'` — an invalid byte sequence becomes U+FFFD, it never raises. */
const UTF8_REPLACING = new TextDecoder('utf-8', { fatal: false });
