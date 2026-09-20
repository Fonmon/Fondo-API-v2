import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClockModule } from '../common/clock/clock';
import { AppConfigModule } from '../config/config.module';
import { MailModule } from '../mail/mail.module';
import { NotificationModule } from '../notifications/notification.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PowerService } from './power.service';
import { UserActivateController } from './user-activate.controller';
import { UserAppsController } from './user-apps.controller';
import { UserController } from './user.controller';
import { UserDetailController } from './user-detail.controller';
import { UserService } from './user.service';

/**
 * Phase 3 — members, finance, powers of attorney.
 *
 * ## Controller order is v1's `urls.py` order
 *
 * `fondo_api/urls.py:20-23` lists `UserView`, `UserAppsView`, `UserDetailView`,
 * `UserActivateView`, and Django resolves by first match. v2 keeps that order so the two files
 * diff cleanly — but it is **no longer load-bearing**: `DjangoUrlPattern.dispatch` gives the
 * two colliding patterns disjoint internal prefixes (`/api/user/apps/…`, `/api/user/detail/…`),
 * so Express's declaration order cannot pick a different view from Django's regexes. Condition
 * **C20**'s guard remains as the check that they agree.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule, MailModule, NotificationModule, ClockModule],
  controllers: [UserController, UserAppsController, UserDetailController, UserActivateController],
  providers: [UserService, PowerService],
  exports: [UserService, PowerService],
})
export class UserModule {}
