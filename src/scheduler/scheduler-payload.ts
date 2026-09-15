/**
 * `fondo_api_schedulertask.payload` after Phase 9 step 6 — the jsonb object, and the two
 * accessors that keep v1's failure modes.
 *
 * Before step 6 this lived in `hstore.codec.ts` as `HstoreMap` + `decodeSchedulerPayload`,
 * and every read did v1's `json.loads(payload["user_ids"])`. The migration did that once and
 * permanently, so `user_ids` arrives as a real array and the rest as JSON strings.
 *
 * ⚠️ **The failure modes are unchanged on purpose.** An absent key still raises a `KeyError`
 * and a `null` value still raises, because those decide whether a scheduler row is *retried*
 * or *silently mis-delivered* — condition **C23**, and deviations **P7-D4** and **P7-D6**.
 */

/** A scheduler payload as the jsonb column yields it. */
export type SchedulerPayload = Record<string, unknown>;

/**
 * `payload["<key>"]` for a text member, with v1's two failure modes preserved.
 *
 * * **Absent key** → `KeyError`, uncaught in `run`, caught by the scheduler loop; the row is
 *   left unprocessed and retried next pass, exactly as v1's is. The log *text* differs from
 *   v1's and is meant to — **P7-D6**.
 * * **`null` value** → refused loudly. v1 would have passed Python `None` into the message
 *   body and `json.dumps` would render `null` on the wire; no writer can produce it (Django
 *   `str()`ed everything, and step 6 preserved that), so v2 refuses rather than widening the
 *   notification payload's types for a row only a hand-edit can produce — **P7-D4**.
 *
 * ⚠️ **Third case, new in stage 2a:** the column is jsonb now, so a member can be a number,
 * a boolean, an array or an object where it used to be forced to a string. None of those is a
 * shape any writer or the migration produces, and silently `String()`-ing one would let a
 * hand-written `{"owner_id": 9}` flow through as `"9"` and hide the very mixed-type drift
 * `jsonb-storage.ts` exists to prevent. It throws.
 */
export function requireText(payload: SchedulerPayload, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw new Error(`KeyError: '${key}'`);
  }
  const value = payload[key];
  if (value === null) {
    throw new TypeError(`scheduler payload key '${key}' is NULL`);
  }
  if (typeof value !== 'string') {
    throw new TypeError(
      `scheduler payload key '${key}' is ${Array.isArray(value) ? 'a list' : `a ${typeof value}`}, ` +
        'not a string. Every member except `user_ids` is a JSON string in all 626 migrated ' +
        'rows; see jsonb-storage.ts.',
    );
  }
  return value;
}

/**
 * `payload["user_ids"]`, which v1 read as `json.loads(payload["user_ids"])` and step 6
 * unwrapped once and for all.
 *
 * Same fail-closed rule as {@link requireText} — condition **C23**: v1 subscripts the key
 * unconditionally, so an absent one aborts the publish rather than sending to nobody.
 */
export function requireUserIds(payload: SchedulerPayload): number[] {
  if (!Object.prototype.hasOwnProperty.call(payload, 'user_ids')) {
    throw new Error("KeyError: 'user_ids'");
  }
  const value = payload.user_ids;
  if (value === null) {
    // v1: `json.loads(None)` -> TypeError, uncaught. Kept verbatim; P7-D6 covers the text.
    throw new TypeError('TypeError: the JSON object must be str, bytes or bytearray, not NoneType');
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      `scheduler payload key 'user_ids' is not a list (got ${typeof value}). ` +
        'Step 6 unwrapped it from its stringified form in all 626 rows; a string here means ' +
        'the row was written by something that did not go through SchedulerTaskRepository.',
    );
  }
  return value as number[];
}
