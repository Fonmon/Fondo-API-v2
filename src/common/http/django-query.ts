/**
 * `django.http.QueryDict` read semantics, for the query string.
 *
 * v1's views read query parameters through `request.query_params`, which is DRF's alias for
 * Django's `QueryDict`. A `QueryDict` is a *multi*-value mapping whose `__getitem__`/`get`
 * return the **last** value of a repeated key (`django/http/request.py:QueryDict.__getitem__`
 * → `list.__getitem__(-1)`), while Express's `qs`-backed `req.query` hands a repeated key back
 * as an **array**. `?page=1&page=2` is therefore `'2'` in v1 and `['1', '2']` in Express, and
 * the difference is invisible until the value reaches `int()`.
 *
 * ⚠️ Shared, not users-only (review C36). `LoanView.get` (Phase 4) reads `all_loans`, `state`,
 * `page` and `paginate`; `ActivityView` (Phase 5) reads its own. Every one of them needs this
 * before `pythonInt`.
 */

/**
 * `QueryDict.get(key)` — the **last** value of a repeated key, `undefined` when the key is
 * absent.
 *
 * Note the distinction v1's `UserView.get` depends on: an *absent* key and a key *present but
 * empty* are different. `?page=` yields `''`, which reaches `int('')` and 500s; no `page` at
 * all yields `undefined`, which takes the unpaginated branch.
 */
export function lastQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value[value.length - 1];
  }
  return value;
}
