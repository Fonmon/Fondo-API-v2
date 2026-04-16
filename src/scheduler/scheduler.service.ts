import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { addDays, addWeeks, addMonths, addYears } from 'date-fns';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { parseHstore, toHstoreLiteral } from '../common/utils/hstore.util';
import { SchedulerTaskType, SchedulerRepeat } from '../common/enums';

interface SchedulerTaskRow {
  id: number;
  type: number;
  run_date: Date;
  payload: string;
  processed: boolean;
  repeat: number;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Mirrors Django's crontab(minute=0, hour='10,14')
  @Cron('0 10,14 * * *')
  async runScheduledTasks(): Promise<void> {
    this.logger.log('Running scheduler');

    const tasks = await this.prisma.$queryRaw<SchedulerTaskRow[]>`
      SELECT id, type, run_date, payload::text, processed, repeat
      FROM fondo_api_schedulertask
      WHERE DATE(run_date AT TIME ZONE 'UTC') = CURRENT_DATE
      AND processed = false
    `;

    this.logger.log(`${tasks.length} tasks to process`);

    for (const task of tasks) {
      try {
        await this.executeTask(task);

        await this.prisma.$executeRaw`
          UPDATE fondo_api_schedulertask
          SET processed = true
          WHERE id = ${task.id}
        `;

        await this.createRepeatInstance(task);
      } catch (error) {
        this.logger.error(
          `Error processing task id=${task.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async executeTask(task: SchedulerTaskRow): Promise<void> {
    const payload = parseHstore(task.payload);

    if (task.type === SchedulerTaskType.NOTIFICATIONS) {
      const userId = parseInt(payload['user_id'], 10);
      const body = payload['body'] ?? '';
      const target = payload['target'] ?? '';
      await this.notifications.sendNotification([userId], { body, target });
    } else {
      throw new Error(`Unknown task type: ${task.type}`);
    }
  }

  private async createRepeatInstance(task: SchedulerTaskRow): Promise<void> {
    if (task.repeat === SchedulerRepeat.NONE) return;

    const runDate = new Date(task.run_date);
    let nextDate: Date;

    switch (task.repeat) {
      case SchedulerRepeat.DAILY:   nextDate = addDays(runDate, 1);    break;
      case SchedulerRepeat.WEEKLY:  nextDate = addWeeks(runDate, 1);   break;
      case SchedulerRepeat.MONTHLY: nextDate = addMonths(runDate, 1);  break;
      case SchedulerRepeat.YEARLY:  nextDate = addYears(runDate, 1);   break;
      default: return;
    }

    const payloadHstore = toHstoreLiteral(parseHstore(task.payload));

    await this.prisma.$executeRaw`
      INSERT INTO fondo_api_schedulertask (type, run_date, payload, processed, repeat)
      VALUES (${task.type}, ${nextDate}, ${payloadHstore}::hstore, false, ${task.repeat})
    `;
  }
}
