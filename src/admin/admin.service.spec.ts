import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailTemplate } from '../common/enums';

describe('AdminService', () => {
  let service: AdminService;
  let mail: jest.Mocked<MailService>;
  let notifications: jest.Mocked<NotificationsService>;

  const mockUser = {
    id: 1,
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    role: 0,
    profileId: 1,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: MailService,
          useValue: {
            sendMail: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendNotification: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    mail = module.get(MailService);
    notifications = module.get(NotificationsService);
  });

  it('should send test email', async () => {
    await service.testEmail(mockUser);
    expect(mail.sendMail).toHaveBeenCalledWith(
      EmailTemplate.TEST,
      [mockUser.email],
      { user_full_name: 'Admin User' },
    );
  });

  it('should send test notification', async () => {
    await service.testNotifications(mockUser);
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      [mockUser.profileId],
      { body: 'Test Notification', target: '/' },
    );
  });
});
