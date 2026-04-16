import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulerTaskType, SchedulerRepeat } from '../common/enums';

jest.mock('@aws-sdk/client-sqs', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  const MockSQSClient = jest.fn().mockImplementation(() => ({ send: mockSend }));
  const MockSendMessageCommand = jest.fn().mockImplementation((input) => input);
  return {
    SQSClient: MockSQSClient,
    SendMessageCommand: MockSendMessageCommand,
    __mockSend: mockSend,
  };
});

const { __mockSend: mockSqsSend } = jest.requireMock('@aws-sdk/client-sqs');

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      fondo_api_notificationsubscriptions: {
        deleteMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'aws.region') return 'us-east-1';
              if (key === 'aws.notificationsQueueUrl') return 'https://sqs.test/queue';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    prisma = module.get(PrismaService);
    mockSqsSend.mockClear();
  });

  describe('saveSubscription', () => {
    it('should not insert if subscription already exists', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 1 }]);
      await service.saveSubscription(1, { endpoint: 'https://push.example.com' });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('should insert if subscription does not exist', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
      await service.saveSubscription(1, {
        endpoint: 'https://push.example.com',
        keys: { p256dh: 'key1', auth: 'auth1' },
      });
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should stringify non-string values', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
      await service.saveSubscription(1, {
        endpoint: 'https://push.example.com',
        keys: { p256dh: 'key', auth: 'auth' },
        extra: { nested: true } as unknown as string,
      });
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('unregisterSubscription', () => {
    it('should return true when a row is deleted', async () => {
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
      const result = await service.unregisterSubscription(1, 'https://push.example.com');
      expect(result).toBe(true);
    });

    it('should return false when no rows deleted', async () => {
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);
      const result = await service.unregisterSubscription(1, 'https://push.example.com');
      expect(result).toBe(false);
    });
  });

  describe('removeAllSubscriptions', () => {
    it('should call deleteMany with userId', async () => {
      (prisma.fondo_api_notificationsubscriptions.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
      await service.removeAllSubscriptions(5);
      expect(prisma.fondo_api_notificationsubscriptions.deleteMany).toHaveBeenCalledWith({
        where: { user_id: 5 },
      });
    });
  });

  describe('sendNotification', () => {
    it('should do nothing if userIds is empty', async () => {
      await service.sendNotification([], { body: 'hello', target: '/' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('should do nothing if no subscriptions found', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.sendNotification([1, 2], { body: 'hello', target: '/' });
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('should send SQS message with subscriptions', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { subscription: '"endpoint"=>"https://push.example.com","keys"=>"{\\\"p256dh\\\":\\\"key\\\"}"' },
      ]);
      await service.sendNotification([1], { body: 'hello', target: '/' });
      expect(mockSqsSend).toHaveBeenCalled();
    });

    it('should handle subscription values that are not valid JSON', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { subscription: '"endpoint"=>"https://push.example.com"' },
      ]);
      await service.sendNotification([1], { body: 'test', target: '/home' });
      expect(mockSqsSend).toHaveBeenCalled();
    });
  });

  describe('scheduleNotification', () => {
    it('should not insert if notification already scheduled', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 1 }]);
      await service.scheduleNotification(
        1,
        { body: 'test', target: '/' },
        new Date('2026-03-20'),
        SchedulerTaskType.NOTIFICATIONS,
        SchedulerRepeat.YEARLY,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('should insert if no existing notification', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
      await service.scheduleNotification(
        1,
        { body: 'test', target: '/' },
        new Date('2026-03-20'),
        SchedulerTaskType.NOTIFICATIONS,
        SchedulerRepeat.YEARLY,
      );
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('removeScheduledNotifications', () => {
    it('should call executeRaw with correct params', async () => {
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(2);
      await service.removeScheduledNotifications(1, SchedulerTaskType.NOTIFICATIONS);
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });
  });
});
