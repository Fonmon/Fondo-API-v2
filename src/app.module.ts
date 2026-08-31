import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { DrfParserInterceptor } from './common/http/drf-parser.interceptor';
import { DrfRequestParsingMiddleware } from './common/http/drf-request-parsing.middleware';
import { JsonBigIntSetup } from './common/http/json-bigint';
import { HealthModule } from './health/health.module';
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
 * Users, loans, activities, saving accounts, files, notifications and the scheduler tasks
 * arrive in Phases 2-8.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    // Registered now so Phase 7 only has to add the cron provider. Declares no jobs yet.
    ScheduleModule.forRoot(),
    HealthModule,
  ],
  providers: [
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
   * Owns request body parsing, replacing Nest's built-in parser (which is switched off by
   * `NEST_APPLICATION_OPTIONS`). Applied here rather than in `main.ts` so every e2e suite
   * that imports `AppModule` runs the production request pipeline.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DrfRequestParsingMiddleware).forRoutes('{*path}');
  }
}
