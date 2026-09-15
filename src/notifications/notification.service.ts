import { Injectable } from '@nestjs/common';
import { pythonStr, type PythonEncodable } from '../common/utils/django-str';
import { bogotaWallClockToInstant } from '../common/utils/timezone.util';
import type { PlainDate } from '../common/utils/date.util';
import {
  SchedulerTaskRepository,
  type SchedulerSqlClient,
  type SchedulerTaskPayload,
} from '../scheduler/scheduler-task.repository';
import { NotificationPublisher } from './notification-publisher';
import { NotificationSubscriptionRepository } from './notification-subscription.repository';

/** The outcome of `unregister_subscription`, which v1 expresses as a bare status number. */
export const UNSUBSCRIBE_OK = 200;
export const UNSUBSCRIBE_NOT_FOUND = 404;

/**
 * What actually happened to a `sendNotification` call.
 *
 * ⚠️ **Added in Phase 7b, and the reason is the phase's headline risk.** v1's
 * `send_notification` returns `None` whether it published, published nothing because the
 * member has no devices, or failed and swallowed the exception — and
 * `scheduler/tasks.py:24` then marks the task `processed = True` regardless. A failed
 * publish is recorded as a success, in the one subsystem that is the sole delivery path for
 * loan payment reminders.
 *
 * v2 **keeps the outcome** (the task is still marked processed — operator answer Q6, and the
 * alternative is a task that retries a configuration error twice a day forever and never
 * clones its `repeat` successor) and **drops the silence**: the runner logs a warning naming
 * the task id and counts it, so `failed` is visible without changing a single row. See
 * `docs/phase-7b-deviations.md` §3.
 */
export type NotificationDelivery =
  /** SQS accepted the message. */
  | 'published'
  /** v1's `if len(notification_subscriptions) == 0: return` — nothing was published. */
  | 'no-subscriptions'
  /** Every publish attempt failed. v1 swallows this and so does v2; the log does not. */
  | 'failed';

/**
 * `fondo_api/services/notification.py:NotificationService`.
 *
 * ✅ **The scheduling half landed in Phase 3, not Phase 7** — review finding **S9**,
 * condition **C24**. `schedule_notification` and `remove_sch_notitfications` are called from
 * `services/user.py:281-282` (`PATCH /api/user/<id>`, this phase) and from
 * `services/loan.py` (Phase 4), both of which run *before* Phase 7's runner exists. The
 * write half is here; {@link SchedulerTaskRepository} owns the SQL and the hstore encoding.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly repository: NotificationSubscriptionRepository,
    private readonly publisher: NotificationPublisher,
    private readonly schedulerTasks: SchedulerTaskRepository,
  ) {}

  /**
   * `save_subscription(user_id, subscription)`.
   *
   * ```python
   * user = UserProfile.objects.get(id=user_id)
   * notifications = NotificationSubscriptions.objects.filter(
   *     subscription__endpoint=subscription['endpoint'])
   * if len(notifications) == 0:
   *     NotificationSubscriptions.objects.create(user=user, subscription=subscription)
   * ```
   *
   * Re-subscribing an endpoint that already exists is a **silent no-op** returning 200 — the
   * browser re-registers on every service-worker activation, so this is the normal path, not
   * an error path. v1 dedupes across all users, not per user; see the repository.
   *
   * v1's explicit `UserProfile.objects.get` is not reproduced: it exists only to obtain the
   * FK value, and v2 already has the authenticated user's id. A non-existent user produces a
   * foreign-key violation instead of a `DoesNotExist` — both are an uncaught 500, and neither
   * is reachable behind the roles guard, which denies a user with no profile row.
   */
  async saveSubscription(userId: number, subscription: unknown): Promise<void> {
    const endpoint = readEndpoint(subscription);

    if (await this.repository.existsByEndpoint(endpoint)) {
      return;
    }
    await this.repository.create(userId, subscription as Record<string, PythonEncodable>);
  }

  /**
   * `unregister_subscription(user_id, subscription)` → `200` or `404`.
   *
   * Scoped to the caller: a member cannot unsubscribe another member's browser even knowing
   * its endpoint.
   */
  async unregisterSubscription(userId: number, subscription: unknown): Promise<number> {
    const endpoint = readEndpoint(subscription);

    const id = await this.repository.findIdByUserAndEndpoint(userId, endpoint);
    if (id === null) {
      // v1: `except NotificationSubscriptions.DoesNotExist: return 404`
      return UNSUBSCRIBE_NOT_FOUND;
    }
    await this.repository.deleteById(id);
    return UNSUBSCRIBE_OK;
  }

  /**
   * `remove_all_subscriptions(user_id)`.
   *
   * ⚠️ Called in v1 from `services/user.py:218` when a member turns notifications off —
   * **Phase 3 must wire it into `PATCH /api/user/<id>` with `type=preferences`.** Phase 2
   * ships it with no caller because the route does not exist yet, not because it is dead.
   */
  async removeAllSubscriptions(userId: number): Promise<void> {
    await this.repository.deleteAllByUserId(userId);
  }

  /**
   * `schedule_notification(run_date, payload, repeat=0)`.
   *
   * ```python
   * tasks = SchedulerTask.objects.filter(payload__owner_id=payload["owner_id"],
   *                                      payload__type=payload["type"],
   *                                      run_date__year=run_date.year, ... ,
   *                                      processed=False)
   * if len(tasks) == 0:
   *     run_date = make_aware(run_date)
   *     SchedulerTask.objects.create(type=0, run_date=run_date, payload=payload, repeat=repeat)
   * ```
   *
   * Three things the shape of this signature is protecting:
   *
   *  * **`runDate` is a wall-clock date, not an instant.** v1 builds
   *    `datetime(birthdate.year, birthdate.month, birthdate.day)` — naive local midnight —
   *    dedupes on *its* calendar parts, and only then calls `make_aware`. Taking a `PlainDate`
   *    (plus optional hour/minute) makes it impossible to hand this an instant and have the
   *    dedupe silently compare the wrong day near midnight.
   *  * **The dedupe is same-day, not same-instant**, and is scoped to unprocessed rows. Two
   *    calls on the same day for the same `(owner_id, type)` write one row; the second is a
   *    silent no-op (plan §4 rule 9, idempotent-under-retry).
   *  * **`repeat` defaults to 0 (`NONE`)**, as in v1. The birthday task passes `4` (`YEARLY`).
   */
  async scheduleNotification(
    runDate: PlainDate & { hour?: number; minute?: number },
    payload: SchedulerTaskPayload,
    repeat = 0,
    client?: SchedulerSqlClient,
  ): Promise<void> {
    const alreadyScheduled = await this.schedulerTasks.existsUnprocessedOnDay(
      payload.owner_id,
      payload.type,
      runDate.year,
      runDate.month,
      runDate.day,
      client,
    );
    if (alreadyScheduled) {
      return;
    }
    await this.schedulerTasks.create(bogotaWallClockToInstant(runDate), payload, repeat, client);
  }

  /**
   * `remove_sch_notitfications(notification_type, owner_id)` — v1's spelling, kept only in the
   * doc; the method name is corrected here because nothing external calls it by name.
   *
   * @returns the number of rows deleted.
   */
  async removeSchNotifications(
    notificationType: string,
    ownerId: number,
    client?: SchedulerSqlClient,
  ): Promise<number> {
    return this.schedulerTasks.deleteByOwnerAndType(ownerId, notificationType, client);
  }

  /**
   * `send_notification(user_ids, message, target, run_async=True)`.
   *
   * v1's `run_async` flag chose between `send_notification.delay(payload)` (Celery) and
   * calling the task function directly — both of which end in the same
   * `sqs_client.send_message`. With Celery gone the two converge, so the parameter is gone
   * too. Nothing else about the payload changes.
   *
   * ⚠️ **Condition 4, carried forward knowingly:** a member with **zero** rows in
   * `fondo_api_notificationsubscriptions` receives nothing — the early return below means no
   * message is published at all, so a loan payment reminder for a member who never granted
   * browser notifications is silently dropped. That is v1's behaviour (`if
   * len(notification_subscriptions) == 0: return`) and the operator has confirmed push-only
   * delivery with no email fallback (Q7). It is recorded here rather than "fixed" so the next
   * reader knows it is a decision.
   *
   * ⚠️ **Never call this from inside a Prisma interactive transaction** — see
   * {@link NotificationPublisher}, condition 3.
   *
   * Never throws: a publish failure is swallowed at the boundary, as in v1.
   *
   * @returns which of the three v1 outcomes occurred. v1 returns `None` for all three; the
   *   discriminated value is Phase 7b's, so the scheduler can log a failed publish instead of
   *   recording it as a success. Nothing branches on it in the HTTP paths.
   */
  async sendNotification(
    userIds: readonly number[],
    message: string,
    target: string,
  ): Promise<NotificationDelivery> {
    const subscriptions = await this.repository.findPushSubscriptionsByUserIds(userIds);
    if (subscriptions.length === 0) {
      return 'no-subscriptions';
    }

    const published = await this.publisher.publish({
      subscriptions,
      message: { body: message, target },
    });
    return published ? 'published' : 'failed';
  }
}

/**
 * `subscription['endpoint']`.
 *
 * v1 subscripts the parsed request body directly, so a body without an `endpoint` key raises
 * `KeyError` and a non-mapping body raises `TypeError` — both uncaught, both a 500.
 * Reproduced as a thrown `Error` (the global filter renders a bare 500) rather than silently
 * writing a row with no endpoint, which would be undeletable through `unregister` and
 * invisible to the dedupe check.
 *
 * A non-string endpoint is coerced with {@link pythonStr}, because that is what Django's
 * `HStoreField.get_prep_value` would have stored and therefore what the dedupe query has to
 * compare against. A `null` endpoint is the one case v2 declines to reproduce: Django would
 * store SQL NULL and query `IS NULL`, so the two would need different SQL for a payload no
 * browser can produce. It 500s here instead; registered in `docs/phase-2-deviations.md`.
 */
function readEndpoint(subscription: unknown): string {
  if (subscription === null || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw new TypeError(
      `string indices must be integers: subscription payload is ${describeType(subscription)}`,
    );
  }
  const record = subscription as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'endpoint')) {
    throw new Error("KeyError: 'endpoint'");
  }
  const endpoint = record.endpoint;
  if (endpoint === null || endpoint === undefined) {
    throw new TypeError('subscription endpoint must not be null');
  }
  return pythonStr(endpoint as PythonEncodable);
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'NoneType';
  }
  return Array.isArray(value) ? 'list' : typeof value;
}
