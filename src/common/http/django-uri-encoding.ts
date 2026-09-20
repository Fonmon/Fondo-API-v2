/**
 * `django.utils.encoding.escape_uri_path` / `iri_to_uri` and `django.utils.http.
 * escape_leading_slashes`, ported byte-for-byte — parity finding **N2**, condition **C16**.
 *
 * ## Why v2 needs them
 *
 * `CommonMiddleware`'s `APPEND_SLASH` 301 builds its `Location` from
 * `request.get_full_path(force_append_slash=True)`:
 *
 * ```python
 * return '%s%s%s' % (
 *     escape_uri_path(path),                       # path is PATH_INFO, already *decoded*
 *     '/' if force_append_slash and not path.endswith('/') else '',
 *     ('?' + iri_to_uri(self.META['QUERY_STRING'])) if self.META.get('QUERY_STRING') else ''
 * )
 * ```
 *
 * i.e. Django re-encodes the **decoded** path, it does not echo the request target. The two
 * only agree when the target carries no escapes, which is why the previous comment in
 * `django-url-resolver.middleware.ts` — "the two agree for every path that can reach this
 * branch" — was wrong: the *routes* are ASCII, the *request target* need not be. Measured on
 * the live v1 (Django 2.2.27, gunicorn):
 *
 * ```
 * POST /password%5Freset       -> Location: /password_reset/        (not /password%5Freset/)
 * POST /password_reset%2Fdone  -> Location: /password_reset/done/
 * POST /reset/M%51/abc-def     -> Location: /reset/MQ/abc-def/
 * ```
 *
 * ## The rules are CPython's `quote`, not `encodeURI`
 *
 * `quote(string, safe)` UTF-8-encodes the string and percent-encodes every byte outside
 * `_ALWAYS_SAFE` (`ALPHA DIGIT _ . - ~`) plus `safe`, in **upper-case** hex. No JavaScript
 * built-in has that safe set: `encodeURI` leaves `#`, `?`, `;`, `=` and `%` alone (Django
 * escapes all five in a path) and `encodeURIComponent` escapes `/`, `:`, `@`, `&`, `+`, `$`
 * and `,` (Django keeps all seven). Every expectation in the accompanying spec was produced
 * by calling the real functions inside the v1 container.
 */

/** CPython `urllib.parse._ALWAYS_SAFE` (Python 3.7+ includes `~`). */
const ALWAYS_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~';

const ENCODER = new TextEncoder();

/** CPython `urllib.parse.quote(value, safe=...)`. */
function quote(value: string, safe: ReadonlySet<number>): string {
  let quoted = '';
  for (const byte of ENCODER.encode(value)) {
    quoted += safe.has(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return quoted;
}

function safeBytes(safe: string): ReadonlySet<number> {
  const bytes = new Set<number>();
  for (const character of ALWAYS_SAFE + safe) {
    bytes.add(character.charCodeAt(0));
  }
  return bytes;
}

/** `escape_uri_path`: `quote(path, safe="/:@&+$,-_.!~*'()")`. */
const URI_PATH_SAFE = safeBytes("/:@&+$,-_.!~*'()");

/** `iri_to_uri`: `quote(iri, safe="/#%[]=:;$&()+,!?*@'~")` — note `%` is safe, by RFC 3987. */
const IRI_SAFE = safeBytes("/#%[]=:;$&()+,!?*@'~");

/**
 * `django.utils.encoding.escape_uri_path`.
 *
 * Escapes `;`, `=` and `?` (dropped from RFC 2396's reserved set per its §3.3), `%`, `#`,
 * every other non-ASCII byte, and leaves `/` alone because it escapes a whole path.
 */
export function escapeUriPath(path: string): string {
  return quote(path, URI_PATH_SAFE);
}

/**
 * `django.utils.encoding.iri_to_uri`, applied to `QUERY_STRING` verbatim.
 *
 * `%` is in the safe set, so an already-encoded query survives untouched
 * (`a=%C3%B1&b=1` stays as it is) and an invalid escape is not "repaired" (`a=%zz` stays).
 */
export function iriToUri(iri: string): string {
  return quote(iri, IRI_SAFE);
}

/**
 * `django.utils.http.escape_leading_slashes` — a `//host` redirect would be schemaless.
 *
 * Unreachable with v1's URL table (no pattern matches a path whose first segment is empty),
 * ported because it is one line and the table grows in Phases 3-8.
 */
export function escapeLeadingSlashes(url: string): string {
  return url.startsWith('//') ? `/%2F${url.slice(2)}` : url;
}
