import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let service: jest.Mocked<UsersService>;

  const mockUser = {
    id: 1,
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    role: 0,
    profileId: 1,
  };

  const mockUserData = {
    user: { id: 1, full_name: 'John Doe', identification: 12345, email: 'john@example.com', role: 0, role_display: 'ADMIN', first_name: 'John', last_name: 'Doe', birthdate: '1990-01-15' },
    finance: { contributions: 1000, balance_contributions: 500, total_quota: 5000, available_quota: 3000, last_modified: '15 ene. 1990', utilized_quota: 2000, total_savingaccounts: 10000 },
    preferences: { notifications: true, primary_color: '#800000', secondary_color: '#c83737' },
  };

  beforeEach(async () => {
    const mockService = {
      createUser: jest.fn().mockResolvedValue({ id: 1 }),
      getUsers: jest.fn().mockResolvedValue({ list: [], count: 0, num_pages: 0 }),
      getUser: jest.fn().mockResolvedValue([true, mockUserData]),
      updateUser: jest.fn().mockResolvedValue(undefined),
      inactiveUser: jest.fn().mockResolvedValue(undefined),
      activateUser: jest.fn().mockResolvedValue(true),
      bulkUpdateUsers: jest.fn().mockResolvedValue(undefined),
      getUsersBirthdate: jest.fn().mockResolvedValue([]),
      handlePowerRequest: jest.fn().mockResolvedValue({ list: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: mockService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    service = module.get(UsersService);
  });

  it('should create a user', async () => {
    const result = await controller.createUser({ first_name: 'John', email: 'j@example.com', identification: 123, role: 3, last_name: 'Doe' });
    expect(result).toEqual({ id: 1 });
    expect(service.createUser).toHaveBeenCalled();
  });

  it('should get users without page', async () => {
    await controller.getUsers(undefined);
    expect(service.getUsers).toHaveBeenCalledWith(null);
  });

  it('should get users with page', async () => {
    await controller.getUsers('2');
    expect(service.getUsers).toHaveBeenCalledWith(2);
  });

  it('should bulk update users with file', async () => {
    const mockFile = { buffer: Buffer.from('data') } as Express.Multer.File;
    await controller.bulkUpdateUsers(mockFile);
    expect(service.bulkUpdateUsers).toHaveBeenCalledWith(mockFile.buffer);
  });

  it('should throw BadRequestException when no file for bulk update', async () => {
    await expect(controller.bulkUpdateUsers(undefined as any)).rejects.toThrow(BadRequestException);
  });

  it('should activate user', async () => {
    const result = await controller.activateUser('1', { key: 'abc', identification: 123, password: 'pass' });
    expect(result).toEqual({});
  });

  it('should throw NotFoundException when activation fails', async () => {
    service.activateUser.mockResolvedValue(false);
    await expect(controller.activateUser('1', { key: 'wrong', identification: 0, password: '' })).rejects.toThrow(NotFoundException);
  });

  it('should get user by id', async () => {
    const result = await controller.getUser('1', { user: mockUser } as any);
    expect(result).toEqual(mockUserData);
  });

  it('should get self when id=-1', async () => {
    await controller.getUser('-1', { user: mockUser } as any);
    expect(service.getUser).toHaveBeenCalledWith(mockUser.profileId);
  });

  it('should throw NotFoundException when user not found', async () => {
    service.getUser.mockResolvedValue([false, {}]);
    await expect(controller.getUser('999', { user: mockUser } as any)).rejects.toThrow(NotFoundException);
  });

  it('should update user', async () => {
    const result = await controller.updateUser('1', { type: 'personal', first_name: 'Jane' });
    expect(result).toEqual({});
  });

  it('should inactive user', async () => {
    await controller.inactiveUser('1');
    expect(service.inactiveUser).toHaveBeenCalledWith(1);
  });

  it('should handle birthdates app', async () => {
    await controller.handleApp('birthdates', {}, { user: mockUser } as any);
    expect(service.getUsersBirthdate).toHaveBeenCalled();
  });

  it('should handle power app', async () => {
    await controller.handleApp('power', { type: 'get' }, { user: mockUser } as any);
    expect(service.handlePowerRequest).toHaveBeenCalled();
  });

  it('should throw NotFoundException for unknown app', async () => {
    await expect(controller.handleApp('unknown', {}, { user: mockUser } as any)).rejects.toThrow(NotFoundException);
  });
});
