/**
 * The `<id>` of `^api/activity/(?P<id>[0-9]+)/?$` and the `<id_year>` of
 * `^api/activity/year/(?P<id_year>[0-9]+)$`.
 *
 * ⚠️ **v1 never calls `int()` on either.** `ActivityDetailView` and `ActivityYearDetailView`
 * pass the raw **string** straight into the ORM (`Activity.objects.get(id = id)`,
 * `Activity.objects.filter(year_id = id_year)`, `activity.year_id = id_year`), exactly as
 * `LoanDetailView` does. Django coerces in the query compiler, so for every value the regex
 * admits the observable behaviour is the same either way.
 *
 * ⚠️ Python's `int` is arbitrary precision and PostgreSQL happily compares an `integer` column
 * against an out-of-range numeric literal, so `GET /api/activity/99999999999999999999` is a
 * plain **404** in v1 — it resolves, queries and misses. `Number()` would lose precision and
 * Prisma would reject the value as an `Int`, producing a 500 instead.
 *
 * So an out-of-range value is mapped to **`-1`**, an id no row can hold: the sequences start
 * at 1 and the patterns are `[0-9]+`, so nothing can address a negative id from outside. Each
 * of the four handlers then reaches its own miss path unchanged, and all four agree with v1:
 *
 * | handler | with a huge id | with `-1` |
 * |---|---|---|
 * | `ActivityDetailView.get` | `DoesNotExist` → **404** | no row → **404** |
 * | `ActivityDetailView.patch` | `DoesNotExist`, swallowed → **404** | → **404** |
 * | `ActivityDetailView.delete` | deletes nothing → **200** | deletes nothing → **200** |
 * | `ActivityYearDetailView.get` | no rows → **200 `[]`** | no rows → **200 `[]`** |
 * | `ActivityYearDetailView.post` | deferred FK violation at COMMIT → **500** | same → **500** |
 *
 * Shared by both controllers rather than duplicated: `LoanDetailController` and
 * `LoanAppsController` share `parseLoanPathId` for the same reason.
 */
export function parseActivityPathId(raw: string): number {
  const value = BigInt(raw);
  return value > 2147483647n ? -1 : Number(value);
}
