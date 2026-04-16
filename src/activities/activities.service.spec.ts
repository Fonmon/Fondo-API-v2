import { Test, TestingModule } from '@nestjs/testing';
import { ActivitiesService } from './activities.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ActivitiesService', () => {
  let service: ActivitiesService;
  let prisma: any;

  const mockProfile = {
    user_ptr_id: 1,
    identification: BigInt(12345),
    role: 0,
    birthdate: new Date('1990-01-15'),
    auth_user: {
      first_name: 'John',
      last_name: 'Doe',
      email: 'john@example.com',
    },
  };

  const mockYear = {
    id: 1,
    year: BigInt(2026),
    enable: true,
  };

  const mockActivity = {
    id: 1,
    name: 'Annual Meeting',
    date: new Date('2026-01-15'),
    value: BigInt(50000),
    year_id: 1,
  };

  const mockActivityUser = {
    id: 1,
    activity_id: 1,
    user_id: 1,
    state: 0,
    fondo_api_userprofile: mockProfile,
  };

  beforeEach(async () => {
    const mockPrisma = {
      fondo_api_activityyear: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([mockYear]),
        create: jest.fn().mockResolvedValue(mockYear),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fondo_api_activity: {
        findMany: jest.fn().mockResolvedValue([mockActivity]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue(mockActivity),
        update: jest.fn().mockResolvedValue(mockActivity),
        delete: jest.fn().mockResolvedValue(mockActivity),
      },
      fondo_api_activityuser: {
        create: jest.fn().mockResolvedValue(mockActivityUser),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(mockActivityUser),
      },
      fondo_api_userprofile: {
        findMany: jest.fn().mockResolvedValue([mockProfile]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivitiesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ActivitiesService>(ActivitiesService);
    prisma = module.get(PrismaService);
  });

  describe('createYear', () => {
    it('should create a new year', async () => {
      prisma.fondo_api_activityyear.findUnique.mockResolvedValue(null);
      const result = await service.createYear();
      expect(result).not.toBe(false);
      expect(prisma.fondo_api_activityyear.create).toHaveBeenCalled();
    });

    it('should return false if year already exists', async () => {
      prisma.fondo_api_activityyear.findUnique.mockResolvedValue(mockYear);
      const result = await service.createYear();
      expect(result).toBe(false);
    });
  });

  describe('getYears', () => {
    it('should return all years ordered by year desc', async () => {
      const result = await service.getYears();
      expect(result[0]).toHaveProperty('year', 2026);
      expect(result[0]).toHaveProperty('enable', true);
    });
  });

  describe('getActivities', () => {
    it('should return activities for a year', async () => {
      const result = await service.getActivities(1);
      expect(result[0]).toHaveProperty('id', 1);
      expect(result[0]).toHaveProperty('name', 'Annual Meeting');
    });
  });

  describe('createActivity', () => {
    it('should create activity and activity users for all active users', async () => {
      const result = await service.createActivity(
        { name: 'New Activity', date: '2026-02-01', value: 30000 },
        1,
      );
      expect(prisma.fondo_api_activity.create).toHaveBeenCalled();
      expect(prisma.fondo_api_activityuser.create).toHaveBeenCalled();
      expect(result).toHaveProperty('id');
    });
  });

  describe('getActivity', () => {
    it('should return activity with users', async () => {
      const activityWithUsers = {
        ...mockActivity,
        fondo_api_activityuser: [mockActivityUser],
      };
      prisma.fondo_api_activity.findUnique.mockResolvedValue(activityWithUsers);

      const result = await service.getActivity(1);
      expect(result).toHaveProperty('users');
      expect(result!.users[0]).toHaveProperty('user');
    });

    it('should return null when activity not found', async () => {
      prisma.fondo_api_activity.findUnique.mockResolvedValue(null);
      const result = await service.getActivity(999);
      expect(result).toBeNull();
    });

    it('should handle null birthdate in user profile', async () => {
      const profileNoBirthdate = { ...mockProfile, birthdate: null };
      const activityUserNoBirthdate = { ...mockActivityUser, fondo_api_userprofile: profileNoBirthdate };
      prisma.fondo_api_activity.findUnique.mockResolvedValue({
        ...mockActivity,
        fondo_api_activityuser: [activityUserNoBirthdate],
      });

      const result = await service.getActivity(1);
      expect(result!.users[0].user.birthdate).toBeNull();
    });
  });

  describe('removeActivity', () => {
    it('should delete activity and related activityusers', async () => {
      await service.removeActivity(1);
      expect(prisma.fondo_api_activityuser.deleteMany).toHaveBeenCalled();
      expect(prisma.fondo_api_activity.delete).toHaveBeenCalled();
    });
  });

  describe('getActivity with unknown role', () => {
    it('should fallback to String(role) for unknown role numbers', async () => {
      const profileUnknownRole = { ...mockProfile, role: 99 };
      const activityUserUnknownRole = { ...mockActivityUser, fondo_api_userprofile: profileUnknownRole };
      prisma.fondo_api_activity.findUnique.mockResolvedValue({
        ...mockActivity,
        fondo_api_activityuser: [activityUserUnknownRole],
      });
      const result = await service.getActivity(1);
      expect(result!.users[0].user.role_display).toBe('99');
    });
  });

  describe('patchActivity', () => {
    it('should patch activity fields', async () => {
      const result = await service.patchActivity('activity', 1, {
        name: 'Updated Name',
        date: '2026-02-15',
        value: 60000,
      });
      expect(prisma.fondo_api_activity.update).toHaveBeenCalled();
      expect(result).toHaveProperty('id');
    });

    it('should patch activity with only name (no date or value)', async () => {
      const result = await service.patchActivity('activity', 1, {
        name: 'Updated Name Only',
      });
      expect(prisma.fondo_api_activity.update).toHaveBeenCalled();
    });

    it('should patch activity with empty data (no fields)', async () => {
      const result = await service.patchActivity('activity', 1, {});
      expect(prisma.fondo_api_activity.update).toHaveBeenCalled();
    });

    it('should patch user state', async () => {
      prisma.fondo_api_activityuser.update.mockResolvedValue({ id: 1, state: 1 });
      const result = await service.patchActivity('user', 1, { id: 1, state: 1 });
      expect(prisma.fondo_api_activityuser.update).toHaveBeenCalled();
      expect(result).toHaveProperty('state', 1);
    });

    it('should return null for unknown patch type', async () => {
      const result = await service.patchActivity('unknown', 1, {});
      expect(result).toBeNull();
    });
  });
});
