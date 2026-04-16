import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BadRequestException } from '@nestjs/common';

describe('AdminController', () => {
  let controller: AdminController;
  let service: jest.Mocked<AdminService>;

  const mockUser = {
    id: 1,
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    role: 0,
    profileId: 1,
  };

  beforeEach(async () => {
    const mockService = {
      testEmail: jest.fn().mockResolvedValue(undefined),
      testNotifications: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: mockService }],
    }).compile();

    controller = module.get<AdminController>(AdminController);
    service = module.get(AdminService);
  });

  it('should call testEmail', async () => {
    const result = await controller.handleAdmin({ user: mockUser } as any, 'email');
    expect(service.testEmail).toHaveBeenCalledWith(mockUser);
    expect(service.testNotifications).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('should call testNotifications', async () => {
    const result = await controller.handleAdmin({ user: mockUser } as any, 'notifications');
    expect(service.testNotifications).toHaveBeenCalledWith(mockUser);
    expect(service.testEmail).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('should throw error 400', async () => {
    await expect(controller.handleAdmin({ user: mockUser } as any, null)).rejects.toThrow(BadRequestException);
    expect(service.testNotifications).not.toHaveBeenCalled();
    expect(service.testEmail).not.toHaveBeenCalled();
  });
});
