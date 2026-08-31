import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationController } from './notification.controller';
import {
  NotificationPublisher,
  defaultNotificationPublishRetry,
  NOTIFICATION_PUBLISH_RETRY,
} from './notification-publisher';
import { NotificationService } from './notification.service';
import { NotificationSubscriptionRepository } from './notification-subscription.repository';
import { sqsClientProvider, SQS_CLIENT } from './sqs.client';

/**
 * Web-push notifications: subscription storage (hstore) and publication to SQS.
 *
 * Phases 3, 4 and 6 import this module for {@link NotificationService}; Phase 7's scheduler
 * calls the same `sendNotification`, which is why the Celery `run_async` flag could be
 * dropped without a second code path.
 *
 * {@link SQS_CLIENT} and {@link NOTIFICATION_PUBLISH_RETRY} are exported so an e2e suite can
 * substitute a stub client and a zero-delay retry policy — the v2 equivalent of v1's
 * `@patch('boto3.client')`.
 */
@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [NotificationController],
  providers: [
    sqsClientProvider,
    defaultNotificationPublishRetry,
    NotificationSubscriptionRepository,
    NotificationPublisher,
    NotificationService,
  ],
  exports: [
    NotificationService,
    NotificationSubscriptionRepository,
    NotificationPublisher,
    SQS_CLIENT,
    NOTIFICATION_PUBLISH_RETRY,
  ],
})
export class NotificationModule {}
