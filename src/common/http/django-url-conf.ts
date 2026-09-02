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

import type { V1ViewName } from '../../auth/permissions/permission-matrix';

/**
 * DRF's `APIView.default_response_headers`, per view. `null` for a plain Django view.
 *
 * ✅ **Phase 3 resolved this without widening the table** — `Vary: Cookie` is not a per-view
 * header, it is a consequence of *which layer touched a cookie*, and condition **C21**'s depth
 * model already expresses that. `PasswordResetController` registers its `patch_vary_headers`
 * hook at the depth of the v1 layer it is porting, and the three measured orders fall out:
 *
 * | route | `Vary` | who added `Cookie` | depth |
 * |---|---|---|---|
 * | `GET /password_reset/` | `Cookie, Origin` | `PasswordResetView`'s `@method_decorator(csrf_protect)` | `DjangoStack.VIEW` — below all eight |
 * | `GET /reset/<uid>/<valid token>/` | `Origin, Cookie` | `SessionMiddleware` | slot 2 |
 * | `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `CsrfViewMiddleware` (that view has **no** `csrf_protect` decorator) | slot 4 |
 *
 * Both orders verified live against v1, and against v2, byte for byte. Building the header
 * from a per-view flag here would have needed a special case for the order; putting each hook
 * where its counterpart lives needs none.
 *
 * ✅ **The `django_session` question is answered too, and the answer is "no sessions".**
 * `GET /reset/<uid>/<token>/` writes a `django_session` row in v1 because
 * `PasswordResetConfirmView.dispatch` (Django 2.2.27, `contrib/auth/views.py:272-278`) stores
 * the token in the session and 302s to `…/set-password/`. v2 keeps the **hop** — it exists so
 * the token leaves the URL before a page that loads a third-party stylesheet renders, which
 * would otherwise leak it in `Referer` — and drops the **store**: the token travels in an
 * `HttpOnly` cookie and is re-validated by `check_token` on arrival, exactly as Django
 * re-validates the session copy. Strictly less state, no `django_session` row, and nothing for
 * a parity round to misread. Registered as **P3-D3**; see `PasswordResetController`.
 */
export interface DrfViewHeaders {
  /** `Allow` — `[m.upper() for m in http_method_names if hasattr(self, m)]`, DRF's order. */
  readonly allow: string;
  /** `Vary: Accept`, set when the view has more than one renderer class. */
  readonly varyAccept: boolean;
}

/**
 * The v1 views this table can resolve to that have **no** entry in
 * `fondo_api/permissions.py:list_permissions`, and therefore no role rule.
 *
 *  * the four `django.contrib.auth` password-reset pages are plain Django views, not DRF
 *    `APIView`s, so `APIRolePermission` never runs on them;
 *  * `ObtainAuthToken` sets `permission_classes = ()`;
 *  * `UserActivateView` sets `permission_classes = []`;
 *  * `AuthView` is Alexa account linking and is **not migrated** (plan §1) — it stays in the
 *    table because `/api/authorize` still resolves in v1 and must not 404 differently here.
 *
 * Everything in this union must be `@Public()` on the v2 side (or have no v2 route at all).
 * A route carrying `@V1View(...)` that resolves to one of these names is a wiring bug and
 * {@link RolesGuard} fails it closed — see condition **C20**.
 */
export type UnguardedV1View =
  | 'PasswordResetView'
  | 'PasswordResetDoneView'
  | 'PasswordResetConfirmView'
  | 'PasswordResetCompleteView'
  | 'ObtainAuthToken'
  | 'AuthView'
  | 'UserActivateView';

/**
 * The name of the v1 view a pattern resolves to — condition **C20**, finding **S2**.
 *
 * Typed rather than a free `string` so the URL table and
 * `fondo_api/permissions.py:list_permissions` are linked at **compile** time: a pattern
 * cannot claim a view the permission matrix has never heard of, and renaming a matrix entry
 * breaks the table rather than silently unbinding a route from its rules.
 */
export type ResolvedViewName = V1ViewName | UnguardedV1View;

export interface DjangoUrlPattern {
  /** The v1 regex, transcribed verbatim (Python named groups become plain groups). */
  readonly regex: RegExp;
  /**
   * The v1 view class Django's resolver would pick for this pattern — **the** authorisation
   * key, not documentation (condition **C20**). `null` only for a v2-only or synthetic route
   * with no v1 counterpart, which must therefore be `@Public()`.
   */
  readonly view: ResolvedViewName | null;
  /** The headers DRF attaches to every response from this view. */
  readonly drf: DrfViewHeaders | null;
  /**
   * An **internal** path for Nest's router, used only where Express cannot express the
   * discrimination Django's regexes make.
   *
   * ## Why this exists — the `/api/user/<x>` collision
   *
   * Three v1 patterns share one path shape, with different views and different rules:
   *
   * ```
   * ^api/user/(?P<app>-?[a-zA-Z]+)$   UserAppsView     POST 3
   * ^api/user/(?P<id>-?[0-9]+)$       UserDetailView   GET 3  PATCH 3  DELETE 0
   * ```
   *
   * Django tells them apart by **character class**; path-to-regexp v8 dropped inline
   * parameter patterns, so `:app` and `:id` are the same unconstrained segment to Express and
   * whichever controller is registered first wins **both**. That is not a routing nuisance,
   * it is an authorisation decision: `DELETE /api/user/power` would reach
   * `UserDetailView.DELETE` (ADMIN-allowed) instead of `UserAppsView` (deny-all), and
   * `POST /api/user/5` the reverse.
   *
   * The C20 guard catches the disagreement, but only by answering **500**, where v1 answers
   * 403 — a fail-*safe* outcome, not a correct one. So the regexes that already encode the
   * discrimination get to make it: a pattern with a `dispatch` has
   * `DjangoUrlResolverMiddleware` rewrite `req.url` to a prefix only that pattern can produce,
   * and the matching controller is mounted there. Each controller then binds to exactly one
   * v1 view and the C20 invariant (declared === resolved) holds by construction rather than
   * by declaration order.
   *
   * ⚠️ The rewritten prefix must be **unreachable from outside**: `/api/user/apps/power` has
   * three segments and matches no pattern in this table, so a client cannot address it — the
   * resolver 404s it before the router ever sees it. Any new `dispatch` must preserve that.
   *
   * @param pathInfo the decoded `PATH_INFO` the pattern matched, leading slash included.
   * @returns the internal path, leading slash included.
   */
  readonly dispatch?: (pathInfo: string) => string;
}

/**
 * What {@link DjangoUrlResolverMiddleware} hands the guards: the pattern Django's resolver
 * would have matched, so `RolesGuard` evaluates the rules of the view **v1** would have
 * dispatched to rather than the one Express's declaration order happened to pick.
 *
 * ## Why this is not paranoia
 *
 * Django picks the view by *first pattern that matches*. Express matches by *declaration
 * order with unconstrained `:params`*. Those are two different mappings, and on
 * `/api/user/<x>` v1 has three patterns whose rules disagree (measured live — the `Allow`
 * header names the view that answered):
 *
 * ```
 * ^api/user/?$                      UserView        POST 0  GET 3  PATCH [0,2]
 * ^api/user/(?P<app>-?[a-zA-Z]+)$   UserAppsView    POST 3            <- no DELETE
 * ^api/user/(?P<id>-?[0-9]+)$       UserDetailView  GET 3  PATCH 3  DELETE 0
 * ```
 *
 * `DELETE /api/user/power` is `UserAppsView` in v1 (`Allow: POST, OPTIONS`, verified), which
 * declares no `DELETE`, so `APIRolePermission`'s bare `except` denies it for **every** role
 * including ADMIN. A Phase 3 controller that declared `@Delete(':id')` before `@Post(':app')`
 * would route it to `UserDetailView.DELETE` — ADMIN-allowed — and the difference would show
 * up as a successful soft delete, not as a 404.
 */
export interface RequestWithDjangoRoute {
  /** Set by {@link DjangoUrlResolverMiddleware} on every request it lets through. */
  djangoRoute?: DjangoUrlPattern;
}

const DRF_JSON_ONLY = (allow: string): DrfViewHeaders => ({ allow, varyAccept: false });

/** The captured segment of a two-segment `/api/user/<x>` path. */
const lastSegment = (pathInfo: string): string => pathInfo.slice(pathInfo.lastIndexOf('/') + 1);
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
  // ⚠️ `dispatch` — see DjangoUrlPattern.dispatch. `:app` and `:id` are indistinguishable to
  // Express, and picking the wrong one is an authorisation decision, not a routing detail.
  {
    regex: /^api\/user\/-?[a-zA-Z]+$/,
    view: 'UserAppsView',
    drf: DRF('POST, OPTIONS'),
    dispatch: (pathInfo) => `/api/user/apps/${lastSegment(pathInfo)}`,
  },
  // url(r'^api/user/(?P<id>-?[0-9]+)$', UserDetailView.as_view(), ...) — the `-1` sentinel
  {
    regex: /^api\/user\/-?[0-9]+$/,
    view: 'UserDetailView',
    drf: DRF('GET, PATCH, DELETE, HEAD, OPTIONS'),
    dispatch: (pathInfo) => `/api/user/detail/${lastSegment(pathInfo)}`,
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
  // `view: null` — no v1 view, so no permission rule can key on it and `RolesGuard` refuses
  // any controller that claims one here (condition C20). `/health` is `@Public()`.
  { regex: /^health\/?$/, view: null, drf: null },
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
 * .useValue([...DJANGO_URL_CONF, { regex: /^__bigint\/.+$/, view: null, drf: null }])
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
