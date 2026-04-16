import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

jest.mock('../auth/password.util', () => ({
  hashPassword: jest.fn().mockResolvedValue('hashed_password'),
}));

describe('UsersService', () => {
  let service: UsersService;
  let prisma: any;
  let mail: jest.Mocked<MailService>;
  let notifications: jest.Mocked<NotificationsService>;

  const mockProfile = {
    user_ptr_id: 1,
    identification: BigInt(12345),
    role: 0,
    birthdate: new Date('1990-01-15'),
    key_activation: 'activation_key',
    auth_user: {
      id: 1,
      first_name: 'John',
      last_name: 'Doe',
      email: 'john@example.com',
      is_active: true,
    },
    fondo_api_userfinance: [
      {
        id: 1,
        contributions: BigInt(1000),
        balance_contributions: BigInt(500),
        total_quota: BigInt(5000),
        utilized_quota: BigInt(2000),
        available_quota: BigInt(3000),
        last_modified: new Date('2026-03-20'),
        user_id: 1,
      },
    ],
    fondo_api_userpreference: [
      {
        id: 1,
        notifications: true,
        primary_color: '#800000',
        secondary_color: '#c83737',
        user_id: 1,
      },
    ],
    fondo_api_savingaccount: [
      { id: 1, value: BigInt(10000), state: 0, user_id: 1, created_at: new Date(), end_date: new Date() },
    ],
  };

  beforeEach(async () => {
    const mockPrisma = {
      $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
      auth_user: {
        create: jest.fn().mockResolvedValue({ id: 1, email: 'john@example.com' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
      },
      fondo_api_userprofile: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(2),
      },
      fondo_api_userfinance: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      fondo_api_userpreference: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      fondo_api_power: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: MailService,
          useValue: {
            sendMail: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            removeAllSubscriptions: jest.fn().mockResolvedValue(undefined),
            sendNotification: jest.fn().mockResolvedValue(undefined),
            scheduleNotification: jest.fn().mockResolvedValue(undefined),
            removeScheduledNotifications: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://app.example.com'),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    prisma = module.get(PrismaService);
    mail = module.get(MailService);
    notifications = module.get(NotificationsService);
  });

  describe('createUser', () => {
    it('should create user with profile, finance, preference and send activation email', async () => {
      const body = {
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@example.com',
        identification: 12345,
        role: 3,
      };

      const result = await service.createUser(body);
      expect(prisma.auth_user.create).toHaveBeenCalled();
      expect(prisma.fondo_api_userprofile.create).toHaveBeenCalled();
      expect(prisma.fondo_api_userfinance.create).toHaveBeenCalled();
      expect(prisma.fondo_api_userpreference.create).toHaveBeenCalled();
      expect(mail.sendMail).toHaveBeenCalled();
    });
  });

  describe('getUsers', () => {
    it('should return paginated users when page is provided', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      prisma.fondo_api_userprofile.count.mockResolvedValue(1);

      const result = await service.getUsers(1);
      expect(result).toHaveProperty('list');
      expect(result).toHaveProperty('num_pages');
      expect(result).toHaveProperty('count');
    });

    it('should return unpaginated users when page is null', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      prisma.fondo_api_userprofile.count.mockResolvedValue(1);

      const result = await service.getUsers(null);
      expect(result).toHaveProperty('list');
      expect(result).not.toHaveProperty('num_pages');
    });

    it('should convert BigInt identification to number', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      prisma.fondo_api_userprofile.count.mockResolvedValue(1);

      const result = await service.getUsers(null);
      expect(typeof (result as any).list[0].identification).toBe('number');
    });

    it('should show null birthdate when not set', async () => {
      const profileNoBirthdate = { ...mockProfile, birthdate: null };
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([profileNoBirthdate]);
      prisma.fondo_api_userprofile.count.mockResolvedValue(1);

      const result = await service.getUsers(null);
      expect((result as any).list[0].birthdate).toBeNull();
    });
  });

  describe('getUser', () => {
    it('should return user with finance and preferences', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);
      const [found, data] = await service.getUser(1);
      expect(found).toBe(true);
      expect(data).toHaveProperty('user');
      expect(data).toHaveProperty('finance');
      expect(data).toHaveProperty('preferences');
    });

    it('should return [false, {}] when user not found', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(null);
      const [found, data] = await service.getUser(999);
      expect(found).toBe(false);
      expect(data).toEqual({});
    });

    it('should handle null finance and preferences', async () => {
      const profileNoFinance = { ...mockProfile, fondo_api_userfinance: [], fondo_api_userpreference: [] };
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(profileNoFinance);
      const [found, data] = await service.getUser(1);
      expect(found).toBe(true);
      expect((data as any).finance).toBeNull();
      expect((data as any).preferences).toBeNull();
    });
  });

  describe('inactiveUser', () => {
    it('should set is_active to false', async () => {
      await service.inactiveUser(1);
      expect(prisma.auth_user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { is_active: false },
      });
    });
  });

  describe('updateUser', () => {
    it('should update personal info', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);
      await service.updateUser(1, {
        type: 'personal',
        preferences: {},
        personal: { first_name: 'Jane', email: 'jane@example.com', birthdate: '1995-05-15' },
        finance: {},
      });
      expect(prisma.auth_user.update).toHaveBeenCalled();
    });

    it('should update personal info without auth_user fields', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);
      await service.updateUser(1, {
        type: 'personal',
        preferences: {},
        personal: { role: 3 },
        finance: {},
      });
      expect(prisma.fondo_api_userprofile.update).toHaveBeenCalled();
    });

    it('should update personal without birthdate scheduling if no birthdate', async () => {
      await service.updateUser(1, {
        type: 'personal',
        preferences: {},
        personal: { first_name: 'Jane' },
        finance: {},
      });
      expect(notifications.scheduleNotification).not.toHaveBeenCalled();
    });

    it('should update finance info', async () => {
      await service.updateUser(1, {
        type: 'finance',
        preferences: {},
        personal: {},
        finance: { total_quota: 10000, utilized_quota: 2000, contributions: 500, balance_contributions: 300 },
      });
      expect(prisma.fondo_api_userfinance.update).toHaveBeenCalled();
    });

    it('should update finance when financeRecord not found', async () => {
      prisma.fondo_api_userfinance.findFirst.mockResolvedValue(null);
      await service.updateUser(1, {
        type: 'finance',
        preferences: {},
        personal: {},
        finance: { total_quota: 10000, utilized_quota: 2000 },
      });
      expect(prisma.fondo_api_userfinance.update).not.toHaveBeenCalled();
    });

    it('should use 0 as default for total_quota and utilized_quota when not provided', async () => {
      await service.updateUser(1, {
        type: 'finance',
        preferences: {},
        personal: {},
        finance: {},
      });
      expect(prisma.fondo_api_userfinance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            available_quota: BigInt(0),
          }),
        }),
      );
    });

    it('should handle undefined contributions and balance in finance update', async () => {
      await service.updateUser(1, {
        type: 'finance',
        preferences: {},
        personal: {},
        finance: { total_quota: 10000, utilized_quota: 3000 },
      });
      expect(prisma.fondo_api_userfinance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contributions: undefined,
            balance_contributions: undefined,
          }),
        }),
      );
    });

    it('should handle personal update with identification provided', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(null);
      await service.updateUser(1, {
        type: 'personal',
        preferences: {},
        personal: { identification: 99999 },
        finance: {},
      });
      expect(prisma.fondo_api_userprofile.update).toHaveBeenCalled();
    });

    it('should update preferences and remove subscriptions when notifications=false', async () => {
      await service.updateUser(1, {
        type: 'preferences',
        preferences: { notifications: false, primary_color: '#000000', secondary_color: '#ffffff' },
        personal: {},
        finance: {},
      });
      expect(prisma.fondo_api_userpreference.update).toHaveBeenCalled();
      expect(notifications.removeAllSubscriptions).toHaveBeenCalledWith(1);
    });

    it('should update preferences without removing subscriptions when notifications=true', async () => {
      await service.updateUser(1, {
        type: 'preferences',
        preferences: { notifications: true },
        personal: {},
        finance: {},
      });
      expect(notifications.removeAllSubscriptions).not.toHaveBeenCalled();
    });

    it('should not update preference when prefRecord not found', async () => {
      prisma.fondo_api_userpreference.findFirst.mockResolvedValue(null);
      await service.updateUser(1, {
        type: 'preferences',
        preferences: { notifications: false },
        personal: {},
        finance: {},
      });
      expect(prisma.fondo_api_userpreference.update).not.toHaveBeenCalled();
    });
  });

  describe('activateUser', () => {
    it('should activate user successfully', async () => {
      prisma.fondo_api_userprofile.findFirst.mockResolvedValue({ user_ptr_id: 1 });
      const result = await service.activateUser(1, {
        key: 'activation_key',
        identification: 12345,
        password: 'newpassword',
      });
      expect(result).toBe(true);
      expect(prisma.auth_user.update).toHaveBeenCalled();
    });

    it('should return false when activation fails', async () => {
      prisma.fondo_api_userprofile.findFirst.mockResolvedValue(null);
      const result = await service.activateUser(1, {
        key: 'wrong_key',
        identification: 99999,
        password: 'newpassword',
      });
      expect(result).toBe(false);
    });
  });

  describe('bulkUpdateUsers', () => {
    it('should update users from TSV file', async () => {
      const tsv = '12345\t500\t5000\t1000\t2000\n';
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);
      prisma.fondo_api_userfinance.findFirst.mockResolvedValue({ id: 1 });

      await service.bulkUpdateUsers(Buffer.from(tsv));
      expect(prisma.fondo_api_userfinance.update).toHaveBeenCalled();
    });

    it('should skip unknown identification', async () => {
      const tsv = '99999\t500\t5000\t1000\t2000\n';
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(null);

      await service.bulkUpdateUsers(Buffer.from(tsv));
      expect(prisma.fondo_api_userfinance.update).not.toHaveBeenCalled();
    });

    it('should skip when finance record not found', async () => {
      const tsv = '12345\t500\t5000\t1000\t2000\n';
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);
      prisma.fondo_api_userfinance.findFirst.mockResolvedValue(null);

      await service.bulkUpdateUsers(Buffer.from(tsv));
      expect(prisma.fondo_api_userfinance.update).not.toHaveBeenCalled();
    });
  });

  describe('getUsersAttr', () => {
    it('should return ids of active users', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      const result = await service.getUsersAttr('id');
      expect(result).toEqual([1]);
    });

    it('should return emails of active users', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      const result = await service.getUsersAttr('email');
      expect(result).toEqual(['john@example.com']);
    });

    it('should filter by roles', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      const result = await service.getUsersAttr('id', [0, 2]);
      expect(prisma.fondo_api_userprofile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: { in: [0, 2] } }),
        }),
      );
    });
  });

  describe('getProfile', () => {
    it('should return profile by userId', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);
      const result = await service.getProfile(1);
      expect(result).toEqual(mockProfile);
    });
  });

  describe('getUsersBirthdate', () => {
    it('should return birthdates of active users', async () => {
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      const result = await service.getUsersBirthdate();
      expect(result[0]).toHaveProperty('birthdate');
      expect(result[0]).toHaveProperty('full_name', 'John Doe');
    });

    it('should filter out profiles without birthdate', async () => {
      const profileNoBirthdate = { ...mockProfile, birthdate: null };
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([profileNoBirthdate]);
      const result = await service.getUsersBirthdate();
      expect(result).toHaveLength(0);
    });
  });

  describe('handlePowerRequest', () => {
    it('should create power request', async () => {
      prisma.fondo_api_power.create.mockResolvedValue({ id: 1, requestee_id: 2, requester_id: 1, state: 0, meeting_date: new Date() });
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(mockProfile);

      const result = await service.handlePowerRequest(1, {
        type: 'post',
        requestee_id: 2,
        meeting_date: '2026-04-01',
      });

      expect(prisma.fondo_api_power.create).toHaveBeenCalled();
      expect(notifications.sendNotification).toHaveBeenCalled();
    });

    it('should get paginated power requests', async () => {
      const powerRecord = {
        id: 1,
        state: 0,
        meeting_date: new Date('2026-04-01'),
        requestee_id: 2,
        requester_id: 1,
        fondo_api_userprofile_fondo_api_power_requestee_idTofondo_api_userprofile: {
          auth_user: { first_name: 'Jane', last_name: 'Smith' },
        },
        fondo_api_userprofile_fondo_api_power_requester_idTofondo_api_userprofile: {
          auth_user: { first_name: 'John', last_name: 'Doe' },
        },
      };
      prisma.fondo_api_power.findMany.mockResolvedValue([powerRecord]);
      prisma.fondo_api_power.count.mockResolvedValue(1);

      const result = await service.handlePowerRequest(1, {
        type: 'get',
        page: 1,
      });

      expect(result).toHaveProperty('list');
    });

    it('should get paginated power requests with default page', async () => {
      prisma.fondo_api_power.findMany.mockResolvedValue([]);
      prisma.fondo_api_power.count.mockResolvedValue(0);

      const result = await service.handlePowerRequest(1, { type: 'get' });
      expect(result).toHaveProperty('list');
    });

    it('should patch power state and send email on approval', async () => {
      prisma.fondo_api_power.update.mockResolvedValue({ id: 1, state: 1, meeting_date: new Date('2026-04-01') });
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);

      await service.handlePowerRequest(1, {
        type: 'patch',
        id: 1,
        state: 1,
      });

      expect(mail.sendMail).toHaveBeenCalled();
    });

    it('should patch power state without email on non-approval', async () => {
      prisma.fondo_api_power.update.mockResolvedValue({ id: 1, state: 2, meeting_date: new Date() });
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);

      await service.handlePowerRequest(1, {
        type: 'patch',
        id: 1,
        state: 2,
      });

      expect(mail.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('createBirthdateNotification', () => {
    it('should remove old and schedule new notification', async () => {
      await service.createBirthdateNotification({
        id: 1,
        full_name: 'John Doe',
        birthdate: '1990-01-15',
      });

      expect(notifications.removeScheduledNotifications).toHaveBeenCalled();
      expect(notifications.scheduleNotification).toHaveBeenCalled();
    });
  });

  describe('buildUserProfile with unknown role', () => {
    it('should fallback to String(role) for unknown roles', async () => {
      const profileUnknownRole = { ...mockProfile, role: 99 };
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([profileUnknownRole]);
      prisma.fondo_api_userprofile.count.mockResolvedValue(1);
      const result = await service.getUsers(null);
      expect((result as any).list[0].role_display).toBe('99');
    });
  });

  describe('getUser with no fondo_api_savingaccount', () => {
    it('should default to 0 total_savingaccounts when savingaccount array is absent', async () => {
      const profileNoSavings = { ...mockProfile, fondo_api_savingaccount: undefined };
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(profileNoSavings);
      const [found, data] = await service.getUser(1);
      expect(found).toBe(true);
      expect((data as any).finance.total_savingaccounts).toBe(0);
    });
  });

  describe('updateUser personal with last_name', () => {
    it('should update last_name when provided', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(null);
      await service.updateUser(1, {
        type: 'personal',
        preferences: {},
        personal: { last_name: 'Smith' },
        finance: {},
      });
      expect(prisma.auth_user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { last_name: 'Smith' },
      });
    });
  });

  describe('updateUser personal with birthdate but profile not found', () => {
    it('should not schedule notification when profile not found', async () => {
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(null);
      await service.updateUser(1, {
        type: 'personal',
        preferences: {},
        personal: { birthdate: '1995-05-15' },
        finance: {},
      });
      expect(notifications.scheduleNotification).not.toHaveBeenCalled();
    });
  });

  describe('handlePowerRequest post without requestee profile', () => {
    it('should not send notification when requestee profile not found', async () => {
      prisma.fondo_api_power.create.mockResolvedValue({ id: 1 });
      prisma.fondo_api_userprofile.findMany.mockResolvedValue([mockProfile]);
      prisma.fondo_api_userprofile.findUnique.mockResolvedValue(null);

      await service.handlePowerRequest(1, {
        type: 'post',
        requestee_id: 99,
        meeting_date: '2026-04-01',
      });

      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });
  });
});
