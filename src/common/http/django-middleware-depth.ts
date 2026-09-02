/**
 * v1's `MIDDLEWARE` stack as a **number line**, so the response phase can be ordered by it —
 * review condition **C21**, finding **S1**.
 *
 * ## Why a depth and not a registration order
 *
 * Django middleware is a pair of phases. Requests run **down** `MIDDLEWARE`
 * (`api/settings/base.py:38-46`); responses run back **up** it, plus the view underneath,
 * which is deeper than all eight. `AppModule.configure` registers v2's middlewares in
 * *forward* order because that is the order their request phases run — so registration order
 * is the exact **reverse** of the order their response phases run, and a FIFO hook list ran
 * the response phase backwards. (It was unobservable: the two hooks that existed touched
 * disjoint headers. The doc comment claiming otherwise was simply wrong.)
 *
 * The order is load-bearing from Phase 3 onward because `patch_vary_headers` **appends**;
 * `Vary`'s element order is a function of which layer got there first, and the round-3 parity
 * sweep measured two different orders on v1 for that reason:
 *
 * | route | `Vary` | who added `Cookie` | depth |
 * |---|---|---|---|
 * | `GET /password_reset/` | `Cookie, Origin` | `PasswordResetView`'s view-level `csrf_protect` | {@link DjangoStack.VIEW} — **below** all eight |
 * | `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `SessionMiddleware` | {@link DjangoStack.SESSION} — slot 2, above `corsheaders` |
 *
 * Both fall out of "run hooks in descending depth" with no per-route special case. That is
 * the property this module exists to give the runtime; `django-middleware-depth.spec.ts`
 * pins both orders against probe hooks.
 *
 * ## Not a middleware registry
 *
 * These numbers are v1's slots, not v2's classes. Several slots have no v2 counterpart (they
 * are no-ops under v1's settings, or not modelled yet) and one v2 class registers hooks at
 * **three** different depths, because that is where the three things it does actually live.
 */
export const DjangoStack = {
  /**
   * Above all of Django: the WSGI/HTTP server boundary. Not a v1 slot.
   *
   * gunicorn adds `Server` and `Date` here; Express adds `X-Powered-By` and `ETag`, which v1
   * never emits. Removing them is a transport fixup, not a ported middleware, and it must
   * survive every short-circuit — which it does, because no `skipBeforeHeadersHooks` caller
   * can be shallower than slot 1.
   */
  TRANSPORT: 0,

  /** `django.middleware.security.SecurityMiddleware` — no-op, no `SECURE_*` is configured. */
  SECURITY: 1,
  /** `django.contrib.sessions.middleware.SessionMiddleware` — not modelled until Phase 3. */
  SESSION: 2,
  /** `django.middleware.common.CommonMiddleware` — `get_host()` (C19) and `APPEND_SLASH`. */
  COMMON: 3,
  /** `django.middleware.csrf.CsrfViewMiddleware` — not modelled until Phase 3. */
  CSRF: 4,
  /** `django.contrib.auth.middleware.AuthenticationMiddleware` — DRF authenticates per view. */
  AUTHENTICATION: 5,
  /** `django.contrib.messages.middleware.MessageMiddleware` — no view uses the framework. */
  MESSAGE: 6,
  /** `django.middleware.clickjacking.XFrameOptionsMiddleware`. */
  X_FRAME_OPTIONS: 7,
  /** `corsheaders.middleware.CorsMiddleware`. */
  CORS: 8,

  /**
   * `BaseHandler._get_response` — URL resolution, view-level decorators and the view itself,
   * **below** all eight. DRF's renderer, its `default_response_headers` and Django's
   * view-level `csrf_protect` all live here.
   *
   * A sentinel rather than a real slot, and the reason `skipBeforeHeadersHooks` needs a
   * *depth* rather than a boolean: "below the middleware stack" is a position the flat model
   * could not express at all.
   */
  VIEW: 9,
} as const;

/** One of {@link DjangoStack}'s positions. */
export type DjangoDepth = (typeof DjangoStack)[keyof typeof DjangoStack];
