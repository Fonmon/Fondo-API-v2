import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
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
   *  1. {@link DjangoResponseHeadersMiddleware} — `XFrameOptionsMiddleware` plus the
   *     Express-isms v1 does not emit (`X-Powered-By`, `ETag`, `; charset=utf-8`). Registered
   *     first so its response hook also lands on the CORS preflight short-circuit.
   *  2. {@link DjangoCorsMiddleware} — `corsheaders.CorsMiddleware`. Answers a **genuine**
   *     preflight before the router; lets every other `OPTIONS` fall through to the guards.
   *  3. {@link DjangoUrlResolverMiddleware} — `URLResolver.resolve` + `APPEND_SLASH`, i.e.
   *     v1's URL table, applied before any guard (condition C9).
   *  4. {@link DrfRequestParsingMiddleware} — owns request body parsing, replacing Nest's
   *     built-in parser (switched off by `NEST_APPLICATION_OPTIONS`).
   *
   * 1 and 2 both act on the way *out* (via `onBeforeHeaders`) and are independent of each
   * other; 3 and 4 act on the way in and are strictly ordered — Django resolves the URL
   * before DRF ever looks at the body.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        DjangoResponseHeadersMiddleware,
        DjangoCorsMiddleware,
        DjangoUrlResolverMiddleware,
        DrfRequestParsingMiddleware,
      )
      .forRoutes('{*path}');
  }
}
