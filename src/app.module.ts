import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { DjangoAppendSlashMiddleware } from './common/http/django-append-slash.middleware';
import { DjangoCorsMiddleware } from './common/http/django-cors.middleware';
import { DjangoResponseHeadersMiddleware } from './common/http/django-response-headers.middleware';
import { DJANGO_URL_CONF, DJANGO_URL_CONF_TOKEN } from './common/http/django-url-conf';
import { DjangoUrlResolverMiddleware } from './common/http/django-url-resolver.middleware';
import { DrfParserInterceptor } from './common/http/drf-parser.interceptor';
import { DrfRequestParsingMiddleware } from './common/http/drf-request-parsing.middleware';
import { JsonBigIntSetup } from './common/http/json-bigint';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { NotificationModule } from './notifications/notification.module';
import { PrismaModule } from './prisma/prisma.module';

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
 * Users, loans, activities, saving accounts, files and the scheduler arrive in Phases 3-8.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    MailModule,
    NotificationModule,
    // Registered now so Phase 7 only has to add the cron provider. Declares no jobs yet.
    ScheduleModule.forRoot(),
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
   * | 3 | `CommonMiddleware` | {@link DjangoAppendSlashMiddleware} — the `APPEND_SLASH` 301 |
   * | 4 | `CsrfViewMiddleware` | not modelled; DRF views are CSRF-exempt (Phase 3 owns the forms) |
   * | 5 | `AuthenticationMiddleware` | not modelled; DRF authenticates per view |
   * | 6 | `MessageMiddleware` | not modelled; no view uses the messages framework |
   * | 7 | `XFrameOptionsMiddleware` | {@link DjangoResponseHeadersMiddleware} (+ the Express-isms v1 does not emit) |
   * | 8 | `corsheaders.CorsMiddleware` | {@link DjangoCorsMiddleware} |
   * | — | `BaseHandler._get_response` — URL resolution and the view, *below* all eight | {@link DjangoUrlResolverMiddleware}, then {@link DrfRequestParsingMiddleware} |
   *
   * The last row is why the URL layer is **two** middlewares (finding N1, condition C15).
   * `CommonMiddleware`'s 301 is emitted at depth 3, above CORS; the resolver's 404 is emitted
   * below depth 8, under it. Measured on the live v1, a genuine preflight is a **301** on
   * `/password_reset` and a **200** on `/nope/nope` — no single middleware placed on one side
   * of {@link DjangoCorsMiddleware} can produce both.
   *
   * Requests run down the list; responses run back up it, which is what
   * `onBeforeHeaders`/`skipBeforeHeadersHooks` reproduce — 7 and 8 decorate everything the
   * layers below them return, and nothing decorates 3's redirect.
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
        DjangoAppendSlashMiddleware,
        DjangoResponseHeadersMiddleware,
        DjangoCorsMiddleware,
        DjangoUrlResolverMiddleware,
        DrfRequestParsingMiddleware,
      )
      .forRoutes('/');
  }
}
