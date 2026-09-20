import { Injectable, Logger } from '@nestjs/common';
import { requireText, requireUserIds, type SchedulerPayload } from '../scheduler-payload';
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
   * The skip is a *return*, never a *throw*. A throw releases the claim (`scheduler.runner.ts`),
   * so the row stays unprocessed, clones nothing on that pass, and D7's `<=` picks it up again at
   * every later pass: the chain is **stalled**, logged twice a day, and clones only once a pass
   * gets through (C87). That is right for a malformed row someone must repair, and wrong for a
   * greeting that simply should not go out, which would retry and log for as long as the member
   * is away. So a departed or missing owner is a return: processed, cloned, chain rolling (Q48).
   *
   * ## The owner read and the audience read are deliberately not atomic (review m3)
   *
   * {@link MemberDirectory.ownerStatus} and {@link MemberDirectory.activeMemberIdsExcept} are two
   * statements, not one transaction. Nothing observable depends on their agreeing:
   *
   *  * the owner is removed from the audience **whatever** their status at the second read, so a
   *    member deactivated between the two reads is not greeted about themselves either way;
   *  * a member activated or deactivated between the reads joins or leaves this one audience,
   *    exactly as if the change had landed a second earlier or later.
   *
   * ⚠️ Do not wrap them in a transaction. It buys nothing, and it invites moving the SQS publish
   * inside it, which `NotificationPublisher` forbids (a publish is not rolled back).
   */
  async run(payload: SchedulerPayload): Promise<SchedulerExecuterOutcome> {
    // Step 6 did v1's `json.loads(payload["user_ids"])` once and permanently; this still
    // raises for an absent key (C23) and for a NULL value.
    const userIds = requireUserIds(payload);
    const message = requireText(payload, 'message');
    const target = requireText(payload, 'target');

    if (payload.type !== BIRTHDATE_PAYLOAD_TYPE) {
      return this.deliver(userIds, message, target);
    }

    const ownerId = parseOwnerId(payload);
    if (ownerId === null) {
      // C88: beyond `integer`, so no `auth_user` row can have it. Answered here, with no query:
      // Prisma refuses the bind (P2020), which would throw and stall the row instead of §2.2.
      return MISSING_OWNER;
    }
    const owner = await this.members.ownerStatus(ownerId);
    if (owner === 'inactive') {
      // D39 (Q35, Q48).
      this.logger.log(`Birthday of inactive member ${ownerId} not announced (D39).`);
      return { ok: true, detail: 'owner-inactive' };
    }
    if (owner === 'missing') {
      return MISSING_OWNER;
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

/**
 * §2.2: a birthday whose owner has no `auth_user` row. No announcement, but it is not the expected
 * case, so `ok: false` puts a WARN naming the task in the runner's log. Shared by the lookup's
 * `missing` answer and C88's no-query answer for an id beyond `integer`, so the two cannot drift.
 */
const MISSING_OWNER: SchedulerExecuterOutcome = { ok: false, detail: 'owner-missing' };

/** `auth_user.id` is `integer`; a larger id cannot name any row. */
const MAX_INT4 = 2147483647;

/**
 * `payload["owner_id"]` as a member id, for D39/D49. v1's executer never reads this key.
 *
 *  * absent → `KeyError: 'owner_id'`, thrown. The row stays unprocessed, is retried and logged at
 *    every pass, and clones nothing until it is repaired (C87). Both writers always set it
 *    (`services/user.py:271`), so only a hand-written row reaches this.
 *  * NULL → `TypeError`, as for `message`/`target` (P7-D4).
 *  * not ASCII decimal digits → `ValueError`, thrown, with the same stall.
 *  * digits beyond `integer` → **`null`**: no row can match, and the caller answers `missing` with
 *    **no query** (C88). Measured by `nestjs-reviewer` on `fondo_api_test`: `findUnique` with
 *    `2147483647` returns `null`, with `2147483648` it throws P2020 (value out of range).
 *
 * ⚠️ **Whoever repairs a stalled row must also move its `run_date` to the next birthday** (D48's
 * rule). D7's `<=` sends a past-dated row on the very next pass, saying *"hoy"* on the wrong day.
 */
function parseOwnerId(payload: SchedulerPayload): number | null {
  const text = requireText(payload, 'owner_id');
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`ValueError: invalid owner_id in scheduler payload: '${text}'`);
  }
  const id = Number(text);
  return id > MAX_INT4 ? null : id;
}
