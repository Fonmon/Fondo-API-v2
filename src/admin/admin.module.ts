import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { NotificationModule } from '../notifications/notification.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Phase 8 — `GET /api/admin`. Mirrors `views/admin.py:8-10`, which builds a `MailService`
 * and a `NotificationService` and hands both to `AdminService`.
 */
@Module({
  imports: [AuthModule, MailModule, NotificationModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
