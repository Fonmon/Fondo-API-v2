import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailTemplate } from '../common/enums';
import { UserContext } from '../auth/auth.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  async testEmail(user: UserContext): Promise<void> {
    await this.mail.sendMail(EmailTemplate.TEST, [user.email], {
      user_full_name: `${user.firstName} ${user.lastName}`,
    });
  }

  async testNotifications(user: UserContext): Promise<void> {
    await this.notifications.sendNotification([user.profileId], {
      body: 'Test Notification',
      target: '/',
    });
  }
}
