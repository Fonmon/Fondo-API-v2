/**
 * The pagination envelope every list endpoint in v1 returns, reproduced exactly.
 *
 * v1 builds it by hand around `django.core.paginator.Paginator`
 * (`services/loan.py`, `services/user.py`, `services/saving_account.py`):
 *
 * ```python
 * paginator = Paginator(queryset, PER_PAGE)
 * if page > paginator.num_pages:
 *     return {'list': [], 'num_pages': paginator.num_pages, 'count': paginator.count}
 * page_return = paginator.page(page)
 * return {'list': serializer.data, 'num_pages': paginator.num_pages, 'count': paginator.count}
 * ```
 *
 * Two behaviours that are easy to "improve" by accident and must not be:
 *
 *  1. **A page past the last one is a 200, not a 404.** The response is the same envelope
 *     with an empty `list` and the real `num_pages` / `count`.
 *  2. **`num_pages` is never 0.** Django computes `ceil(max(1, count - orphans) / per_page)`
 *     with `orphans = 0`, so an empty result set still reports `num_pages: 1` alongside
 *     `count: 0`.
 *
 * When `paginate=false` the services return `{'list': [...]}` with **no** `num_pages` and
 * **no** `count` — see {@link unpaginatedEnvelope}.
 */
export interface PageEnvelope<T> {
  list: T[];
  num_pages: number;
  count: number;
}

/** The shape returned when a caller passes `paginate=false`. */
export interface UnpaginatedEnvelope<T> {
  list: T[];
}

/**
 * `django.core.paginator.Paginator.num_pages` with `orphans = 0` and
 * `allow_empty_first_page = True`.
 *
 * `numPages(0, 10) === 1` — not 0.
 */
export function numPages(count: number, perPage: number): number {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError(`perPage must be a positive integer, received ${String(perPage)}`);
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, received ${String(count)}`);
  }
  return Math.ceil(Math.max(1, count) / perPage);
}

/** v1's `if page > paginator.num_pages` check. */
export function isPageBeyondLast(page: number, count: number, perPage: number): boolean {
  return page > numPages(count, perPage);
}

/** Zero-based row offset for a 1-based page number, for use in a `skip`/`OFFSET` clause. */
export function pageOffset(page: number, perPage: number): number {
  return (page - 1) * perPage;
}

/**
 * Assembles the envelope from an already-fetched page of rows plus the total row count.
 *
 * `items` must be the rows for `page`; pass an empty array when the page is beyond the
 * last one (`isPageBeyondLast`), which is what v1 does.
 */
export function buildPageEnvelope<T>(
  items: readonly T[],
  count: number,
  perPage: number,
): PageEnvelope<T> {
  return {
    list: [...items],
    num_pages: numPages(count, perPage),
    count,
  };
}

/** The `paginate=false` response: a bare list, with no `num_pages` and no `count`. */
export function unpaginatedEnvelope<T>(items: readonly T[]): UnpaginatedEnvelope<T> {
  return { list: [...items] };
}

/**
 * In-memory pagination, for callers that already hold the full collection (and for tests).
 * Applies the same past-the-end rule as v1.
 */
export function paginateArray<T>(
  items: readonly T[],
  page: number,
  perPage: number,
): PageEnvelope<T> {
  const count = items.length;
  if (isPageBeyondLast(page, count, perPage)) {
    return buildPageEnvelope<T>([], count, perPage);
  }
  const offset = pageOffset(page, perPage);
  return buildPageEnvelope(items.slice(offset, offset + perPage), count, perPage);
}
