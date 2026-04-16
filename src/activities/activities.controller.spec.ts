import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

describe('ActivitiesController', () => {
  let controller: ActivitiesController;
  let service: jest.Mocked<ActivitiesService>;

  const mockYear = { id: 1, year: 2026, enable: true };
  const mockActivity = { id: 1, name: 'Annual Meeting' };
  const mockActivityDetail = {
    id: 1,
    name: 'Annual Meeting',
    date: '2026-01-15',
    value: 50000,
    users: [],
  };

  beforeEach(async () => {
    const mockService = {
      getYears: jest.fn().mockResolvedValue([mockYear]),
      createYear: jest.fn().mockResolvedValue(mockYear),
      getActivities: jest.fn().mockResolvedValue([mockActivity]),
      createActivity: jest.fn().mockResolvedValue(mockActivityDetail),
      getActivity: jest.fn().mockResolvedValue(mockActivityDetail),
      removeActivity: jest.fn().mockResolvedValue(undefined),
      patchActivity: jest.fn().mockResolvedValue(mockActivityDetail),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActivitiesController],
      providers: [{ provide: ActivitiesService, useValue: mockService }],
    }).compile();

    controller = module.get<ActivitiesController>(ActivitiesController);
    service = module.get(ActivitiesService);
  });

  it('should get years', async () => {
    const result = await controller.getYears();
    expect(result).toEqual([mockYear]);
  });

  it('should create year', async () => {
    const result = await controller.createYear();
    expect(result).toEqual(mockYear);
  });

  it('should return error when year already exists', async () => {
    service.createYear.mockResolvedValue(false);
    const result = await controller.createYear();
    expect(result).toHaveProperty('error');
  });

  it('should get activities for a year', async () => {
    const result = await controller.getActivities('1');
    expect(result).toEqual([mockActivity]);
  });

  it('should create activity', async () => {
    const result = await controller.createActivity('1', { name: 'New', date: '2026-02-01', value: 30000 });
    expect(result).toHaveProperty('id');
  });

  it('should get activity by id', async () => {
    const result = await controller.getActivity('1');
    expect(result).toEqual(mockActivityDetail);
  });

  it('should throw NotFoundException when activity not found', async () => {
    service.getActivity.mockResolvedValue(null);
    await expect(controller.getActivity('999')).rejects.toThrow(NotFoundException);
  });

  it('should remove activity', async () => {
    await controller.removeActivity('1');
    expect(service.removeActivity).toHaveBeenCalledWith(1);
  });

  it('should patch activity', async () => {
    const result = await controller.patchActivity('1', 'activity', { name: 'Updated' });
    expect(result).toHaveProperty('id');
  });

  it('should throw NotFoundException for unknown patch type', async () => {
    service.patchActivity.mockResolvedValue(null);
    await expect(controller.patchActivity('1', 'unknown', {})).rejects.toThrow(NotFoundException);
  });
});
