/**
 * The push subscription as it travels from `fondo_api_notificationsubscriptions.subscription`
 * to the SQS body the external Web Push Lambda consumes — and **C91's pinned member order**.
 *
 * Before Phase 9 step 6 this type lived in `hstore.codec.ts`, which stage 2a deleted.
 */

/** A push subscription, as the browser produced it and v1 republishes it to SQS. */
export interface PushSubscription {
  endpoint: string;
  expirationTime: string | null;
  keys: Record<string, string>;
  [extra: string]: unknown;
}

/**
 * ✅ **C91 (operator answer Q60): the `keys` object goes on the wire as `p256dh`, then `auth`.**
 *
 * ## What happened, and why a pin rather than a conversion change
 *
 * While the column was `hstore`, `keys` was an opaque **string** holding a Python dict repr,
 * and v1's `json.loads` produced a dict in the repr's order — `p256dh, auth` in **94 of 94**
 * live rows, which is the browser's own `PushSubscription.toJSON()` order
 * (`business-analyst`, `docs/ba-phase-9-step6-questions.md`). Step 6 made it a real jsonb
 * object, and **jsonb sorts members by (length, bytes)**, so what is *stored* is now
 * `auth, p256dh`. jsonb cannot hold a non-canonical order, so the order cannot be preserved
 * in storage — the operator's ruling is preserved on the **emit** side instead.
 *
 * ## Why this matters, and why it cannot be re-derived later
 *
 * The project holds SQS bodies to a byte-identical criterion (§4 rules 8 and 5d), the
 * consumer is an out-of-repo Lambda nobody here can read, and the analyst measured **no
 * signature, no content hash, no FIFO dedupe and no `MessageAttributes`** anywhere on the SQS
 * path — so nothing *proved* the order is load-bearing, and nothing proved it is not. The
 * operator took the no-change option at a one-way door.
 *
 * 🔴 **After step 6 the stored order no longer exists anywhere.** This function and its cells
 * are the only thing holding it. Do not "simplify" it away because the object looks
 * unordered: `JSON.stringify` and `pythonJsonDumps` both emit insertion order.
 *
 * Unknown members are **kept**, after the pinned two, in the order they arrived — dropping a
 * member the browser sent would be a different and worse change than reordering one.
 */
export const PINNED_KEYS_MEMBER_ORDER = ['p256dh', 'auth'] as const;

export function pinKeysMemberOrder(subscription: PushSubscription): PushSubscription {
  const keys = subscription.keys;
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    // Not a shape this can reorder. The preflight's stop conditions mean no migrated row is
    // like this; leaving it alone is better than inventing an order for it.
    return subscription;
  }

  const ordered: Record<string, string> = {};
  for (const name of PINNED_KEYS_MEMBER_ORDER) {
    if (Object.prototype.hasOwnProperty.call(keys, name)) {
      ordered[name] = keys[name];
    }
  }
  for (const [name, value] of Object.entries(keys)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, name)) {
      ordered[name] = value;
    }
  }

  // The *top-level* order is jsonb's — `keys`, `endpoint`, `expirationTime` by (length,
  // bytes), the same order hstore emitted — and is preserved by rebuilding in place.
  const pinned: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(subscription)) {
    pinned[name] = name === 'keys' ? ordered : value;
  }
  return pinned as unknown as PushSubscription;
}
