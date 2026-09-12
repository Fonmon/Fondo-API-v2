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
 * ⚠️ Two older copies of this rule live in feature modules (`loans/loan-path-id.ts`,
 * `activities/activity-path-id.ts`, counted 2026-09-12). They are left in place rather than
 * re-pointed from an approved phase; `docs/phase-8-deviations.md` §7 proposes the hoist.
 */
export function parseDjangoIntPathId(raw: string): number {
  const value = BigInt(raw);
  return value > 2147483647n ? -1 : Number(value);
}
