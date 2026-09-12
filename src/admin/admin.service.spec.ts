import { Role } from '../auth/permissions/roles';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { EmailTemplate } from '../mail/email-template';
import type { MailService } from '../mail/mail.service';
import type { NotificationService } from '../notifications/notification.service';
import { AdminService } from './admin.service';

/**
 * `fondo_api/services/admin.py`, unit level. ⚠️ **v1 has no test for this service or its
 * view**; the cells are written from the source and from the pinned v1's measured calls
 * (`oracle-out2.jsonl`: `['mail', 'TEST', 5, [<caller email>], None, []]` and
 * `['notification', [<caller id>], 'Test Notification', '/']`).
 */
describe('AdminService (unit)', () => {
  const caller: AuthenticatedUser = {
    id: 7,
    username: 'admin@mail.com',
    email: 'admin@mail.com',
    isActive: true,
    profile: { role: Role.ADMIN, identification: 99999n },
  };

  function build(sendMailResult: boolean = true): {
    service: AdminService;
    mail: { sendMail: jest.Mock };
    notifications: { sendNotification: jest.Mock };
  } {
    const mail = { sendMail: jest.fn().mockResolvedValue(sendMailResult) };
    const notifications = { sendNotification: jest.fn().mockResolvedValue('no-subscriptions') };
    const service = new AdminService(
      mail as unknown as MailService,
      notifications as unknown as NotificationService,
    );
    return { service, mail, notifications };
  }

  it('test_email: the TEST template (5) to the caller alone, no params, default bcc', async () => {
    const { service, mail, notifications } = build();
    await service.testEmail(caller);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).toHaveBeenCalledWith(EmailTemplate.TEST, ['admin@mail.com'], undefined);
    expect(mail.sendMail.mock.calls[0]).toHaveLength(3);
    expect(EmailTemplate.TEST).toBe(5);
    expect(notifications.sendNotification).not.toHaveBeenCalled();
  });

  it('test_email: a refused send is swallowed (send_mail returns False, the view still 200s)', async () => {
    const { service } = build(false);
    await expect(service.testEmail(caller)).resolves.toBeUndefined();
  });

  it('test_notifications: the caller id alone, the literal body and target', async () => {
    const { service, mail, notifications } = build();
    await service.testNotifications(caller);
    expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
    expect(notifications.sendNotification).toHaveBeenCalledWith([7], 'Test Notification', '/');
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});
