/**
 * The request target, split the way the WSGI server splits it into `PATH_INFO` and
 * `QUERY_STRING`.
 *
 * `request.originalUrl` rather than `request.url`: Nest mounts middleware with `app.use(path,
 * ...)`, and for any mount path other than `/` Express *trims the matched prefix* from
 * `req.url` for the duration of the middleware. `originalUrl` is the untouched target.
 *
 * ## The fragment never reaches the application — finding **N4**, condition **C18**
 *
 * Node hands the request target through to `originalUrl` verbatim, `#` included. gunicorn does
 * not: it parses the target and drops the fragment on the floor. Read off the image v1 runs
 * (gunicorn 19.9.0, CPython 3.9.25), `Request.parse_request_line`
 * (`gunicorn/http/message.py:344-352`) calls `split_request_uri`
 * (`gunicorn/util.py:548-557`), which is `urllib.parse.urlsplit` plus a `//` workaround, and
 * keeps `path`/`query`/`fragment` as three separate attributes. `create()`
 * (`gunicorn/http/wsgi.py:97,191-194`) then puts **only two of them** into the environ —
 * `QUERY_STRING = req.query` and `PATH_INFO = unquote(req.path)`. The fragment survives only
 * in `RAW_URI`, which Django never reads. So Django is structurally incapable of seeing it.
 *
 * ## Order matters: fragment first, at the *first* `#`
 *
 * This was checked against the installed `urllib/parse.py:527-530` rather than assumed, because
 * the two splits are not commutative:
 *
 * ```python
 * if allow_fragments and '#' in url:
 *     url, fragment = url.split('#', 1)   # first, on the FIRST '#'
 * if '?' in url:
 *     url, query = url.split('?', 1)      # then, on what is left
 * ```
 *
 * Two consequences a `?`-only split gets wrong, both confirmed against the live v1 over a raw
 * socket (`POST`, gunicorn, DEBUG off):
 *
 * | target | `PATH_INFO` | `QUERY_STRING` | v1 |
 * |---|---|---|---|
 * | `/password_reset#frag` | `/password_reset` | `` | 301 → `/password_reset/` |
 * | `/password_reset?a=1#frag` | `/password_reset` | `a=1` | 301 → `/password_reset/?a=1` |
 * | `/password_reset#frag?a=1` | `/password_reset` | `` | 301 → `/password_reset/` |
 * | `/password_reset?a=1#f1#f2` | `/password_reset` | `a=1` | 301 → `/password_reset/?a=1` |
 * | `/password_reset%23frag` | `/password_reset%23frag` | `` | 404 |
 *
 * A `#` *after* a `?` still ends the query — the split is on the first `#` in the whole target,
 * not on one that happens to precede the `?`. And because the fragment is removed before the
 * path is taken, a `#` ahead of any `?` still yields the right path. Percent-encoded `%23` is
 * not a delimiter and must survive into `PATH_INFO` untouched, which is what keeps the 404 a
 * 404 — it is the control that proves this does not over-reach.
 *
 * Both callers ({@link DjangoUrlResolverMiddleware}, {@link DjangoAppendSlashMiddleware}) take
 * their path *and* their query from this one function, so stripping here is also what keeps the
 * fragment out of the `APPEND_SLASH` `Location`.
 *
 * ⚠️ Not a full `urlsplit` port: an absolute-form target (`POST http://host/path`, legal for
 * proxies, RFC 7230 §5.3.2) would have its scheme and netloc split off by `urlsplit` and is
 * left alone here. No client of v1 sends one and no probe covers it; if a phase ever needs it,
 * it is a separate finding, not a widening of this one.
 */
export function splitQuery(target: string): [path: string, query: string] {
  // `urlsplit` step 1 — the fragment goes first, so that a `#` before any `?` still ends the
  // path rather than being absorbed into it.
  const hash = target.indexOf('#');
  const addressable = hash === -1 ? target : target.slice(0, hash);

  // `urlsplit` step 2 — the query, from what the fragment left behind.
  const index = addressable.indexOf('?');
  return index === -1
    ? [addressable, '']
    : [addressable.slice(0, index), addressable.slice(index + 1)];
}
