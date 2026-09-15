import { pythonStr, type PythonEncodable } from './django-str';

/**
 * The write-side rule for the two columns Phase 9 step 6 converted from `hstore` to `jsonb`
 * — `fondo_api_schedulertask.payload` and `fondo_api_notificationsubscriptions.subscription`.
 *
 * ## Why a rule is needed at all, when the column now takes JSON
 *
 * The conversion did **not** turn those columns into free-form JSON documents. It reproduced
 * what v1 stored, and v1 stored **strings**: Django's `HStoreField.get_prep_value` ran `str()`
 * over every value on the way in. The migration's repair pass then unwrapped exactly the two
 * members v1 unwrapped on every read — `payload['user_ids']` and `subscription['keys']` — and
 * nothing else. So a migrated row looks like:
 *
 * ```json
 * {"type": "birthdate", "target": "/", "message": "…", "owner_id": "9", "user_ids": [2, 4]}
 * {"keys": {"p256dh": "…", "auth": "…"}, "endpoint": "https://…", "expirationTime": null}
 * ```
 *
 * `owner_id` is the **string** `"9"`, not the number `9`. That is not an oversight to be
 * tidied up now the type allows it: `business-analyst` established that `owner_id` is
 * overloaded — a *member* id on the 86 birthday rows and a *loan* id on the 540 payment
 * reminders — so a numeric type would imply an entity it does not have, the Phase 7 dedupe
 * compares it as text, and a mixed-type slip is member-visible twice (a missed dedupe sends
 * the same reminder twice in a day; a missed delete sends reminders for a paid loan).
 *
 * If v2 started writing `{"owner_id": 9}` while 626 migrated rows hold `{"owner_id": "9"}`,
 * every equality filter would quietly match half the table. This module is what stops that.
 *
 * ## The rule
 *
 * {@link encodeJsonbColumn} takes the object the service layer builds and returns the object
 * to store: the keys named in `nativeKeys` pass through as JSON values, **every other key is
 * stored as a JSON string**, and `null`/`undefined` become JSON `null` (the SQL NULL an
 * hstore value used to be) — and the stringification is **Django's `str()`**, not
 * `JSON.stringify`, so a list becomes `"[1, 2]"` and a dict becomes `"{'a': 'b'}"` exactly as
 * `HStoreField.get_prep_value` wrote them. See `django-str.ts` for why that coercion outlived
 * the hstore codec.
 */

/**
 * Anything the service layer may hand to one of the two converted columns. Identical to
 * {@link PythonEncodable}, aliased so a call site reads as storage rather than as Python.
 */
export type StorableValue = PythonEncodable;

/**
 * Builds the object to store in a converted column.
 *
 * @param source the service-layer object
 * @param nativeKeys the keys that keep their JSON type — `['user_ids']` for a scheduler
 *   payload, `['keys']` for a push subscription. Everything else is stringified.
 */
export function encodeJsonbColumn(
  source: Readonly<Record<string, StorableValue>>,
  nativeKeys: readonly string[],
): Record<string, unknown> {
  const native = new Set(nativeKeys);
  const encoded: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) {
      encoded[key] = null;
      continue;
    }
    if (native.has(key)) {
      encoded[key] = value;
      continue;
    }
    // ⚠️ **Django's `str()`, not `JSON.stringify` and not the value's own JSON type.** A
    // number becomes `"53"`, a list becomes its Python repr `"[1, 2]"`, a dict becomes
    // `"{'a': 'b'}"` — exactly what `HStoreField.get_prep_value` wrote and what the 720
    // migrated rows contain. Storing the JSON type instead would look tidier and would break
    // every equality filter against the existing rows.
    encoded[key] = pythonStr(value);
  }

  return encoded;
}
