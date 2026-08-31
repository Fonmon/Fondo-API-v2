import { Injectable } from '@nestjs/common';
import {
  decodePushSubscription,
  parseHstore,
  toHstoreLiteral,
  type PushSubscription,
  type PythonEncodable,
} from '../common/utils/hstore.codec';
import { Prisma } from '../prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The **only** place in the codebase allowed to write SQL against
 * `fondo_api_notificationsubscriptions.subscription`.
 *
 * ## Why raw SQL at all
 *
 * The column is `hstore`. Prisma models it as `Unsupported("hstore")` and its client can
 * neither select nor write it ([prisma#19000](https://github.com/prisma/prisma/issues/19000)),
 * so every access casts — `subscription::text` on the way out, `$1::hstore` on the way in —
 * and goes through the Phase 0 codec. Plan §2 confines that to this class and
 * `SchedulerTaskRepository` (Phase 7); `nestjs-reviewer` enforces the rule. It all disappears
 * at Phase 9 when the column becomes `jsonb`.
 *
 * ## Three encoding quirks that live rows depend on
 *
 * `fondodev` holds **94 real subscriptions** written by v1, so the encoding is not
 * negotiable:
 *
 *  1. **hstore stores strings only.** Django's `HStoreField.get_prep_value` runs `str()` over
 *     every value, so the nested `keys` object is stored as a Python `repr`:
 *     `{'p256dh': '…', 'auth': '…'}` — single quotes, **not** JSON. {@link toHstoreLiteral}
 *     reproduces that on write; writing real JSON would make v2's own rows unreadable by the
 *     read-side repair below (and by v1, which still runs until cutover).
 *  2. **`None` becomes SQL NULL**, not the string `'None'` — 93 of the 94 rows have
 *     `"expirationTime"=>NULL`, and one (an `web.push.apple.com` endpoint) has no
 *     `expirationTime` key at all.
 *  3. **The `'` → `"` repair on read** (`subscription['keys'].replace("'", '"')` in
 *     `services/notification.py:38`), applied by {@link decodePushSubscription}.
 *
 * ## ⚠️ Row order is part of the SQS wire format — do not add an ORDER BY
 *
 * `NotificationSubscriptions.objects.filter(user_id__in=…)` has no `Meta.ordering`, so
 * Django emits no `ORDER BY` and v1 serialises whatever heap order PostgreSQL returns
 * straight into `json.dumps`. On `fondodev` that order is **not** id order — the table has
 * been updated enough for the heap to diverge — so adding `ORDER BY id` here would make v2's
 * SQS body differ from v1's for the same input. {@link findPushSubscriptionsByUserIds}
 * therefore emits `IN (…)`, exactly as Django does, and the planner picks the same sequential
 * scan for both. Counter-intuitive, and verified against the live table.
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
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id
      FROM fondo_api_notificationsubscriptions
      WHERE subscription -> 'endpoint' = ${endpoint}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  /**
   * `NotificationSubscriptions.objects.create(user=user, subscription=subscription)`.
   *
   * `id` is left to the sequence — v1 and v2 share it during parity testing and plan §4
   * forbids v2 setting a primary key on a table v1 also writes.
   */
  async create(userId: number, subscription: Record<string, PythonEncodable>): Promise<void> {
    const literal = toHstoreLiteral(subscription);
    await this.prisma.$executeRaw`
      INSERT INTO fondo_api_notificationsubscriptions (user_id, subscription)
      VALUES (${userId}, ${literal}::hstore)
    `;
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
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id
      FROM fondo_api_notificationsubscriptions
      WHERE user_id = ${userId}
        AND subscription -> 'endpoint' = ${endpoint}
    `;
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
    await this.prisma.$executeRaw`
      DELETE FROM fondo_api_notificationsubscriptions WHERE id = ${id}
    `;
  }

  /**
   * `NotificationSubscriptions.objects.filter(user_id=user_id).delete()`
   * (`remove_all_subscriptions`).
   *
   * ⚠️ Nothing in v1 calls it — verified across `fondo_api/`. Ported because it is part of
   * the service's surface and Phase 3's soft delete is the obvious future caller; recorded in
   * `docs/phase-2-deviations.md` so it is not mistaken for dead code that crept in.
   */
  async deleteAllByUserId(userId: number): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM fondo_api_notificationsubscriptions WHERE user_id = ${userId}
    `;
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
   * Key order within each subscription is PostgreSQL's — `(length, bytes)`, i.e.
   * `keys`, `endpoint`, `expirationTime` — and is preserved through {@link parseHstore} into
   * the JSON body. Row order is the heap order described in the class comment.
   *
   * An empty `user_ids` short-circuits: Django turns `__in=[]` into an `EmptyResultSet` and
   * never runs a query, whereas `IN ()` is a SQL syntax error.
   */
  async findPushSubscriptionsByUserIds(userIds: readonly number[]): Promise<PushSubscription[]> {
    if (userIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<{ subscription: string }[]>`
      SELECT subscription::text AS subscription
      FROM fondo_api_notificationsubscriptions
      WHERE user_id IN (${Prisma.join([...userIds])})
    `;

    return rows.map((row) => decodePushSubscription(parseHstore(row.subscription)));
  }

  /**
   * Reads one row's raw hstore rendering. Used by the Phase 2 round-trip integration test to
   * prove that a subscription written by v2 is byte-identical to one written by v1 —
   * including the Python `repr` in `keys` — and by nothing in production.
   */
  async findRawSubscriptionById(id: number): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ subscription: string }[]>`
      SELECT subscription::text AS subscription
      FROM fondo_api_notificationsubscriptions
      WHERE id = ${id}
    `;
    return rows.length === 0 ? null : rows[0].subscription;
  }
}
