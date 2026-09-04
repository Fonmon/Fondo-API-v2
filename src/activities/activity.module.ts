import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ActivityDetailController } from './activity-detail.controller';
import { ActivityService } from './activity.service';
import { ActivityYearController } from './activity-year.controller';
import { ActivityYearDetailController } from './activity-year-detail.controller';

/**
 * Phase 5 — activities.
 *
 * ⚠️ **The controller order is load-bearing here, unlike Phase 4's.** Django's resolver reads
 * `fondo_api/urls.py:25-27` in order and `^api/activity/(?P<id>[0-9]+)/?$` can never match
 * `/api/activity/year`, because `year` is not `[0-9]+`. Express has no such constraint:
 * `api/activity/:id` matches `year` happily, so {@link ActivityYearController} and
 * {@link ActivityYearDetailController} are registered **before**
 * {@link ActivityDetailController}, which is the reverse of v1's file order and deliberate.
 *
 * The failure mode if that were wrong is loud rather than silent — condition **C20**:
 * `DjangoUrlResolverMiddleware` resolves `ActivityYearView` from the table, the matched Nest
 * route declares `@V1View('ActivityDetailView')`, and `RolesGuard` raises a logged **500**
 * instead of applying the wrong role rules. `test/activity.e2e-spec.ts` pins it from the
 * outside: `GET /api/activity/year` must answer the year list, not an activity 404.
 *
 * No `dispatch` rewrite is needed (contrast the `UserAppsView` / `UserDetailView` pair): the
 * three v1 patterns are distinguishable by a **literal segment**, not only by character
 * class, so declaration order alone separates them.
 *
 * `ActivityService` has one dependency, Prisma — matching v1, where
 * `views/activity.py:7` constructs a bare `ActivityService()`. {@link AuthModule} is imported
 * for the guards, as every feature module does.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ActivityYearController, ActivityYearDetailController, ActivityDetailController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
