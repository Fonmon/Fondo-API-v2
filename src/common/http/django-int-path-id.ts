/**
 * A `[0-9]+` URL segment used as a primary-key lookup, where an out-of-range value is a
 * **miss**, not an error.
 *
 * `FileDetailView.get` does `File.objects.get(id=int(id))`. Python's `int` is arbitrary
 * precision and Django 2.2 sends the literal to PostgreSQL, which compares an `integer`
 * column against a larger numeric happily and finds nothing — measured on the pinned v1:
 * `GET /api/file/99999999999999999999` is a **404**. Prisma would reject the value as an
 * `Int` and answer 500, so a value above int4 maps to `-1`, an id no row holds (the pattern
 * admits no sign, and the sequence starts at 1).
 *
 * ✅ **C83 closed (Phase 9 stage 2a).** Two feature modules used to carry byte-identical
 * copies of this function. `loans/loan-path-id.ts` and `activities/activity-path-id.ts` now
 * delegate here and keep only their route-specific documentation, so the rule has one
 * implementation and three call sites instead of three implementations.
 */
export function parseDjangoIntPathId(raw: string): number {
  const value = BigInt(raw);
  return value > 2147483647n ? -1 : Number(value);
}
