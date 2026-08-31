import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, type Provider } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { pythonJsonDumps } from '../common/utils/python-json-dumps';
import type { PushSubscription } from '../common/utils/hstore.codec';
import { SQS_CLIENT } from './sqs.client';

/**
 * The message body the external Web Push Lambda consumes. Unchanged from v1 — the Lambda is
 * **not** part of this migration and still does the actual push.
 *
 * Built in `NotificationService.send_notification`:
 *
 * ```python
 * content = {
 *     'subscriptions': subscriptions,
 *     'message': {'body': message, 'target': target}
 * }
 * ```
 *
 * Property order is the wire format: `subscriptions` then `message`, `body` then `target`.
 */
export interface NotificationContent {
  readonly subscriptions: readonly PushSubscription[];
  readonly message: {
    readonly body: string;
    readonly target: string;
  };
}

/** Retry policy for `SendMessage`. Overridable so tests do not sleep. */
export interface NotificationPublishRetry {
  /** Total attempts, including the first. Plan Phase 2, condition 1: **3**. */
  readonly attempts: number;
  /** First backoff pause in milliseconds; doubles each retry. */
  readonly baseDelayMs: number;
}

export const NOTIFICATION_PUBLISH_RETRY = Symbol('NOTIFICATION_PUBLISH_RETRY');

export const defaultNotificationPublishRetry: Provider = {
  provide: NOTIFICATION_PUBLISH_RETRY,
  useValue: { attempts: 3, baseDelayMs: 200 } satisfies NotificationPublishRetry,
};

/**
 * `fondo_api/celery/tasks.py:send_notification` — the SQS boundary.
 *
 * ## What collapsed, and the four conditions attached to collapsing it
 *
 * v1 goes `send_notification.delay(...)` → Celery worker → `sqs_client.send_message(...)`.
 * v2 publishes inline; there is no worker to retire the indirection to. The plan authorised
 * that **only** with these four conditions (Phase 2, §3), all of which live here or in
 * {@link NotificationService}:
 *
 * 1. ✅ **Bounded retry with backoff, 3 attempts.** v1 has none — `celery/tasks.py` declares
 *    no `autoretry_for` and swallows the exception, so the message is simply lost. Removing
 *    the queue hop without adding a retry would have made a transient SQS blip *more* costly
 *    than it is today; this is a strict improvement and needs no new infrastructure.
 * 2. ✅ **v1's swallow semantics are kept at this boundary.** {@link publish} never throws.
 *    A publish failure must never fail the HTTP write that triggered it or roll back a
 *    loan / CAP / power row — in v1 it could not, because the publish happened in another
 *    process entirely.
 * 3. ⚠️ **Never call this from inside a Prisma interactive transaction.** All three v1
 *    `.delay()` sites sit *outside* `transaction.atomic()`. Publishing inside a transaction
 *    would hold a database connection for the length of an SQS round trip and — combined
 *    with a retry — turn an SQS outage into rolled-back loan creations. Phases 3, 4 and 6
 *    must call `NotificationService` after their transaction has committed.
 * 4. (Condition 4 — the zero-subscription early return — lives in {@link NotificationService}.)
 *
 * ## Byte-identical bodies
 *
 * v1 sends `json.dumps(message['content'])`. `JSON.stringify` is **not** the same function:
 * CPython separates with `', '` / `': '` and escapes non-ASCII, and every notification body
 * this fund sends is accented Spanish. {@link pythonJsonDumps} is the port.
 */
@Injectable()
export class NotificationPublisher {
  private readonly logger = new Logger(NotificationPublisher.name);

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: AppConfigService,
    @Inject(NOTIFICATION_PUBLISH_RETRY) private readonly retry: NotificationPublishRetry,
  ) {}

  /**
   * Publishes one notification. **Never throws** and never rejects.
   *
   * @returns `true` if SQS accepted the message, `false` if every attempt failed. The boolean
   *   exists for tests and for Phase 7's scheduler, which the plan already records as
   *   marking a task processed regardless (a known, accepted v1 behaviour — Q6).
   */
  async publish(content: NotificationContent): Promise<boolean> {
    const queueUrl = this.config.notificationsQueueUrl;
    if (queueUrl === undefined) {
      // v1 passes `QueueUrl=None`; botocore raises ParamValidationError and the bare
      // `except` swallows it. Retrying a configuration error would only delay the same
      // outcome, so this fails once, loudly in the log, exactly as v1 does.
      this.logger.error(
        'Error trying to connect to MNS service: NOTIFICATIONS_QUEUE_URL is not configured',
      );
      return false;
    }

    let body: string;
    try {
      body = pythonJsonDumps(content as never);
    } catch (error) {
      this.logger.error(`Error trying to connect to MNS service: ${describe(error)}`);
      return false;
    }

    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      try {
        const response = await this.sqs.send(
          new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }),
        );
        // v1: logger.info("Message sent, id: {}".format(response["MessageId"]))
        this.logger.log(`Message sent, id: ${response.MessageId ?? ''}`);
        return true;
      } catch (error) {
        const last = attempt === this.retry.attempts;
        if (last) {
          // v1: logger.error("Error trying to connect to MNS service: {}".format(ex))
          this.logger.error(
            `Error trying to connect to MNS service: ${describe(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
          return false;
        }
        this.logger.warn(
          `SQS SendMessage attempt ${attempt}/${this.retry.attempts} failed: ${describe(error)}`,
        );
        await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
      }
    }

    /* istanbul ignore next -- the loop always returns on its last iteration */
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
