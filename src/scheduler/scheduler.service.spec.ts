import { SchedulerService } from './scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
} as unknown as PrismaService;

const mockNotifications = {
  sendNotification: jest.fn(),
} as unknown as NotificationsService;

function buildService(): SchedulerService {
  return new SchedulerService(
    mockPrisma as any,
    mockNotifications as any,
  );
}

beforeEach(() => jest.clearAllMocks());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<{
  id: number;
  type: number;
  run_date: Date;
  payload: string;
  processed: boolean;
  repeat: number;
}> = {}) {
  return {
    id: 1,
    type: 0,
    run_date: new Date('2024-01-15T00:00:00Z'),
    payload: '"body"=>"Pay soon","target"=>"/loan/5","user_id"=>"42"',
    processed: false,
    repeat: 0, // NONE
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SchedulerService.runScheduledTasks', () => {
  it('does nothing when no tasks are due today', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await buildService().runScheduledTasks();
    expect(mockNotifications.sendNotification).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('executes a NOTIFICATIONS task with correct user/body/target', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask()]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockNotifications.sendNotification).toHaveBeenCalledWith(
      [42],
      { body: 'Pay soon', target: '/loan/5' },
    );
  });

  it('marks task as processed after execution', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask({ id: 7 })]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    // First $executeRaw call is the UPDATE processed=true
    const firstCall = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0];
    expect(firstCall[0].join('')).toContain('UPDATE fondo_api_schedulertask');
  });

  it('does NOT create a repeat instance for repeat=NONE (0)', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask({ repeat: 0 })]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1); // only UPDATE
  });

  it('creates repeat instance for repeat=DAILY (1) — calls $executeRaw twice', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask({ repeat: 1 })]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2); // UPDATE + INSERT
  });

  it('creates repeat instance for repeat=WEEKLY (2)', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask({ repeat: 2 })]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('creates repeat instance for repeat=MONTHLY (3)', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask({ repeat: 3 })]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('creates repeat instance for repeat=YEARLY (4)', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([makeTask({ repeat: 4 })]);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('continues processing remaining tasks if one fails', async () => {
    const tasks = [
      makeTask({ id: 1, payload: '"body"=>"A","target"=>"/","user_id"=>"1"' }),
      makeTask({ id: 2, payload: '"body"=>"B","target"=>"/","user_id"=>"2"' }),
    ];
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue(tasks);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock)
      .mockRejectedValueOnce(new Error('SQS failure'))
      .mockResolvedValueOnce(undefined);

    await buildService().runScheduledTasks();

    // Both tasks attempted; only the second succeeds and gets marked
    expect(mockNotifications.sendNotification).toHaveBeenCalledTimes(2);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1); // only task 2 marked processed
  });

  it('throws for unknown task type and skips to next task', async () => {
    const tasks = [
      makeTask({ id: 1, type: 99 }), // unknown type
      makeTask({ id: 2, type: 0 }),  // valid NOTIFICATIONS
    ];
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue(tasks);
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (mockNotifications.sendNotification as jest.Mock).mockResolvedValue(undefined);

    await buildService().runScheduledTasks();

    expect(mockNotifications.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1); // only task 2
  });
});
