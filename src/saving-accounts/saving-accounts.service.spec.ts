import { Test, TestingModule } from '@nestjs/testing';
import { SavingAccountsService } from './saving-accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

describe('SavingAccountsService', () => {
  let service: SavingAccountsService;
  let prisma: any;
  let notifications: jest.Mocked<NotificationsService>;
  let users: jest.Mocked<UsersService>;

  const mockAccount = {
    id: 1,
    value: BigInt(10000),
    created_at: new Date('2026-01-01'),
    state: 0,
    end_date: new Date('2026-12-31'),
    user_id: 1,
    fondo_api_userprofile: {
      auth_user: { first_name: 'John', last_name: 'Doe' },
    },
  };

  beforeEach(async () => {
    const mockPrisma = {
      fondo_api_savingaccount: {
        create: jest.fn().mockResolvedValue(mockAccount),
        findMany: jest.fn().mockResolvedValue([mockAccount]),
        update: jest.fn().mockResolvedValue(mockAccount),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavingAccountsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: NotificationsService,
          useValue: {
            sendNotification: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: UsersService,
          useValue: {
            getUsersAttr: jest.fn().mockResolvedValue([1, 2]),
          },
        },
      ],
    }).compile();

    service = module.get<SavingAccountsService>(SavingAccountsService);
    prisma = module.get(PrismaService);
    notifications = module.get(NotificationsService);
    users = module.get(UsersService);
  });

  describe('createAccount', () => {
    it('should create a saving account and notify admins', async () => {
      const result = await service.createAccount(1, { end_date: '2026-12-31' });
      expect(prisma.fondo_api_savingaccount.create).toHaveBeenCalled();
      expect(notifications.sendNotification).toHaveBeenCalled();
      expect(result).toHaveProperty('id', 1);
      expect(result).toHaveProperty('value', 10000);
    });
  });

  describe('getAccounts', () => {
    it('should return paginated accounts', async () => {
      const result = await service.getAccounts(1, 1, true, null, true);
      expect(result).toHaveProperty('list');
      expect(result).toHaveProperty('num_pages');
    });

    it('should return unpaginated accounts', async () => {
      const result = await service.getAccounts(1, null, false, null, false);
      expect(result).toHaveProperty('list');
      expect(result).not.toHaveProperty('num_pages');
    });

    it('should filter by user when allAccounts=false', async () => {
      await service.getAccounts(5, null, false, null, false);
      expect(prisma.fondo_api_savingaccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: 5 }),
        }),
      );
    });

    it('should filter by state when provided', async () => {
      await service.getAccounts(1, null, true, 1, false);
      expect(prisma.fondo_api_savingaccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: 1 }),
        }),
      );
    });
  });

  describe('updateAccount', () => {
    it('should update account state and value', async () => {
      prisma.fondo_api_savingaccount.update.mockResolvedValue({ ...mockAccount, state: 1, value: BigInt(20000) });
      const result = await service.updateAccount({ id: 1, state: 1, value: 20000 });
      expect(result).toHaveProperty('state', 1);
      expect(result).toHaveProperty('value', 20000);
    });
  });

  describe('buildSavingAccount without profile', () => {
    it('should return empty string for user_full_name when profile is absent', async () => {
      const accountWithoutProfile = {
        ...mockAccount,
        fondo_api_userprofile: undefined,
      };
      prisma.fondo_api_savingaccount.create.mockResolvedValue(accountWithoutProfile);
      const result = await service.createAccount(1, { end_date: '2026-12-31' });
      expect(result.user_full_name).toBe('');
    });
  });
});
