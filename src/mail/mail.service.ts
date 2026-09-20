import { SendEmailCommand, type SESClient, type SendEmailCommandInput } from '@aws-sdk/client-ses';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { EmailTemplateRenderer } from './email-template.renderer';
import type { EmailTemplate, EmailTemplateParams } from './email-template';
import { SES_CLIENT } from './ses.client';

/**
 * `fondo_api/services/mail.py:MailService`.
 *
 * ## The three behaviours that are load-bearing
 *
 * 1. **`sendMail` never throws.** v1's `send_mail` wraps everything in
 *    `try/except Exception → log → return False`. That falsy return is not defensive
 *    padding: `create_user` (`services/user.py:53`) does
 *    `if not self.__mail_service.send_mail(...): transaction.set_rollback(True)`, so an SES
 *    outage must roll the new member's four rows back rather than leaving an account nobody
 *    can activate. Anything that turns this into a thrown exception breaks Phase 3.
 * 2. **An address in both `recipients` and `bcc` is dropped from `bcc`** — otherwise the
 *    borrower receives the loan-approval email twice, once openly and once blind. v1's loop
 *    removes only the *first* matching entry per recipient (`list.remove`), which is
 *    reproduced literally below; `fondodev` has two pairs of members sharing one email
 *    address, so a duplicated bcc entry is not hypothetical.
 * 3. **`Source` is `DEFAULT_FROM_EMAIL` verbatim**, including the display-name form
 *    `Fondo Montanez <no-reply@fonmon.minagle.com>`.
 *
 * ## Deliberate difference: `bcc` is not mutated
 *
 * v1 mutates the caller's list in place (`bcc.remove(recipient)`), and its `bcc=[]` default
 * argument is the classic shared-mutable-default. Neither is observable — `.remove` only ever
 * shortens the shared default, and all three call sites pass a freshly built list from
 * `get_users_attr('email', [0,2])` — so v2 copies instead. Registered in
 * `docs/phase-2-deviations.md`.
 */
@Injectable()
export class MailService {
  /** v1: `self.CHARSET = "UTF-8"`. */
  private readonly charset = 'UTF-8';

  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    private readonly config: AppConfigService,
    private readonly renderer: EmailTemplateRenderer,
  ) {}

  /**
   * `send_mail(template, recipients, params, bcc=[])`.
   *
   * @returns `true` when SES accepted the message, `false` for **any** failure — a template
   *   miss, a render error, a network error, a throttle, a malformed address. Callers branch
   *   on the boolean; nothing propagates.
   */
  async sendMail<T extends EmailTemplate>(
    template: T,
    recipients: readonly string[],
    params: EmailTemplateParams[T],
    bcc: readonly string[] = [],
  ): Promise<boolean> {
    try {
      const bccAddresses = withoutRecipients(recipients, bcc);
      const mail = this.renderer.render(template, params);

      const input: SendEmailCommandInput = {
        Destination: {
          ToAddresses: [...recipients],
          BccAddresses: bccAddresses,
        },
        Message: {
          Body: {
            Html: {
              Charset: this.charset,
              Data: mail.body,
            },
          },
          Subject: {
            Charset: this.charset,
            Data: mail.subject,
          },
        },
        Source: this.config.defaultFromEmail,
      };

      await this.ses.send(new SendEmailCommand(input));
      return true;
    } catch (error) {
      // v1: `self.__logger.error('Error sending email: %s', e)`.
      this.logger.error(
        `Error sending email: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }
}

/**
 * v1's deduplication loop, transcribed:
 *
 * ```python
 * for recipient in recipients:
 *     if recipient in bcc:
 *         bcc.remove(recipient)
 * ```
 *
 * ⚠️ `list.remove` deletes **one** occurrence, so `bcc = ['a', 'a']` with `recipients = ['a']`
 * leaves `['a']`. A `filter(a => !recipients.includes(a))` would leave `[]` — a different
 * `BccAddresses` array, i.e. a different SES payload. Two pairs of live members share an
 * email address, so `get_users_attr('email', [0, 2])` can genuinely contain a duplicate.
 */
function withoutRecipients(recipients: readonly string[], bcc: readonly string[]): string[] {
  const remaining = [...bcc];
  for (const recipient of recipients) {
    const index = remaining.indexOf(recipient);
    if (index !== -1) {
      remaining.splice(index, 1);
    }
  }
  return remaining;
}
