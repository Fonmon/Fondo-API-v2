import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { EmailTemplateRenderer } from './email-template.renderer';
import { MailService } from './mail.service';
import { sesClientProvider, SES_CLIENT } from './ses.client';

/**
 * SES email. The v2 home of `fondo_api/services/mail.py` plus the six Spanish templates.
 *
 * v1 instantiates `MailService()` at module import in four view modules
 * (`views/user.py`, `views/loan.py`, `views/auth.py`, `views/admin.py`), each getting its own
 * boto3 client. v2 exports one provider and lets Nest inject it — Phases 3, 4 and 8 import
 * this module instead of constructing anything.
 *
 * {@link SES_CLIENT} is exported so an e2e suite can override it with a stub, which is the
 * v2 equivalent of v1's `@patch('boto3.client')`.
 */
@Module({
  imports: [AppConfigModule],
  providers: [sesClientProvider, EmailTemplateRenderer, MailService],
  exports: [MailService, EmailTemplateRenderer, SES_CLIENT],
})
export class MailModule {}
