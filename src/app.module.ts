import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Phase 0 root module: configuration, the data layer, cross-cutting error rendering, the
 * scheduler runtime and a single `/health` route.
 *
 * **No business endpoints.** Auth, users, loans, activities, saving accounts, files,
 * notifications and the scheduler tasks themselves arrive in Phases 1-8.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    // Registered now so Phase 7 only has to add the cron provider. Declares no jobs yet.
    ScheduleModule.forRoot(),
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
})
export class AppModule {}
