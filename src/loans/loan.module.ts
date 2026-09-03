import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppConfigModule } from '../config/config.module';
import { MailModule } from '../mail/mail.module';
import { NotificationModule } from '../notifications/notification.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UserModule } from '../users/user.module';
import { LoanAppsController } from './loan-apps.controller';
import { LoanDetailController } from './loan-detail.controller';
import { LoanController } from './loan.controller';
import { LoanService } from './loan.service';

/**
 * Phase 4 — loans.
 *
 * Controller order is `fondo_api/urls.py:17-19` order (`LoanView`, `LoanDetailView`,
 * `LoanAppsView`). Unlike the user routes, the three loan patterns are mutually exclusive by
 * *shape* (`/api/loan`, `/api/loan/<id>`, `/api/loan/<id>/<app>`), so no `dispatch` rewrite is
 * needed and declaration order is not load-bearing — `DjangoUrlResolverMiddleware` picks the
 * view and condition **C20** makes `RolesGuard` key off *that*, not off whichever Nest route
 * Express matched.
 *
 * {@link UserModule} is imported for `UserService.getUserIds` / `getUserEmails`, which is how
 * v1 wires it too: `views/loan.py:14` constructs
 * `LoanService(user_service, notification_service, mail_service)`.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule, MailModule, NotificationModule, UserModule],
  controllers: [LoanController, LoanDetailController, LoanAppsController],
  providers: [LoanService],
  exports: [LoanService],
})
export class LoanModule {}
