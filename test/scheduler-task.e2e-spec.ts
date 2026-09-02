import { Test, type TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '../src/config/config.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { NotificationModule } from '../src/notifications/notification.module';
import {
  SchedulerTaskRepository,
  type SchedulerTaskPayload,
} from '../src/scheduler/scheduler-task.repository';

/**
 * Phase **7a** — the `SchedulerTask` write half, DB-backed (review finding **S9**,
 * condition **C24**).
 *
 * ## How these rows are validated before Phase 7's runner exists — C24's answer
 *
 * By **comparison, not execution**. The expectations below are transcribed from a live
 * `fondodev` row written by v1:
 *
 * ```
 * id        | 2458
 * type      | 0
 * run_date  | 2027-08-25 05:00:00+00
 * payload   | "type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años N@CHO
 *           |  Montañez Herrera", "owner_id"=>"5", "user_ids"=>"[2, 4, 3, 13, 11, 10, 1, 9,
 *           |  12, 6, 7, 8]"
 * processed | f
 * repeat    | 4
 * ```
 *
 * so a v2 row is checked against a real v1 row field by field, `payload::text` included.
 * Phase 7 later adds the behavioural half (the runner picks it up; the `repeat` clone
 * advances), by which time `nextRepeatRunDate` is already unit-pinned against
 * `python-dateutil==2.7.5` (Phase 0, condition C3).
 */
describe('Phase 7a — SchedulerTaskRepository (C24)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let repository: SchedulerTaskRepository;
  let notifications: NotificationService;

  const payload = (ownerId: number, type = 'birthdate'): SchedulerTaskPayload => ({
    type,
    owner_id: ownerId,
    user_ids: [2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8],
    target: '/',
    message: 'Hoy está cumpliendo años N@CHO Montañez Herrera',
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, NotificationModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    repository = moduleRef.get(SchedulerTaskRepository);
    notifications = moduleRef.get(NotificationService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE fondo_api_schedulertask RESTART IDENTITY');
  });

  it('writes a row identical to the one v1 wrote, payload::text included', async () => {
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);

    const rows = await prisma.schedulerTask.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(0);
    expect(rows[0].processed).toBe(false);
    expect(rows[0].repeat).toBe(4);
    // 2027-08-25 00:00 America/Bogota.
    expect(rows[0].run_date.toISOString()).toBe('2027-08-25T05:00:00.000Z');

    // hstore normalises key order to (length, bytes) on storage, so this is v1's exact string.
    await expect(repository.findRawPayloadById(rows[0].id)).resolves.toBe(
      '"type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años N@CHO ' +
        'Montañez Herrera", "owner_id"=>"5", "user_ids"=>"[2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8]"',
    );
  });

  it('stores owner_id as text and user_ids as a Python list repr', async () => {
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);

    const [row] = await prisma.$queryRaw<{ owner: string; ids: string }[]>`
      SELECT payload -> 'owner_id' AS owner, payload -> 'user_ids' AS ids
      FROM fondo_api_schedulertask
    `;
    expect(row.owner).toBe('5');
    expect(row.ids).toBe('[2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8]');
  });

  it('dedupes a second schedule on the same local day for the same owner and type', async () => {
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);

    await expect(prisma.schedulerTask.count()).resolves.toBe(1);
  });

  it('does not dedupe across owners, types or days', async () => {
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(6), 4);
    await notifications.scheduleNotification(
      { year: 2027, month: 8, day: 25 },
      payload(5, 'payment_reminder'),
    );
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 26 }, payload(5), 4);

    await expect(prisma.schedulerTask.count()).resolves.toBe(4);
  });

  it('does not dedupe against a processed task', async () => {
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);
    await prisma.schedulerTask.updateMany({ data: { processed: true } });

    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);

    await expect(prisma.schedulerTask.count()).resolves.toBe(2);
  });

  /**
   * ⚠️ The regression this pins: `run_date__year` under `USE_TZ = True` extracts in
   * `America/Bogota`, not UTC. A local-midnight task is stored as 05:00Z, so a UTC extract
   * reports the *same* day here but the **previous** day for any task scheduled between
   * 19:00 and 23:59 local — which is where the dedupe would silently stop working.
   */
  it('extracts the calendar day in America/Bogota, not UTC', async () => {
    // 2027-08-25 20:00 Bogota = 2027-08-26 01:00 UTC.
    await notifications.scheduleNotification(
      { year: 2027, month: 8, day: 25, hour: 20 },
      payload(5),
      4,
    );
    const [row] = await prisma.schedulerTask.findMany();
    expect(row.run_date.toISOString()).toBe('2027-08-26T01:00:00.000Z');

    await expect(repository.existsUnprocessedOnDay(5, 'birthdate', 2027, 8, 25)).resolves.toBe(
      true,
    );
    await expect(repository.existsUnprocessedOnDay(5, 'birthdate', 2027, 8, 26)).resolves.toBe(
      false,
    );
  });

  it('removeSchNotifications deletes every task for that owner and type, processed or not', async () => {
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(5), 4);
    await prisma.schedulerTask.updateMany({ data: { processed: true } });
    await notifications.scheduleNotification({ year: 2028, month: 8, day: 25 }, payload(5), 4);
    await notifications.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload(6), 4);
    await notifications.scheduleNotification(
      { year: 2027, month: 8, day: 25 },
      payload(5, 'payment_reminder'),
    );

    await expect(notifications.removeSchNotifications('birthdate', 5)).resolves.toBe(2);

    const remaining = await prisma.$queryRaw<{ owner: string; type: string }[]>`
      SELECT payload -> 'owner_id' AS owner, payload -> 'type' AS type
      FROM fondo_api_schedulertask ORDER BY id
    `;
    expect(remaining).toEqual([
      { owner: '6', type: 'birthdate' },
      { owner: '5', type: 'payment_reminder' },
    ]);
  });
});
