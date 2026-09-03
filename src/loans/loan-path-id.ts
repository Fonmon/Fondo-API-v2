/**
 * The `<id>` of `^api/loan/(?P<id>[0-9]+)$` and `^api/loan/(?P<id>[0-9]+)/(?P<app>[a-zA-Z]+)$`.
 *
 * ⚠️ **v1 never calls `int()` on it.** `LoanDetailView` and `LoanAppsView` pass the raw
 * **string** straight into the ORM (`Loan.objects.get(id=id)`,
 * `LoanDetail.objects.get(loan_id=loan_id)`) — unlike `UserDetailView`, which does
 * `id = int(id)`. Django coerces it in the query compiler, so the observable behaviour is the
 * same for every value the regex admits, and `refinance_loan`'s comment string interpolates
 * the raw segment (`'…crédito #{}'.format(loan_id)`), which renders identically either way.
 *
 * ⚠️ Python's `int` is arbitrary precision and PostgreSQL compares an `integer` column against
 * an out-of-range numeric literal happily, so `GET /api/loan/99999999999999999999` is a plain
 * **404** in v1 — it resolves, queries and misses. `Number()` would lose precision and Prisma
 * would reject the value as an `Int`, giving a 500 instead.
 *
 * So an out-of-range value is mapped to **`-1`**, an id no row can hold: the sequence starts
 * at 1 and the pattern is `[0-9]+`, so nothing can address a negative id from outside. Each
 * handler then reaches its own miss path unchanged — a **404** for
 * `GET /api/loan/<id>` and `paymentProjection`, a **400** for `refinance`, which is exactly
 * how v1 answers those three. Returning a thrown 404 here instead would have turned
 * `refinance`'s 400 into a 404.
 *
 * The regex admits only `[0-9]+`, so there is no sign to handle and no `-1` sentinel on the
 * way *in*: the loan routes have no "me".
 */
export function parseLoanPathId(raw: string): number {
  const value = BigInt(raw);
  return value > 2147483647n ? -1 : Number(value);
}
