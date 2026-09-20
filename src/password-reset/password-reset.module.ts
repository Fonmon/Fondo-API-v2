import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppConfigModule } from '../config/config.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UserModule } from '../users/user.module';
import { PasswordResetHtmlRenderer } from './html-template.renderer';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetTokenService } from './password-reset-token.service';

/**
 * Phase 3 — password reset: `POST /password_reset/` (v1's own view) and the three
 * `django.contrib.auth` pages around it.
 *
 * These are the **only Django form pages** in the service — everything else is DRF — which is
 * why CSRF, HTML templates and cookies exist here and nowhere else in v2.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule, MailModule, UserModule],
  controllers: [PasswordResetController],
  providers: [PasswordResetService, PasswordResetTokenService, PasswordResetHtmlRenderer],
  exports: [PasswordResetService, PasswordResetTokenService],
})
export class PasswordResetModule {}
