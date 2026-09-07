import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ActivityModule } from './activities/activity.module';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { DjangoAllowedHostsMiddleware } from './common/http/django-allowed-hosts.middleware';
import { DjangoAppendSlashMiddleware } from './common/http/django-append-slash.middleware';
import { DjangoCorsMiddleware } from './common/http/django-cors.middleware';
import { DjangoResponseHeadersMiddleware } from './common/http/django-response-headers.middleware';
import { DJANGO_URL_CONF, DJANGO_URL_CONF_TOKEN } from './common/http/django-url-conf';
import { DjangoUrlResolverMiddleware } from './common/http/django-url-resolver.middleware';
import { DrfContentNegotiationMiddleware } from './common/http/drf-content-negotiation.middleware';
import { DrfParserInterceptor } from './common/http/drf-parser.interceptor';
import { DrfRequestParsingMiddleware } from './common/http/drf-request-parsing.middleware';
import { GunicornHttpEdge } from './common/http/gunicorn-http-edge';
import { JsonBigIntSetup } from './common/http/json-bigint';
import { HealthModule } from './health/health.module';
import { LoanModule } from './loans/loan.module';
import { MailModule } from './mail/mail.module';
import { NotificationModule } from './notifications/notification.module';
import { PasswordResetModule } from './password-reset/password-reset.module';
import { PrismaModule } from './prisma/prisma.module';
import { SchedulerRunnerModule } from './scheduler/scheduler-runner.module';
import { UserModule } from './users/user.module';

/**
 * Root module.
 *
 * Phase 0 supplied configuration, the data layer, cross-cutting error rendering, the
 * scheduler runtime and `/health`. Phase 1 adds {@link AuthModule}, which contributes
 * `POST /api-token-auth` **and the two global guards** — from here on every route is denied
 * unless it carries `@V1View(...)` with a matching rule in the permission matrix, or is
 * explicitly `@Public()`.
 *
 * Phase 2 adds {@link MailModule} (SES, the six Spanish templates) and
 * {@link NotificationModule} (`POST /api/notification/<subscribe|unsubscribe>`, the hstore
 * subscription repository and the SQS publisher).
 *
 * Phase 3 adds {@link UserModule} — `POST|GET|PATCH /api/user`,
 * `GET|PATCH|DELETE /api/user/<id>`, `POST /api/user/<birthdates|power>`,
 * `POST /api/user/activate/<id>` — together with Phase **7a**, the `SchedulerTask` write half
 * its birthday notification needs (`SchedulerModule`, pulled in through
 * {@link NotificationModule}).
 *
 * Phase 4 adds {@link LoanModule} — `GET|POST|PATCH /api/loan`, `GET|PATCH /api/loan/<id>`
 * and `POST /api/loan/<id>/<paymentProjection|refinance>`.
 *
 * Phase 5 adds {@link ActivityModule} — `GET|POST /api/activity/year`,
 * `GET|POST /api/activity/year/<id_year>` and `GET|PATCH|DELETE /api/activity/<id>`.
 *
 * Phase **7b** adds {@link SchedulerRunnerModule} — the cron that replaces `celery beat`,
 * the executer factory and the `repeat` cloning. It contributes **no route**.
 *
 * Saving accounts and files arrive in Phases 6 and 8.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    MailModule,
    NotificationModule,
    UserModule,
    LoanModule,
    ActivityModule,
    PasswordResetModule,
    ScheduleModule.forRoot(),
    // Phase 7b: the `celery beat` replacement. Declares the 10:00/14:00 America/Bogota cron
    // but does no work unless `SCHEDULER_ENABLED` is set on *this* process — v1's beat is a
    // separate container, and that is how the multi-instance question is answered.
    SchedulerRunnerModule,
    HealthModule,
  ],
  providers: [
    // v1's URL conf, as a provider so a suite that mounts a synthetic controller can widen
    // it explicitly (`test/json-bigint.e2e-spec.ts`) and no other way.
    {
      provide: DJANGO_URL_CONF_TOKEN,
      useValue: DJANGO_URL_CONF,
    },
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    // Money is `BigInt` in Prisma and `JSON.stringify(1n)` throws. Registered here rather
    // than in `main.ts` so every e2e suite exercises the production wiring (rule 5b).
    JsonBigIntSetup,
    // Restores the two request shapes Node answers without ever calling Express: a method
    // token `llhttp` does not know (a bare 400) and `CONNECT` (no reply at all). v1 has no
    // method table — gunicorn validates the request line and Django's permission map decides
    // — so both are ordinary 401/403/404s there. Parity finding **N1**. A provider rather
    // than a line in `main.ts`, for the reason the middleware list gives.
    GunicornHttpEdge,
    // Raises the 415 / JSON-parse 400 that `DrfRequestParsingMiddleware` deferred, at DRF's
    // point in the pipeline: after authentication and permissions, before the handler (D18).
    {
      provide: APP_INTERCEPTOR,
      useClass: DrfParserInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * v1's `MIDDLEWARE` stack, in the order its phases run — and the whole of it, because
   * anything installed in `main.ts` instead is invisible to the e2e suites. That gap is how
   * `app.enableCors()` shipped a 204-for-every-`OPTIONS` past a green build (finding F1,
   * condition C14): the suites build the app from `AppModule` and never saw it.
   *
   * ## The order is v1's `MIDDLEWARE` list, not a convenience
   *
   * `api/settings/base.py:38-46`, with what each entry means for v2:
   *
   * | # | v1 | v2 |
   * |---|---|---|
   * | 1 | `SecurityMiddleware` | no-op — no `SECURE_*` setting is configured |
   * | 2 | `SessionMiddleware` | not modelled; only the Phase 3 auth pages touch the session |
   * | 3 | `CommonMiddleware` | {@link DjangoAllowedHostsMiddleware} (`get_host()` → 400), then {@link DjangoAppendSlashMiddleware} (the `APPEND_SLASH` 301) |
   * | 4 | `CsrfViewMiddleware` | not modelled; DRF views are CSRF-exempt (Phase 3 owns the forms) |
   * | 5 | `AuthenticationMiddleware` | not modelled; DRF authenticates per view |
   * | 6 | `MessageMiddleware` | not modelled; no view uses the messages framework |
   * | 7 | `XFrameOptionsMiddleware` | {@link DjangoResponseHeadersMiddleware} (+ the Express-isms v1 does not emit) |
   * | 8 | `corsheaders.CorsMiddleware` | {@link DjangoCorsMiddleware} |
   * | — | `BaseHandler._get_response` — URL resolution and the view, *below* all eight | {@link DjangoUrlResolverMiddleware}, then {@link DrfContentNegotiationMiddleware}, then {@link DrfRequestParsingMiddleware} |
   *
   * Slot 3 is **two** classes for the same reason the URL layer is: they are the two steps
   * of one `process_request`, in its order. `request.get_host()` runs first
   * (`django/middleware/common.py:47`) and raises `DisallowedHost` → **400** ahead of the
   * `APPEND_SLASH` check, the CORS preflight and the resolver — condition **C19**, and the
   * control that stops Phase 3's `PasswordResetView` from emailing a reset link built from a
   * forged `Host` header.
   *
   * ## The last three rows are one v1 layer, in `APIView.dispatch`'s order
   *
   * `BaseHandler` resolves the URL, then the view runs. Inside the view,
   * `initial()` negotiates a renderer **before** `perform_authentication` — so a request
   * whose `Accept` matches no renderer is a **406 before the guards, the handler and any
   * write** (parity finding **F6**). {@link DrfContentNegotiationMiddleware} therefore sits
   * between the resolver, which tells it which view's `renderer_classes` apply, and the body
   * parser, which in v1 does not run until the handler touches `request.data` at all.
   *
   * The last row is why the URL layer is **two** middlewares (finding N1, condition C15).
   * `CommonMiddleware`'s 301 is emitted at depth 3, above CORS; the resolver's 404 is emitted
   * below depth 8, under it. Measured on the live v1, a genuine preflight is a **301** on
   * `/password_reset` and a **200** on `/nope/nope` — no single middleware placed on one side
   * of {@link DjangoCorsMiddleware} can produce both.
   *
   * ## Registration order is the *request* order, and the reverse of the response order
   *
   * Requests run down the list; responses run back up it. So the order below is the order
   * these classes' **request** phases run, and their response phases run in the opposite
   * order — which is why `onBeforeHeaders` takes an explicit `DjangoStack` depth and sorts by
   * it rather than trusting this list (condition **C21**, finding **S1**). `DjangoCorsMiddleware`
   * is registered fourth of six and its response phase runs first of all the middlewares;
   * the comment that used to claim registration order *was* the response order was wrong,
   * and stopped being harmless the moment Phase 3 adds a second `Vary`-touching layer.
   *
   * `skipBeforeHeadersHooks` likewise takes a depth: `CommonMiddleware`'s 301 skips only what
   * is *below* slot 3, and the C19 `DisallowedHost` 400 skips slot 3's own response phase as
   * well, because Django raises it rather than returning it.
   *
   * ## Mounted at `/`, not at a wildcard
   *
   * `forRoutes('/')` makes Nest call `app.use('/', ...)`, which Express treats as "every
   * request, trim nothing". Under a wildcard mount (`'{*path}'`) Express strips the matched
   * prefix from `req.url` for the duration of the middleware and restores it by *prepending*
   * the removed prefix on `next()` — so `DjangoUrlResolverMiddleware`'s rewrite of `req.url`
   * to the decoded `PATH_INFO` (finding N3) would be spliced onto the raw target instead of
   * replacing it. Both mounts run on every request; only this one lets a middleware re-target
   * the router.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        DjangoAllowedHostsMiddleware,
        DjangoAppendSlashMiddleware,
        DjangoResponseHeadersMiddleware,
        DjangoCorsMiddleware,
        DjangoUrlResolverMiddleware,
        DrfContentNegotiationMiddleware,
        DrfRequestParsingMiddleware,
      )
      .forRoutes('/');
  }
}
