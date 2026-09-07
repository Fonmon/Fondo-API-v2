import { Injectable } from '@nestjs/common';
import {
  decodeSchedulerPayload,
  type HstoreMap,
  type HstoreValue,
} from '../../common/utils/hstore.codec';
import { NotificationService } from '../../notifications/notification.service';
import type { SchedulerExecuter, SchedulerExecuterOutcome } from './scheduler-executer';

/**
 * `fondo_api/scheduler/executers/notification_executer.py` — the only executer v1 has.
 *
 * ```python
 * class NotificationExecuter(AbstractExecuter):
 *     def __init__(self, notification_service):
 *         self.__notification_service = notification_service
 *
 *     def run(self, payload):
 *         user_ids = json.loads(payload["user_ids"])
 *         self.__notification_service.send_notification(
 *             user_ids, payload["message"], payload["target"], False)
 * ```
 *
 * `run_async = False` was v1's "call the Celery task function in-process instead of
 * `.delay()`-ing it". Both branches ended in the same `sqs_client.send_message`, so with
 * Celery retired the flag has nothing left to choose between and is gone
 * (see {@link NotificationService.sendNotification}).
 *
 * ## Why the three key reads are explicit
 *
 * All three are bare subscripts in v1, so a payload missing any of them raises `KeyError`
 * inside `executer.run()`; `scheduler/tasks.py` catches it, logs
 * `Error processing task with id: …`, and leaves the row unprocessed. That is a real code
 * path — the two writers always set all five keys, but a hand-written row or a future task
 * type need not — and it is exactly the shape condition **C23** was raised about: a decoder
 * that fails *open* on an absent key turns a loud v1 error into a silently malformed
 * notification. The order of the checks is v1's evaluation order: `user_ids` first (it is on
 * its own line), then `message`, then `target`, as the call's arguments are built.
 */
@Injectable()
export class NotificationExecuter implements SchedulerExecuter {
  constructor(private readonly notifications: NotificationService) {}

  async run(payload: HstoreMap): Promise<SchedulerExecuterOutcome> {
    // `json.loads(payload["user_ids"])`. Raises for an absent key (C23) and for a NULL value.
    const decoded = decodeSchedulerPayload(payload);
    const message = requireText(payload, 'message');
    const target = requireText(payload, 'target');

    const delivery = await this.notifications.sendNotification(decoded.user_ids, message, target);
    // `no-subscriptions` is v1's `if len(...) == 0: return` — the member granted no browser
    // permission, so there is nothing to publish and nothing went wrong (Q7: push only, no
    // email fallback). `failed` is a swallowed publish error, which v1 cannot distinguish.
    return { ok: delivery !== 'failed', detail: delivery };
  }
}

/**
 * `payload["<key>"]`, with v1's two failure modes preserved.
 *
 * * **Absent key** → `KeyError`, uncaught in `run`, caught by the scheduler loop. Rendered
 *   with the same `KeyError: 'key'` text the hstore codec uses so the log line reads the way
 *   v1's does.
 * * **SQL NULL value** → v1 would pass `None` straight into the message body and
 *   `json.dumps` would render `null` on the wire. Not reachable from either writer —
 *   Django's `HStoreField.get_prep_value` calls `str()`, so a Python `None` is stored as the
 *   *string* `'None'`, never SQL NULL — so v2 refuses it loudly instead of widening the
 *   notification payload's types for a row only a hand-edit can produce. Registered as
 *   **P7-D4**.
 */
function requireText(payload: HstoreMap, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw new Error(`KeyError: '${key}'`);
  }
  const value: HstoreValue = payload[key];
  if (value === null) {
    throw new TypeError(`scheduler payload key '${key}' is NULL`);
  }
  return value;
}
