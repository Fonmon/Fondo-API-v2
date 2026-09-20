import { Injectable } from '@nestjs/common';
import { encodeJsonbColumn, type StorableValue } from '../common/utils/jsonb-storage';
import type { Prisma } from '../prisma';
import { PrismaService } from '../prisma/prisma.service';
import { pinKeysMemberOrder, type PushSubscription } from './push-subscription';

/**
 * The subscription members that hold structured JSON after Phase 9 step 6. Everything else is
 * stored as a JSON **string**, which is what v1 stored and what all 94 migrated rows contain.
 */
const SUBSCRIPTION_NATIVE_KEYS = ['keys'] as const;

/**
 * `fondo_api_notificationsubscriptions`, on ordinary Prisma models.
 *
 * ## ⚠️ Row order is part of the SQS wire format — do not add an ORDER BY
 *
 * **Read this first, because it is the one thing in this file that a change can break
 * silently, and it survived Phase 9 step 6 unchanged.**
 *
 * `NotificationSubscriptions.objects.filter(user_id__in=…)` has no `Meta.ordering`, so
 * Django emits no `ORDER BY` and v1 serialises whatever heap order PostgreSQL returns
 * straight into `json.dumps`. On `fondodev` that order is **not** id order — the table has
 * been updated enough for the heap to diverge — so adding `ORDER BY id` here would make v2's
 * SQS body differ from v1's for the same input. {@link findPushSubscriptionsByUserIds} is a
 * `findMany` with **no `orderBy`**, which emits none, exactly as Django does, and the planner
 * picks the same sequential scan for both. Counter-intuitive, and verified against the live
 * table.
 *
 * 🔴 An `orderBy: { id: 'asc' }` added here "for determinism" changes **every** notification's
 * SQS body. Nothing in the type system, the lint rules or the unit suite would object.
 *
 * ## What step 6 changed, and what it did not
 *
 * The column was `hstore` until Phase 9 step 6; Prisma modelled it `Unsupported("hstore")`,
 * every access cast (`subscription::text` out, `$1::hstore` in) and went through a codec. All
 * of that is gone — the column is `jsonb`, the client reads and writes it directly, and
 * `hstore.codec.ts` is deleted.
 *
 * Two of the old encoding quirks were **decided once, by the migration**, and no longer exist
 * at runtime: the nested `keys` object was stored as a Python `repr`
 * (`{'p256dh': '…', 'auth': '…'}`, single quotes, not JSON) and read back through a
 * `'` → `"` repair — the step-6 repair pass unwrapped it into a real object in all 94 rows.
 * ⚠️ Its **member order** did move, from `p256dh, auth` to jsonb's `auth, p256dh`, and
 * `pinKeysMemberOrder` restores the browser's order on the way out — condition **C91**,
 * operator answer **Q60**, and after step 6 that pin is the only thing holding it.
 *
 * The third quirk is **not** historical and still governs every write:
 *
 *  * **Values are strings.** Django's `HStoreField.get_prep_value` ran `str()` over every
 *    value, and the 94 migrated rows embody that — `endpoint` is a JSON string even when the
 *    caller passed a number, and `expirationTime: None` is JSON `null` (93 rows have it; one
 *    `web.push.apple.com` row has no `expirationTime` member at all). {@link encodeJsonbColumn}
 *    applies the rule; `common/utils/jsonb-storage.ts` explains why storing the value's own
 *    JSON type instead would look tidier and would break every equality filter against those
 *    rows.
 */
@Injectable()
export class NotificationSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `NotificationSubscriptions.objects.filter(subscription__endpoint=endpoint)` reduced to
   * the existence test `save_subscription` actually performs (`len(notifications) == 0`).
   *
   * ⚠️ The filter is **global**, not scoped to the user: a browser endpoint already
   * registered by *another* member is not re-registered. That is v1's dedupe rule and it is
   * correct — an endpoint identifies one browser installation, which belongs to one person.
   */
  async existsByEndpoint(endpoint: string): Promise<boolean> {
    const row = await this.prisma.notificationSubscription.findFirst({
      where: { subscription: { path: ['endpoint'], equals: endpoint } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * `NotificationSubscriptions.objects.create(user=user, subscription=subscription)`.
   *
   * `id` is left to the sequence — v1 and v2 share it during parity testing and plan §4
   * forbids v2 setting a primary key on a table v1 also writes.
   */
  async create(userId: number, subscription: Record<string, StorableValue>): Promise<void> {
    await this.prisma.notificationSubscription.create({
      data: {
        user_id: userId,
        subscription: encodeJsonbColumn(
          subscription,
          SUBSCRIPTION_NATIVE_KEYS,
        ) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * ```python
   * NotificationSubscriptions.objects.get(user_id=user_id,
   *                                       subscription__endpoint=subscription['endpoint'])
   * ```
   *
   * @returns the row id, or `null` where v1 raises `DoesNotExist` (which the caller turns
   *   into a 404).
   * @throws Error where v1 raises `MultipleObjectsReturned` — an uncaught 500 in v1, because
   *   `unregister_subscription` only catches `DoesNotExist`. Unreachable through the API
   *   (`existsByEndpoint` prevents a second row for the same endpoint) but reachable from
   *   rows written by anything else, so it fails loudly rather than deleting an arbitrary one.
   */
  async findIdByUserAndEndpoint(userId: number, endpoint: string): Promise<number | null> {
    const rows = await this.prisma.notificationSubscription.findMany({
      where: {
        user_id: userId,
        subscription: { path: ['endpoint'], equals: endpoint },
      },
      select: { id: true },
    });
    if (rows.length === 0) {
      return null;
    }
    if (rows.length > 1) {
      throw new Error(
        `get() returned more than one NotificationSubscriptions -- it returned ${rows.length}!`,
      );
    }
    return rows[0].id;
  }

  /** `.delete()` on the row `findIdByUserAndEndpoint` located. */
  async deleteById(id: number): Promise<void> {
    await this.prisma.notificationSubscription.delete({ where: { id } });
  }

  /**
   * `NotificationSubscriptions.objects.filter(user_id=user_id).delete()`
   * (`remove_all_subscriptions`).
   *
   * ⚠️ **This has a live v1 caller** — `services/user.py:218`, inside
   * `__update_user_preferences`:
   *
   * ```python
   * remove_notifications = user_preference.notifications != obj['notifications']
   * ...
   * if remove_notifications and not user_preference.notifications:
   *     self.__notification_service.remove_all_subscriptions(id)
   * ```
   *
   * so a member switching notifications **off** deletes every push subscription they own, on
   * every device. It is unreachable in Phase 2 only because `PATCH /api/user/<id>` does not
   * exist yet: **Phase 3 must wire this call** (P2-D4, corrected after parity finding F5).
   */
  async deleteAllByUserId(userId: number): Promise<number> {
    const { count } = await this.prisma.notificationSubscription.deleteMany({
      where: { user_id: userId },
    });
    return count;
  }

  /**
   * The read half of `send_notification`:
   *
   * ```python
   * notification_subscriptions = NotificationSubscriptions.objects.filter(user_id__in=user_ids)
   * for notification_subscription in notification_subscriptions:
   *     subscription = notification_subscription.subscription
   *     subscription['keys'] = subscription['keys'].replace("'", '"')
   *     subscription['keys'] = json.loads(subscription['keys'])
   *     subscriptions.append(subscription)
   * ```
   *
   * The `keys` repair the loop above does on **every** read was done once and permanently by
   * the step-6 migration, so this method only reads. Two orders still have to be right:
   *
   *  * **Top-level member order** is PostgreSQL's `(length, bytes)` — `keys`, `endpoint`,
   *    `expirationTime` — which jsonb reproduces exactly as hstore emitted it (measured on all
   *    720 migrated rows, `scripts/parity/step6-prove.sh`'s `keyorder` comparison).
   *  * **`keys` member order** is restored to the browser's `p256dh, auth` by
   *    `pinKeysMemberOrder`, inside {@link requirePushSubscription} — C91 / Q60.
   *
   * ⚠️ **Row order is the heap order the class comment describes: no `orderBy` here, ever.**
   *
   * An empty `user_ids` short-circuits: Django turns `__in=[]` into an `EmptyResultSet` and
   * never runs a query, whereas `IN ()` is a SQL syntax error.
   */
  async findPushSubscriptionsByUserIds(userIds: readonly number[]): Promise<PushSubscription[]> {
    if (userIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.notificationSubscription.findMany({
      where: { user_id: { in: [...userIds] } },
      select: { subscription: true },
    });

    return rows.map((row) => requirePushSubscription(row.subscription));
  }

  /**
   * Reads one row's stored `subscription` object. Used by the integration cells that prove a
   * subscription v2 writes is stored exactly like one the step-6 migration produced — which is
   * what keeps every equality filter matching the whole table — and by nothing in production.
   *
   * Before step 6 this returned the raw hstore *text*, because the comparison then was against
   * v1's Python-repr encoding byte for byte.
   */
  async findSubscriptionById(id: number): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.notificationSubscription.findUnique({
      where: { id },
      select: { subscription: true },
    });
    return row === null ? null : (row.subscription as Record<string, unknown>);
  }
}

/**
 * The read half of v1's `send_notification`, after Phase 9 step 6.
 *
 * ```python
 * subscription = notification_subscription.subscription
 * subscription['keys'] = subscription['keys'].replace("'", '"')
 * subscription['keys'] = json.loads(subscription['keys'])
 * ```
 *
 * The migration did the repair once and permanently, so there is nothing left to decode —
 * but the two things that loop *guaranteed* still have to hold:
 *
 *  1. ⚠️ **Condition C23 — fail closed on a missing `keys`.** v1 subscripts the key
 *     unconditionally, so a row without it raises before anything is published. Iterating the
 *     object's own members would instead publish a subscription with no `keys` field to the
 *     Lambda — a fail-*open* divergence invisible to any black-box round, because all 94 live
 *     rows carry it.
 *  2. ✅ **C91 (Q60) — the `keys` members go out as `p256dh, auth`.** jsonb stores them in
 *     (length, bytes) order, i.e. `auth, p256dh`; the pin restores the browser's order at the
 *     one place every SQS body passes through. See `push-subscription.ts`.
 */
function requirePushSubscription(stored: unknown): PushSubscription {
  const subscription = stored as PushSubscription;
  if (!Object.prototype.hasOwnProperty.call(subscription, 'keys')) {
    throw new Error("KeyError: 'keys'");
  }
  if (subscription.keys === null) {
    // Django stored Python `None` as SQL NULL, which step 6 turned into JSON null; v1 then
    // did `None.replace(...)`.
    throw new TypeError("AttributeError: 'NoneType' object has no attribute 'replace'");
  }
  return pinKeysMemberOrder(subscription);
}
