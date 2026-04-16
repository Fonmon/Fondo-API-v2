import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { PrismaService } from '../prisma/prisma.service';
import { toHstoreLiteral, parseHstore } from '../common/utils/hstore.util';
import {
  SchedulerTaskType,
  SchedulerRepeat,
} from '../common/enums';

interface Subscription {
  endpoint: string;
  keys?: Record<string, string>;
  [key: string]: unknown;
}

@Injectable()
export class NotificationsService {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  /* istanbul ignore next */
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.sqs = new SQSClient({
      region: config.get<string>('aws.region'),
    });
    this.queueUrl = config.get<string>('aws.notificationsQueueUrl') ?? '';
  }

  async saveSubscription(userId: number, subscription: Subscription): Promise<void> {
    const endpointValue = subscription.endpoint;
    // Check uniqueness by endpoint
    const existing = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM fondo_api_notificationsubscriptions
      WHERE subscription -> 'endpoint' = ${endpointValue}
      AND user_id = ${userId}
    `;
    if (existing.length > 0) return;

    const hstore = toHstoreLiteral(
      Object.fromEntries(
        Object.entries(subscription).map(([k, v]) => [
          k,
          typeof v === 'string' ? v : JSON.stringify(v),
        ]),
      ),
    );
    await this.prisma.$executeRaw`
      INSERT INTO fondo_api_notificationsubscriptions (subscription, user_id)
      VALUES (${hstore}::hstore, ${userId})
    `;
  }

  async unregisterSubscription(userId: number, endpoint: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      DELETE FROM fondo_api_notificationsubscriptions
      WHERE subscription -> 'endpoint' = ${endpoint}
      AND user_id = ${userId}
    `;
    return result > 0;
  }

  async removeAllSubscriptions(userId: number): Promise<void> {
    await this.prisma.fondo_api_notificationsubscriptions.deleteMany({
      where: { user_id: userId },
    });
  }

  async sendNotification(
    userIds: number[],
    message: { body: string; target: string },
  ): Promise<void> {
    if (userIds.length === 0) return;

    const rows = await this.prisma.$queryRaw<{ subscription: string }[]>`
      SELECT subscription::text FROM fondo_api_notificationsubscriptions
      WHERE user_id = ANY(${userIds}::int[])
    `;

    const subscriptions = rows.map((row) => {
      const parsed = parseHstore(row.subscription);
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        try {
          result[k] = JSON.parse(v);
        } catch {
          result[k] = v;
        }
      }
      return result;
    });

    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({
      type: 'send_notification',
      content: { subscriptions, message: { body: message.body, target: message.target } },
    });

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: payload,
      }),
    );
  }

  async scheduleNotification(
    userId: number,
    message: { body: string; target: string },
    runDate: Date,
    type: SchedulerTaskType,
    repeat: SchedulerRepeat,
  ): Promise<void> {
    const payloadObj = { user_id: String(userId), body: message.body, target: message.target };
    const payloadHstore = toHstoreLiteral(payloadObj);

    const year = runDate.getFullYear();
    const month = runDate.getMonth() + 1;
    const day = runDate.getDate();

    const existing = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM fondo_api_schedulertask
      WHERE payload -> 'user_id' = ${String(userId)}
      AND type = ${type}
      AND EXTRACT(YEAR FROM run_date) = ${year}
      AND EXTRACT(MONTH FROM run_date) = ${month}
      AND EXTRACT(DAY FROM run_date) = ${day}
    `;

    if (existing.length > 0) return;

    await this.prisma.$executeRaw`
      INSERT INTO fondo_api_schedulertask (type, run_date, payload, processed, repeat)
      VALUES (${type}, ${runDate}, ${payloadHstore}::hstore, false, ${repeat})
    `;
  }

  async removeScheduledNotifications(
    userId: number,
    type: SchedulerTaskType,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM fondo_api_schedulertask
      WHERE payload -> 'user_id' = ${String(userId)}
      AND type = ${type}
      AND processed = false
    `;
  }
}
