import { Injectable, Logger } from '@nestjs/common';
import {
  decodeSchedulerPayload,
  type HstoreMap,
  type HstoreValue,
} from '../../common/utils/hstore.codec';
import { NotificationService } from '../../notifications/notification.service';
import { MemberDirectory } from '../member-directory';
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
  private readonly logger = new Logger(NotificationExecuter.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly members: MemberDirectory,
  ) {}

  /**
   * ## Phase 8b — birthday tasks only (`payload.type === 'birthdate'`)
   *
   * | step | v1 | v2 | register |
   * |---|---|---|---|
   * | `user_ids`, `message`, `target` read | yes, in that order | **unchanged**, same order and same failures (C23, P7-D4) | §2.3 |
   * | owner departed (`is_active = false`) | announced | **nothing sent**, `ok: true`, `owner-inactive`; row processed, successor cloned | **D39** |
   * | owner row absent | announced | **nothing sent**, `ok: false`, `owner-missing`; row processed, successor cloned | §2.2 |
   * | recipients | stored `user_ids` | **every active member except the owner, read now** | **D49** |
   *
   * The stored `user_ids` is still parsed, so a row v1 would fail on still fails here, but it
   * no longer chooses who receives a birthday greeting (§2.3). Payment reminders and every
   * other `type` go down v1's path unchanged.
   *
   * The skip is a *return*, never a *throw*: a throw releases the claim and clones no
   * successor (`scheduler-executer.ts`, C77), which would end the yearly chain. Q48 requires the
   * chain to keep rolling, so a member who returns is greeted again with no action.
   */
  async run(payload: HstoreMap): Promise<SchedulerExecuterOutcome> {
    // `json.loads(payload["user_ids"])`. Raises for an absent key (C23) and for a NULL value.
    const decoded = decodeSchedulerPayload(payload);
    const message = requireText(payload, 'message');
    const target = requireText(payload, 'target');

    if (payload.type !== BIRTHDATE_PAYLOAD_TYPE) {
      return this.deliver(decoded.user_ids, message, target);
    }

    const ownerId = parseOwnerId(payload);
    const owner = await this.members.ownerStatus(ownerId);
    if (owner === 'inactive') {
      // D39 (Q35, Q48).
      this.logger.log(`Birthday of inactive member ${ownerId} not announced (D39).`);
      return { ok: true, detail: 'owner-inactive' };
    }
    if (owner === 'missing') {
      // §2.2: a hard-deleted or hand-written owner. No announcement, but it is not the expected
      // case, so `ok: false` puts a WARN naming the task in the runner's log.
      return { ok: false, detail: 'owner-missing' };
    }

    // D49 (Q49): the stored list is ignored for the audience.
    const recipients = await this.members.activeMemberIdsExcept(ownerId);
    return this.deliver(recipients, message, target);
  }

  private async deliver(
    userIds: readonly number[],
    message: string,
    target: string,
  ): Promise<SchedulerExecuterOutcome> {
    const delivery = await this.notifications.sendNotification(userIds, message, target);
    // `no-subscriptions` is v1's `if len(...) == 0: return` — the member granted no browser
    // permission, so there is nothing to publish and nothing went wrong (Q7: push only, no
    // email fallback). `failed` is a swallowed publish error, which v1 cannot distinguish.
    return { ok: delivery !== 'failed', detail: delivery };
  }
}

/** The `type` both birthday writers store (`services/user.py:273`). */
export const BIRTHDATE_PAYLOAD_TYPE = 'birthdate';

/** `auth_user.id` is `integer`; a larger id cannot name any row. */
const MAX_INT4 = 2147483647;

/**
 * `payload["owner_id"]` as a member id, for D39/D49. v1's executer never reads this key.
 *
 *  * absent → `KeyError: 'owner_id'`, thrown: the row stays unprocessed and is logged, like
 *    every other missing key (C23). Both writers always set it (`services/user.py:271`), so only
 *    a hand-written row reaches this.
 *  * NULL → `TypeError`, as for `message`/`target` (P7-D4).
 *  * not ASCII decimal digits → `ValueError`, thrown.
 *  * digits beyond `integer` → no row can match, so the caller gets `MAX_INT4 + 1` and the
 *    lookup answers `missing` without sending an out-of-range bind to PostgreSQL.
 */
function parseOwnerId(payload: HstoreMap): number {
  const text = requireText(payload, 'owner_id');
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`ValueError: invalid owner_id in scheduler payload: '${text}'`);
  }
  const id = Number(text);
  return id > MAX_INT4 ? MAX_INT4 + 1 : id;
}

/**
 * `payload["<key>"]`, with v1's two failure modes preserved.
 *
 * * **Absent key** → `KeyError`, uncaught in `run`, caught by the scheduler loop. The row is
 *   left unprocessed and retried on the next pass, exactly as v1's is. ⚠️ **The log *text*
 *   does not match v1 and is not meant to** — registered as **P7-D6** (parity round F1).
 *   `'{}'.format(ex)` is `str(ex)`, and `str(KeyError('message'))` is `'message'`: the quotes
 *   are the repr and there is no `KeyError:` prefix, so v1 logs `exception: 'message'` where
 *   v2 logs `exception: KeyError: 'message'`. v2 keeps the prefix because its exception class
 *   is a plain `Error` — drop it and the line degrades to a bare quoted word with nothing
 *   saying what went wrong, which is the opposite of this phase's §3 stance. Rows and wire are
 *   identical either way; the one-line change that would match v1 is in `requireText` below
 *   and in {@link requireHstoreKey}.
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
