import { Test, TestingModule } from '@nestjs/testing';
import { MethodNotAllowedException } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let service: jest.Mocked<NotificationsService>;

  const mockUser = {
    id: 1,
    email: 'test@test.com',
    firstName: 'Test',
    lastName: 'User',
    role: 3,
    profileId: 1,
  };

  beforeEach(async () => {
    const mockService = {
      saveSubscription: jest.fn().mockResolvedValue(undefined),
      unregisterSubscription: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: mockService }],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
    service = module.get(NotificationsService);
  });

  it('should call saveSubscription on subscribe', async () => {
    const body = { endpoint: 'https://push.example.com' };
    await controller.handleNotification(
      'subscribe',
      body as any,
      { user: mockUser } as any,
    );
    expect(service.saveSubscription).toHaveBeenCalledWith(1, body);
  });

  it('should call unregisterSubscription on unsubscribe', async () => {
    await controller.handleNotification(
      'unsubscribe',
      { subscription: { endpoint: '' }, endpoint: 'https://push.example.com' } as any,
      { user: mockUser } as any,
    );
    expect(service.unregisterSubscription).toHaveBeenCalledWith(1, 'https://push.example.com');
  });

  it('should throw MethodNotAllowedException for unknown operation', async () => {
    await expect(
      controller.handleNotification(
        'unknown',
        {} as any,
        { user: mockUser } as any,
      ),
    ).rejects.toThrow(MethodNotAllowedException);
  });
});
