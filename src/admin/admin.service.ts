import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { EmailTemplate } from '../mail/email-template';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';

/**
 * `fondo_api/services/admin.py:AdminService` — the operator's self-test of the two outbound
 * channels.
 *
 * ```python
 * def test_email(self, user):
 *     self.__mail_service.send_mail(EmailTemplate.TEST, [user.email], None)
 *
 * def test_notifications(self, user):
 *     self.__notification_service.send_notification([user.id], "Test Notification", "/")
 * ```
 *
 * ⚠️ **Both sends go to the caller only**, and **both results are discarded**: a mail SES
 * refuses and a push with no subscription both still answer 200. `MailService.sendMail`
 * returns `false` rather than throwing (`admin.service.spec.ts`, "a refused send is
 * swallowed"), and `NotificationPublisher.publish` swallows publish failures
 * (`notification-publisher.spec.ts`, "condition 2 — the failure is swallowed at the
 * boundary"). ⚠️ Not everything is swallowed: `sendNotification` first awaits the subscription
 * query, and a rejection there propagates out of `testNotifications`. No cell here pins that
 * path. ⚠️ These are **real** sends in production — the
 * `TEST` template to a real inbox, a push to real devices.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
  ) {}

  async testEmail(user: AuthenticatedUser): Promise<void> {
    await this.mail.sendMail(EmailTemplate.TEST, [user.email], undefined);
  }

  async testNotifications(user: AuthenticatedUser): Promise<void> {
    await this.notifications.sendNotification([user.id], 'Test Notification', '/');
  }
}
